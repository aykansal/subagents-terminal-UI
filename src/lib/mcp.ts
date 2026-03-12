import {
  experimental_createMCPClient as createMCPClient,
  type JSONRPCMessage,
  type MCPTransport,
} from "@ai-sdk/mcp";
import type { ToolSet } from "ai";
import type { ConnectorRecord } from "./db";

const MCP_PROTOCOL_VERSION = "2025-06-18";

type JsonRpcId = string | number;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number";
}

function extractSessionId(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (typeof payload.sessionId === "string") {
    return payload.sessionId;
  }

  if (isRecord(payload.result) && typeof payload.result.sessionId === "string") {
    return payload.result.sessionId;
  }

  return null;
}

function normalizeJsonRpcMessage(
  payload: unknown,
  fallbackId?: JsonRpcId
): JSONRPCMessage {
  if (!isRecord(payload)) {
    throw new Error("MCP transport received a non-object response.");
  }

  if (
    payload.jsonrpc === "2.0" &&
    isJsonRpcId(payload.id) &&
    ("result" in payload || "error" in payload)
  ) {
    return payload as JSONRPCMessage;
  }

  if (payload.jsonrpc === "2.0" && typeof payload.method === "string") {
    return payload as JSONRPCMessage;
  }

  if (fallbackId !== undefined && "result" in payload) {
    return {
      jsonrpc: "2.0",
      id: fallbackId,
      result: isRecord(payload.result) ? payload.result : {},
    };
  }

  if (fallbackId !== undefined && "error" in payload) {
    const errorObject = isRecord(payload.error) ? payload.error : {};
    return {
      jsonrpc: "2.0",
      id: fallbackId,
      error: {
        code:
          typeof errorObject.code === "number" ? errorObject.code : -32000,
        message:
          typeof errorObject.message === "string"
            ? errorObject.message
            : "Unknown MCP error",
      },
    };
  }

  throw new Error("MCP transport received an invalid JSON-RPC payload.");
}

class CompatHttpMCPTransport implements MCPTransport {
  private readonly url: URL;
  private readonly headers?: Record<string, string>;
  private abortController: AbortController | null = null;
  private sessionId: string | null = null;
  private closed = true;

  onclose?: () => void;
  onerror?: (error: unknown) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(url: string, headers?: Record<string, string>) {
    this.url = new URL(url);
    this.headers = headers;
  }

  async start(): Promise<void> {
    if (this.abortController) {
      return;
    }

    this.abortController = new AbortController();
    this.closed = false;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    const controller = this.abortController;
    this.abortController = null;
    this.closed = true;

    try {
      if (controller && this.sessionId && !controller.signal.aborted) {
        await fetch(this.url, {
          method: "DELETE",
          headers: this.commonHeaders({}),
          signal: controller.signal,
        }).catch(() => undefined);
      }
    } finally {
      controller?.abort();
      this.onclose?.();
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: this.commonHeaders({
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        }),
        body: JSON.stringify(message),
        signal: this.abortController?.signal,
      });

      const headerSessionId = response.headers.get("mcp-session-id");
      if (headerSessionId) {
        this.sessionId = headerSessionId;
      }

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(
          `MCP HTTP transport error: POST ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`
        );
      }

      if (!("id" in message)) {
        return;
      }

      const contentType = response.headers.get("content-type") || "";
      const fallbackId = message.id;

      if (contentType.includes("application/json")) {
        const data = await response.json();
        const messages = Array.isArray(data) ? data : [data];

        for (const item of messages) {
          const normalized = normalizeJsonRpcMessage(item, fallbackId);
          const sessionId = extractSessionId(item);
          if (sessionId) {
            this.sessionId = sessionId;
          }
          this.onmessage?.(normalized);
        }

        return;
      }

      if (contentType.includes("text/event-stream")) {
        const body = await response.text();

        for (const line of body.split("\n")) {
          if (!line.startsWith("data: ")) {
            continue;
          }

          const payload = JSON.parse(line.slice(6)) as unknown;
          const normalized = normalizeJsonRpcMessage(payload, fallbackId);
          const sessionId = extractSessionId(payload);
          if (sessionId) {
            this.sessionId = sessionId;
          }
          this.onmessage?.(normalized);
        }

        return;
      }

      throw new Error(
        `Unsupported MCP content type: ${contentType || "unknown"}`
      );
    } catch (error) {
      this.onerror?.(error);
      throw error;
    }
  }

  private commonHeaders(baseHeaders: Record<string, string>) {
    const headers: Record<string, string> = {
      ...this.headers,
      ...baseHeaders,
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    };

    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    return headers;
  }
}

function buildAuthHeaders(record: ConnectorRecord): Record<string, string> {
  return {
    Authorization: `${record.tokens.token_type || "Bearer"} ${record.tokens.access_token}`,
  };
}

export async function getGoogleMcpClient(record: ConnectorRecord) {
  return await createMCPClient({
    transport: new CompatHttpMCPTransport(
      record.serverUrl,
      buildAuthHeaders(record)
    ),
    name: "subagents-cli",
    version: "0.1.0",
  });
}

export async function createGoogleMcpSession(record: ConnectorRecord): Promise<{
  client: Awaited<ReturnType<typeof getGoogleMcpClient>>;
  tools: ToolSet;
}> {
  const client = await getGoogleMcpClient(record);
  const tools = (await client.tools()) as ToolSet;

  return {
    client,
    tools,
  };
}

export async function listGoogleMcpTools(record: ConnectorRecord) {
  const client = await getGoogleMcpClient(record);

  try {
    const tools = await client.tools();
    return Object.entries(tools).map(([name, value]) => {
      const typedValue = value as { description?: string };
      return {
        name,
        description: typedValue.description || "",
      };
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

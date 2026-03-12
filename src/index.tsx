import { createCliRenderer, TextAttributes } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { deleteConnectorRecord, getDbPath } from "./lib/db";
import { buildMainAgent } from "./lib/agents";
import {
  authenticateGoogleWorkspace,
  getGoogleConnectorRecord,
} from "./lib/oauth";
import { createGoogleMcpSession, listGoogleMcpTools } from "./lib/mcp";

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "status";
  text: string;
};

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: makeId(),
      role: "status",
      text:
        "Commands: /auth to connect Google, /tools to inspect MCP tools, /reset-auth to clear saved tokens, /quit to exit.",
    },
  ]);
  const [busy, setBusy] = useState(false);
  const [composerKey, setComposerKey] = useState(0);
  const [draft, setDraft] = useState("");
  const [authSummary, setAuthSummary] = useState("Checking saved Google token...");

  const pushMessage = (role: ChatMessage["role"], text: string) => {
    setMessages((current) => [...current, { id: makeId(), role, text }]);
  };

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const record = await getGoogleConnectorRecord();
      if (!cancelled) {
        setAuthSummary(
          record
            ? `Google Workspace connected. Tokens stored in ${getDbPath()}.`
            : `Google Workspace not connected. Tokens will be stored in ${getDbPath()}.`
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const visibleMessages = useMemo(() => messages.slice(-14), [messages]);

  const runPrompt = async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed || busy) {
      return;
    }

    if (trimmed === "/quit") {
      process.exit(0);
    }

    setBusy(true);
    pushMessage("user", trimmed);

    try {
      if (trimmed === "/auth") {
        pushMessage("status", "Starting terminal OAuth for Google Workspace...");
        const record = await authenticateGoogleWorkspace((message) =>
          pushMessage("status", message)
        );
        setAuthSummary(
          `Google Workspace connected. Tokens stored in ${getDbPath()} and last updated ${record.updatedAt}.`
        );
        pushMessage("assistant", "Google Workspace connected successfully.");
        return;
      }

      if (trimmed === "/tools") {
        const record = await getGoogleConnectorRecord((message) =>
          pushMessage("status", message)
        );
        if (!record) {
          pushMessage("assistant", "No Google token yet. Run /auth first.");
          return;
        }

        const tools = await listGoogleMcpTools(record);
        setAuthSummary(
          `Google Workspace connected. Tokens stored in ${getDbPath()}.`
        );
        pushMessage(
          "assistant",
          tools.length === 0
            ? "The Google MCP returned no tools."
            : tools
                .map((toolInfo) =>
                  toolInfo.description
                    ? `- ${toolInfo.name}: ${toolInfo.description}`
                    : `- ${toolInfo.name}`
                )
                .join("\n")
        );
        return;
      }

      if (trimmed === "/reset-auth") {
        await deleteConnectorRecord("google-workspace");
        setAuthSummary(
          `Saved Google tokens cleared. New tokens will be written to ${getDbPath()}.`
        );
        pushMessage("assistant", "Deleted the saved Google Workspace token.");
        return;
      }

      const record = await getGoogleConnectorRecord((message) =>
        pushMessage("status", message)
      );
      const mcpSession = record ? await createGoogleMcpSession(record) : null;

      try {
        const mainAgent = buildMainAgent({
          googleTools: mcpSession?.tools ?? {},
          emitStatus: (message) => pushMessage("status", message),
        });

        const result = await mainAgent.generate({
          prompt: trimmed,
        });

        setAuthSummary(
          record
            ? `Google Workspace connected. Tokens stored in ${getDbPath()}.`
            : `Google Workspace not connected. Run /auth to enable MCP tools.`
        );
        pushMessage("assistant", result.text);
      } finally {
        await mcpSession?.client.close().catch(() => undefined);
      }
    } catch (error) {
      pushMessage(
        "assistant",
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      setBusy(false);
      setDraft("");
      setComposerKey((current) => current + 1);
    }
  };

  return (
    <box
      style={{
        flexGrow: 1,
        flexDirection: "column",
        padding: 1,
        gap: 1,
      }}
    >
      <box
        style={{
          border: true,
          flexDirection: "column",
          padding: 1,
          gap: 1,
        }}
      >
        <box justifyContent="space-between">
          <ascii-font font="tiny" text="Subagents" />
          <text attributes={TextAttributes.DIM}>OpenRouter + OpenTUI + Google MCP</text>
        </box>
        <text>{authSummary}</text>
      </box>

      <box
        style={{
          border: true,
          flexGrow: 1,
          flexDirection: "column",
          padding: 1,
          gap: 1,
        }}
      >
        {visibleMessages.map((message) => (
          <box key={message.id} style={{ flexDirection: "column" }}>
            <text
              fg={
                message.role === "assistant"
                  ? "#6ee7b7"
                  : message.role === "user"
                    ? "#93c5fd"
                    : "#fcd34d"
              }
            >
              {message.role.toUpperCase()}
            </text>
            <text>{message.text}</text>
          </box>
        ))}
      </box>

      <box
        style={{
          border: true,
          height: 3,
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        <input
          key={composerKey}
          placeholder={
            busy
              ? "Agent is working..."
              : "Ask something. Example: find my latest unread email from Alice"
          }
          focused={!busy}
          onInput={setDraft}
          onSubmit={runPrompt}
        />
      </box>

      <text attributes={TextAttributes.DIM}>
        {busy
          ? "Running agent..."
          : draft || "The main agent can delegate to two subagents and use Google MCP tools when connected."}
      </text>
    </box>
  );
}

const renderer = await createCliRenderer();
createRoot(renderer).render(<App />);

import { createCliRenderer, TextAttributes } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import { execFileSync } from "node:child_process";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildMainAgent } from "./lib/agents";
import { deleteConnectorRecord, getDbPath } from "./lib/db";
import { createGoogleMcpSession, listGoogleMcpTools } from "./lib/mcp";
import {
  authenticateGoogleWorkspace,
  getGoogleConnectorRecord,
} from "./lib/oauth";

type TranscriptEntry = {
  id: string;
  role: "user" | "assistant";
  title: string;
  content: string;
  reasoning?: string;
  tools?: string[];
  usage?: string;
  details?: string[];
  actionLabel?: string;
  actionValue?: string;
  actionStatus?: string;
  createdAt: string;
};

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function trimBlock(value: string, maxChars = 2200) {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(value.length - maxChars)}\n[truncated]`;
}

function readStreamText(part: unknown): string {
  if (typeof part !== "object" || part === null) {
    return "";
  }

  const maybeDelta = (part as { delta?: unknown }).delta;
  if (typeof maybeDelta === "string") {
    return maybeDelta;
  }

  const maybeText = (part as { text?: unknown }).text;
  if (typeof maybeText === "string") {
    return maybeText;
  }

  return "";
}

function formatUsage(part: {
  finishReason: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    outputTokenDetails?: {
      reasoningTokens?: number;
    };
  };
}) {
  const inputTokens = part.usage?.inputTokens ?? 0;
  const outputTokens = part.usage?.outputTokens ?? 0;
  const reasoningTokens = part.usage?.outputTokenDetails?.reasoningTokens ?? 0;
  return `finish=${part.finishReason} in=${inputTokens} out=${outputTokens} reasoning=${reasoningTokens}`;
}

function copyWithSystemClipboard(text: string): boolean {
  const attempts: Array<[string, string[]]> = [];

  if (process.platform === "win32") {
    attempts.push(["clip.exe", []], ["cmd.exe", ["/c", "clip"]]);
  } else {
    attempts.push(
      ["/mnt/c/Windows/System32/clip.exe", []],
      ["clip.exe", []],
      ["cmd.exe", ["/c", "clip"]]
    );
  }

  for (const [command, args] of attempts) {
    try {
      execFileSync(command, args, { input: text });
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

function App() {
  const tuiRenderer = useRenderer();
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([
    {
      id: makeId(),
      role: "assistant",
      title: "SYSTEM",
      content:
        "Commands: /auth, /tools, /reset-auth, /quit. ctrl+C cancels a running turn or shows a hint.",
      createdAt: new Date().toISOString(),
    },
  ]);
  const [busy, setBusy] = useState(false);
  const [composerKey, setComposerKey] = useState(0);
  const [draft, setDraft] = useState("");
  const [authSummary, setAuthSummary] = useState("Checking saved Google token...");
  const [lastUsage, setLastUsage] = useState("usage=idle");
  const [expandedEntries, setExpandedEntries] = useState<Record<string, boolean>>(
    {}
  );
  const abortControllerRef = useRef<AbortController | null>(null);
  const oauthAbortControllerRef = useRef<AbortController | null>(null);

  const appendTranscript = (
    entry: Omit<TranscriptEntry, "id" | "createdAt">
  ): string => {
    const id = makeId();
    setTranscript((current) => [
      ...current,
      {
        ...entry,
        id,
        createdAt: new Date().toISOString(),
      },
    ]);
    return id;
  };

  const updateTranscript = (
    id: string,
    updater: (entry: TranscriptEntry) => TranscriptEntry
  ) => {
    setTranscript((current) =>
      current.map((entry) => (entry.id === id ? updater(entry) : entry))
    );
  };

  const setActionStatus = (id: string, actionStatus: string) => {
    setTranscript((current) =>
      current.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              actionStatus,
            }
          : entry
      )
    );
  };

  const copyAuthValue = (id: string, value: string) => {
    const copied =
      tuiRenderer.copyToClipboardOSC52(value) || copyWithSystemClipboard(value);

    setActionStatus(
      id,
      copied
        ? "Copied. Paste in your browser and sign in with the Google account you want to connect."
        : "Copy failed in this terminal too. I can add an open-browser fallback next if you want."
    );
  };

  const appendDetail = (id: string, line: string) => {
    setTranscript((current) =>
      current.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              details: [...(entry.details ?? []), line].slice(-24),
            }
          : entry
      )
    );
  };

  const setExpanded = (id: string, value: boolean) => {
    setExpandedEntries((current) => ({
      ...current,
      [id]: value,
    }));
  };

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const record = await getGoogleConnectorRecord();
      if (!cancelled) {
        setAuthSummary(
          record
            ? `Google connected • token DB ${getDbPath()}`
            : `Google disconnected • tokens will be written to ${getDbPath()}`
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      } else if (oauthAbortControllerRef.current) {
        oauthAbortControllerRef.current.abort();
      } else {
        appendTranscript({
          role: "assistant",
          title: "SYSTEM",
          content: "Ctrl+C intercepted. Use /quit to exit.",
        });
      }
    }

    if (key.name === "tab") {
      const lastAssistant = [...transcript]
        .reverse()
        .find((entry) => entry.role === "assistant");
      if (lastAssistant) {
        setExpanded(
          lastAssistant.id,
          !Boolean(expandedEntries[lastAssistant.id])
        );
      }
    }

    if (key.ctrl && key.name === "y") {
      const lastActionable = [...transcript]
        .reverse()
        .find((entry) => entry.actionValue);
      if (lastActionable?.actionValue) {
        copyAuthValue(lastActionable.id, lastActionable.actionValue);
      }
    }
  });

  const visibleTranscript = useMemo(() => transcript.slice(-16), [transcript]);

  const runPrompt = async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed || busy) {
      return;
    }

    if (trimmed === "/quit") {
      await renderer.destroy();
      return;
    }

    setBusy(true);
    appendTranscript({
      role: "user",
      title: "YOU",
      content: trimmed,
    });

    try {
      if (trimmed === "/auth") {
        const outputId = appendTranscript({
          role: "assistant",
          title: "AGENT",
          content: "Starting Google Workspace OAuth...",
          details: [],
          actionLabel: "copy this",
        });
        setExpanded(outputId, true);
        appendDetail(outputId, "Starting terminal OAuth for Google Workspace...");
        const oauthAbortController = new AbortController();
        oauthAbortControllerRef.current = oauthAbortController;
        try {
          const record = await authenticateGoogleWorkspace(
            (line) => appendDetail(outputId, line),
            {
              signal: oauthAbortController.signal,
              onAuthorizationUrl: (url) => {
                updateTranscript(outputId, (entry) => ({
                  ...entry,
                  actionValue: url,
                  actionStatus:
                    "Preparing clipboard copy...",
                }));
                copyAuthValue(outputId, url);
              },
            }
          );
          setAuthSummary(
            `Google connected • token DB ${getDbPath()} • updated ${record.updatedAt}`
          );
          updateTranscript(outputId, (entry) => ({
            ...entry,
            content: "Google Workspace connected successfully.",
            actionValue: undefined,
            actionLabel: undefined,
            actionStatus: undefined,
          }));
        } finally {
          oauthAbortControllerRef.current = null;
        }
        return;
      }

      if (trimmed === "/tools") {
        const outputId = appendTranscript({
          role: "assistant",
          title: "AGENT",
          content: "Loading Google MCP tools...",
          details: [],
        });
        const record = await getGoogleConnectorRecord((line) =>
          appendDetail(outputId, line)
        );

        if (!record) {
          updateTranscript(outputId, (entry) => ({
            ...entry,
            content: "No Google token yet. Run /auth first.",
          }));
          return;
        }

        const tools = await listGoogleMcpTools(record);
        updateTranscript(outputId, (entry) => ({
          ...entry,
          content:
            tools.length === 0
              ? "The Google MCP returned no tools."
              : tools
                  .map((toolInfo) =>
                    toolInfo.description
                      ? `- ${toolInfo.name}: ${toolInfo.description}`
                      : `- ${toolInfo.name}`
                  )
                  .join("\n"),
        }));
        setAuthSummary(`Google connected • token DB ${getDbPath()}`);
        return;
      }

      if (trimmed === "/reset-auth") {
        await deleteConnectorRecord("google-workspace");
        setAuthSummary(
          `Google disconnected • tokens will be written to ${getDbPath()}`
        );
        appendTranscript({
          role: "assistant",
          title: "AGENT",
          content: "Deleted the saved Google Workspace token.",
        });
        return;
      }

      const outputId = appendTranscript({
        role: "assistant",
        title: "AGENT",
        content: "",
        reasoning: "",
        tools: [],
        details: [],
      });
      setExpanded(outputId, true);

      const record = await getGoogleConnectorRecord((line) =>
        appendDetail(outputId, line)
      );
      const mcpSession = record ? await createGoogleMcpSession(record) : null;
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        const mainAgent = buildMainAgent({
          googleTools: mcpSession?.tools ?? {},
          emitStatus: (line) => appendDetail(outputId, line),
        });

        const result = await mainAgent.stream({
          prompt: trimmed,
          abortSignal: abortController.signal,
        });
        appendDetail(outputId, "Streaming assistant response...");

        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta":
            case "text":
              updateTranscript(outputId, (entry) => ({
                ...entry,
                content: entry.content + readStreamText(part),
              }));
              break;
            case "reasoning-delta":
            case "reasoning":
              updateTranscript(outputId, (entry) => ({
                ...entry,
                reasoning: trimBlock(
                  (entry.reasoning ?? "") + readStreamText(part)
                ),
              }));
              break;
            case "tool-call":
              appendDetail(outputId, `Tool call • ${part.toolName}`);
              updateTranscript(outputId, (entry) => ({
                ...entry,
                tools: entry.tools?.includes(part.toolName)
                  ? entry.tools
                  : [...(entry.tools ?? []), part.toolName],
              }));
              break;
            case "tool-result":
              appendDetail(outputId, `Tool finished • ${part.toolName}`);
              break;
            case "error":
              appendDetail(
                outputId,
                `Stream error • ${
                  part.error instanceof Error
                    ? part.error.message
                    : String(part.error)
                }`
              );
              break;
            case "finish": {
              const usage = formatUsage(part);
              setLastUsage(usage);
              updateTranscript(outputId, (entry) => ({
                ...entry,
                usage,
              }));
              appendDetail(outputId, `Turn finished • ${usage}`);
              setExpanded(outputId, false);
              break;
            }
          }
        }

        setAuthSummary(
          record
            ? `Google connected • token DB ${getDbPath()}`
            : `Google disconnected • run /auth to enable MCP tools`
        );
      } finally {
        abortControllerRef.current = null;
        await mcpSession?.client.close().catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        appendTranscript({
          role: "assistant",
          title: "AGENT",
          content:
            oauthAbortControllerRef.current || !abortControllerRef.current
              ? "Cancelled the current flow."
              : "Cancelled the current run.",
        });
      } else {
        appendTranscript({
          role: "assistant",
          title: "AGENT",
          content: error instanceof Error ? error.message : String(error),
        });
      }
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
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <box
        style={{
          height: 2,
          flexDirection: "column",
          justifyContent: "center",
          borderBottom: true,
        }}
      >
        <text>
          <strong>subagents</strong> <span>•</span> {authSummary}
        </text>
      </box>

      <box
        style={{
          flexGrow: 1,
          flexDirection: "column",
          borderBottom: true,
          paddingTop: 1,
          paddingBottom: 1,
        }}
      >
        {/* <text fg="#c4b5fd" attributes={TextAttributes.DIM}>
          TRANSCRIPT
        </text> */}
        <scrollbox style={{ flexGrow: 1, paddingTop: 1 }}>
          {visibleTranscript.map((entry) => {
            const isExpanded = Boolean(expandedEntries[entry.id]);
            const hasDetails =
              Boolean(entry.reasoning) ||
              Boolean(entry.tools?.length) ||
              Boolean(entry.usage) ||
              Boolean(entry.details?.length);

            return (
            <box
              key={entry.id}
              style={{
                flexDirection: "column",
                marginBottom: 1,
                paddingLeft: 1,
                borderLeft: true,
              }}
            >
              <text fg={entry.role === "user" ? "#93c5fd" : "#6ee7b7"}>
                {entry.title}
              </text>
              <text>{entry.content || (busy ? "Streaming..." : "")}</text>
              {hasDetails ? (
                <box style={{ flexDirection: "column", marginTop: 1 }}>
                  <text
                    attributes={TextAttributes.DIM}
                    fg="#a1a1aa"
                  >
                    [{isExpanded ? "-" : "+"}] details
                    {entry.usage ? ` • ${entry.usage}` : ""}
                  </text>
                  {isExpanded ? (
                    <box
                      style={{
                        flexDirection: "column",
                        marginTop: 1,
                        paddingLeft: 1,
                        borderLeft: true,
                      }}
                    >
                      {entry.reasoning ? (
                        <>
                          <text fg="#fca5a5" attributes={TextAttributes.DIM}>
                            THINKING
                          </text>
                          <text>{entry.reasoning}</text>
                        </>
                      ) : null}
                      {entry.tools && entry.tools.length > 0 ? (
                        <text attributes={TextAttributes.DIM}>
                          tools: {entry.tools.join(", ")}
                        </text>
                      ) : null}
                      {entry.actionLabel ? (
                        <box style={{ flexDirection: "column", marginTop: 1 }}>
                          <text fg="#93c5fd">[ {entry.actionLabel} ]</text>
                          <text attributes={TextAttributes.DIM}>
                            {entry.actionStatus ??
                              "Press Ctrl+Y to copy this, then paste in your browser with the Google account you want to connect."}
                          </text>
                        </box>
                      ) : null}
                      {entry.details?.map((line, index) => (
                        <text key={`${entry.id}-detail-${index}`}>{line}</text>
                      ))}
                    </box>
                  ) : null}
                </box>
              ) : null}
            </box>
            );
          })}
        </scrollbox>
      </box>

      <box
        style={{
          height: 3,
          flexDirection: "column",
          justifyContent: "center",
          borderBottom: true,
        }}
      >
        <input
          key={composerKey}
          placeholder={
            busy
              ? "Agent is running..."
              : "Ask something. The main agent can spawn subagents and call Google MCP tools."
          }
          value={draft}
          focused={!busy}
          onChange={setDraft}
          onSubmit={runPrompt}
        />
      </box>

      <box
        style={{
          height: 1,
          justifyContent: "center",
        }}
      >
        <text attributes={TextAttributes.DIM}>
          Enter=send • Tab=toggle latest details • Ctrl+Y=copy auth link • /auth Google • Ctrl+C=cancel • /quit=exit • model=claude-sonnet-4.6 • subagents=research,ops • {lastUsage} • {busy ? "mode=running" : "mode=idle"}
        </text>
      </box>
    </box>
  );
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
});
createRoot(renderer).render(<App />);

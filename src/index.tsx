import { createCliRenderer, type InputRenderable } from "@opentui/core";
import {
  createRoot,
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import { execFileSync } from "node:child_process";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildMainAgent } from "./lib/agents";
import { deleteConnectorRecord, getDbPath } from "./lib/db";
import { createDirectTools } from "./lib/direct-tools";
import { createGoogleMcpSession, listGoogleMcpTools } from "./lib/mcp";
import {
  authenticateGoogleWorkspace,
  getGoogleConnectorRecord,
} from "./lib/oauth";
import { AppHeader } from "./ui/AppHeader";
import { Composer } from "./ui/Composer";
import { type TranscriptEntry } from "./ui/chat-types";
import { StatusBar } from "./ui/StatusBar";
import { TranscriptView } from "./ui/TranscriptView";

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
      ["cmd.exe", ["/c", "clip"]],
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
  const { width } = useTerminalDimensions();
  const directTools = useMemo(() => createDirectTools(), []);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [composerKey, setComposerKey] = useState(0);
  const [draft, setDraft] = useState("");
  const [authSummary, setAuthSummary] = useState("");
  const [googleConnected, setGoogleConnected] = useState(false);
  // "Checking saved Google token...",
  const [lastUsage, setLastUsage] = useState("usage=idle");
  const [expandedEntries, setExpandedEntries] = useState<
    Record<string, boolean>
  >({});
  const abortControllerRef = useRef<AbortController | null>(null);
  const oauthAbortControllerRef = useRef<AbortController | null>(null);
  const composerInputRef = useRef<InputRenderable | null>(null);

  const appendTranscript = (
    entry: Omit<TranscriptEntry, "id" | "createdAt">,
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
    updater: (entry: TranscriptEntry) => TranscriptEntry,
  ) => {
    setTranscript((current) =>
      current.map((entry) => (entry.id === id ? updater(entry) : entry)),
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
          : entry,
      ),
    );
  };

  const copyAuthValue = (id: string, value: string) => {
    const copied =
      tuiRenderer.copyToClipboardOSC52(value) || copyWithSystemClipboard(value);

    setActionStatus(
      id,
      copied
        ? "Copied. Paste in your browser and sign in with the Google account you want to connect."
        : "Copy failed in this terminal too. I can add an open-browser fallback next if you want.",
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
          : entry,
      ),
    );
  };

  const setExpanded = (id: string, value: boolean) => {
    setExpandedEntries((current) => ({
      ...current,
      [id]: value,
    }));
  };

  const toggleExpanded = (id: string) => {
    setExpandedEntries((current) => ({
      ...current,
      [id]: !current[id],
    }));
  };

  const focusComposer = () => {
    if (!busy) {
      composerInputRef.current?.focus();
    }
  };

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const record = await getGoogleConnectorRecord();
      if (!cancelled) {
        setGoogleConnected(Boolean(record));
        setAuthSummary(
          record
            ? `Google • DB: ${getDbPath()}`
            : `Google • DB: ${getDbPath()}`,
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    focusComposer();
  }, [busy, composerKey]);

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
          !Boolean(expandedEntries[lastAssistant.id]),
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
  const divider = useMemo(() => "─".repeat(Math.max(16, width - 4)), [width]);

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
    setDraft("");
    setComposerKey((current) => current + 1);
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
        appendDetail(
          outputId,
          "Starting terminal OAuth for Google Workspace...",
        );
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
                  actionStatus: "Preparing clipboard copy...",
                }));
                copyAuthValue(outputId, url);
              },
            },
          );
          setGoogleConnected(true);
          setAuthSummary(
            `Google • token DB ${getDbPath()} • updated ${record.updatedAt}`,
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
          content: "Loading direct tools and Google MCP tools...",
          details: [],
        });
        const directToolNames = Object.keys(directTools).sort();
        const record = await getGoogleConnectorRecord((line) =>
          appendDetail(outputId, line),
        );

        if (!record) {
          updateTranscript(outputId, (entry) => ({
            ...entry,
            content: [
              "Direct tools:",
              ...directToolNames.map((toolName) => `- ${toolName}`),
              "",
              "Google MCP tools:",
              "- Not connected. Run /auth first.",
            ].join("\n"),
          }));
          setGoogleConnected(false);
          setAuthSummary(`Google • not connected • token DB ${getDbPath()}`);
          return;
        }

        const tools = await listGoogleMcpTools(record);
        updateTranscript(outputId, (entry) => ({
          ...entry,
          content: [
            "Direct tools:",
            ...directToolNames.map((toolName) => `- ${toolName}`),
            "",
            "Google MCP tools:",
            ...(tools.length === 0
              ? ["- The Google MCP returned no tools."]
              : tools.map((toolInfo) =>
                  toolInfo.description
                    ? `- ${toolInfo.name}: ${toolInfo.description}`
                    : `- ${toolInfo.name}`,
                )),
          ].join("\n"),
        }));
        setGoogleConnected(true);
        setAuthSummary(`Google • token DB ${getDbPath()}`);
        return;
      }

      if (trimmed === "/reset-auth") {
        await deleteConnectorRecord("google-workspace");
        setGoogleConnected(false);
        setAuthSummary(
          `Google • not connected • tokens will be written to ${getDbPath()}`,
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

      const record = await getGoogleConnectorRecord((line) =>
        appendDetail(outputId, line),
      );
      const mcpSession = record ? await createGoogleMcpSession(record) : null;
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        const mainAgent = buildMainAgent({
          directTools,
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
              updateTranscript(outputId, (entry) => ({
                ...entry,
                content: entry.content + readStreamText(part),
              }));
              break;
            case "reasoning-delta":
              updateTranscript(outputId, (entry) => ({
                ...entry,
                reasoning: trimBlock(
                  (entry.reasoning ?? "") + readStreamText(part),
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
                }`,
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
              break;
            }
          }
        }

        setAuthSummary(
          record
            ? `Google • token DB ${getDbPath()}`
            : `Google • not connected • run /auth to enable MCP tools`,
        );
        setGoogleConnected(Boolean(record));
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
    }
  };

  return (
    <box
      onMouseDown={focusComposer}
      style={{
        flexGrow: 1,
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <AppHeader divider={divider} />
      <TranscriptView
        busy={busy}
        divider={divider}
        entries={visibleTranscript}
        expandedEntries={expandedEntries}
        onToggleExpanded={toggleExpanded}
      />
      <Composer
        busy={busy}
        composerKey={composerKey}
        divider={divider}
        draft={draft}
        inputRef={composerInputRef}
        onChange={setDraft}
        onSubmit={(value) => {
          void runPrompt(value);
        }}
      />
      <StatusBar
        authSummary={authSummary}
        busy={busy}
        googleConnected={googleConnected}
      />
    </box>
  );
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
});
createRoot(renderer).render(<App />);

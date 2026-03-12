import { createCliRenderer, TextAttributes } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { useEffect, useMemo, useState } from "react";
import { buildMainAgent } from "./lib/agents";
import { deleteConnectorRecord, getDbPath } from "./lib/db";
import { createGoogleMcpSession, listGoogleMcpTools } from "./lib/mcp";
import {
  authenticateGoogleWorkspace,
  getGoogleConnectorRecord,
} from "./lib/oauth";

type InputEntry = {
  id: string;
  text: string;
  createdAt: string;
};

type OutputEntry = {
  id: string;
  prompt: string;
  text: string;
  reasoning: string;
  tools: string[];
  usage?: string;
  createdAt: string;
};

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function trimBlock(value: string, maxChars = 1600) {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(value.length - maxChars)}\n[truncated]`;
}

function App() {
  const [inputs, setInputs] = useState<InputEntry[]>([
    {
      id: makeId(),
      text: "Commands: /auth, /tools, /reset-auth, /quit",
      createdAt: new Date().toISOString(),
    },
  ]);
  const [outputs, setOutputs] = useState<OutputEntry[]>([]);
  const [statusLines, setStatusLines] = useState<string[]>([
    "Waiting for input.",
  ]);
  const [busy, setBusy] = useState(false);
  const [composerKey, setComposerKey] = useState(0);
  const [draft, setDraft] = useState("");
  const [authSummary, setAuthSummary] = useState("Checking saved Google token...");

  const pushInput = (text: string) => {
    setInputs((current) => [
      ...current,
      { id: makeId(), text, createdAt: new Date().toISOString() },
    ]);
  };

  const pushStatus = (text: string) => {
    setStatusLines((current) => [...current.slice(-24), text]);
  };

  const createOutput = (prompt: string) => {
    const id = makeId();
    setOutputs((current) => [
      ...current,
      {
        id,
        prompt,
        text: "",
        reasoning: "",
        tools: [],
        createdAt: new Date().toISOString(),
      },
    ]);
    return id;
  };

  const updateOutput = (
    id: string,
    updater: (entry: OutputEntry) => OutputEntry
  ) => {
    setOutputs((current) =>
      current.map((entry) => (entry.id === id ? updater(entry) : entry))
    );
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

  const visibleInputs = useMemo(() => inputs.slice(-18), [inputs]);
  const visibleOutputs = useMemo(() => outputs.slice(-10), [outputs]);
  const visibleStatus = useMemo(() => statusLines.slice(-18), [statusLines]);

  const runPrompt = async (input: string) => {
    const trimmed = input.trim();
    let activeOutputId: string | null = null;

    if (!trimmed || busy) {
      return;
    }

    if (trimmed === "/quit") {
      process.exit(0);
    }

    setBusy(true);
    pushInput(trimmed);

    try {
      if (trimmed === "/auth") {
        pushStatus("Starting terminal OAuth for Google Workspace...");
        const record = await authenticateGoogleWorkspace(pushStatus);
        setAuthSummary(
          `Google Workspace connected. Tokens stored in ${getDbPath()} and last updated ${record.updatedAt}.`
        );
        const outputId = createOutput(trimmed);
        activeOutputId = outputId;
        updateOutput(outputId, (entry) => ({
          ...entry,
          text: "Google Workspace connected successfully.",
        }));
        return;
      }

      if (trimmed === "/tools") {
        const record = await getGoogleConnectorRecord(pushStatus);
        const outputId = createOutput(trimmed);
        activeOutputId = outputId;

        if (!record) {
          updateOutput(outputId, (entry) => ({
            ...entry,
            text: "No Google token yet. Run /auth first.",
          }));
          return;
        }

        const tools = await listGoogleMcpTools(record);
        updateOutput(outputId, (entry) => ({
          ...entry,
          text:
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
        setAuthSummary(
          `Google Workspace connected. Tokens stored in ${getDbPath()}.`
        );
        return;
      }

      if (trimmed === "/reset-auth") {
        await deleteConnectorRecord("google-workspace");
        setAuthSummary(
          `Saved Google tokens cleared. New tokens will be written to ${getDbPath()}.`
        );
        const outputId = createOutput(trimmed);
        activeOutputId = outputId;
        updateOutput(outputId, (entry) => ({
          ...entry,
          text: "Deleted the saved Google Workspace token.",
        }));
        return;
      }

      const outputId = createOutput(trimmed);
      activeOutputId = outputId;
      const record = await getGoogleConnectorRecord(pushStatus);
      const mcpSession = record ? await createGoogleMcpSession(record) : null;

      try {
        const mainAgent = buildMainAgent({
          googleTools: mcpSession?.tools ?? {},
          emitStatus: pushStatus,
        });

        const result = await mainAgent.stream({
          prompt: trimmed,
        });

        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta":
              updateOutput(outputId, (entry) => ({
                ...entry,
                text: entry.text + part.delta,
              }));
              break;
            case "reasoning-delta":
              updateOutput(outputId, (entry) => ({
                ...entry,
                reasoning: trimBlock(entry.reasoning + part.delta),
              }));
              break;
            case "tool-call":
              pushStatus(`Tool call: ${part.toolName}`);
              updateOutput(outputId, (entry) => ({
                ...entry,
                tools: entry.tools.includes(part.toolName)
                  ? entry.tools
                  : [...entry.tools, part.toolName],
              }));
              break;
            case "tool-result":
              pushStatus(`Tool finished: ${part.toolName}`);
              break;
            case "error":
              pushStatus(
                `Stream error: ${
                  part.error instanceof Error
                    ? part.error.message
                    : String(part.error)
                }`
              );
              break;
            case "finish":
              updateOutput(outputId, (entry) => ({
                ...entry,
                usage: `finish=${part.finishReason} in=${part?.usage?.inputTokens ?? 0} out=${part?.usage?.outputTokens ?? 0} reasoning=${part.usage.reasoningTokens ?? part.usage.outputTokenDetails?.reasoningTokens ?? 0}`,
              }));
              break;
          }
        }

        setAuthSummary(
          record
            ? `Google Workspace connected. Tokens stored in ${getDbPath()}.`
            : `Google Workspace not connected. Run /auth to enable MCP tools.`
        );
      } finally {
        await mcpSession?.client.close().catch(() => undefined);
      }
    } catch (error) {
      const outputId = activeOutputId ?? createOutput(trimmed);
      updateOutput(outputId, (entry) => ({
        ...entry,
        text: error instanceof Error ? error.message : String(error),
      }));
      pushStatus(
        `Request failed: ${
          error instanceof Error ? error.message : String(error)
        }`
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
          <text attributes={TextAttributes.DIM}>
            Streaming + Reasoning + Google MCP
          </text>
        </box>
        <text>{authSummary}</text>
      </box>

      <box style={{ flexGrow: 1, gap: 1 }}>
        <box
          style={{
            border: true,
            flexGrow: 1,
            flexDirection: "column",
            padding: 1,
            gap: 1,
          }}
        >
          <text fg="#93c5fd">INPUT</text>
          <scrollbox focused style={{ flexGrow: 1 }}>
            {visibleInputs.map((entry) => (
              <box
                key={entry.id}
                style={{
                  border: true,
                  flexDirection: "column",
                  padding: 1,
                  marginBottom: 1,
                }}
              >
                <text attributes={TextAttributes.DIM}>{entry.createdAt}</text>
                <text>{entry.text}</text>
              </box>
            ))}
          </scrollbox>
        </box>

        <box
          style={{
            border: true,
            flexGrow: 2,
            flexDirection: "column",
            padding: 1,
            gap: 1,
          }}
        >
          <text fg="#6ee7b7">OUTPUT</text>
          <scrollbox focused style={{ flexGrow: 1 }}>
            {visibleOutputs.map((entry) => (
              <box
                key={entry.id}
                style={{
                  border: true,
                  flexDirection: "column",
                  padding: 1,
                  marginBottom: 1,
                }}
              >
                <text fg="#fcd34d">Prompt</text>
                <text>{entry.prompt}</text>
                {entry.reasoning ? (
                  <>
                    <text fg="#fca5a5">Thinking</text>
                    <text>{entry.reasoning}</text>
                  </>
                ) : null}
                <text fg="#6ee7b7">Answer</text>
                <text>{entry.text || (busy ? "Streaming..." : "")}</text>
                {entry.tools.length > 0 ? (
                  <>
                    <text fg="#c4b5fd">Tools</text>
                    <text>{entry.tools.join(", ")}</text>
                  </>
                ) : null}
                {entry.usage ? (
                  <text attributes={TextAttributes.DIM}>{entry.usage}</text>
                ) : null}
              </box>
            ))}
          </scrollbox>
        </box>
      </box>

      <box
        style={{
          border: true,
          height: 8,
          flexDirection: "column",
          padding: 1,
          gap: 1,
        }}
      >
        <text fg="#fcd34d">STATUS / MCP</text>
        <scrollbox focused style={{ flexGrow: 1 }}>
          {visibleStatus.map((line, index) => (
            <text key={`${line}-${index}`}>{line}</text>
          ))}
        </scrollbox>
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
              ? "Agent is streaming..."
              : "Ask something. Example: find my latest unread email from Alice"
          }
          focused={!busy}
          onInput={setDraft}
          onSubmit={runPrompt}
        />
      </box>

      <text attributes={TextAttributes.DIM}>
        {busy
          ? "Streaming response and reasoning..."
          : draft ||
            "Input and output are separated, and the main agent now streams visible reasoning deltas."}
      </text>
    </box>
  );
}

const renderer = await createCliRenderer();
createRoot(renderer).render(<App />);

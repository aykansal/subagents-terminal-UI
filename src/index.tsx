import { createCliRenderer, type InputRenderable } from "@opentui/core";
import {
  createRoot,
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import { execFileSync } from "node:child_process";
import { useEffect, useMemo, useRef, useState } from "react";
import { buildMainAgent, type AgentStatusEvent } from "./lib/agents";
import {
  deriveChatTitle,
  formatStructuredValue,
  getMessageTextContent,
} from "./lib/chat-utils";
import {
  createChatSession,
  deleteConnectorRecord,
  getActiveChatSessionId,
  getChatSession,
  getDbPath,
  listChatSessions,
  saveChatSession,
  setActiveChatSession,
} from "./lib/db";
import { createDirectTools } from "./lib/direct-tools";
import type {
  ChatMessage,
  ChatSessionSummary,
  DataOAuthPart,
  DataTracePart,
  MessagePart,
} from "./lib/chat-types";
import { createGoogleMcpSession, listGoogleMcpTools } from "./lib/mcp";
import {
  authenticateGoogleWorkspace,
  getGoogleConnectorRecord,
} from "./lib/oauth";
import { AppHeader } from "./ui/AppHeader";
import { Composer } from "./ui/Composer";
import { StatusBar } from "./ui/StatusBar";
import { TranscriptView } from "./ui/TranscriptView";

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

function sortChatSummaries(chats: ChatSessionSummary[]) {
  return [...chats].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function summarizeChat(chatId: string, title: string, transcript: ChatMessage[]) {
  const timestamp =
    transcript[transcript.length - 1]?.createdAt ?? new Date().toISOString();

  return {
    id: chatId,
    title,
    createdAt: transcript[0]?.createdAt ?? timestamp,
    updatedAt: timestamp,
    messageCount: transcript.length,
  } satisfies ChatSessionSummary;
}

type OutputActivityContext = {
  toolEventIdsByCallId: Record<string, string>;
  activeSubagentTraceIdsByAgent: Record<string, string[]>;
};

function createOutputActivityContext(): OutputActivityContext {
  return {
    toolEventIdsByCallId: {},
    activeSubagentTraceIdsByAgent: {},
  };
}

function getOAuthFromMessage(msg: ChatMessage): DataOAuthPart["data"] | null {
  const part = msg.parts?.find((p) => p.type === "data-oauth") as
    | DataOAuthPart
    | undefined;
  return part ? part.data : null;
}

function App() {
  const tuiRenderer = useRenderer();
  const { width } = useTerminalDimensions();
  const directTools = useMemo(() => createDirectTools(), []);
  const [transcript, setTranscript] = useState<ChatMessage[]>([]);
  const [chatSessions, setChatSessions] = useState<ChatSessionSummary[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [booting, setBooting] = useState(true);
  const [composerKey, setComposerKey] = useState(0);
  const [draft, setDraft] = useState("");
  const [googleConnected, setGoogleConnected] = useState(false);
  const [expandedEntries, setExpandedEntries] = useState<
    Record<string, boolean>
  >({});
  const [collapsedActivityNodes, setCollapsedActivityNodes] = useState<
    Record<string, boolean>
  >({});
  const abortControllerRef = useRef<AbortController | null>(null);
  const oauthAbortControllerRef = useRef<AbortController | null>(null);
  const composerInputRef = useRef<InputRenderable | null>(null);
  const activeChatIdRef = useRef<string | null>(null);
  const chatSessionsRef = useRef<ChatSessionSummary[]>([]);
  const persistQueueRef = useRef<Promise<void>>(Promise.resolve());
  const activityContextRef = useRef<Record<string, OutputActivityContext>>({});

  const uiBusy = busy || booting || !activeChatId;
  const activeChatSummary =
    chatSessions.find((chat) => chat.id === activeChatId) ?? null;

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  useEffect(() => {
    chatSessionsRef.current = chatSessions;
  }, [chatSessions]);

  const queuePersist = (
    chatId: string,
    title: string,
    nextTranscript: ChatMessage[],
  ) => {
    persistQueueRef.current = persistQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        await saveChatSession({
          id: chatId,
          title,
          transcript: nextTranscript,
        });
      })
      .catch((error) => {
        console.error("Failed to persist chat session", error);
      });
  };

  const syncActiveChat = (nextTranscript: ChatMessage[], chatId?: string) => {
    const resolvedChatId = chatId ?? activeChatIdRef.current;
    if (!resolvedChatId) {
      return;
    }

    const existing = chatSessionsRef.current.find(
      (chat) => chat.id === resolvedChatId,
    );
    const title = deriveChatTitle(nextTranscript, existing?.title ?? "New chat");
    const nextSummary = summarizeChat(resolvedChatId, title, nextTranscript);

    setChatSessions((current) =>
      sortChatSummaries([
        nextSummary,
        ...current.filter((chat) => chat.id !== resolvedChatId),
      ]),
    );

    queuePersist(resolvedChatId, title, nextTranscript);
  };

  const appendTranscript = (
    entry: Omit<ChatMessage, "id" | "createdAt">,
  ): string => {
    const id = makeId();
    const nextEntry: ChatMessage = {
      ...entry,
      id,
      createdAt: new Date().toISOString(),
    };

    setTranscript((current) => {
      const nextTranscript = [...current, nextEntry];
      syncActiveChat(nextTranscript);
      return nextTranscript;
    });
    return id;
  };

  const updateTranscript = (
    id: string,
    updater: (entry: ChatMessage) => ChatMessage,
  ) => {
    setTranscript((current) => {
      const nextTranscript = current.map((entry) =>
        entry.id === id ? updater(entry) : entry,
      );
      syncActiveChat(nextTranscript);
      return nextTranscript;
    });
  };

  const appendMessagePart = (id: string, part: MessagePart) => {
    updateTranscript(id, (msg) => ({
      ...msg,
      parts: [...(msg.parts ?? []), part],
    }));
  };

  const updateMessagePart = (
    id: string,
    matcher: (part: MessagePart) => boolean,
    updater: (part: MessagePart) => MessagePart,
  ) => {
    updateTranscript(id, (msg) => ({
      ...msg,
      parts: (msg.parts ?? []).map((part) => (matcher(part) ? updater(part) : part)),
    }));
  };

  const setActionStatus = (id: string, actionStatus: string) => {
    updateTranscript(id, (msg) => {
      const parts: MessagePart[] = [...(msg.parts ?? [])];
      const oauthPart = parts.find((p) => p.type === "data-oauth") as
        | DataOAuthPart
        | undefined;
      const data: DataOAuthPart["data"] = oauthPart
        ? { ...oauthPart.data, actionStatus }
        : { actionStatus };
      if (oauthPart) {
        const idx = parts.indexOf(oauthPart);
        if (idx >= 0) parts[idx] = { type: "data-oauth", data };
      } else {
        parts.push({ type: "data-oauth", data });
      }
      return { ...msg, parts };
    });
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

  const ensureActivityContext = (id: string) => {
    const existing = activityContextRef.current[id];
    if (existing) {
      return existing;
    }

    const next = createOutputActivityContext();
    activityContextRef.current[id] = next;
    return next;
  };

  const handleAgentStatusEvent = (id: string, event: AgentStatusEvent) => {
    const context = ensureActivityContext(id);

    const getActiveSubagentTraceId = (agent: string) => {
      const stack = context.activeSubagentTraceIdsByAgent[agent] ?? [];
      return stack[stack.length - 1];
    };

    switch (event.type) {
      case "delegate-start": {
        const traceId = makeId();
        const stack = context.activeSubagentTraceIdsByAgent[event.agent] ?? [];
        context.activeSubagentTraceIdsByAgent[event.agent] = [...stack, traceId];
        appendMessagePart(id, {
          type: "data-trace",
          data: {
            id: traceId,
            label: `${event.agent} subagent`,
            content: event.task,
            tone: "action",
            state: "running",
          },
        });
        return;
      }
      case "delegate-finish": {
        const traceId = getActiveSubagentTraceId(event.agent);
        if (!traceId) {
          return;
        }

        updateMessagePart(
          id,
          (part) => part.type === "data-trace" && part.data.id === traceId,
          (part) =>
            part.type === "data-trace"
              ? {
                  ...part,
                  data: {
                    ...part.data,
                    state: "done",
                  },
                }
              : part,
        );
        appendMessagePart(id, {
          type: "data-trace",
          data: {
            id: makeId(),
            parentId: traceId,
            label: `${event.agent} response`,
            content: event.summary,
            tone: "muted",
            state: "done",
          },
        });
        context.activeSubagentTraceIdsByAgent[event.agent] = (
          context.activeSubagentTraceIdsByAgent[event.agent] ?? []
        ).slice(0, -1);
        return;
      }
      case "step-finish": {
        const parentId = getActiveSubagentTraceId(event.agent);
        appendMessagePart(id, {
          type: "data-trace",
          data: {
            id: makeId(),
            parentId,
            label: `${event.agent} step`,
            content: event.text,
            tone: "muted",
            state: "done",
          },
        });
        return;
      }
      case "tool-start": {
        const partId = `subagent:${event.agent}:${event.toolCallId}`;
        context.toolEventIdsByCallId[partId] = partId;
        const parentTraceId = getActiveSubagentTraceId(event.agent);
        appendMessagePart(id, {
          type: "tool-invocation",
          toolInvocation: {
            toolCallId: partId,
            toolName: `${event.agent} · ${event.toolName}`,
            parentTraceId,
            args: event.input,
            state: "call",
          },
        });
        return;
      }
      case "tool-finish": {
        const partId = `subagent:${event.agent}:${event.toolCallId}`;
        updateMessagePart(
          id,
          (part) =>
            part.type === "tool-invocation" &&
            part.toolInvocation.toolCallId === partId,
          (part) =>
            part.type === "tool-invocation"
              ? {
                  ...part,
                  toolInvocation: {
                    ...part.toolInvocation,
                    result: event.success ? event.output : event.error,
                    state: "result",
                  },
                }
              : part,
        );
        return;
      }
    }
  };

  const appendDetail = (id: string, line: string) => {
    updateTranscript(id, (msg) => {
      const parts: MessagePart[] = [...(msg.parts ?? [])];
      const detailsPart = parts.find(
        (p): p is Extract<MessagePart, { type: "data-details" }> =>
          p.type === "data-details",
      );
      const nextLines = detailsPart
        ? [...detailsPart.data, line].slice(-24)
        : [line];
      if (detailsPart) {
        const idx = parts.indexOf(detailsPart);
        if (idx >= 0) parts[idx] = { type: "data-details", data: nextLines };
      } else {
        parts.push({ type: "data-details", data: nextLines });
      }
      return { ...msg, parts };
    });
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

  const toggleActivityNode = (id: string) => {
    setCollapsedActivityNodes((current) => ({
      ...current,
      [id]: !current[id],
    }));
  };

  const focusComposer = () => {
    if (!uiBusy) {
      composerInputRef.current?.focus();
    }
  };

  const resetComposer = () => {
    setDraft("");
    setComposerKey((current) => current + 1);
  };

  const createNewChat = async () => {
    if (busy) {
      return;
    }

    const chatId = makeId();
    const chat = await createChatSession({
      id: chatId,
      title: "New chat",
      transcript: [],
      makeActive: true,
    });

    activeChatIdRef.current = chatId;
    setActiveChatId(chatId);
    setTranscript([]);
    activityContextRef.current = {};
    setExpandedEntries({});
    setCollapsedActivityNodes({});
    resetComposer();
    setChatSessions((current) =>
      sortChatSummaries([
        {
          id: chat.id,
          title: chat.title,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt,
          messageCount: 0,
        },
        ...current.filter((entry) => entry.id !== chat.id),
      ]),
    );
  };

  const switchChat = async (chatId: string) => {
    if (busy || chatId === activeChatIdRef.current) {
      return;
    }

    const chat = await getChatSession(chatId);
    if (!chat) {
      return;
    }

    await setActiveChatSession(chatId);
    activeChatIdRef.current = chatId;
    setActiveChatId(chatId);
    setTranscript(chat.transcript);
    activityContextRef.current = {};
    setExpandedEntries({});
    setCollapsedActivityNodes({});
    resetComposer();
  };

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [savedActiveChatId, summaries, record] = await Promise.all([
        getActiveChatSessionId(),
        listChatSessions(),
        getGoogleConnectorRecord(),
      ]);

      if (cancelled) {
        return;
      }

      setGoogleConnected(Boolean(record));

      const initialActiveChatId = savedActiveChatId ?? summaries[0]?.id ?? null;
      const initialActiveChat = initialActiveChatId
        ? await getChatSession(initialActiveChatId)
        : null;

      if (cancelled) {
        return;
      }

      if (initialActiveChat) {
        setChatSessions(summaries);
        activeChatIdRef.current = initialActiveChat.id;
        setActiveChatId(initialActiveChat.id);
        setTranscript(initialActiveChat.transcript);
        activityContextRef.current = {};
        setCollapsedActivityNodes({});
      } else {
        const chatId = makeId();
        const chat = await createChatSession({
          id: chatId,
          title: "New chat",
          transcript: [],
          makeActive: true,
        });

        if (cancelled) {
          return;
        }

        setChatSessions([
          {
            id: chat.id,
            title: chat.title,
            createdAt: chat.createdAt,
            updatedAt: chat.updatedAt,
            messageCount: 0,
          },
        ]);
        activeChatIdRef.current = chat.id;
        setActiveChatId(chat.id);
        setTranscript([]);
        activityContextRef.current = {};
        setCollapsedActivityNodes({});
      }

      setBooting(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    focusComposer();
  }, [composerKey, uiBusy]);

  useKeyboard((key) => {
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
        .find((m) => getOAuthFromMessage(m)?.actionValue);
      const oauth = lastActionable && getOAuthFromMessage(lastActionable);
      if (lastActionable && oauth?.actionValue) {
        copyAuthValue(lastActionable.id, oauth.actionValue);
      }
    }

    if (key.ctrl && key.name === "n") {
      void createNewChat();
    }
  });

  const visibleTranscript = useMemo(() => transcript.slice(-16), [transcript]);
  const divider = useMemo(() => "─".repeat(Math.max(16, width - 4)), [width]);

  const runPrompt = async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed || uiBusy) {
      return;
    }

    if (trimmed === "/quit") {
      await renderer.destroy();
      return;
    }

    if (trimmed === "/new") {
      await createNewChat();
      return;
    }

    setBusy(true);
    resetComposer();
    appendTranscript({
      role: "user",
      parts: [{ type: "text", text: trimmed }],
    });

    try {
      if (trimmed === "/auth") {
        const outputId = appendTranscript({
          role: "assistant",
          parts: [
            { type: "text", text: "Starting Google Workspace OAuth..." },
            { type: "data-oauth", data: { actionLabel: "copy this" } },
            { type: "data-details", data: [] },
          ],
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
          updateTranscript(outputId, (msg) => {
            const parts: MessagePart[] = msg.parts?.slice() ?? [];
            const oauthPart = parts.find((p) => p.type === "data-oauth") as
              | DataOAuthPart
              | undefined;
            const data = {
              actionLabel: "copy this",
              actionValue: url,
              actionStatus: "Preparing clipboard copy...",
            };
            if (oauthPart) {
              const idx = parts.indexOf(oauthPart);
              if (idx >= 0) parts[idx] = { type: "data-oauth", data };
            } else {
              parts.push({ type: "data-oauth", data });
            }
            return { ...msg, parts };
          });
                copyAuthValue(outputId, url);
              },
            },
          );
          setGoogleConnected(true);
          updateTranscript(outputId, (msg) => {
            const rest = (msg.parts ?? []).filter(
              (p): p is Extract<MessagePart, { type: "data-details" }> =>
                p.type === "data-details",
            );
            return {
              ...msg,
              parts: [
                { type: "text", text: "Google Workspace connected successfully." },
                ...rest,
              ],
            };
          });
        } finally {
          oauthAbortControllerRef.current = null;
        }
        return;
      }

      if (trimmed === "/tools") {
        const outputId = appendTranscript({
          role: "assistant",
          parts: [
            { type: "text", text: "Loading direct tools and Google MCP tools..." },
            { type: "data-details", data: [] },
          ],
        });
        const directToolNames = Object.keys(directTools).sort();
        const record = await getGoogleConnectorRecord((line) =>
          appendDetail(outputId, line),
        );

        if (!record) {
          updateTranscript(outputId, (msg) => {
            const text =
              "Direct tools:\n" +
              directToolNames.map((n) => `- ${n}`).join("\n") +
              "\n\nGoogle MCP tools:\n- Not connected. Run /auth first.";
            const parts: MessagePart[] = (msg.parts ?? []).filter(
              (p) => p.type !== "text",
            );
            parts.unshift({ type: "text", text });
            return { ...msg, parts };
          });
          setGoogleConnected(false);
          return;
        }

        const tools = await listGoogleMcpTools(record);
        const text =
          "Direct tools:\n" +
          directToolNames.map((n) => `- ${n}`).join("\n") +
          "\n\nGoogle MCP tools:\n" +
          (tools.length === 0
            ? "- The Google MCP returned no tools."
            : tools
                .map((t) =>
                  t.description ? `- ${t.name}: ${t.description}` : `- ${t.name}`,
                )
                .join("\n"));
        updateTranscript(outputId, (msg) => {
          const parts: MessagePart[] = (msg.parts ?? []).filter(
            (p) => p.type !== "text",
          );
          parts.unshift({ type: "text", text });
          return { ...msg, parts };
        });
        setGoogleConnected(true);
        return;
      }

      if (trimmed === "/reset-auth") {
        await deleteConnectorRecord("google-workspace");
        setGoogleConnected(false);
        appendTranscript({
          role: "assistant",
          parts: [
            {
              type: "text",
              text: "Deleted the saved Google Workspace token.",
            },
          ],
        });
        return;
      }

      const outputId = appendTranscript({
        role: "assistant",
        parts: [],
      });
      activityContextRef.current[outputId] = createOutputActivityContext();
      setExpanded(outputId, true);

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
          emitStatus: (event) => handleAgentStatusEvent(outputId, event),
        });

        const result = await mainAgent.stream({
          prompt: trimmed,
          abortSignal: abortController.signal,
        });

        for await (const part of result.fullStream) {
          const context = ensureActivityContext(outputId);

          switch (part.type) {
            case "start-step":
              break;
            case "text-delta": {
              const delta = readStreamText(part);
              updateTranscript(outputId, (msg) => {
                const parts = [...(msg.parts ?? [])];
                let idx = -1;
                for (let i = parts.length - 1; i >= 0; i--) {
                  if (parts[i]?.type === "text") {
                    idx = i;
                    break;
                  }
                }
                const current = idx >= 0 ? parts[idx] : undefined;
                if (current && current.type === "text") {
                  parts[idx] = { type: "text", text: current.text + delta };
                } else {
                  parts.push({ type: "text", text: delta });
                }
                return { ...msg, parts };
              });
              break;
            }
            case "reasoning-delta": {
              const delta = readStreamText(part);
              updateTranscript(outputId, (msg) => {
                const parts = [...(msg.parts ?? [])];
                const idx = parts.findIndex((p) => p.type === "reasoning");
                if (idx >= 0 && parts[idx]?.type === "reasoning") {
                  parts[idx] = {
                    type: "reasoning",
                    reasoning: parts[idx].reasoning + delta,
                  };
                } else {
                  parts.push({ type: "reasoning", reasoning: delta });
                }
                return { ...msg, parts };
              });
              break;
            }
            case "reasoning-end":
            case "text-end":
              break;
            case "tool-input-start":
              if (!context.toolEventIdsByCallId[part.id]) {
                context.toolEventIdsByCallId[part.id] = part.id;
                appendMessagePart(outputId, {
                  type: "tool-invocation",
                  toolInvocation: {
                    toolCallId: part.id,
                    toolName: part.toolName,
                    args: "",
                    state: "partial-call",
                  },
                });
              }
              break;
            case "tool-input-delta":
              updateMessagePart(
                outputId,
                (entryPart) =>
                  entryPart.type === "tool-invocation" &&
                  entryPart.toolInvocation.toolCallId === part.id,
                (entryPart) =>
                  entryPart.type === "tool-invocation"
                    ? {
                        ...entryPart,
                        toolInvocation: {
                          ...entryPart.toolInvocation,
                          args:
                            typeof entryPart.toolInvocation.args === "string"
                              ? entryPart.toolInvocation.args + part.delta
                              : part.delta,
                          state: "partial-call",
                        },
                      }
                    : entryPart,
              );
              break;
            case "tool-call":
              if (!context.toolEventIdsByCallId[part.toolCallId]) {
                appendMessagePart(outputId, {
                  type: "tool-invocation",
                  toolInvocation: {
                    toolCallId: part.toolCallId,
                    toolName: part.toolName,
                    state: "call",
                    args: part.input,
                  },
                });
                context.toolEventIdsByCallId[part.toolCallId] = part.toolCallId;
              } else {
                updateMessagePart(
                  outputId,
                  (entryPart) =>
                    entryPart.type === "tool-invocation" &&
                    entryPart.toolInvocation.toolCallId === part.toolCallId,
                  (entryPart) =>
                    entryPart.type === "tool-invocation"
                      ? {
                          ...entryPart,
                          toolInvocation: {
                            ...entryPart.toolInvocation,
                            toolName: part.toolName,
                            args: part.input,
                            state: "call",
                          },
                        }
                      : entryPart,
                );
              }
              break;
            case "tool-result":
              updateMessagePart(
                outputId,
                (entryPart) =>
                  entryPart.type === "tool-invocation" &&
                  entryPart.toolInvocation.toolCallId === part.toolCallId,
                (entryPart) =>
                  entryPart.type === "tool-invocation"
                    ? {
                        ...entryPart,
                        toolInvocation: {
                          ...entryPart.toolInvocation,
                          result: part.output,
                          state: part.preliminary ? "partial-call" : "result",
                        },
                      }
                    : entryPart,
              );
              break;
            case "tool-error":
              updateMessagePart(
                outputId,
                (entryPart) =>
                  entryPart.type === "tool-invocation" &&
                  entryPart.toolInvocation.toolCallId === part.toolCallId,
                (entryPart) =>
                  entryPart.type === "tool-invocation"
                    ? {
                        ...entryPart,
                        toolInvocation: {
                          ...entryPart.toolInvocation,
                          result: part.error,
                          state: "result",
                        },
                      }
                    : entryPart,
              );
              break;
            case "finish-step":
            case "error":
            case "finish":
              break;
          }
        }

        setGoogleConnected(Boolean(record));
      } finally {
        abortControllerRef.current = null;
        await mcpSession?.client.close().catch(() => undefined);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        appendTranscript({
          role: "assistant",
          parts: [
            {
              type: "text",
              text:
                oauthAbortControllerRef.current || !abortControllerRef.current
                  ? "Cancelled the current flow."
                  : "Cancelled the current run.",
            },
          ],
        });
      } else {
        appendTranscript({
          role: "assistant",
          parts: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
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
      <AppHeader
        activeChatId={activeChatId}
        chats={chatSessions}
        divider={divider}
        onCreateChat={() => {
          void createNewChat();
        }}
        onSelectChat={(chatId) => {
          void switchChat(chatId);
        }}
      />
      <TranscriptView
        busy={uiBusy}
        collapsedActivityNodes={collapsedActivityNodes}
        divider={divider}
        entries={visibleTranscript}
        expandedEntries={expandedEntries}
        onToggleActivityNode={toggleActivityNode}
        onToggleExpanded={toggleExpanded}
      />
      <Composer
        busy={uiBusy}
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
        activeChatLabel={activeChatSummary?.title ?? "New chat"}
        busy={uiBusy}
        chatCount={chatSessions.length}
        dbPath={getDbPath()}
        googleConnected={googleConnected}
      />
    </box>
  );
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
});
createRoot(renderer).render(<App />);

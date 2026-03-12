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
  ChatSessionSummary,
  TranscriptActivityEvent,
  TranscriptEntry,
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

function summarizeChat(chatId: string, title: string, transcript: TranscriptEntry[]) {
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

type ActiveSubagentContext = {
  rootEventId: string;
  currentStepId?: string;
  toolEventIdsByCallId: Record<string, string>;
};

type OutputActivityContext = {
  currentStepId?: string;
  textEventIdsByStreamId: Record<string, string>;
  reasoningEventIdsByStreamId: Record<string, string>;
  toolEventIdsByCallId: Record<string, string>;
  activeDelegateEventIds: string[];
  activeSubagents: ActiveSubagentContext[];
};

function createOutputActivityContext(): OutputActivityContext {
  return {
    textEventIdsByStreamId: {},
    reasoningEventIdsByStreamId: {},
    toolEventIdsByCallId: {},
    activeDelegateEventIds: [],
    activeSubagents: [],
  };
}

function isDelegateTool(toolName: string) {
  return toolName.startsWith("delegate");
}

function normalizeTranscriptEntry(entry: TranscriptEntry): TranscriptEntry {
  if (!entry.activity?.length) {
    return entry;
  }

  const textEvents = entry.activity.filter(
    (event) =>
      event.kind === "text" &&
      (event.label === "assistant output" || event.label === "main output"),
  );
  const lastTextEventId = textEvents[textEvents.length - 1]?.id;
  const reasoningEvents = entry.activity.filter((event) => event.kind === "reasoning");
  const lastReasoningEventId = reasoningEvents[reasoningEvents.length - 1]?.id;
  let changed = false;

  const activity = entry.activity.map((event) => {
    if (
      event.id === lastTextEventId &&
      entry.content &&
      event.content?.includes("[truncated]")
    ) {
      changed = true;
      return {
        ...event,
        content: entry.content,
      };
    }

    if (
      event.id === lastReasoningEventId &&
      entry.reasoning &&
      event.content?.includes("[truncated]")
    ) {
      changed = true;
      return {
        ...event,
        content: entry.reasoning,
      };
    }

    return event;
  });

  return changed
    ? {
        ...entry,
        activity,
      }
    : entry;
}

function App() {
  const tuiRenderer = useRenderer();
  const { width } = useTerminalDimensions();
  const directTools = useMemo(() => createDirectTools(), []);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
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
    nextTranscript: TranscriptEntry[],
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

  const syncActiveChat = (nextTranscript: TranscriptEntry[], chatId?: string) => {
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
    entry: Omit<TranscriptEntry, "id" | "createdAt">,
  ): string => {
    const id = makeId();
    const nextEntry: TranscriptEntry = {
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
    updater: (entry: TranscriptEntry) => TranscriptEntry,
  ) => {
    setTranscript((current) => {
      const nextTranscript = current.map((entry) =>
        entry.id === id ? updater(entry) : entry,
      );
      syncActiveChat(nextTranscript);
      return nextTranscript;
    });
  };

  const setActionStatus = (id: string, actionStatus: string) => {
    setTranscript((current) => {
      const nextTranscript = current.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              actionStatus,
            }
          : entry,
      );
      syncActiveChat(nextTranscript);
      return nextTranscript;
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

  const appendActivity = (
    id: string,
    event: Omit<TranscriptActivityEvent, "id">,
  ) => {
    const eventId = makeId();

    updateTranscript(id, (entry) => ({
      ...entry,
      activity: [...(entry.activity ?? []), { ...event, id: eventId }],
    }));

    return eventId;
  };

  const updateActivity = (
    id: string,
    eventId: string,
    updater: (event: TranscriptActivityEvent) => TranscriptActivityEvent,
  ) => {
    updateTranscript(id, (entry) => ({
      ...entry,
      activity: (entry.activity ?? []).map((event) =>
        event.id === eventId ? updater(event) : event,
      ),
    }));
  };

  const appendActivityContent = (
    id: string,
    eventId: string,
    value: string,
  ) => {
    updateActivity(id, eventId, (event) => ({
      ...event,
      content: `${event.content ?? ""}${value}`,
    }));
  };

  const getActiveParentId = (context: OutputActivityContext) => {
    const activeSubagent =
      context.activeSubagents[context.activeSubagents.length - 1];

    return activeSubagent?.currentStepId ??
      activeSubagent?.rootEventId ??
      context.currentStepId;
  };

  const handleAgentStatusEvent = (id: string, event: AgentStatusEvent) => {
    const context = ensureActivityContext(id);
    const activeDelegateId =
      context.activeDelegateEventIds[context.activeDelegateEventIds.length - 1];
    const activeSubagent =
      context.activeSubagents[context.activeSubagents.length - 1];

    switch (event.type) {
      case "delegate-start": {
        if (!activeDelegateId) {
          return;
        }

        const rootEventId = appendActivity(id, {
          parentId: activeDelegateId,
          kind: "status",
          label: `${event.agent} subagent`,
          content: event.task,
          tone: "action",
          state: "running",
        });

        context.activeSubagents.push({
          rootEventId,
          toolEventIdsByCallId: {},
        });
        return;
      }
      case "delegate-finish": {
        if (!activeSubagent) {
          return;
        }

        updateActivity(id, activeSubagent.rootEventId, (item) => ({
          ...item,
          state: "done",
        }));

        if (event.summary.trim()) {
          appendActivity(id, {
            parentId: activeSubagent.rootEventId,
            kind: "result",
            label: `${event.agent} response`,
            content: event.summary.trim(),
            tone: "muted",
            state: "done",
          });
        }

        context.activeSubagents.pop();
        return;
      }
      case "step-finish": {
        const parentId = activeSubagent?.rootEventId ?? activeDelegateId;
        if (!parentId || !event.text.trim()) {
          return;
        }

        const stepEventId = appendActivity(id, {
          parentId,
          kind: "step",
          label: `${event.agent} step`,
          tone: "muted",
          state: "done",
        });

        appendActivity(id, {
          parentId: stepEventId,
          kind: "text",
          label: `${event.agent} output`,
          content: event.text.trim(),
          tone: "muted",
          state: "done",
        });

        if (activeSubagent) {
          activeSubagent.currentStepId = undefined;
        }
        return;
      }
      case "tool-start": {
        const parentId = activeSubagent?.rootEventId ?? activeDelegateId;
        if (!parentId) {
          return;
        }

        const toolEventId = appendActivity(id, {
          parentId,
          kind: "tool",
          label: `tool ${event.toolName}`,
          content: formatStructuredValue(event.input, Number.POSITIVE_INFINITY),
          tone: "tool",
          state: "running",
        });

        if (activeSubagent) {
          activeSubagent.toolEventIdsByCallId[event.toolCallId] = toolEventId;
        }
        return;
      }
      case "tool-finish": {
        const toolEventId = activeSubagent?.toolEventIdsByCallId[event.toolCallId];
        if (!activeSubagent || !toolEventId) {
          return;
        }

        updateActivity(id, toolEventId, (item) => ({
          ...item,
          content: event.success
            ? formatStructuredValue(event.output, Number.POSITIVE_INFINITY)
            : formatStructuredValue(event.error, Number.POSITIVE_INFINITY),
          state: event.success ? "done" : "error",
          tone: event.success ? "tool" : "error",
        }));
        return;
      }
    }
  };

  const appendDetail = (id: string, line: string) => {
    setTranscript((current) => {
      const nextTranscript = current.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              details: [...(entry.details ?? []), line].slice(-24),
            }
          : entry,
      );
      syncActiveChat(nextTranscript);
      return nextTranscript;
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
    setTranscript(chat.transcript.map(normalizeTranscriptEntry));
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
        setTranscript(initialActiveChat.transcript.map(normalizeTranscriptEntry));
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
        .find((entry) => entry.actionValue);
      if (lastActionable?.actionValue) {
        copyAuthValue(lastActionable.id, lastActionable.actionValue);
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
        return;
      }

      if (trimmed === "/reset-auth") {
        await deleteConnectorRecord("google-workspace");
        setGoogleConnected(false);
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
        activity: [],
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
            case "start-step": {
              const activeSubagent =
                context.activeSubagents[context.activeSubagents.length - 1];
              const stepEventId = appendActivity(outputId, {
                parentId: activeSubagent?.rootEventId,
                kind: "step",
                label: "main step",
                tone: "muted",
                state: "running",
              });

              if (activeSubagent) {
                activeSubagent.currentStepId = stepEventId;
              } else {
                context.currentStepId = stepEventId;
              }
              break;
            }
            case "text-delta":
              updateTranscript(outputId, (entry) => ({
                ...entry,
                content: entry.content + readStreamText(part),
              }));
              if (!context.textEventIdsByStreamId[part.id]) {
                context.textEventIdsByStreamId[part.id] = appendActivity(outputId, {
                  parentId: getActiveParentId(context),
                  kind: "text",
                  label: "main output",
                  tone: "default",
                  state: "running",
                });
              }
              appendActivityContent(
                outputId,
                context.textEventIdsByStreamId[part.id],
                readStreamText(part),
              );
              break;
            case "reasoning-delta":
              updateTranscript(outputId, (entry) => ({
                ...entry,
                reasoning: (entry.reasoning ?? "") + readStreamText(part),
              }));
              if (!context.reasoningEventIdsByStreamId[part.id]) {
                context.reasoningEventIdsByStreamId[part.id] = appendActivity(outputId, {
                  parentId: getActiveParentId(context),
                  kind: "reasoning",
                  label: "reasoning",
                  tone: "reasoning",
                  state: "running",
                });
              }
              appendActivityContent(
                outputId,
                context.reasoningEventIdsByStreamId[part.id],
                readStreamText(part),
              );
              break;
            case "reasoning-end":
              if (context.reasoningEventIdsByStreamId[part.id]) {
                updateActivity(
                  outputId,
                  context.reasoningEventIdsByStreamId[part.id],
                  (event) => ({ ...event, state: "done" }),
                );
              }
              break;
            case "text-end":
              if (context.textEventIdsByStreamId[part.id]) {
                updateActivity(outputId, context.textEventIdsByStreamId[part.id], (event) => ({
                  ...event,
                  state: "done",
                }));
              }
              break;
            case "tool-input-start": {
              const toolEventId = appendActivity(outputId, {
                  parentId: getActiveParentId(context),
                  kind: "tool",
                  label: `tool ${part.toolName}`,
                  tone: "tool",
                  state: "running",
                });
              context.toolEventIdsByCallId[part.id] = toolEventId;
              if (isDelegateTool(part.toolName)) {
                context.activeDelegateEventIds.push(toolEventId);
              }
              break;
            }
            case "tool-input-delta":
              if (context.toolEventIdsByCallId[part.id]) {
                appendActivityContent(
                  outputId,
                  context.toolEventIdsByCallId[part.id],
                  part.delta,
                  // 1200,
                );
              }
              break;
            case "tool-call":
              updateTranscript(outputId, (entry) => ({
                ...entry,
                tools: entry.tools?.includes(part.toolName)
                  ? entry.tools
                  : [...(entry.tools ?? []), part.toolName],
              }));
              if (!context.toolEventIdsByCallId[part.toolCallId]) {
                const toolEventId = appendActivity(outputId, {
                  parentId: getActiveParentId(context),
                  kind: "tool",
                  label: `tool ${part.toolName}`,
                  content: formatStructuredValue(part.input, Number.POSITIVE_INFINITY),
                  tone: "tool",
                  state: "running",
                });
                context.toolEventIdsByCallId[part.toolCallId] = toolEventId;
                if (isDelegateTool(part.toolName)) {
                  context.activeDelegateEventIds.push(toolEventId);
                }
              } else {
                updateActivity(outputId, context.toolEventIdsByCallId[part.toolCallId], (event) => ({
                  ...event,
                  content: formatStructuredValue(part.input, Number.POSITIVE_INFINITY),
                }));
              }
              break;
            case "tool-result":
              if (context.toolEventIdsByCallId[part.toolCallId]) {
                updateActivity(outputId, context.toolEventIdsByCallId[part.toolCallId], (event) => ({
                  ...event,
                  content: formatStructuredValue(part.output, Number.POSITIVE_INFINITY),
                  state: part.preliminary ? "running" : "done",
                }));
              }
              if (!part.preliminary && isDelegateTool(part.toolName)) {
                const activeDelegateId =
                  context.activeDelegateEventIds[context.activeDelegateEventIds.length - 1];
                if (activeDelegateId === context.toolEventIdsByCallId[part.toolCallId]) {
                  context.activeDelegateEventIds.pop();
                }
              }
              break;
            case "tool-error":
              if (context.toolEventIdsByCallId[part.toolCallId]) {
                updateActivity(outputId, context.toolEventIdsByCallId[part.toolCallId], (event) => ({
                  ...event,
                  content: formatStructuredValue(part.error, Number.POSITIVE_INFINITY),
                  state: "error",
                  tone: "error",
                }));
              }
              break;
            case "finish-step": {
              const activeSubagent =
                context.activeSubagents[context.activeSubagents.length - 1];
              const stepId = activeSubagent?.currentStepId ?? context.currentStepId;
              if (stepId) {
                updateActivity(outputId, stepId, (event) => ({
                  ...event,
                  label: `main step ${part.finishReason}`,
                  state: "done",
                }));
              }
              if (activeSubagent) {
                activeSubagent.currentStepId = undefined;
              } else {
                context.currentStepId = undefined;
              }
              break;
            }
            case "error":
              appendActivity(outputId, {
                parentId: getActiveParentId(context),
                kind: "error",
                label: "stream error",
                content:
                  part.error instanceof Error
                    ? part.error.message
                    : String(part.error),
                tone: "error",
                state: "error",
              });
              break;
            case "finish":
              appendActivity(outputId, {
                kind: "status",
                label: "turn finished",
                tone: "muted",
                state: "done",
              });
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

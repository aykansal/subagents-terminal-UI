/** AI SDK–compatible message parts (junebot / UIMessage style). */
export type DataOAuthPart = {
  type: "data-oauth";
  data: {
    actionLabel?: string;
    actionValue?: string;
    actionStatus?: string;
  };
};

export type DataTracePart = {
  type: "data-trace";
  data: {
    id: string;
    parentId?: string;
    label: string;
    content?: string;
    tone?: "default" | "muted" | "tool" | "reasoning" | "action" | "error";
    state?: "running" | "done" | "error";
  };
};

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; reasoning: string }
  | {
      type: "tool-invocation";
      toolInvocation: {
        toolCallId: string;
        toolName: string;
        parentTraceId?: string;
        args?: unknown;
        result?: unknown;
        state?: "call" | "result" | "partial-call";
      };
    }
  | {
      type: "data-webSearchSources";
      data: Array<{ url: string; title?: string; description?: string }>;
    }
  | {
      type: "data-webSearchQueries";
      data: Array<{ query: string; timestamp?: string }>;
    }
  | {
      type: "data-toolSources";
      data: Array<{
        url: string;
        title?: string;
        description?: string;
        toolName?: string;
        sourceType?: "mcp" | "document" | "memory" | "chat";
      }>;
    }
  | { type: "data-usage"; data: unknown }
  | DataOAuthPart
  | DataTracePart
  | { type: "data-details"; data: string[] };

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  attachments?: unknown[];
  createdAt: string;
};

export type ChatSessionSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type ChatSessionRecord = ChatSessionSummary & {
  transcript: ChatMessage[];
};

/** Legacy format (for migration only). */
export type TranscriptEntryLegacy = {
  id: string;
  role: "user" | "assistant";
  title?: string;
  content: string;
  reasoning?: string;
  tools?: string[];
  usage?: string;
  details?: string[];
  activity?: unknown[];
  actionLabel?: string;
  actionValue?: string;
  actionStatus?: string;
  createdAt: string;
};

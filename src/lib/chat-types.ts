export type TranscriptActivityTone =
  | "default"
  | "muted"
  | "tool"
  | "reasoning"
  | "action"
  | "error";

export type TranscriptActivityState = "running" | "done" | "error";

export type TranscriptActivityEvent = {
  id: string;
  parentId?: string;
  kind:
    | "step"
    | "reasoning"
    | "text"
    | "tool"
    | "status"
    | "result"
    | "error";
  label: string;
  content?: string;
  tone?: TranscriptActivityTone;
  state?: TranscriptActivityState;
};

export type TranscriptEntry = {
  id: string;
  role: "user" | "assistant";
  title: string;
  content: string;
  reasoning?: string;
  tools?: string[];
  usage?: string;
  details?: string[];
  activity?: TranscriptActivityEvent[];
  actionLabel?: string;
  actionValue?: string;
  actionStatus?: string;
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
  transcript: TranscriptEntry[];
};

export type TranscriptEntry = {
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

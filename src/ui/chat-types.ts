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

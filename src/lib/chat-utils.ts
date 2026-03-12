import type { TranscriptActivityEvent } from "./chat-types";

export type OrderedTranscriptActivityEvent = TranscriptActivityEvent & {
  children: OrderedTranscriptActivityEvent[];
};

export function formatBlock(
  content: string,
  prefix: string,
  continuationPrefix = "  "
) {
  return content
    .split("\n")
    .map((line, index) =>
      index === 0 ? `${prefix} ${line}` : `${continuationPrefix}${line}`
    )
    .join("\n");
}

export function deriveChatTitle(
  transcript: Array<{ role: "user" | "assistant"; content: string }>,
  fallback = "New chat",
) {
  const firstUserMessage = transcript.find(
    (entry) =>
      entry.role === "user" &&
      entry.content.trim().length > 0 &&
      !entry.content.trim().startsWith("/"),
  );

  if (!firstUserMessage) {
    return fallback;
  }

  const normalized = firstUserMessage.content.replace(/\s+/g, " ").trim();
  return normalized.length <= 36
    ? normalized
    : `${normalized.slice(0, 33).trimEnd()}...`;
}

export function trimInline(value: string, maxChars = 180) {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) {
    return singleLine;
  }

  return `${singleLine.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function formatStructuredValue(value: unknown, maxChars = 240) {
  if (typeof value === "string") {
    return trimInline(value, maxChars);
  }

  try {
    return trimInline(JSON.stringify(value), maxChars);
  } catch {
    return trimInline(String(value), maxChars);
  }
}

export function orderActivityTree(
  events: TranscriptActivityEvent[],
): OrderedTranscriptActivityEvent[] {
  const byParent = new Map<string | undefined, TranscriptActivityEvent[]>();

  for (const event of events) {
    const group = byParent.get(event.parentId) ?? [];
    group.push(event);
    byParent.set(event.parentId, group);
  }

  const visit = (parentId?: string): OrderedTranscriptActivityEvent[] =>
    (byParent.get(parentId) ?? []).map((event) => ({
      ...event,
      children: visit(event.id),
    }));

  return visit(undefined);
}

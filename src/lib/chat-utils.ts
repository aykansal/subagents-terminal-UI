import type { TranscriptActivityEvent } from "./chat-types";

export type OrderedTranscriptActivityEvent = TranscriptActivityEvent & {
  children: OrderedTranscriptActivityEvent[];
};

export type FlattenedActivityItem =
  | { type: "inline"; event: OrderedTranscriptActivityEvent }
  | { type: "branch"; event: OrderedTranscriptActivityEvent };

/**
 * Flattens the activity tree into a display sequence: text/reasoning as inline
 * (no collapsible branch), tool/result/error as collapsible branches. Steps are
 * transparent (children appear at the same level). Preserves LLM order.
 */
export function flattenActivitySequence(
  ordered: OrderedTranscriptActivityEvent[],
): FlattenedActivityItem[] {
  const out: FlattenedActivityItem[] = [];

  const visit = (events: OrderedTranscriptActivityEvent[]) => {
    for (const event of events) {
      // Steps are transparent containers – we don't render them directly.
      if (event.kind === "step") {
        visit(event.children);
        continue;
      }

      if (event.kind === "text" || event.kind === "reasoning") {
        out.push({ type: "inline", event });
        continue;
      }
      out.push({ type: "branch", event });
    }
  };

  visit(ordered);
  return out;
}

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
  return normalized.length <= 15
    ? normalized
    : `${normalized.slice(0, 15).trimEnd()}...`;
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
    return maxChars === Number.POSITIVE_INFINITY
      ? value
      : trimInline(value, maxChars);
  }

  try {
    const formatted = JSON.stringify(value, null, 2);
    return maxChars === Number.POSITIVE_INFINITY
      ? formatted
      : trimInline(formatted, maxChars);
  } catch {
    const fallback = String(value);
    return maxChars === Number.POSITIVE_INFINITY
      ? fallback
      : trimInline(fallback, maxChars);
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

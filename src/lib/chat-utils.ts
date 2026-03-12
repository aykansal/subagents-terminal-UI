import type { ChatMessage } from "./chat-types";

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

export function getMessageTextContent(msg: ChatMessage): string {
  return (msg.parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

export function deriveChatTitle(
  transcript: ChatMessage[],
  fallback = "New chat",
) {
  const firstUserMessage = transcript.find(
    (entry) =>
      entry.role === "user" &&
      getMessageTextContent(entry).trim().length > 0 &&
      !getMessageTextContent(entry).trim().startsWith("/"),
  );

  if (!firstUserMessage) {
    return fallback;
  }

  const normalized = getMessageTextContent(firstUserMessage)
    .replace(/\s+/g, " ")
    .trim();
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

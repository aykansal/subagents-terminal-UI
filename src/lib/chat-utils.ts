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

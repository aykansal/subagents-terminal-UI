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

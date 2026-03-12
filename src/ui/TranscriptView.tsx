import { TextAttributes } from "@opentui/core";
import { formatBlock, getMessageTextContent } from "../lib/chat-utils";
import type { ChatMessage, MessagePart } from "../lib/chat-types";
import { uiColors, uiCopy, uiSpacing } from "../lib/design-system";

type TranscriptViewProps = {
  busy: boolean;
  collapsedActivityNodes: Record<string, boolean>;
  divider: string;
  entries: ChatMessage[];
  expandedEntries: Record<string, boolean>;
  onToggleActivityNode: (id: string) => void;
  onToggleExpanded: (id: string) => void;
};

type TranscriptRowProps = {
  busy: boolean;
  collapsedActivityNodes: Record<string, boolean>;
  divider: string;
  entry: ChatMessage;
  expanded: boolean;
  isFirst: boolean;
  isLast: boolean;
  onToggleActivityNode: (id: string) => void;
  onToggleExpanded: (id: string) => void;
};

function getPartSummary(part: MessagePart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "reasoning":
      return part.reasoning;
    case "tool-invocation":
      return `${part.toolInvocation.toolName}${part.toolInvocation.state === "result" ? " (done)" : ""}`;
    case "data-usage":
      return typeof part.data === "object" && part.data !== null && "raw" in part.data
        ? String((part.data as { raw?: unknown }).raw ?? "")
        : "";
    case "data-oauth":
      return part.data.actionLabel ?? "";
    case "data-details":
      return part.data.length ? "trace" : "";
    case "data-webSearchSources":
    case "data-webSearchQueries":
    case "data-toolSources":
      return "";
    default:
      return "";
  }
}

function formatUnknown(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function renderTracePart(part: MessagePart, key: string) {
  switch (part.type) {
    case "text":
      if (!part.text.trim()) {
        return null;
      }
      return (
        <text key={key} fg={uiColors.text} attributes={TextAttributes.NONE}>
          {formatBlock(part.text, "=")}
        </text>
      );
    case "reasoning":
      if (!part.reasoning.trim()) {
        return null;
      }
      return (
        <text key={key} fg={uiColors.reasoning} attributes={TextAttributes.NONE}>
          {formatBlock(part.reasoning, "~")}
        </text>
      );
    case "tool-invocation": {
      const { toolInvocation } = part;
      const running = toolInvocation.state !== "result";
      return (
        <box key={key} style={{ flexDirection: "column" }}>
          <text fg={uiColors.tool} attributes={TextAttributes.NONE}>
            {formatBlock(
              `${running ? "+" : "•"} ${toolInvocation.toolName}${running ? "..." : ""}`,
              " ",
            )}
          </text>
          {toolInvocation.args !== undefined ? (
            <text fg={uiColors.muted} attributes={TextAttributes.NONE}>
              {formatBlock(formatUnknown(toolInvocation.args), "| args", "|     ")}
            </text>
          ) : null}
          {toolInvocation.result !== undefined ? (
            <text fg={uiColors.muted} attributes={TextAttributes.NONE}>
              {formatBlock(formatUnknown(toolInvocation.result), "| result", "|        ")}
            </text>
          ) : null}
        </box>
      );
    }
    case "data-usage": {
      const summary = getPartSummary(part);
      if (!summary) {
        return null;
      }
      return (
        <text key={key} fg={uiColors.subtle} attributes={TextAttributes.NONE}>
          {formatBlock(summary, "·")}
        </text>
      );
    }
    case "data-oauth":
      if (!part.data.actionLabel) {
        return null;
      }
      return (
        <box key={key} style={{ flexDirection: "column", marginTop: 0.5 }}>
          <text fg={uiColors.action}>
            {formatBlock(`[ ${part.data.actionLabel} ]`, "+")}
          </text>
          <text fg={uiColors.muted} attributes={TextAttributes.NONE}>
            {formatBlock(part.data.actionStatus ?? uiCopy.authCopyHint, "|")}
          </text>
        </box>
      );
    case "data-details":
      return (
        <box key={key} style={{ flexDirection: "column" }}>
          {part.data.map((line, detailIndex) => {
            const isToolLine = line.includes("Tool");
            return (
              <text
                key={`${key}-${detailIndex}`}
                fg={isToolLine ? uiColors.tool : uiColors.muted}
                attributes={TextAttributes.NONE}
              >
                {formatBlock(line, isToolLine ? "+" : "|")}
              </text>
            );
          })}
        </box>
      );
    case "data-webSearchSources":
    case "data-webSearchQueries":
    case "data-toolSources":
      return null;
    default:
      return null;
  }
}

function TranscriptRow({
  busy,
  divider,
  entry,
  expanded,
  isFirst,
  isLast,
  onToggleExpanded,
}: TranscriptRowProps) {
  const isUser = entry.role === "user";
  const parts = entry.parts ?? [];
  const textContent = getMessageTextContent(entry);
  const usagePart = parts.find(
    (p): p is { type: "data-usage"; data: unknown } => p.type === "data-usage",
  );

  const hasTraceParts = parts.some(
    (part) => part.type !== "text" || Boolean(textContent.trim()),
  );
  const hasExpandable = hasTraceParts || Boolean(usagePart);

  const marker = isUser ? ">" : "*";
  const accent = isUser ? uiColors.userText : uiColors.text;
  const summaryLine =
    isUser || !expanded
      ? textContent || (!isUser && busy ? "Streaming..." : "")
      : "";

  return (
    <box
      style={{
        flexDirection: "column",
        marginBottom: isLast ? 0 : 0.15,
        paddingTop: isFirst ? 0 : 0.15,
      }}
    >
      {!isFirst ? (
        <text fg={uiColors.divider} attributes={TextAttributes.DIM}>
          {divider}
        </text>
      ) : null}

      <box
        style={{
          flexDirection: "column",
          marginTop: isFirst ? 0 : 0.15,
        }}
      >
        {summaryLine ? (
          <text fg={accent}>
            {formatBlock(summaryLine, marker)}
          </text>
        ) : null}

        {hasExpandable ? (
          <box style={{ flexDirection: "column", marginTop: 0.5 }}>
            <text
              fg={uiColors.subtle}
              attributes={TextAttributes.NONE}
              onMouseDown={() => onToggleExpanded(entry.id)}
            >
              {usagePart
                ? `${expanded ? "[-]" : "[+]"} ${getPartSummary(usagePart)}`
                : `${expanded ? "[-]" : "[+]"} trace`}
            </text>

            {expanded ? (
              <box
                style={{
                  flexDirection: "column",
                  marginTop: 0.2,
                  paddingLeft: uiSpacing.inset,
                }}
              >
                {parts.map((part, index) =>
                  renderTracePart(part, `${entry.id}-part-${index}`),
                )}
              </box>
            ) : null}
          </box>
        ) : null}
      </box>
    </box>
  );
}

export function TranscriptView({
  busy,
  collapsedActivityNodes,
  divider,
  entries,
  expandedEntries,
  onToggleActivityNode,
  onToggleExpanded,
}: TranscriptViewProps) {
  return (
    <box
      style={{
        flexGrow: 1,
        flexDirection: "column",
        paddingTop: 0.15,
        paddingBottom: 0.15,
      }}
    >
      <scrollbox style={{ flexGrow: 1, paddingTop: 1, paddingBottom: 1 }}>
        {entries.map((entry, index) => (
          <TranscriptRow
            key={entry.id}
            busy={busy}
            collapsedActivityNodes={collapsedActivityNodes}
            divider={divider}
            entry={entry}
            expanded={Boolean(expandedEntries[entry.id])}
            isFirst={index === 0}
            isLast={index === entries.length - 1}
            onToggleActivityNode={onToggleActivityNode}
            onToggleExpanded={onToggleExpanded}
          />
        ))}
      </scrollbox>
    </box>
  );
}

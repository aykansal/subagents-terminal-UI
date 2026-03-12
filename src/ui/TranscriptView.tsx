import { TextAttributes } from "@opentui/core";
import {
  formatBlock,
  orderActivityTree,
  type OrderedTranscriptActivityEvent,
} from "../lib/chat-utils";
import {
  type TranscriptActivityEvent,
  type TranscriptEntry,
} from "../lib/chat-types";
import { uiColors, uiCopy, uiSpacing } from "../lib/design-system";

type TranscriptViewProps = {
  busy: boolean;
  divider: string;
  entries: TranscriptEntry[];
  expandedEntries: Record<string, boolean>;
  onToggleExpanded: (id: string) => void;
};

type TranscriptRowProps = {
  busy: boolean;
  divider: string;
  entry: TranscriptEntry;
  expanded: boolean;
  isFirst: boolean;
  isLast: boolean;
  onToggleExpanded: (id: string) => void;
};

type ActivityNodeProps = {
  event: OrderedTranscriptActivityEvent;
  isLast: boolean;
  trail: string;
};

function getActivityIcon(event: TranscriptActivityEvent) {
  switch (event.kind) {
    case "step":
      return ">";
    case "reasoning":
      return "~";
    case "text":
      return "=";
    case "tool":
      return event.state === "running" ? "+" : "•";
    case "result":
      return "↳";
    case "error":
      return "!";
    case "status":
    default:
      return "·";
  }
}

function getActivityColor(event: TranscriptActivityEvent) {
  if (event.state === "error" || event.kind === "error") {
    return uiColors.error;
  }

  switch (event.tone) {
    case "tool":
      return uiColors.tool;
    case "reasoning":
      return uiColors.reasoning;
    case "action":
      return uiColors.action;
    case "muted":
      return uiColors.muted;
    default:
      return uiColors.text;
  }
}

function renderActivityLine(prefix: string, value: string) {
  return value
    .split("\n")
    .map((line, index) => `${index === 0 ? prefix : " ".repeat(prefix.length)}${line}`)
    .join("\n");
}

function ActivityNode({ event, isLast, trail }: ActivityNodeProps) {
  const branch = `${trail}${isLast ? "└─" : "├─"}`;
  const childTrail = `${trail}${isLast ? "  " : "│ "}`;
  const suffix =
    event.state === "running" ? "..." : event.state === "error" ? " (failed)" : "";
  const label = `${getActivityIcon(event)} ${event.label}${suffix}`;
  const children = event.children;

  return (
    <box style={{ flexDirection: "column" }}>
      <text
        fg={getActivityColor(event)}
        attributes={
          event.kind === "reasoning" || event.tone === "muted"
            ? TextAttributes.DIM
            : TextAttributes.NONE
        }
      >
        {renderActivityLine(branch, label)}
      </text>

      {event.content ? (
        <text
          fg={getActivityColor(event)}
          attributes={
            event.kind === "reasoning" || event.kind === "text"
              ? TextAttributes.DIM
              : TextAttributes.NONE
          }
        >
          {formatBlock(event.content, `${childTrail}  `, `${childTrail}  `)}
        </text>
      ) : null}

      {children.map((child, index) => (
        <ActivityNode
          key={child.id}
          event={child}
          isLast={index === children.length - 1}
          trail={childTrail}
        />
      ))}
    </box>
  );
}

function ActivityTree({ events }: { events: TranscriptActivityEvent[] }) {
  const ordered = orderActivityTree(events);

  return (
    <box style={{ flexDirection: "column", marginTop: 0.2 }}>
      {ordered.map((event, index) => (
        <ActivityNode
          key={event.id}
          event={event}
          isLast={index === ordered.length - 1}
          trail=""
        />
      ))}
    </box>
  );
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
  const hasActivity = Boolean(entry.activity?.length);
  const hasDetails =
    hasActivity ||
    Boolean(entry.reasoning) ||
    Boolean(entry.tools?.length) ||
    Boolean(entry.usage) ||
    Boolean(entry.details?.length);
  const marker = isUser ? ">" : "*";
  const accent = isUser ? uiColors.userText : uiColors.text;
  const summaryLine = entry.content || (!isUser && busy ? "Streaming..." : "");
  const label = entry.title === "SYSTEM" ? "[system] " : "";

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
        <text fg={accent}>
          {formatBlock(`${label}${summaryLine || "..."}`, marker)}
        </text>

        {hasDetails ? (
          <box
            style={{ flexDirection: "column", marginTop: 0.5 }}
            onMouseDown={() => onToggleExpanded(entry.id)}
          >
            <text fg={uiColors.subtle} attributes={TextAttributes.DIM}>
              {entry.usage
                ? `${expanded ? "[-]" : "[+]"} ${entry.usage}`
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
                {entry.activity?.length ? (
                  <ActivityTree events={entry.activity} />
                ) : null}

                {!entry.activity?.length && entry.reasoning ? (
                  <text fg={uiColors.reasoning} attributes={TextAttributes.DIM}>
                    {formatBlock(entry.reasoning, "~")}
                  </text>
                ) : null}

                {!entry.activity?.length && entry.tools && entry.tools.length > 0 ? (
                  <text fg={uiColors.tool}>
                    {formatBlock(`tools ${entry.tools.join(", ")}`, "+")}
                  </text>
                ) : null}

                {entry.actionLabel ? (
                  <box style={{ flexDirection: "column", marginTop: 1 }}>
                    <text fg={uiColors.action}>
                      {formatBlock(`[ ${entry.actionLabel} ]`, "+")}
                    </text>
                    <text fg={uiColors.muted} attributes={TextAttributes.DIM}>
                      {formatBlock(
                        entry.actionStatus ?? uiCopy.authCopyHint,
                        "|",
                      )}
                    </text>
                  </box>
                ) : null}

                {!entry.activity?.length
                  ? entry.details?.map((line, detailIndex) => {
                      const isToolLine = line.includes("Tool");

                      return (
                        <text
                          key={`${entry.id}-detail-${detailIndex}`}
                          fg={isToolLine ? uiColors.tool : uiColors.muted}
                          attributes={
                            isToolLine ? TextAttributes.NONE : TextAttributes.DIM
                          }
                        >
                          {formatBlock(line, isToolLine ? "+" : "|")}
                        </text>
                      );
                    })
                  : null}
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
  divider,
  entries,
  expandedEntries,
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
            divider={divider}
            entry={entry}
            expanded={Boolean(expandedEntries[entry.id])}
            isFirst={index === 0}
            isLast={index === entries.length - 1}
            onToggleExpanded={onToggleExpanded}
          />
        ))}
      </scrollbox>
    </box>
  );
}

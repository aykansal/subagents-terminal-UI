import { TextAttributes } from "@opentui/core";
import {
  flattenActivitySequence,
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
  collapsedActivityNodes: Record<string, boolean>;
  divider: string;
  entries: TranscriptEntry[];
  expandedEntries: Record<string, boolean>;
  onToggleActivityNode: (id: string) => void;
  onToggleExpanded: (id: string) => void;
};

type TranscriptRowProps = {
  busy: boolean;
  collapsedActivityNodes: Record<string, boolean>;
  divider: string;
  entry: TranscriptEntry;
  expanded: boolean;
  isFirst: boolean;
  isLast: boolean;
  onToggleActivityNode: (id: string) => void;
  onToggleExpanded: (id: string) => void;
};

type ActivityNodeProps = {
  collapsedActivityNodes: Record<string, boolean>;
  event: OrderedTranscriptActivityEvent;
  isLast: boolean;
  onToggleActivityNode: (id: string) => void;
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
    .map((line, index) =>
      `${index === 0 ? prefix : " ".repeat(prefix.length)}${line}`,
    )
    .join("\n");
}

function ActivityNode({
  collapsedActivityNodes,
  event,
  isLast,
  onToggleActivityNode,
  trail,
}: ActivityNodeProps) {
  const branch = `${trail}${isLast ? "└─" : "├─"}`;
  const childTrail = `${trail}${isLast ? "  " : "│ "}`;
  const isCollapsible = Boolean(event.content || event.children.length);
  const collapsed = Boolean(collapsedActivityNodes[event.id]);
  const toggleLabel = isCollapsible ? (collapsed ? "[+]" : "[-]") : "   ";
  const suffix =
    event.state === "running" ? "..." : event.state === "error" ? " (failed)" : "";
  const label = `${toggleLabel} ${getActivityIcon(event)} ${event.label}${suffix}`;

  return (
    <box style={{ flexDirection: "column" }}>
      <text
        fg={getActivityColor(event)}
        attributes={TextAttributes.NONE}
        onMouseDown={() => {
          if (isCollapsible) {
            onToggleActivityNode(event.id);
          }
        }}
      >
        {renderActivityLine(branch, label)}
      </text>

      {event.content && !collapsed ? (
        <text fg={getActivityColor(event)} attributes={TextAttributes.NONE}>
          {formatBlock(event.content, `${childTrail}  `, `${childTrail}  `)}
        </text>
      ) : null}

      {!collapsed ? (
        <ActivitySequence
          collapsedActivityNodes={collapsedActivityNodes}
          events={event.children}
          onToggleActivityNode={onToggleActivityNode}
          trail={childTrail}
        />
      ) : null}
    </box>
  );
}

function ActivitySequence({
  collapsedActivityNodes,
  events,
  onToggleActivityNode,
  trail,
}: {
  collapsedActivityNodes: Record<string, boolean>;
  events: OrderedTranscriptActivityEvent[];
  onToggleActivityNode: (id: string) => void;
  trail: string;
}) {
  const sequence = flattenActivitySequence(events);
  return (
    <box style={{ flexDirection: "column" }}>
      {sequence.map((item, index) => {
        if (item.type === "inline") {
          const { event } = item;
          if (!event.content?.trim()) return null;
          const prefix = event.kind === "reasoning" ? "~" : "=";
          const linePrefix = trail ? `${trail}  ` : "";
          return (
            <text
              key={event.id}
              fg={uiColors.text}
              attributes={TextAttributes.NONE}
            >
              {formatBlock(event.content, linePrefix + prefix, linePrefix)}
            </text>
          );
        }
        return (
          <ActivityNode
            key={item.event.id}
            collapsedActivityNodes={collapsedActivityNodes}
            event={item.event}
            isLast={index === sequence.length - 1}
            onToggleActivityNode={onToggleActivityNode}
            trail={trail}
          />
        );
      })}
    </box>
  );
}

function ActivityTree({
  collapsedActivityNodes,
  events,
  onToggleActivityNode,
}: {
  collapsedActivityNodes: Record<string, boolean>;
  events: TranscriptActivityEvent[];
  onToggleActivityNode: (id: string) => void;
}) {
  const ordered = orderActivityTree(events);
  return (
    <box style={{ flexDirection: "column", marginTop: 0.2 }}>
      <ActivitySequence
        collapsedActivityNodes={collapsedActivityNodes}
        events={ordered}
        onToggleActivityNode={onToggleActivityNode}
        trail=""
      />
    </box>
  );
}

function TranscriptRow({
  busy,
  collapsedActivityNodes,
  divider,
  entry,
  expanded,
  isFirst,
  isLast,
  onToggleActivityNode,
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
  const summaryLine =
    isUser || !hasActivity
      ? entry.content || (!isUser && busy ? "Streaming..." : "")
      : "";
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
        {summaryLine ? (
          <text fg={accent}>
            {formatBlock(`${label}${summaryLine}`, marker)}
          </text>
        ) : null}

        {hasActivity ? (
          <box style={{ flexDirection: "column", marginTop: 0.2 }}>
            <ActivityTree
              collapsedActivityNodes={collapsedActivityNodes}
              events={entry.activity!}
              onToggleActivityNode={onToggleActivityNode}
            />
          </box>
        ) : hasDetails ? (
          <box style={{ flexDirection: "column", marginTop: 0.5 }}>
            <text
              fg={uiColors.subtle}
              attributes={TextAttributes.NONE}
              onMouseDown={() => onToggleExpanded(entry.id)}
            >
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
                {entry.reasoning ? (
                  <text fg={uiColors.reasoning} attributes={TextAttributes.NONE}>
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
                    <text fg={uiColors.muted} attributes={TextAttributes.NONE}>
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
                          attributes={TextAttributes.NONE}
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

import { TextAttributes } from "@opentui/core";
import { TranscriptEntry } from "./chat-types";
import { formatBlock } from "./chat-utils";
import { uiColors, uiCopy, uiSpacing } from "./design-system";

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
  const hasDetails =
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
        marginBottom: isLast ? 0 : 1,
        paddingTop: isFirst ? 0 : 1,
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
          marginTop: isFirst ? 0 : 1,
        }}
      >
        <text fg={accent}>
          {formatBlock(`${label}${summaryLine || "..."}`, marker)}
        </text>

        {hasDetails ? (
          <box
            style={{ flexDirection: "column", marginTop: 1 }}
            onMouseDown={() => onToggleExpanded(entry.id)}
          >
            <text fg={uiColors.subtle} attributes={TextAttributes.DIM}>
              {entry.usage
                ? `${expanded ? "[-]" : "[+]"} ${entry.usage}`
                : `${expanded ? "[-]" : "[+]"} details`}
            </text>

            {expanded ? (
              <box
                style={{
                  flexDirection: "column",
                  marginTop: 1,
                  paddingLeft: uiSpacing.inset,
                }}
              >
                {entry.reasoning ? (
                  <text fg={uiColors.reasoning} attributes={TextAttributes.DIM}>
                    {formatBlock(entry.reasoning, "~")}
                  </text>
                ) : null}

                {entry.tools && entry.tools.length > 0 ? (
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
                        "|"
                      )}
                    </text>
                  </box>
                ) : null}

                {entry.details?.map((line, detailIndex) => {
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
                })}
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
        paddingTop: 1,
        paddingBottom: 1,
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

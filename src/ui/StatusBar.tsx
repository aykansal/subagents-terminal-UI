import { TextAttributes } from "@opentui/core";
import { uiColors, uiCopy, uiLayout } from "../lib/design-system";

type StatusBarProps = {
  activeChatLabel: string;
  busy: boolean;
  chatCount: number;
  dbPath: string;
  googleConnected: boolean;
};

export function StatusBar({
  activeChatLabel,
  busy,
  chatCount,
  dbPath,
  googleConnected,
}: StatusBarProps) {
  return (
    <box
      style={{
        height: uiLayout.statusHeight,
        flexDirection: "column",
        justifyContent: "center",
      }}
    >
      <text fg={uiColors.subtle} attributes={TextAttributes.DIM}>
        Mode:{busy ? "running" : "idle"} • {uiCopy.statusCommands}
      </text>
      <box
        style={{
          flexDirection: "row",
          gap: 1,
        }}
      >
        <text
          fg={googleConnected ? uiColors.tool : uiColors.subtle}
          attributes={TextAttributes.BOLD}
        >
          ● 
        </text>
        <text fg={uiColors.subtle} attributes={TextAttributes.DIM}>
          Google • Chats: {chatCount} • Active: {activeChatLabel} • DB: {dbPath}
        </text>
      </box>
    </box>
  );
}

import { TextAttributes } from "@opentui/core";
import { uiColors, uiCopy, uiLayout } from "./design-system";

type StatusBarProps = {
  busy: boolean;
  authSummary: string;
  googleConnected: boolean;
};

export function StatusBar({
  busy,
  authSummary,
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
          {authSummary}
        </text>
      </box>
    </box>
  );
}

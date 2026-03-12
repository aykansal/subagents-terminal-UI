import { TextAttributes } from "@opentui/core";
import { uiColors, uiCopy, uiLayout } from "../lib/design-system";

type StatusBarProps = {
  busy: boolean;
  dbPath: string;
  googleConnected: boolean;
};

export function StatusBar({
  busy,
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
          Google • DB: {dbPath}
        </text>
      </box>
    </box>
  );
}

import { TextAttributes } from "@opentui/core";
import { uiColors, uiCopy, uiLayout } from "./design-system";

type StatusBarProps = {
  busy: boolean;
};

export function StatusBar({ busy }: StatusBarProps) {
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
    </box>
  );
}

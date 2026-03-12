import { TextAttributes } from "@opentui/core";
import { uiColors, uiCopy, uiLayout, uiSpacing } from "./design-system";

type AppHeaderProps = {
  authSummary: string;
  divider: string;
};

export function AppHeader({ authSummary, divider }: AppHeaderProps) {
  return (
    <box
      style={{
        height: uiLayout.headerHeight,
        flexDirection: "column",
        justifyContent: "center",
        paddingTop: uiSpacing.base,
      }}
    >
      <text fg={uiColors.title}>
        <strong>{uiCopy.appTitle}</strong>
      </text>
      <text fg={uiColors.muted} attributes={TextAttributes.DIM}>
        {authSummary}
      </text>
      <text fg={uiColors.divider} attributes={TextAttributes.DIM}>
        {divider}
      </text>
    </box>
  );
}

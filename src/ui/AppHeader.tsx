import { TextAttributes } from "@opentui/core";
import { uiColors, uiCopy, uiLayout, uiSpacing } from "../lib/design-system";

type AppHeaderProps = {
  divider: string;
};

export function AppHeader({ divider }: AppHeaderProps) {
  return (
    <box
      style={{
        height: uiLayout.headerHeight,
        flexDirection: "column",
        justifyContent: "space-between",
        paddingTop: uiSpacing.base,
      }}
    >
      <ascii-font font="tiny" color={uiColors.primary} text={uiCopy.appTitle} />
      <text fg={uiColors.divider} attributes={TextAttributes.DIM}>
        {divider}
      </text>
    </box>
  );
}

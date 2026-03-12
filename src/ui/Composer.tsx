import type { InputRenderable } from "@opentui/core";
import { TextAttributes } from "@opentui/core";
import type { RefObject } from "react";
import { uiColors, uiCopy, uiLayout, uiSpacing } from "../lib/design-system";

type ComposerProps = {
  busy: boolean;
  composerKey: number;
  divider: string;
  draft: string;
  inputRef: RefObject<InputRenderable | null>;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
};

export function Composer({
  busy,
  composerKey,
  divider,
  draft,
  inputRef,
  onChange,
  onSubmit,
}: ComposerProps) {
  return (
    <box
      style={{
        height: uiLayout.composerHeight,
        flexDirection: "column",
        justifyContent: "center",
        paddingTop: uiSpacing.base,
      }}
    >
      <text fg={uiColors.divider} attributes={TextAttributes.DIM}>
        {divider}
      </text>
      <box style={{ flexDirection: "row", alignItems: "center" }}>
        <text fg={uiColors.title}>{">"}</text>
        <box style={{ flexGrow: 1, paddingLeft: uiSpacing.base }}>
          <input
            ref={inputRef}
            key={composerKey}
            placeholder={
              busy ? uiCopy.composerPlaceholderBusy : uiCopy.composerPlaceholderIdle
            }
            placeholderColor={uiColors.subtle}
            value={draft}
            focused={!busy}
            onChange={onChange}
            onSubmit={(value) => {
              if (typeof value === "string") {
                onSubmit(value);
              }
            }}
          />
        </box>
      </box>
    </box>
  );
}

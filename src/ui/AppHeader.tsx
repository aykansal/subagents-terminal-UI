import { TextAttributes } from "@opentui/core";
import type { ChatSessionSummary } from "../lib/chat-types";
import { uiColors, uiCopy, uiLayout, uiSpacing } from "../lib/design-system";

type AppHeaderProps = {
  activeChatId: string | null;
  chats: ChatSessionSummary[];
  divider: string;
  onCreateChat: () => void;
  onSelectChat: (chatId: string) => void;
};

export function AppHeader({
  activeChatId,
  chats,
  divider,
  onCreateChat,
  onSelectChat,
}: AppHeaderProps) {
  const visibleChats = chats.slice(0, 6);

  return (
    <box
      style={{
        height: uiLayout.headerHeight,
        flexDirection: "column",
        justifyContent: "space-between",
        paddingTop: uiSpacing.base,
      }}
    >
      <box
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <ascii-font font="tiny" color={uiColors.primary} text={uiCopy.appTitle} />
        <box onMouseDown={onCreateChat}>
          <text fg={uiColors.action} attributes={TextAttributes.BOLD}>
            [ + New Chat ]
          </text>
        </box>
      </box>
      <box style={{ flexDirection: "row", gap: 1 }}>
        {visibleChats.map((chat) => {
          const active = chat.id === activeChatId;

          return (
            <box key={chat.id} onMouseDown={() => onSelectChat(chat.id)}>
              <text
                fg={active ? uiColors.primary : uiColors.subtle}
                attributes={active ? TextAttributes.BOLD : TextAttributes.DIM}
              >
                {active ? "[ " : "("}
                {chat.title}
                {active ? " ]" : ")"}
              </text>
            </box>
          );
        })}
      </box>
      <text fg={uiColors.divider} attributes={TextAttributes.DIM}>
        {divider}
      </text>
    </box>
  );
}

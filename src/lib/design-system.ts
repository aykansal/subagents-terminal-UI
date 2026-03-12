export const uiColors = {
  divider: "#3f3f46",
  title: "#f5f5f5",
  text: "#D9D4C9",
  userText: "#f4f4f5",
  muted: "#a1a1aa",
  subtle: "#71717a",
  tool: "#34d399",
  action: "#60a5fa",
  reasoning: "#a78bfa",
  error: "#f87171",
  primary:"#C96442"
} as const;

export const uiSpacing = {
  base: 1,
  inset: 2,
} as const;

export const uiLayout = {
  headerHeight: 7,
  composerHeight: 4,
  statusHeight: 4,
} as const;

export const uiCopy = {
  appTitle: "June Subagents",
  composerPlaceholderIdle: "Enter prompt here",
  composerPlaceholderBusy: "Agent is running...",
  authCopyHint:
    "Press Ctrl+Y to copy this, then paste it into your browser with the Google account you want to connect.",
  statusCommands:
    "Enter:Send • Ctrl+C:Abort • Ctrl+N:/new • /auth • /tools • /reset-auth • /quit",
} as const;

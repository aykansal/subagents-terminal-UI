export const uiColors = {
  divider: "#3f3f46",
  title: "#f5f5f5",
  text: "#e5e7eb",
  userText: "#f4f4f5",
  muted: "#a1a1aa",
  subtle: "#71717a",
  tool: "#34d399",
  action: "#60a5fa",
  reasoning: "#a78bfa",
} as const;

export const uiSpacing = {
  base: 1,
  inset: 2,
} as const;

export const uiLayout = {
  headerHeight: 3,
  composerHeight: 4,
  statusHeight: 4,
} as const;

export const uiCopy = {
  appTitle: "subagents",
  composerPlaceholderIdle: "Enter prompt here",
  composerPlaceholderBusy: "Agent is running...",
  authCopyHint:
    "Press Ctrl+Y to copy this, then paste it into your browser with the Google account you want to connect.",
  statusCommands:
    "Enter:Send • Ctrl+C:Abort • /auth • /tools • /reset-auth • /quit",
} as const;

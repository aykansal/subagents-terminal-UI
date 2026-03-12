# Subagents CLI Playground

Small OpenTUI demo for testing AI SDK subagents with OpenRouter, local direct tools, and an optional Google Workspace MCP connection.

It reuses Junebot's environment values by loading `../junebot/.env.local`, stores OAuth tokens, local tasks, and saved chat transcripts in [`db.txt`](/mnt/c/Users/ayver/Documents/VS%20CODE%20Data/june_all/subagents/db.txt), and keeps a token history instead of only the latest token.

The TUI now persists chat sessions across launches. You can start a fresh conversation with the header button, `Ctrl+N`, or `/new`, and switch between recent chats from the tabs in the header.

Available direct tools:

- `getCurrentTime`
- `getWeather`
- `createTask`
- `listTasks`
- `updateTask`
- `deleteTask`

The main agent can use those tools directly, and it now has two non-MCP specialist subagents:

- `delegateTaskManager`
- `delegateDailyBrief`

Run it with:

```bash
bun run src/index.tsx
```

Useful commands inside the app:

```text
/auth
/new
/tools
/reset-auth
/quit
```

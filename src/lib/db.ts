import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { env } from "../env";
import type { ChatSessionRecord, ChatSessionSummary, TranscriptEntry } from "./chat-types";

export type OAuthTokens = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  [key: string]: unknown;
};

export type OAuthProtectedResourceMetadata = {
  resource: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
  introspection_endpoint?: string;
  introspection_endpoint_auth_methods_supported?: string[];
  [key: string]: unknown;
};

export type OAuthMetadata = {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  client_id?: string;
  client_secret?: string;
  scopes_supported?: string[];
  resource?: string;
  resource_metadata?: OAuthProtectedResourceMetadata | null;
  [key: string]: unknown;
};

export type ConnectorRecord = {
  connectorId: string;
  serverUrl: string;
  metadata: OAuthMetadata;
  tokens: OAuthTokens;
  tokenHistory: Array<{
    access_token: string;
    refresh_token?: string;
    expires_at?: number;
    receivedAt: string;
  }>;
  updatedAt: string;
};

export type LocalTaskStatus = "todo" | "in_progress" | "done" | "backlog";
export type LocalTaskPriority = "low" | "medium" | "high" | "urgent";

export type LocalTaskRecord = {
  id: string;
  title: string;
  description: string | null;
  status: LocalTaskStatus;
  priority: LocalTaskPriority;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
};

type DbShape = {
  activeChatId: string | null;
  chats: ChatSessionRecord[];
  connectors: Record<string, ConnectorRecord>;
  tasks: LocalTaskRecord[];
};

const DB_PATH = resolve(env.subagentsRoot, "db.txt");

const DEFAULT_DB: DbShape = {
  activeChatId: null,
  chats: [],
  connectors: {},
  tasks: [],
};

let dbWriteQueue: Promise<unknown> = Promise.resolve();

export async function readDb(): Promise<DbShape> {
  try {
    const raw = await readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<DbShape>;
    return {
      activeChatId: parsed.activeChatId ?? null,
      chats: parsed.chats ?? [],
      connectors: parsed.connectors ?? {},
      tasks: parsed.tasks ?? [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return DEFAULT_DB;
    }
    throw error;
  }
}

export async function writeDb(db: DbShape): Promise<void> {
  await mkdir(dirname(DB_PATH), { recursive: true });
  await writeFile(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

async function mutateDb<T>(
  mutator: (db: DbShape) => Promise<T> | T,
): Promise<T> {
  let result!: T;

  dbWriteQueue = dbWriteQueue.catch(() => undefined).then(async () => {
    const db = await readDb();
    result = await mutator(db);
    await writeDb(db);
  });

  await dbWriteQueue;
  return result;
}

function sortChats(chats: ChatSessionRecord[]): ChatSessionRecord[] {
  return [...chats].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

function toChatSummary(chat: ChatSessionRecord): ChatSessionSummary {
  return {
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    messageCount: chat.transcript.length,
  };
}

export async function listChatSessions(): Promise<ChatSessionSummary[]> {
  const db = await readDb();
  return sortChats(db.chats).map(toChatSummary);
}

export async function getChatSession(chatId: string): Promise<ChatSessionRecord | null> {
  const db = await readDb();
  return db.chats.find((chat) => chat.id === chatId) ?? null;
}

export async function createChatSession(
  input: Pick<ChatSessionRecord, "id" | "title"> & {
    transcript?: TranscriptEntry[];
    makeActive?: boolean;
  },
): Promise<ChatSessionRecord> {
  return mutateDb((db) => {
    const now = new Date().toISOString();
    const chat: ChatSessionRecord = {
      id: input.id,
      title: input.title,
      createdAt: now,
      updatedAt: now,
      transcript: input.transcript ?? [],
      messageCount: (input.transcript ?? []).length,
    };

    db.chats = sortChats([
      chat,
      ...db.chats.filter((entry) => entry.id !== chat.id),
    ]);
    if (input.makeActive ?? true) {
      db.activeChatId = chat.id;
    }
    return chat;
  });
}

export async function saveChatSession(
  input: Pick<ChatSessionRecord, "id" | "title"> & { transcript: TranscriptEntry[] },
): Promise<ChatSessionRecord> {
  return mutateDb((db) => {
    const now = new Date().toISOString();
    const existing = db.chats.find((chat) => chat.id === input.id);
    const chat: ChatSessionRecord = {
      id: input.id,
      title: input.title,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      transcript: input.transcript,
      messageCount: input.transcript.length,
    };

    db.chats = sortChats([
      chat,
      ...db.chats.filter((entry) => entry.id !== input.id),
    ]);
    return chat;
  });
}

export async function setActiveChatSession(chatId: string | null): Promise<void> {
  await mutateDb((db) => {
    db.activeChatId = chatId;
  });
}

export async function getActiveChatSessionId(): Promise<string | null> {
  const db = await readDb();
  return db.activeChatId;
}

export async function getConnectorRecord(
  connectorId: string
): Promise<ConnectorRecord | null> {
  const db = await readDb();
  const record = db.connectors[connectorId];
  if (!record) {
    return null;
  }

  return {
    ...record,
    tokenHistory: record.tokenHistory ?? [],
  };
}

export async function saveConnectorRecord(record: ConnectorRecord): Promise<void> {
  await mutateDb((db) => {
    const existing = db.connectors[record.connectorId];
    const tokenHistory = [...(existing?.tokenHistory ?? [])];
    const alreadyStored = tokenHistory.some(
      (entry) => entry.access_token === record.tokens.access_token
    );

    if (!alreadyStored) {
      tokenHistory.push({
        access_token: record.tokens.access_token,
        refresh_token: record.tokens.refresh_token,
        expires_at: record.tokens.expires_at,
        receivedAt: new Date().toISOString(),
      });
    }

    db.connectors[record.connectorId] = {
      ...record,
      tokenHistory,
    };
  });
}

export async function deleteConnectorRecord(connectorId: string): Promise<void> {
  await mutateDb((db) => {
    delete db.connectors[connectorId];
  });
}

export async function listTasks(): Promise<LocalTaskRecord[]> {
  const db = await readDb();
  return [...db.tasks].sort((left, right) => {
    if (left.status !== right.status) {
      return left.status.localeCompare(right.status);
    }

    return left.createdAt.localeCompare(right.createdAt);
  });
}

export async function createTask(
  input: Omit<LocalTaskRecord, "id" | "createdAt" | "updatedAt">,
): Promise<LocalTaskRecord> {
  return mutateDb((db) => {
    const now = new Date().toISOString();
    const task: LocalTaskRecord = {
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      ...input,
    };

    db.tasks.push(task);
    return task;
  });
}

export async function updateTask(
  taskId: string,
  updates: Partial<
    Pick<LocalTaskRecord, "title" | "description" | "status" | "priority" | "dueDate">
  >,
): Promise<LocalTaskRecord | null> {
  return mutateDb((db) => {
    const index = db.tasks.findIndex((task) => task.id === taskId);
    if (index === -1) {
      return null;
    }

    const current = db.tasks[index];
    if (!current) {
      return null;
    }

    const nextTask: LocalTaskRecord = {
      ...current,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    db.tasks[index] = nextTask;
    return nextTask;
  });
}

export async function deleteTask(taskId: string): Promise<boolean> {
  return mutateDb((db) => {
    const nextTasks = db.tasks.filter((task) => task.id !== taskId);
    if (nextTasks.length === db.tasks.length) {
      return false;
    }

    db.tasks = nextTasks;
    return true;
  });
}

export function getDbPath(): string {
  return DB_PATH;
}

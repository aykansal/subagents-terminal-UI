import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { env } from "../env";

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

type DbShape = {
  connectors: Record<string, ConnectorRecord>;
};

const DB_PATH = resolve(env.subagentsRoot, "db.txt");

const DEFAULT_DB: DbShape = {
  connectors: {},
};

export async function readDb(): Promise<DbShape> {
  try {
    const raw = await readFile(DB_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<DbShape>;
    return {
      connectors: parsed.connectors ?? {},
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
  const db = await readDb();
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
  await writeDb(db);
}

export async function deleteConnectorRecord(connectorId: string): Promise<void> {
  const db = await readDb();
  delete db.connectors[connectorId];
  await writeDb(db);
}

export function getDbPath(): string {
  return DB_PATH;
}

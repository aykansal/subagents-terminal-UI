import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ConnectorRecord, OAuthMetadata, OAuthTokens } from "./db";
import { getConnectorRecord, saveConnectorRecord } from "./db";
import { env } from "../env";

const CLIENT_ID = "mcp-chat-ui-client";
const METADATA_FETCH_TIMEOUT_MS = 12_000;
const MAX_METADATA_REDIRECTS = 3;
const MAX_FETCH_RETRIES = 3;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const CONNECTOR_ID = "google-workspace";

function base64Url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createPkce() {
  const verifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(
    createHash("sha256").update(verifier).digest()
  );

  return {
    verifier,
    codeChallenge,
  };
}

function getEffectiveClientId(metadata: OAuthMetadata): string {
  return typeof metadata.client_id === "string" && metadata.client_id.length > 0
    ? metadata.client_id
    : CLIENT_ID;
}

function shouldSendClientSecret(metadata: OAuthMetadata): boolean {
  if (
    typeof metadata.client_secret === "string" &&
    metadata.client_secret.length > 0
  ) {
    return true;
  }

  const methods = metadata.token_endpoint_auth_methods_supported as
    | string[]
    | undefined;

  return (
    Array.isArray(methods) &&
    (methods.includes("client_secret_post") ||
      methods.includes("client_secret_basic"))
  );
}

function parseAuthenticateParams(headerValue: string): Record<string, string> {
  const params: Record<string, string> = {};

  for (const match of headerValue.matchAll(
    /([a-zA-Z_][a-zA-Z0-9_-]*)="([^"]*)"/g
  )) {
    const [, key, value] = match;
    if (key && value) {
      params[key] = value;
    }
  }

  return params;
}

function resolveUrl(value: string, baseUrl: string): string | null {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

async function fetchWithTimeout(
  url: string,
  init?: RequestInit
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      METADATA_FETCH_TIMEOUT_MS
    );

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (error) {
      lastError = error;
      if (attempt === MAX_FETCH_RETRIES) {
        break;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

async function fetchWithRedirectHandling(
  url: string,
  init?: RequestInit
): Promise<Response | null> {
  let currentUrl = url;

  for (let attempt = 0; attempt <= MAX_METADATA_REDIRECTS; attempt++) {
    const response = await fetchWithTimeout(currentUrl, init);
    const isRedirect = response.status >= 300 && response.status < 400;

    if (!isRedirect) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      return response;
    }

    const nextUrl = resolveUrl(location, currentUrl);
    if (!nextUrl || nextUrl === currentUrl) {
      return null;
    }

    currentUrl = nextUrl;
  }

  return null;
}

async function discoverProtectedResourceMetadata(serverUrl: string) {
  const initializeResponse = await fetchWithRedirectHandling(serverUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        clientInfo: {
          name: "subagents-cli",
          version: "0.1.0",
        },
      },
    }),
  });

  const authenticate = initializeResponse?.headers.get("www-authenticate");
  const metadataUrl = authenticate
    ? resolveUrl(
        parseAuthenticateParams(authenticate).resource_metadata ||
          parseAuthenticateParams(authenticate).realm ||
          "",
        serverUrl
      )
    : null;

  if (metadataUrl) {
    const response = await fetchWithRedirectHandling(metadataUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (response?.ok) {
      return (await response.json()) as OAuthMetadata["resource_metadata"];
    }
  }

  const baseUrl = new URL(serverUrl);
  const scopedPath = `/.well-known/oauth-protected-resource${baseUrl.pathname}`.replace(
    /\/{2,}/g,
    "/"
  );

  for (const candidate of [
    `${baseUrl.origin}/.well-known/oauth-protected-resource`,
    `${baseUrl.origin}${scopedPath}`,
  ]) {
    const response = await fetchWithRedirectHandling(candidate, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (response?.ok) {
      return (await response.json()) as OAuthMetadata["resource_metadata"];
    }
  }

  return null;
}

async function discoverAuthorizationServerMetadata(
  authServerUrl: string
): Promise<OAuthMetadata | null> {
  const authUrl = new URL(authServerUrl);

  for (const pathname of [
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
  ]) {
    authUrl.pathname = pathname;

    const response = await fetchWithRedirectHandling(authUrl.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (response?.ok) {
      return (await response.json()) as OAuthMetadata;
    }
  }

  return null;
}

export async function getOAuthMetadata(
  serverUrl: string
): Promise<OAuthMetadata | null> {
  const protectedResourceMetadata =
    await discoverProtectedResourceMetadata(serverUrl);
  const authServer = protectedResourceMetadata?.authorization_servers?.[0];

  if (authServer) {
    const metadata = await discoverAuthorizationServerMetadata(authServer);
    if (metadata) {
      return {
        ...metadata,
        resource: protectedResourceMetadata?.resource,
        resource_metadata: protectedResourceMetadata,
      };
    }
  }

  const fallback = await discoverAuthorizationServerMetadata(serverUrl);
  if (!fallback) {
    return null;
  }

  return {
    ...fallback,
    resource: protectedResourceMetadata?.resource,
    resource_metadata: protectedResourceMetadata ?? null,
  };
}

export function getScopeFromMetadata(metadata: OAuthMetadata): string {
  const resourceScopes = metadata.resource_metadata?.scopes_supported;
  const authScopes = metadata.scopes_supported;
  const scopeSource = Array.isArray(resourceScopes) && resourceScopes.length > 0
    ? resourceScopes
    : Array.isArray(authScopes) && authScopes.length > 0
      ? authScopes
      : ["openid"];

  return Array.from(
    new Set(scopeSource.filter((scope): scope is string => Boolean(scope)))
  ).join(" ");
}

async function registerClientIfNeeded(
  metadata: OAuthMetadata,
  redirectUri: string,
  log: (message: string) => void
): Promise<OAuthMetadata> {
  if (
    metadata.client_id ||
    !metadata.registration_endpoint ||
    process.env.SUBAGENTS_SKIP_DCR === "true"
  ) {
    return metadata;
  }

  log("Registering a temporary OAuth client with the Google MCP auth server...");

  const response = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_name: "Junebot Subagents CLI",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: getScopeFromMetadata(metadata),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Client registration failed: ${errorText}`);
  }

  const registration = (await response.json()) as {
    client_id: string;
    client_secret?: string;
  };

  return {
    ...metadata,
    client_id: registration.client_id,
    client_secret: registration.client_secret,
  };
}

function buildAuthorizationUrl(metadata: OAuthMetadata, redirectUri: string) {
  const pkce = createPkce();
  const state = base64Url(randomBytes(18));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: getEffectiveClientId(metadata),
    redirect_uri: redirectUri,
    scope: getScopeFromMetadata(metadata),
    state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
  });

  if (metadata.resource) {
    params.set("resource", metadata.resource);
  }

  return {
    url: `${metadata.authorization_endpoint}?${params.toString()}`,
    state,
    verifier: pkce.verifier,
  };
}

function startAuthorizationCallbackListener(
  redirectUri: string,
  expectedState: string,
  log: (message: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const callbackUrl = new URL(redirectUri);
  const bindHostname =
    callbackUrl.hostname === "127.0.0.1" || callbackUrl.hostname === "localhost"
      ? "0.0.0.0"
      : callbackUrl.hostname;
  const timeoutMs = 5 * 60 * 1000;

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      server.stop(true);
    };

    const finishReject = (error: Error) => {
      if (settled) {
        return;
      }
      cleanup();
      reject(error);
    };

    const finishResolve = (code: string) => {
      if (settled) {
        return;
      }
      cleanup();
      resolve(code);
    };

    const onAbort = () => {
      finishReject(new DOMException("OAuth cancelled.", "AbortError"));
    };

    const timer = setTimeout(() => {
      finishReject(new Error("OAuth timed out after 5 minutes."));
    }, timeoutMs);

    const server = Bun.serve({
      hostname: bindHostname,
      port: Number(callbackUrl.port || 80),
      fetch(request) {
        const url = new URL(request.url);

        if (url.pathname !== callbackUrl.pathname) {
          return new Response("Not found", { status: 404 });
        }

        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          finishReject(new Error(`OAuth failed: ${error}`));
          return new Response("Authentication failed. Return to the terminal.");
        }

        if (!code || state !== expectedState) {
          finishReject(new Error("OAuth callback was missing code or state."));
          return new Response("Invalid callback. Return to the terminal.");
        }

        finishResolve(code);

        return new Response(
          "Authentication complete. You can close this tab and return to the terminal.",
          {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
            },
          }
        );
      },
    });

    signal?.addEventListener("abort", onAbort, { once: true });
    log(
      `Waiting for OAuth callback on ${redirectUri} (listener bound to ${bindHostname}:${callbackUrl.port || "80"})`
    );
  });
}

async function exchangeCodeForTokens(
  code: string,
  verifier: string,
  metadata: OAuthMetadata,
  redirectUri: string
): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: getEffectiveClientId(metadata),
    code_verifier: verifier,
  });

  if (metadata.resource) {
    params.set("resource", metadata.resource);
  }

  if (shouldSendClientSecret(metadata) && metadata.client_secret) {
    params.set("client_secret", metadata.client_secret);
  }

  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${errorText}`);
  }

  const tokens = (await response.json()) as OAuthTokens;

  if (typeof tokens.expires_in === "number") {
    tokens.expires_at = Date.now() + tokens.expires_in * 1000;
  }

  return tokens;
}

export async function refreshAccessToken(
  metadata: OAuthMetadata,
  tokens: OAuthTokens
): Promise<OAuthTokens> {
  if (!tokens.refresh_token) {
    return tokens;
  }

  if (!tokens.expires_at || tokens.expires_at > Date.now() + 60_000) {
    return tokens;
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: getEffectiveClientId(metadata),
  });

  if (shouldSendClientSecret(metadata) && metadata.client_secret) {
    params.set("client_secret", metadata.client_secret);
  }

  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed: ${errorText}`);
  }

  const nextTokens = {
    ...tokens,
    ...(await response.json()),
  } as OAuthTokens;

  if (typeof nextTokens.expires_in === "number") {
    nextTokens.expires_at = Date.now() + nextTokens.expires_in * 1000;
  }

  return nextTokens;
}

export async function authenticateGoogleWorkspace(
  log: (message: string) => void,
  options?: {
    signal?: AbortSignal;
    onAuthorizationUrl?: (url: string) => void;
  }
): Promise<ConnectorRecord> {
  log(`Discovering OAuth metadata from ${env.googleWorkspaceMcpUrl} ...`);

  const metadataResult = await getOAuthMetadata(env.googleWorkspaceMcpUrl).catch(
    (error) => {
      throw new Error(
        `OAuth metadata discovery failed for ${env.googleWorkspaceMcpUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  );
  if (!metadataResult) {
    throw new Error("Could not discover OAuth metadata for the Google MCP.");
  }

  const metadata = await registerClientIfNeeded(
    metadataResult,
    env.oauthRedirectUri,
    log
  );
  const authRequest = buildAuthorizationUrl(metadata, env.oauthRedirectUri);
  const callbackPromise = startAuthorizationCallbackListener(
    env.oauthRedirectUri,
    authRequest.state,
    log,
    options?.signal
  );

  options?.onAuthorizationUrl?.(authRequest.url);
  log("Authorization URL prepared.");

  await delay(10);
  const code = await callbackPromise;
  const tokens = await exchangeCodeForTokens(
    code,
    authRequest.verifier,
    metadata,
    env.oauthRedirectUri
  );

  const record: ConnectorRecord = {
    connectorId: CONNECTOR_ID,
    serverUrl: env.googleWorkspaceMcpUrl,
    metadata,
    tokens,
    tokenHistory: [],
    updatedAt: new Date().toISOString(),
  };

  await saveConnectorRecord(record);
  return record;
}

export async function getGoogleConnectorRecord(
  log?: (message: string) => void
): Promise<ConnectorRecord | null> {
  const record = await getConnectorRecord(CONNECTOR_ID);
  if (!record) {
    return null;
  }

  try {
    const refreshed = await refreshAccessToken(record.metadata, record.tokens);
    if (refreshed !== record.tokens) {
      const nextRecord: ConnectorRecord = {
        ...record,
        tokens: refreshed,
        updatedAt: new Date().toISOString(),
      };
      await saveConnectorRecord(nextRecord);
      if (log) {
        log("Refreshed the stored Google Workspace access token.");
      }
      return nextRecord;
    }
  } catch (error) {
    if (log) {
      log(
        `Stored token could not be refreshed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return record;
}

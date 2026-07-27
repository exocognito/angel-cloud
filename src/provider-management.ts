import type { OAuthStateRecord } from "./oauth-state";
import type { ManagementConnection } from "./management-contract";

export interface ProviderAppSummary {
  id: string;
  accountId: string;
  provider: "google";
  displayName: string;
  clientIdSuffix: string;
}

export interface ConnectionSummary {
  id: string;
  accountId: string;
  nickname: string;
  providerAppId: string;
  provider: "google";
  displayName: string;
  grantedScopes: string[];
  health: "healthy" | "revoked" | "error";
}

export interface ProviderManagementState {
  schemaVersion: 1;
  providerApps: ProviderAppSummary[];
  connections: ConnectionSummary[];
  oauthStates: Record<string, OAuthStateRecord>;
}

export type ProviderRegistryCommand =
  | { operation: "list_provider_apps"; accountId: string }
  | { operation: "list_provider_connections"; accountId: string }
  | { operation: "reconcile_provider_apps"; accountId: string; providerApps: ProviderAppSummary[] }
  | { operation: "reconcile_provider_connections"; accountId: string; connections: ConnectionSummary[] }
  | { operation: "save_provider_app"; accountId: string; summary: ProviderAppSummary }
  | { operation: "save_provider_connection"; accountId: string; summary: ConnectionSummary }
  | { operation: "remove_provider_connection"; accountId: string; connectionId: string }
  | { operation: "put_oauth_state"; accountId: string; state: OAuthStateRecord }
  | {
      operation: "take_oauth_state";
      accountId: string;
      state: string;
      accessSubject: string;
      now: number;
    };

export function emptyProviderManagementState(): ProviderManagementState {
  return { schemaVersion: 1, providerApps: [], connections: [], oauthStates: {} };
}

export function managementConnectionsFromProviderSummaries(
  accountId: string,
  summaries: readonly ConnectionSummary[],
): ManagementConnection[] {
  const nicknames = new Set<string>();
  return summaries.map((summary) => {
    if (summary.accountId !== accountId) throw new Error("Provider Connection Account mismatch");
    if (nicknames.has(summary.nickname)) {
      throw new Error(`Connection nickname already exists: ${summary.nickname}`);
    }
    nicknames.add(summary.nickname);
    const providers = [
      ...(summary.grantedScopes.includes("https://www.googleapis.com/auth/gmail.readonly") ? ["gmail"] : []),
      ...(summary.grantedScopes.includes("https://www.googleapis.com/auth/documents.readonly") ? ["docs"] : []),
    ];
    return {
      id: summary.id,
      accountId: summary.accountId,
      nickname: summary.nickname,
      identityLabel: summary.displayName,
      credential: "google_oauth" as const,
      providers,
      grantedScopes: [...summary.grantedScopes],
      health: summary.health === "healthy" ? "healthy" as const : "error" as const,
    };
  });
}

export function reconcileManagementConnections(
  accountId: string,
  current: readonly ManagementConnection[],
  summaries: readonly ConnectionSummary[],
  referencedConnectionIds: ReadonlySet<string>,
): ManagementConnection[] {
  const fresh = managementConnectionsFromProviderSummaries(
    accountId,
    summaries,
  );
  const freshIds = new Set(fresh.map((connection) => connection.id));
  const tombstones = current
    .filter((connection) => referencedConnectionIds.has(connection.id) && !freshIds.has(connection.id))
    .map((connection) => ({ ...connection, health: "error" as const }));
  return [...fresh, ...tombstones];
}

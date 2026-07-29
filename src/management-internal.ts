import type {
  DeploymentEnvironment,
  ManagementAvailabilityChange,
  ManagementBindingMap,
  ManagementVersionArtifact,
  PublishedAngelVersion,
} from "@smcllns/angel-core";
import type { GateAvailability, GateAvailabilityCommand, GateToolBinding } from "./gate";

/**
 * A named runtime key for a single environment. The plaintext secret is never
 * persisted — only its `hash` (for gate auth) and short `fingerprint` (for
 * display) are stored. `createdAt`/`revokedAt` are recorded ISO-8601 UTC times
 * for events this backend actually performs; a key migrated from the legacy
 * single-key field has no `createdAt` (its real mint time was never recorded, so
 * we never fabricate one).
 */
export interface AgentKey {
  id: string;
  name: string;
  fingerprint: string;
  hash: string;
  status: "active" | "revoked";
  createdAt?: string;
  revokedAt?: string;
}

/**
 * The safe projection of an {@link AgentKey}: everything a client/UI needs and
 * NEVER the secret hash. `createdAt`/`revokedAt` are surfaced as `string | null`
 * (null = the event's wall-clock was never recorded) so consumers can validate an
 * exact, stable shape.
 */
export interface AgentKeyView {
  id: string;
  name: string;
  fingerprint: string;
  status: "active" | "revoked";
  createdAt: string | null;
  revokedAt: string | null;
}


export interface ManagementAngel {
  id: string;
  accountId: string;
  slug: string;
  environments: Record<DeploymentEnvironment, ManagementEnvironment>;
}

export interface ManagementDeployment {
  id: string;
  angelId: string;
  environment: DeploymentEnvironment;
  versionId: string;
  version: number;
  digest: string;
  bindings: Record<string, string[]>;
  runtimeBindings: GateToolBinding[];
}

export interface ManagementEnvironment {
  activeDeploymentId: string | null;
  pendingDeploymentId: string | null;
  /**
   * Legacy single-key fields. Retained in lockstep with the first active entry of
   * `keys` so existing gate installs and views keep working through the named-key
   * migration; `keys` is the authoritative model.
   */
  keyHash: string;
  keyFingerprint: string;
  /**
   * Named runtime keys for this environment. Additive: states persisted before
   * named keys have no `keys` and are migrated on read (the legacy key becomes a
   * single entry named "Default key").
   */
  keys?: AgentKey[];
  repair: null | "broker" | "gateway";
  availability: GateAvailability;
  /**
   * Recorded ISO-8601 UTC time of the most recent successful availability change,
   * or absent when no change has been recorded since named-timestamp support
   * landed. Never fabricated for historical changes.
   */
  availabilityChangedAt?: string;
  pendingAvailability: null | {
    change: ManagementAvailabilityChange;
    command: GateAvailabilityCommand;
    target: GateAvailability;
  };
}

export interface MutationIdentity {
  method: string;
  path: string;
  idempotencyKey: string;
  body: unknown;
}

export type ManagementCommand =
  | { operation: "ensure_angel"; accountId: string; slug: string; mutation: MutationIdentity }
  | {
      operation: "delete_angel";
      accountId: string;
      slug: string;
      input: DeleteAngelRequest;
      mutation: MutationIdentity;
    }
  | { operation: "get_angel_by_slug"; accountId: string; slug: string }
  | { operation: "get_angel"; angelId: string }
  | { operation: "get_version"; angelId: string; versionId: string }
  | { operation: "list_connections"; accountId: string }
  | {
      operation: "publish_version";
      angelId: string;
      input: { artifact: ManagementVersionArtifact; expectedDigest: string };
      mutation: MutationIdentity;
    }
  | {
      operation: "deploy_staging";
      angelId: string;
      input: { versionId: string; expectedDigest: string; bindings: ManagementBindingMap };
      mutation: MutationIdentity;
    }
  | { operation: "get_environment"; angelId: string; environment: DeploymentEnvironment }
  | {
      operation: "change_availability";
      angelId: string;
      environment: DeploymentEnvironment;
      input: ManagementAvailabilityChange;
      mutation: MutationIdentity;
    }
  | {
      operation: "promote_production";
      angelId: string;
      input: { stagedDeploymentId: string; expectedDigest: string; bindings: ManagementBindingMap };
      mutation: MutationIdentity;
    }
  | {
      operation: "create_key";
      angelId: string;
      environment: DeploymentEnvironment;
      input: { name: string };
      mutation: MutationIdentity;
    }
  | {
      operation: "rotate_key";
      angelId: string;
      environment: DeploymentEnvironment;
      input: { keyId: string };
      mutation: MutationIdentity;
    }
  | {
      operation: "revoke_key";
      angelId: string;
      environment: DeploymentEnvironment;
      input: { keyId: string };
      mutation: MutationIdentity;
    };

export interface DeleteAngelRequest {
  /**
   * The Angel slug, typed back by the caller. Required only when production has
   * a live deployment; when present it must equal the slug being deleted.
   */
  confirm?: string;
}

export interface DeleteAngelResponse {
  id: string;
  slug: string;
  deleted: true;
}

export interface CreateKeyResponse {
  key: AgentKeyView;
  /** The plaintext runtime secret — returned exactly once, never persisted. */
  plaintext: string;
}

export interface RotateKeyResponse {
  key: AgentKeyView;
  revokedKeyId: string;
  /** The plaintext runtime secret for the replacement key — returned exactly once. */
  plaintext: string;
}

export interface RevokeKeyResponse {
  key: AgentKeyView;
}

export interface EncryptedReplayRecord {
  fingerprint: string;
  ciphertext: string;
  /**
   * Canonical mutation path, recorded so Angel deletion can purge the dead
   * Angel's records. Absent on records persisted before deletion existed —
   * deletion purges those only when the stored response contains the dead
   * Angel's id (or cannot be opened at all); the rest age in place.
   */
  path?: string;
  /**
   * The Angel this mutation addressed, when it addressed one. Lets Angel
   * deletion purge records whose path carries no Angel identity (the
   * dashboard's `/api/demo/action`). Absent on pre-deletion records and on
   * mutations that are not Angel-scoped.
   */
  angelId?: string;
}

export interface JsonReplayRecord {
  fingerprint: string;
  responseJson: string;
  /** See {@link EncryptedReplayRecord.path}. */
  path?: string;
  /** See {@link EncryptedReplayRecord.angelId}. */
  angelId?: string;
}

export type IdempotencyRecord = EncryptedReplayRecord | JsonReplayRecord;

// The contract's ManagementConnection is owned by the pinned core package;
// granted scopes are an additive hosted concern. Absent on a pre-scope
// persisted state → treated as no grants (fail closed) until the next
// connection sync repopulates from Broker custody summaries.
export type StoredManagementConnection = import("@smcllns/angel-core").ManagementConnection & {
  grantedScopes?: readonly string[];
};

export interface ManagementState {
  schemaVersion: 1;
  account: { id: string; name: string };
  connections: StoredManagementConnection[];
  angels: ManagementAngel[];
  versions: PublishedAngelVersion[];
  deployments: ManagementDeployment[];
  idempotency: Record<string, IdempotencyRecord>;
  /**
   * Recorded ISO-8601 UTC times for lifecycle events this backend actually
   * performs, keyed by the entity's id: a published Version's id → its publish
   * time; a Deployment's id → its staging-deploy/production-promotion time.
   *
   * A parallel repo-local map is used (rather than adding fields) because the
   * `PublishedAngelVersion` type is owned by the pinned `@smcllns/angel-core`
   * package and cannot be extended there; keying deployments the same way keeps a
   * single uniform, additive store. Absent map / absent key → the event stays
   * `derived` with `at: null`; historical events are never back-filled.
   */
  timestamps?: Record<string, string>;
}

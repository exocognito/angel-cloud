# WS-E brief 6 — Account deletion inventory

- Decision: O6
- Evidence status: complete
- Product implementation: none
- Outcome: close O6 for semantic scope; physical proof remains an execution gate
- Verified: 2026-08-01

## Question

What exactly does Account deletion remove?

## Method

Enumerated every current and target Account-owned store across Control, Gateway, Broker, Durable Objects, custody, OAuth, handles, keys, deployments, receipts, idempotency, auth, provider state, logs, and local files. Traced implemented Angel/Connection/reset paths and separated cloud-owned, provider-owned, infrastructure-retained, and independent local state.

## Verified results

- No Account-delete route exists. Demo reset and repeated Angel delete leave custody, provider/OAuth summaries, handles, auth/platform state, and physical Durable Objects.
- Account-owned authority spans keys/tokens, every Angel/Version/deployment/binding/gate/receipt, custody and Provider Apps/Connections, OAuth state, idempotency, owner source, and future auth rows.
- Google grants are external and must be revoked before refresh-token destruction; provider content and OAuth client projects are not Angel-owned.
- Local source, bundles, pulled evidence, local vault/tokens, saved keys, agent config, and provider content remain independent.
- Cloudflare logs and Durable Object PITR may outlive live deletion; the repo has no legal-retention contract.

## Decision outcome

Outcome: close O6. Account deletion is an asynchronous, retryable hard-delete. It first marks the Account deleting and removes authority, then revokes external grants, physically deletes all Account-owned gate/vault/control/auth state, removes live handle mappings, and finishes only after proofs pass. Preserve only non-resolving tombstones for current/retired handles to honor the approved never-reuse rule; retain no Account identifier or live mapping.

A transient failure leaves the Account disabled and retryable. Do not claim local/provider deletion or immediate physical purge from infrastructure backups.

## Product implication

Delete Account needs a cross-Worker internal job, not demo reset. Owner copy must distinguish cloud deletion from local cleanup, warn about grant-wide Google revocation, state that old handles remain unavailable, and disclose bounded infrastructure retention.

## Execution gates

- Generate and enumerate final Better Auth/D1, passkey, recovery, membership, email, and CLI-token schema before implementation approval.
- Verify every created runtime is discoverable; add an ownership index if the current management list cannot prove this.
- Test `storage.deleteAll()` against Cloudflare 30-day PITR semantics and record the deployed log plan/retention/per-Account erasure limits.
- O10 must accept the non-resolving permanent-handle tombstone and the rule that fresh signup uses a new handle.
- Implement idempotent Broker-before-Gateway cascade, distinct-grant revocation, vault/control/auth deletion, and non-resolving handle tombstones.
- Prove every old session/token/key/coordinate/read fails, cloud stores are empty, provider grants are revoked/invalid, fresh signup works without admin help, and local/provider-owned state remains untouched.

## Evidence record

# Brief O6 — Exact Account-deletion scope

## Question

What exactly must Account deletion remove, what may remain, and which state is independent of the cloud deletion?

## Method

1. Enumerated every persistent API call and every stored state type in Control, Gateway, Broker, config, docs, ADRs, and tests.
2. Traced ownership through Durable Object names and runtime IDs.
3. Traced the only implemented deletion paths: Angel deletion, Connection revoke/remove, OAuth-state consumption, and demo reset.
4. Separated current physical stores from approved-but-unbuilt target stores and external-provider/local state. No missing target table was invented.
5. Ran the relevant persistence, deletion, custody, handle, OAuth-state, provider-lifecycle, and gate tests.

## Sources and commands

### Repository sources

- `src/management-internal.ts`: full `ManagementState`, keys, deployments, bindings, idempotency records, and timestamps.
- `src/management.ts`: Angel hard-delete order and actual purge boundaries.
- `src/provider-management.ts`, `src/oauth-state.ts`: provider summaries and pending OAuth state.
- `src/custody.ts`, `src/workers/credential-vault.ts`: encrypted Provider Apps, Connections, wrapped per-Account DEK, and current Connection removal.
- `src/gate.ts`, `src/workers/gate-object.ts`, `src/workers/service-gate-fleet.ts`: gate installations, key hashes, availability, deployment fingerprints, receipts, and reset behavior.
- `src/workers/account-registry.ts`: Control storage keys, handle directory, provider state, reset behavior, and DO ownership.
- `src/handles.ts`, `src/workers/gateway.ts`: permanent handle policy and Gateway replica.
- `src/workers/control.ts`, `src/workers/broker.ts`, `src/access.ts`: Access auth, Google grant revoke/remove, and external boundaries.
- `wrangler.{control,gateway,broker}.jsonc`: all namespaces, SQLite classes, platform secrets/bindings, and 100% Workers Logs sampling.
- `docs/user-manual.md`, `docs/faq.md`, Product Ledger decision O6, guarantee G10, and command C13, APRD §4.1, CLI target guide, ADRs 0001–0007.
- `tests/cloud/management.test.ts`, `management-worker.test.ts`, `account-handles.test.ts`, `credential-vault.test.ts`, `custody.test.ts`, `control-provider-lifecycle.test.ts`, `oauth-state-registry.test.ts`, `gate-workers.test.ts`.

Representative inventory commands:

```sh
git ls-files | sort
rg -n '(storage\.|getByName|deleteAll|persist\(|idempotency|receipts|oauthStates)' \
  src tests/cloud wrangler.*.jsonc
rg -n -i '(Account deletion|delete Account|retention|local state|revoke|remove)' \
  docs README.md
```

Verification command and result:

```sh
pnpm exec bun test \
  tests/cloud/management.test.ts \
  tests/cloud/management-worker.test.ts \
  tests/cloud/account-handles.test.ts \
  tests/cloud/credential-vault.test.ts \
  tests/cloud/custody.test.ts \
  tests/cloud/control-provider-lifecycle.test.ts \
  tests/cloud/oauth-state-registry.test.ts \
  tests/cloud/gate-workers.test.ts
```

**156 passed, 0 failed.**

### External platform sources

- [Cloudflare Durable Object storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/): a DO that has stored data only fully ceases to exist after `storage.deleteAll()`; SQLite DOs offer point-in-time recovery for up to 30 days.
- [Cloudflare Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/): enabled observability stores invocation logs, request/response metadata, errors, and custom logs. Current documented retention is 3 days on Free and 7 days on Paid, with a 7-day maximum.
- [Google OAuth token revocation](https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke): revocation is part of removal; it invalidates the client/user grant's scopes and issued tokens and may take time to take full effect.
- Better Auth's current docs describe core `user`, `session`, `account`, and `verification` stores and plugin-specific tables. **These are not current Angel stores:** no Better Auth dependency, config, D1 binding, migration, or exact plugin schema exists in this repository.

## Verified current inventory

### 1. Control — Account-specific `AccountRegistry` Durable Object

Instance name: the opaque Account ID, such as `acct_example`.

| Storage key | Persistent content | Ownership |
| --- | --- | --- |
| `management` | Account id/name/display handle; safe Connection summaries; Angels; both environments; named key hashes/fingerprints/status/timestamps; availability and repair state; immutable Versions and full artifacts; deployments; private Connection bindings and runtime refs; lifecycle timestamps; all management idempotency records, including encrypted shown-once key responses | Account-owned |
| `providers` | Safe Provider App summaries; safe Connection summaries; pending Google OAuth states containing Access subject, PKCE verifier/challenge, Provider App/Connection IDs, nickname, redirect URI, expiry, and flow | Account-owned |

Important persistence facts:

- Expired OAuth states are rejected but are not swept; they can remain until some later write or explicit deletion.
- Management idempotency records have no global retention/GC rule.
- Versions and deployments remain until Angel deletion.
- The agreed owner-only `ANGEL.yaml` source-draft store from ADR 0006 is **not implemented**. If added later, it is Account-owned and joins this cascade.

### 2. Control — singleton handle directory `AccountRegistry`

Instance name: `handle-directory`.

- `handle:<current-or-retired-handle> -> accountId`
- `account:<accountId> -> { handle, retiredHandle }`

This is platform-wide state, not inside the Account's own DO. Current policy says handles are permanent, retired names keep resolving, and names are never released.

### 3. Gateway — singleton `HandleDirectory`

Instance name: `directory`.

- `handle:<current-or-retired-handle> -> accountId`

This is an append-only runtime replica used to route public coordinates.

### 4. Gateway — one `GateRuntime` DO per Account + Angel slug + environment

Runtime ID: `<accountId>:<angel-slug>:<preview|production>`.

Stored under `state`:

- gate and Account/Angel/environment identity;
- current deployment installation and full artifact;
- private bindings: Connection ID/ref, provider, identity label;
- active Angel-key hashes;
- availability and overrides;
- all historical deployment fingerprints held by that runtime;
- full hash-chained Gateway receipts, including request/deployment/version/digests/tool/decision, private Connection fields, argument digest, chain links, and checkpoint.

### 5. Broker — one `GateRuntime` DO per Account + Angel slug + environment

Same shape as Gateway, with the independent Broker installation, availability, deployment fingerprints, key state, receipt chain, and checkpoint.

### 6. Broker — one `CredentialVault` DO per Account

Instance name: Account ID. Stored under `custody`:

- one wrapped Account data-encryption key;
- Provider Apps: id, Account id, display name, Google client ID, scopes, encrypted client secret;
- Connections: id, Account id, nickname, Provider App id, Google subject and display identity, granted scopes, health, encrypted refresh token;
- AES-GCM IV/ciphertext metadata.

The Broker's root `CREDENTIAL_KEK` is a platform Worker secret, not an Account object. Deleting one Account must not delete it.

### 7. Current auth and platform state outside those stores

- Current browser auth is Cloudflare Access. Angel stores no auth user/session table; it validates an Access JWT and maps every valid identity to configured `ACCOUNT_ID`.
- Cloudflare Access application/policy, Access sessions, service tokens, and Access logs are external platform state. No Account-deletion path controls them.
- Management/reset/internal service credentials and Worker vars/secrets are platform/operator credentials, not Account-owned. They must survive one Account deletion.
- All three Workers enable observability at `head_sampling_rate: 1`, so Cloudflare stores invocation logs/metadata outside application DO state.
- The SQLite DO namespaces support platform point-in-time recovery. The repository does not invoke it or state whether prior snapshots remain recoverable after `deleteAll()`.

### 8. External Google state

- Google holds the OAuth grant and token status. Current Connection removal revokes the Google grant first, then removes the Connection from Broker custody and Control summaries.
- Google revocation is client/user grant-wide, so it may invalidate sibling Connections made with the same OAuth client and Google identity.
- The owner-created Google OAuth client, consent-screen configuration, and Google Cloud project are owner/provider state, not Angel Cloud objects.
- Gmail drafts/messages, Docs, Google account activity, and other provider data are provider-owned state. Account deletion must not erase them and generally cannot.

### 9. Independent local state

Cloud deletion cannot and must not pretend to remove:

- `ANGEL.yaml`, `angel.json`, source directories, built bundle and digest files;
- locally pulled receipt files and replay reports;
- the future CLI profile and Account handle stored on the machine;
- future Account-scoped management token and local provider OAuth tokens in the OS keychain;
- plaintext Angel keys saved by the owner or installed in an agent;
- local MCP runtime state and logs;
- authenticator-side passkey private keys, if the optional passkey target ships. Deleting their server public-key records makes them unusable at Angel, but does not erase an authenticator device;
- provider-side content and the owner's external OAuth-client configuration.

## Actual deletion paths and gaps

### Implemented Angel deletion

`ManagementControl.deleteAngel`:

1. marks every Angel key revoked and persists that state;
2. pushes an empty key set to Gateway;
3. resets Broker gates before Gateway gates in preview and production;
4. drops the Angel, its Versions, deployments, timestamps, and Angel-owned idempotency records;
5. retains the delete's own idempotency response so a delayed retry cannot delete a recreated Angel.

Tests prove receipts disappear because gate `reset` replaces the entire gate state. Shared Connections and other Angels remain.

### Implemented Connection deletion

Control asks Broker to revoke the Google grant if needed, removes the encrypted Connection from the vault, then removes the safe Control summary. Provider App removal remains `501`.

### Demo reset is not Account deletion

The reset path resets known gates and overwrites `management` with a fresh state. It does **not** delete:

- the AccountRegistry DO;
- `providers` or pending OAuth states;
- the CredentialVault, Provider Apps, or refresh grants;
- Control/Gateway handle entries;
- Cloudflare Access sessions/state;
- Workers Logs or platform recovery data.

### No physical Account deletion exists

- No Account-delete route or command exists.
- No application code calls `storage.deleteAll()`.
- Gate reset overwrites `state`; it does not remove the DO instance.
- Provider App deletion is not implemented.
- The target Better Auth/D1 schema, Account-to-auth-user mapping, CLI-token server store, recovery-contact store, and email provider are not yet present, so their exact physical deletion keys cannot be verified now.

## Alternatives

1. **Call Angel delete repeatedly, then reset.** Rejected: leaves custody, provider summaries, OAuth states, handles, auth state, and physical DOs.
2. **Delete only Control's Account DO.** Rejected: leaves live keys/gates, receipts, bindings, CredentialVault secrets, handle replicas, and provider grants.
3. **Erase all application state but release handles.** Rejected under current PD 0004: released names permit impersonation of old public coordinates.
4. **Keep current handle mappings pointing at the deleted Account.** Rejected: it leaves a live Account identifier and makes deletion/restart semantics unclear.
5. **Retain a minimal, non-resolving handle reservation.** Recommended. It preserves “never released” without preserving a live Account mapping.
6. **Keep receipts or an audit ledger after deletion.** Rejected absent a documented legal duty and retention period. Gate receipts are Account-owned activity data, and the FAQ explicitly has no retention guarantee.

## Recommendation

Account deletion should be an asynchronous, retryable hard-delete that first removes authority, then external grants, then data. It must not report completion until every application-owned deletion step is confirmed. A transient provider/network failure leaves the Account visibly `deleting`, unable to sign in or invoke tools, and safe to retry.

The only recommended product retention exception is a **minimal non-resolving reservation for current and retired handles**. Short-lived Cloudflare logs and any provider backup/PITR behavior must be disclosed as infrastructure retention, not presented as live Account state or a legal audit record.

## Exact contract

### Preconditions and state transition

1. Require a fresh human authentication and explicit confirmation naming the Account handle.
2. Atomically mark the Account `deleting`. From that point, reject new sessions, login-link completion, CLI-token minting, management mutations, publishes, deployments, and provider invocation.
3. Run the cascade from an internal deletion job so removing the owner's session cannot strand the operation. Every step is idempotent.

### Authority shutdown

4. Revoke/delete every Angel key hash and any Account-scoped management/CLI token server record.
5. For every Angel and both environments, close Broker before Gateway, then call `storage.deleteAll()` on each Broker and Gateway gate DO. Do not use gate `reset` as the final erase.
6. Remove all gate installations, artifacts, bindings, private Connection refs/identity labels, availability, deployment fingerprints, receipts, checkpoints, and DO metadata.

### Provider and custody removal

7. Before destroying refresh tokens, attempt revocation for every distinct external Google client/user grant. Treat provider confirmation that a grant is already invalid as success; retry transport/provider failures while the Account remains disabled.
8. Warn that Google revocation is grant-wide and may affect sibling uses of the same Google OAuth client and identity.
9. After revocation completes, call `storage.deleteAll()` on the Account's CredentialVault. Remove the wrapped DEK, every Provider App, client ID/secret/scopes, every Connection, subject/nickname/identity/health field, and every encrypted refresh token.
10. Do not delete the owner's Google Cloud project/OAuth client or provider content.

### Control and auth removal

11. Delete the Account-specific `management` and `providers` state in full: Account record; Angels; Versions/artifacts; deployments; keys; bindings; availability/repair state; safe Connection/Provider App summaries; pending/expired OAuth states and PKCE verifiers; all idempotency records including encrypted shown-once responses; timestamps; and any owner-only source drafts added later. Finish with `storage.deleteAll()` on the AccountRegistry DO.
12. Delete every target-auth row tied solely to the owner/Account: auth user, sessions, linked auth identities, magic-link/verification records, passkey public credentials, recovery addresses/contacts, account memberships, and server-side CLI-token records. The final table/key list must come from the generated Better Auth/D1 migration and Angel extensions; it cannot be frozen from this repository because they do not exist yet.
13. If the auth identity owns no other Angel Account in the Round-2 one-owner model, delete that auth identity. A future multi-Account/member model must separate “delete this Account” from “delete my login”; do not guess that cascade now.

### Handles

14. Remove `account:<accountId>` and remove current/retired live mappings from the Gateway directory so every old coordinate stops resolving immediately.
15. Replace Control's current/retired live claims with non-resolving reservation tombstones containing no Account ID, email, auth-user ID, or Connection data. A hash of the normalized handle is enough for claim rejection, though low-entropy handles may still be personal data and need a stated policy basis.
16. A fresh signup is self-service but must choose a new handle. Reusing the deleted handle would contradict the approved “never released” invariant and requires a separate product decision.

### Completion and proof

17. Remove the transient deletion job after all steps complete. Retain no application audit/legal record unless a later legal requirement names the fields, purpose, and exact duration.
18. A completed deletion must prove:
    - old auth sessions and CLI tokens fail;
    - old Angel keys fail;
    - old public coordinates do not resolve to an Account/Angel;
    - Account, Angel, Version, deployment, binding, receipt, idempotency, provider-summary, OAuth-state, and custody reads find nothing;
    - Google grants are revoked or provider-confirmed invalid;
    - gate, vault, and Account DO storage is empty/deleted;
    - a fresh signup succeeds without admin help;
    - local files/keychain entries and provider content remain untouched and are named to the owner.

## Retention exceptions and risks

### Verified infrastructure retention

- Workers Logs are enabled at 100% sampling. Cloudflare says invocation logs contain request/response metadata and documents 3-day Free / 7-day Paid retention. The repository does not identify the plan or provide selective per-Account erasure. This is a short-lived infrastructure exception, not an Angel audit ledger.
- SQLite Durable Objects offer point-in-time recovery to points within the prior 30 days. The source verifies the feature exists but not whether `deleteAll()` makes pre-delete snapshots unrestorable. Do not promise immediate physical purge from backups until this is tested or confirmed with Cloudflare.

### Unverified future retention

- No email provider is chosen, so delivery-log content and retention are unknown.
- Better Auth/D1 is unimplemented, so the final generated schema and database backup behavior are unknown.
- No legal, tax, fraud, billing, or compliance retention requirement is documented. Do not invent one. If one appears, retain only the named fields for a fixed period and exclude credentials, grants, source, artifacts, receipts, and provider identities unless law specifically requires them.

### Product and operational risks

- The permanent-handle rule conflicts with a literal claim that “nothing remains.” Product copy must say “all live Account data is deleted; the old handle remains permanently unavailable.”
- Google revocation can affect sibling grants for the same OAuth client/user and may take time to take effect.
- Deleting auth state before creating an internal retryable job can strand a partial cascade.
- Management state is the only current list of gate runtime IDs. A previously orphaned gate absent from that list would not be found by a naive cascade. No orphan index/store exists; do not claim one. WS2 must prove that every created runtime is discoverable or add an explicit ownership index.
- Current expired OAuth states and idempotency records have no sweeper; Account deletion must remove them directly.
- Saved plaintext Angel keys and local management/provider tokens remain valid-looking strings after cloud deletion even though server state rejects them. The owner-facing completion screen should tell the owner to remove local copies.

## Product implication

“Delete Account” cannot be implemented as demo reset or a loop over the existing Angel-delete endpoint. It needs a cross-Worker deletion job, physical DO deletion, provider-grant revocation, target-auth cleanup, and a deliberate handle tombstone policy. The UI and CLI must distinguish cloud deletion from local cleanup and state the infrastructure retention window honestly.

## Closure assessment

**Current-store inventory: closed and verified.**  
**Semantic deletion contract: decision-ready with the recommendation above.**  
**Physical O6 closure: not yet complete.** Before O6 can be marked fully closed for implementation, WS2 must preserve evidence for four exact gaps:

1. generated Better Auth/D1 plus passkey/recovery/CLI-token schema and Account-to-user ownership mapping;
2. Cloudflare confirmation/test for DO `deleteAll()` versus 30-day PITR;
3. the deployed Workers plan/log retention and any per-Account erasure option;
4. owner acceptance of the non-resolving permanent-handle tombstone and the resulting “fresh signup uses a new handle” rule.

These are real missing stores/policies, not grounds to infer a broader cascade.

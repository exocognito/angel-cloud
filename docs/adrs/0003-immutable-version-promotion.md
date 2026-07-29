# ADR 0003: Promote the exact staged Angel Version

- Status: Accepted
- Date: 2026-07-20

## Context

The CLI-first workflow needs a fast staging path and a deliberate production
step. Rebuilding or republishing during promotion would make production differ
from what was tested. Reusing staging bindings implicitly would also cross an
environment boundary and could select the wrong credentials.

## Decision

Publishing and promotion are distinct:

```ts
interface PublishedAngelVersion {
  id: string;
  angelId: string;
  number: number;
  digest: string;
  artifact: AngelVersionArtifact;
}

interface Deployment {
  id: string;
  angelId: string;
  environment: "staging" | "production";
  versionId: string;
  digest: string;
  bindings: InstalledBindingMap;
}

interface PromoteProductionRequest {
  stagedDeploymentId: string;
  expectedDigest: string;
  bindings: InstalledBindingMap;
}
```

`angel publish` builds locally, ensures the stable Angel by Account plus slug,
publishes the immutable artifact idempotently by digest, and deploys it to
staging with explicit staging bindings.

`angel deploy --prod` reads the active staged deployment, submits its ID and
expected digest with explicit production Connection IDs, and promotes those
exact Version bytes. It does not build, upload, publish, or choose another
Version. Staging and production have separate bindings, availability overlays,
endpoints, and stable agent keys.

Deployment installs Broker first and Gateway second. Disable/pause closes
Broker first; enable/resume opens Broker first. Partial state remains visible
and repairable. Neither gate falls back to an older Version or availability
state when convergence fails.

## API boundary

The minimal resource API is:

1. `PUT /v1/accounts/:account/angels/:slug`
2. `POST /v1/angels/:id/versions`
3. `POST /v1/angels/:id/environments/staging/deployments`
4. `POST /v1/angels/:id/environments/production/promotions`
5. `GET /v1/accounts/:account/connections` for authenticated CLI nickname
   resolution; it returns opaque management IDs but no credentials or
   agent-plane refs
6. Reads for Angel, Version, and environment state
7. `DELETE /v1/accounts/:account/angels/:slug` (added 2026-07-28, issue #13):
   hard deletion. Keys are revoked first, then Broker closes before Gateway in
   both environments — the same order as disable — then the Angel's state,
   Deployments, and Versions are dropped. The slug is immediately reusable.
   When production has an active or pending-repair deployment the body must
   repeat the slug as `{"confirm": "<slug>"}`.

Every mutation requires management bearer authentication and an
`Idempotency-Key`, rejects unknown JSON keys, and accepts no credentials.
Publishing recomputes the canonical digest; identical Angel plus digest returns
the existing Version.

An idempotency record binds its key to the canonical method, path, and body.
Reusing a key for different input fails. Because first ensure returns shown-once
environment agent keys, its replay payload is encrypted under a dedicated
Control response-replay key; plaintext keys are never stored in ordinary Angel
state. This key is separate from the Broker KEK that protects provider
credentials.

## Consequences

Production is reproducible and auditable from the tested staged digest. A
binding review is required at promotion, which adds one explicit step but avoids
credential/environment ambiguity. Agent keys do not rotate on Version changes.

## Rejected alternatives

- Build or republish in `deploy --prod`: production bytes could drift.
- Promote "latest": races with concurrent publishes and is not auditable.
- Copy staging bindings automatically: violates environment isolation.
- Update both gates concurrently with fallback: hides partial deployment and
  can authorize against different policies.
- Browser authoring/publishing: outside the API-first minimal platform.

## Revisit when

Add higher-level rollout policies only after exact promotion is proven in use.
Any canary or approval workflow must still name immutable digests and explicit
environment bindings.

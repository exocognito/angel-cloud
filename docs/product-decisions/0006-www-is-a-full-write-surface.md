# PD 0006: www is a full-parity write surface

- Status: Agreed
- Date: 2026-07-30
- Implemented: Partly — the dashboard promotes Versions, changes
  availability, and manages keys; source authoring, build, and publish are
  unbuilt
- Tracked: none yet
- Supersedes: the browser-authoring exclusion in
  [ADR 0003](../adrs/0003-immutable-version-promotion.md)

## Decision

The www product is a full-parity Angel write surface. A person can create an
Angel, edit its charter, tools, and guards, build the same canonical artifact,
and publish it without switching to a terminal.

This adds a surface, not a second policy model:

1. www edits the same `ANGEL.yaml` shape as the CLI, including either direct
   `tools:` or composed `angels:` children.
2. Control stores the owner-only source draft. The browser runs the same pinned
   portable compiler and produces the same secret-free, digest-addressed
   artifact.
3. The publish boundary still accepts only the canonical artifact. Control
   stores source as data but does not compile it or run arbitrary user code.
4. Publish keeps the same immutable Version, binding, digest, and exact
   promotion rules on every surface.

The complete product design keeps this parity even when a release ships a
smaller subset first. The v2.1 phase is CLI-first; it does not make CLI-only
authoring the end state.

[ADR 0006](../adrs/0006-browser-source-and-client-compilation.md) owns this
source-storage and client-compilation boundary.

## Why the earlier boundary changed

ADR 0003 rejected browser authoring and publishing as outside the API-first
minimal platform. That was a scope cut for the first working system, not a
security property. Dogfooding the working CLI showed that the cut now hides the
product's main proof from people who work in the dashboard and forces one
lifecycle across two products.

The safety boundary is the canonical artifact and immutable publish contract,
not the terminal. Keeping those contracts identical preserves the reason for
ADR 0003 while removing its temporary surface limit.

## What already works

The dashboard is not read-only. It can promote an exact staged Version, pause
or resume availability, and mint, rotate, and revoke named Angel keys. Those
writes stay.

What is missing is the source path: create, edit, compile, and publish. The
APRD maps those controls as agreed and unbuilt. Its v2.2 mark is a proposal
about order, not a condition on this decision.

## Consequences

- There is one policy representation and one compiler contract across www and
  CLI.
- A browser publish must return the same Version and digest evidence as the CLI.
- Availability toggles remain runtime authority reduction. They do not become
  policy edits.
- This record changes only ADR 0003's browser-surface exclusion. Digest-pinned
  immutable promotion, explicit bindings, and fail-closed convergence stand.

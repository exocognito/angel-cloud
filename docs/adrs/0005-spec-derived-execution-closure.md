# ADR 0005: Derive execution from the same reviewed spec as policy

- Status: Accepted
- Date: 2026-07-24

## Context

Milestone 1 shipped the hosted Google edge with two hand-coded operations
while the core compiler accepted twenty-two operation names. Both suites were
green: the compiler tested its name list, the Broker tested its two
implementations, and no test in either repository owned the property that
everything publishable is executable. The stub satisfied the milestone because
the milestone was written as behavior ("first pinned Gmail and Docs
adapters", two named operations in the settled anchor) rather than mechanism,
the hosted design's spec-driven artifact was framed as a larger product
target rather than acceptance criteria, and the repository split labeled the
existing spec-driven compiler and runtime "legacy" (ADR 0004) without a
tracked work item to rebuild that mechanism in the hosted stack.

## Decision

One closure invariant, to be enforced at publish time in code and honored in
planning:

**An operation may be published only if its request derivation from a
reviewed provider spec is sealed in the artifact and a registered adapter
interprets it. Hand-coded per-operation execution paths are forbidden;
adapters interpret sealed request data, they do not enumerate operations.**

Concretely:

- The reviewed adapter registry in `exocognito/angelmcp` at
  `packages/core/adapters/<provider>/` (curated contract plus narrowed spec,
  generated into a Worker-safe registry; its original landing history is
  preserved in the imported package commits) is the single capability truth.
  The `angel.version.v2` schema is owned by `exocognito/angelmcp`; the v1 → v2
  format decision is recorded in `docs/core/format-v2.md`. ADR 0007 supersedes
  ADR 0004's old repository ownership. This ADR records only the invariant that
  motivates it. The compiler seals the registry's request templates into
  `angel.version.v2` artifacts, and every control plane validates received
  artifacts against the same registry with `validateArtifactAdapters`.
- All three closure pieces are landed. `packages/core` emits v2 artifacts and
  exports the validator; `src/management.ts` calls `validateArtifactAdapters`
  before storing a Version; and `src/workers/broker.ts` executes through the
  generic sealed-request interpreter in `src/google-provider.ts`. Nothing can
  publish unless the registered runtime can interpret its sealed request.
- Test and fixture providers in the hosted stack must interpret sealed
  requests from the same registry as production adapters — every
  registry-derived operation, not a hand-picked subset, since the M1 failure
  was exactly registry-accepted operations the runtime could not run — and
  must not execute hand-coded operations the registry cannot derive. The
  rule scopes to Angel Cloud and any compatible control plane; this
  repository's deterministic Gmail/Docs fixture is a deliberately separate
  implementation per ADR 0004 and stays outside hosted closure evidence.
- Milestones that ship an operation ship its mechanism. Scoping down to few
  operations remains legitimate, but a shortcut that stubs the mechanism must
  be recorded as an explicit debt anchor in `NEXT.md` at the moment of the
  cut — silent stubs are how a scope cut becomes the architecture.

## Why

The two-operation stub cost a paused dogfooding cycle and a re-derivation of
already-made decisions. The root cause was structural, not a bad call:
nothing tied the publisher's accepted set to the runtime's executable set, so
the gap grew silently under green suites. A closure invariant makes that gap
impossible to write down, and the debt-anchor rule keeps deliberate scope
cuts visible until they are paid.

## Rejected alternatives

- Runtime capability handshake (Broker advertises executable operations,
  Control queries at publish): interim plumbing that the sealed-artifact
  validation makes redundant, and a second capability truth to drift.
- Trimming the compiler's accepted set to match the runtime: preserves two
  sources of truth and breaks legitimately compiled policies.
- Enforcement by review vigilance alone: this failure survived multiple
  reviewed PRs; invariants that live only in prose do not hold.

## Revisit when

A provider shape arrives that no reviewed spec can describe (MCP servers,
local device capabilities). The artifact's tagged `request` union and a
format bump are the extension path; the closure invariant itself — sealed
derivation plus registered interpreter — must survive every shape.

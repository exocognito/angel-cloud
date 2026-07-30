# ADR 0006: Store www source in Control and compile it in the browser

- Status: Accepted
- Date: 2026-07-30

## Context

[PD 0006](../product-decisions/0006-www-is-a-full-write-surface.md) makes www
a full-parity Angel write surface. That requires a durable source draft and the
same compiler contract as the CLI.

The existing publish boundary accepts only a canonical, secret-free artifact.
It does not accept `ANGEL.yaml` or run a user's build. Moving the CLI filesystem
build into Control would break that boundary; keeping source only in browser
storage would make the signed-in product lose work across browsers and devices.

## Decision

Control stores owner-authenticated `ANGEL.yaml` source drafts as data. The
browser compiles them:

1. The source-draft API is Account-scoped and owner-only. Control stores the
   source with the Angel's management state; Gateway and Broker never receive
   it. Public pages expose only the compiled trust-page projection.
2. The www bundle pins the same `@smcllns/angel-core` version as the hosted
   engine and imports the package-root compiler API. It calls
   `compileHostedAngel` on the draft in the browser.
3. For composed `angels:` policies, the compiler's source resolver fetches only
   same-Account sibling drafts through the authenticated Control API. The owner
   reviews the complete source and compiled policy before publish. If a sibling
   has no stored draft, the editor asks the owner to import its `ANGEL.yaml`;
   it never reconstructs source from a compiled artifact.
4. The browser sends only the resulting canonical artifact and digest through
   the existing publish contract. Control recomputes the digest and validates
   the artifact against the adapter registry as it does for CLI uploads.
5. A source draft is not a Version. Editing or saving it changes no deployed
   authority; only a successful publish creates an immutable Version.

This is not a server-side build service. Control stores source bytes and serves
them to their owner, but it never executes them.

## Feasibility check

At the pinned `@smcllns/angel-core@0.3.0`, the package root and
`compileHostedAngel` bundle successfully for a browser target. The `./build`
entry point is deliberately not used: it is the Node filesystem wrapper around
that compiler.

The check proves the boundary is viable, not that the current bundle size or
loading strategy is final.

## Consequences

- www and CLI share one source schema, compiler, artifact, and publish
  contract.
- Control gains an owner-only source store, but no runtime receives source and
  no server executes a user build.
- Composition is part of parity: the editor supports either `tools:` or
  `angels:` exactly as the source schema does.
- The pinned compiler version is visible in the editor and travels with the
  artifact's engine pin.
- Draft recovery, history, and collaboration remain ordinary source-product
  concerns; none may mutate a deployed Version.

## Rejected alternatives

- **Compile in Control.** Adds a server-side build boundary the hosted system
  does not need.
- **Keep drafts only in local browser storage.** Loses signed-in continuity and
  makes the web surface less durable than the CLI.
- **Invent a web-only policy schema.** Creates a second capability truth and
  makes parity impossible to test.

## Revisit when

Revisit browser bundle delivery if size or startup cost blocks the editor.
That may change how the fixed compiler is loaded, not which side of the publish
boundary runs it.

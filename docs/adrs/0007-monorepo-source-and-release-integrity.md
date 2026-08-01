# ADR 0007: Keep one source history while preserving package and deploy boundaries

- Status: Accepted
- Date: 2026-08-01
- Approval: Product Ledger WS1, approved by Sam on 2026-08-01

## Decision

`exocognito/angelmcp` is the canonical product repository. It owns:

- `packages/core`: the unchanged public `@smcllns/angel-core@0.3.0` package;
- `examples/angels`: the one checked-in portable example source;
- the hosted Broker, Gateway, Control, www, and docs source;
- one pnpm workspace and one lockfile; and
- package, clean-consumer, history, and Worker-bundle release proofs.

Core package history is rewritten from exact source commit
`8d08c42ff1fd47420f969d268d03ab0e0d7a3de9` with `git subtree split`, then
path-prefixed into `packages/core` and merged without squashing. The source,
package-split, path-prefixed, and merge mappings live in
`docs/evidence/ws1-core-history.json`. That record also stores the inherited
history secret-audit scope and zero-match result. Literal source commit IDs and
the `v0.2.0` tag remain in the archived `exocognito/angel-core-history` repository.

The public package keeps its name, version, exports, bin, dependencies, and
runtime bytes. O1 and later approved work own any public package rename or CLI
split. The root links the package with `workspace:0.3.0`; release proof installs
the packed tarball outside the workspace.

Repository topology does not collapse runtime topology. Broker, Gateway,
Control, www, and docs remain separate deployables. Existing Cloudflare
accounts, Worker names, routes, service bindings, Durable Object bindings,
environment values, and secrets stay separate.

**No runtime, auth, OAuth, policy, route, provider, product-flow, binding, or secret
change belongs to this migration.** WS1 corrects one displayed command by adding
the missing `--preview` flag; the command now matches existing opt-in behavior.

This record supersedes ADR 0004 repository ownership. ADR 0004's artifact,
compatibility, package-export, and deploy-boundary decisions remain current.

## Why

Separate source repositories made one product change require manual
reconciliation and allowed package, examples, docs, and hosted code to drift.
One history makes product changes reviewable together. Package and deploy
boundaries still provide the real compatibility and security controls.

## Release integrity

`pnpm run check:ws1` needs registry network access and the pinned toolchain. It
must hard-fail unless all of these remain true:

1. package file list and modes match the registry 0.3.0 baseline;
2. all package runtime bytes match that baseline;
3. package name, version, exports, bin, files, and dependencies stay fixed;
4. root, `/build`, `/cli`, and `angel` work from a packed clean install;
5. the rewritten history tip remains an ancestor; and
6. all three Worker JavaScript bundles match their pre-migration hashes after
   normalizing only the package source-path comments, and contain no Node
   filesystem or CLI code.

`package.json` repository metadata plus README command paths and the
`angel.version.v2` format correction are the only allowed packed-file
differences.

## Consequences

- The old core source repository becomes read-only history, not a second source.
- The public `exocognito/angels` starter stays an external-consumer surface. It
  does not own compiler or runtime source.
- A package or Worker byte change cannot hide inside a repository move.
- Final package identity, publication, install docs, and any package split stay
  outside WS1.

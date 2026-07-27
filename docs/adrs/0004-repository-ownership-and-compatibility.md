# ADR 0004: Assign repository ownership at the artifact boundary

- Status: Accepted
- Date: 2026-07-21

## Decision

The repositories have separate ownership boundaries:

| Repository | Owns |
| --- | --- |
| `exocognito/angels-comparison` | Executor, lite, and relay implementations; their legacy compiler/runtime; comparison research and tests |
| `exocognito/angels` | `@smcllns/angel-core`: portable `ANGEL.yaml` source schema; compiler; canonical `angel.version.v1` artifact schema and digest rules; target-neutral build/deploy CLI and management contract; portable policy source files and safe `angel.example.json` deployment examples |
| `exocognito/angel-cloud` | Hosted API implementation, Cloudflare Workers runtime, operational secrets/lifecycle, and hosted integration tests; depends on a pinned `@smcllns/angel-core` version |

`angel.version.v1` and the target-neutral management contract are the
compatibility boundary. The core compiler emits canonical, secret-free bytes
and a SHA-256 digest; every control plane validates and re-digests those bytes
before storing a Version. The core CLI reads `angel.json.target` as an opaque
HTTPS origin and knows neither Cloudflare nor Angel Cloud. Hosted and
self-hosted control planes implement the same strict request/response
contract. Changes to the artifact format or management surface require a new
format or an explicit compatibility decision in `angels`.

The cloud repository keeps small checked-in policy fixtures for deterministic
unit and golden tests. They are test inputs, not a second authoring source;
portable policies intended for reuse live in `angels`.

The package surface is deliberately narrow and explicit:

- `@smcllns/angel-core` is the Worker-safe compiler, artifact, crypto,
  decision, management-contract, and fetch-client interface;
- `@smcllns/angel-core/build` is the Node/Bun filesystem build interface;
- `@smcllns/angel-core/cli` is the deployment-config and command interface.

No wildcard subpath is exported. Hosted Worker code consumes only the root;
hosted build and acceptance tooling may consume the two explicit Node-side
entrypoints. This keeps internals private without forcing filesystem modules
into a Worker bundle.

## Why

This is the smallest independently installable split. The comparison repo can
continue to run its legacy variants without a private package dependency, the
hosted repo owns its deployment and operational lifecycle, and policy authors
can publish `angels` and use the same core package against a compatible
self-hosted Cloudflare control plane without checking out Angel Cloud.

No source implementation is copied between repositories. The legacy runtime
and portable Cloud runtime remain intentionally separate implementations with
different contracts; they are compared by behavior and artifacts, not by
shared source files.

## Rejected alternatives

- A private Git/package dependency from Cloud to `angels` as the contract itself:
  Cloud may depend on a versioned core package, but the portable CLI must not
  depend on the hosted product or make self-hosting require its checkout.
- A shared source subtree copied into both repos: it would create drift under
  the appearance of reuse.
- Keeping the hosted runtime in the comparison repo: it would leave the
  operational boundary and Cloudflare lifecycle coupled to research material.

## Distribution and history status

The three repositories now exist privately. `angels-comparison` was renamed in
place; `angels` and `angel-cloud` were seeded with their reviewed boundary
commits. `angels-private` remains an untouched private predecessor. Any future
public visibility requires a separate inherited-history audit.

The chosen transport is public `@smcllns/angel-core@0.1.0` from private source.
Angel Cloud pins that exact version and lockfile integrity, while only the
maintainer needs publish credentials. Consumers need no Git or npm credential.

The active feature work remains in the local candidates at
`/tmp/angel-m0.OSpGqf/angels` and `/tmp/angel-m0.OSpGqf/angels-cloud`, not in
the existing `/Users/smcllns/Projects/angels` checkout. The conservative M0
package is published under Sam's existing `@smcllns` npm scope. Its exact
tarball boundary, public-publish dry run, registry installation, and hosted
suite are verified.

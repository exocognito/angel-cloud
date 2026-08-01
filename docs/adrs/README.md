# Architecture decision records

The first five records were written in `exocognito/angels-comparison` between
2026-07-16 and 2026-07-24. That repository is now archived, so they live here.

Their decision rationale is preserved. An ADR states what was decided and why,
on a date; current implementation and repository annotations may be updated when
verified evidence lands. Material changes are also recorded below.

These records cover how the system is built. Decisions about what the product
does — URL grammar, defaults, what a stranger sees — live in
[product decisions](../product-decisions/README.md).

`Implemented` tracks the code, not the decision. The two columns are separate
because a decision can be settled and unbuilt for months, and that gap is
exactly what used to go missing.

| ADR | Decision | Still current? | Implemented | Tracked |
| --- | --- | --- | --- | --- |
| 0001 | Separate portable policy (`ANGEL.yaml`) from deployment (`angel.json`) | Yes | Yes | — |
| 0002 | Authenticated multi-connection selection | Yes | Yes | — |
| 0003 | Immutable version promotion | Partly — see below | Yes | — |
| 0004 | Repository ownership at the artifact boundary | Partly — ownership superseded by 0007; compatibility boundaries remain | Yes | — |
| 0005 | Derive execution from the same reviewed spec as policy | Yes | Yes — the Broker executes only the sealed template (`src/workers/broker.ts:206`); the compiler side ships in `@smcllns/angel-core` | — |
| 0006 | Store www source in Control and compile it in the browser | Yes | No | — |
| 0007 | One source history with separate package and deploy boundaries | Yes | Yes | WS1 |

ADR 0005 is the design of record for the sealed-request-template work. It
never merged in the comparison repo; it was recovered here from that repo's
`docs/adr-0005-spec-derived-execution` branch. Its invariant is unchanged; its
repository paths and landed implementation status were updated by WS1. The
record was nearly lost with that archive — the first of three near-misses that
produced the product-decisions convention.

## What has changed since

**ADR 0003's environment model is partly superseded.**
[PD 0003](../product-decisions/0003-preview-is-opt-in.md), 2026-07-28, moves
the second environment off the default publish path and renames it `preview`.
The digest-pinned promotion of exact bytes, which is the heart of the record,
is unchanged.

That same record also made preview share production Connections by default —
close to the "copy staging bindings automatically" that 0003 rejected — and
[PD 0005](../product-decisions/0005-preview-binds-its-own-connections.md)
withdrew it the same day. **ADR 0003's binding-isolation stance stands as
written.** Preview binds its own Connections; sharing production's is
available and must be asked for.

**ADR 0003's browser-surface exclusion is superseded.**
[PD 0006](../product-decisions/0006-www-is-a-full-write-surface.md),
2026-07-30, makes www a full-parity authoring and publishing surface. The
record changes the old API-first scope cut, not ADR 0003's core: every surface
still compiles the same canonical artifact and publishes immutable,
digest-pinned Versions through the same binding and promotion rules.

**The [artifact format](../core/format-v2.md) is `angel.version.v2`.** ADRs
0001 and 0004 name `angel.version.v1`. The compiler emits v2 and validation rejects anything else.
The shape of the decision holds: a canonical, secret-free byte string plus a
SHA-256 digest, re-validated by every control plane before a Version is stored.

**Repository ownership is superseded by ADR 0007.** ADR 0004's table describes
the split as it stood on 2026-07-21. Current ownership:

| Repository | Owns |
| --- | --- |
| `exocognito/angelmcp` | Canonical product source: `packages/core`, examples, hosted control plane, Workers runtime, www, docs, and release proofs |
| `exocognito/angels` | Public starter people fork to write their own Angels. External consumer only; no compiler or runtime source |
| `exocognito/angel-core-history` | Archived literal core history and old `v0.2.0` tag; no active source ownership |
| `exocognito/angels-comparison` | Archived executor, lite, and relay variants plus comparison research |
| `exocognito/angels-private` | Private scratch: exploration, design notes, images |

The compatibility boundary from ADR 0004 is unchanged: the core compiles and
digests, the control plane validates and enforces, and the CLI treats
`angel.json.target` as an opaque HTTPS origin. ADR 0007 changes where the source
lives, not those package or deploy contracts.

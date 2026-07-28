# Architecture decision records

These five records were written in `exocognito/angels-comparison` between
2026-07-16 and 2026-07-24. That repository is now archived, so they live here.

They are kept verbatim. An ADR states what was decided and why, on a date — it
is not a description of the system today. Where the world has since moved, the
change is recorded below rather than edited into the record.

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
| 0004 | Repository ownership at the artifact boundary | Partly — see below | Yes | — |
| 0005 | Derive execution from the same reviewed spec as policy | Yes | Yes — the Broker executes only the sealed template (`src/workers/broker.ts:185`); the compiler side ships in `@smcllns/angel-core` | — |

ADR 0005 is the design of record for the sealed-request-template work. It
never merged in the comparison repo; it is recovered here from that repo's
`docs/adr-0005-spec-derived-execution` branch, unchanged. It was nearly lost
with that archive — the first of three near-misses that produced the
product-decisions convention.

## What has changed since

**ADR 0003's environment model is partly superseded.**
[PD 0003](../product-decisions/0003-preview-is-opt-in.md), 2026-07-28, moves
the second environment off the default publish path, renames it `preview`, and
makes it share production Connections by default — close to the "copy staging
bindings automatically" that 0003 rejected. The digest-pinned promotion of
exact bytes, which is the heart of the record, is unchanged.

**The artifact format is `angel.version.v2`.** ADRs 0001 and 0004 name
`angel.version.v1`. The compiler emits v2 and validation rejects anything else.
The shape of the decision holds: a canonical, secret-free byte string plus a
SHA-256 digest, re-validated by every control plane before a Version is stored.

**Repository names have moved on.** ADR 0004's table describes the split as it
stood on 2026-07-21. Current ownership:

| Repository | Owns |
| --- | --- |
| `exocognito/angel-core` | The portable core — schema, compiler, artifact contract, target-neutral CLI. Publishes `@smcllns/angel-core`. Was `exocognito/angels` |
| `exocognito/angels` | Public starter people fork to write their own Angels. No compiler, no runtime. A new repository that reuses the freed name |
| `exocognito/angel-cloud` | This repository. Hosted control plane, Workers runtime, credential custody, operational lifecycle |
| `exocognito/angels-comparison` | Archived. Executor, lite, and relay variants plus the comparison research, read-only |
| `exocognito/angels-private` | Private scratch: exploration, design notes, images |

The boundary itself is unchanged, and that was the point of 0004: the core
compiles and digests, the control plane validates and enforces, and the CLI
treats `angel.json.target` as an opaque HTTPS origin so the same policy deploys
to the hosted service or a self-hosted one.

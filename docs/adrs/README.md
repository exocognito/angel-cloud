# Architecture decision records

These five records were written in `exocognito/angels-comparison` between
2026-07-16 and 2026-07-24. That repository is now archived, so they live here.

They are kept verbatim. An ADR states what was decided and why, on a date — it
is not a description of the system today. Where the world has since moved, the
change is recorded below rather than edited into the record.

| ADR | Decision | Still current? |
| --- | --- | --- |
| 0001 | Separate portable policy (`ANGEL.yaml`) from deployment (`angel.json`) | Yes |
| 0002 | Authenticated multi-connection selection | Yes |
| 0003 | Immutable version promotion | Yes |
| 0004 | Repository ownership at the artifact boundary | Partly — see below |
| 0005 | Derive execution from the same reviewed spec as policy | Yes — being implemented now |

ADR 0005 is the design of record for the sealed-request-template work in
flight. It never merged in the comparison repo; it is recovered here from that
repo's `docs/adr-0005-spec-derived-execution` branch, unchanged.

## What has changed since

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

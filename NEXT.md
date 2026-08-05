# Angel Cloud milestones

The plan of record is the Angel Product Ledger (`docs/product-ledger.html`); it
owns milestone sequence and status. [ROADMAP.md](ROADMAP.md) is the browsable
pointer for old links. For the broader
portable Angel ecosystem, see the comparison repository.

This file used to carry a second copy of the milestone record — the detailed
M0/M1 lists, the decisions locked on 2026-07-21, and operator notes. The Ledger
supersedes all of it and git history preserves it. Keeping two plans in one
repository is how one of them goes quietly wrong: by 2026-08-05 this file still
called public signup "not yet implemented" and still described the deleted
Cloudflare Access application as live, after both had changed.

What remains below is the one thing the Ledger has no row for.

## Debt anchors

ADR 0005 requires that a milestone shipping an operation ships its mechanism,
and that any shortcut stubbing that mechanism is **recorded here at the moment
of the cut** — "silent stubs are how a scope cut becomes the architecture". That
rule exists because a two-operation stub once cost a paused dogfooding cycle.

Record each anchor as the cut, its date, the mechanism that was stubbed, and
what would have to be true to call it done.

_No open debt anchors._

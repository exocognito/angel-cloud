# Roadmap

The canonical product goal, roadmap, next-milestone proposal, learning
reconciliation, and build-approval status live in the
[Angel Product Ledger](docs/product-ledger.html).

This file remains as a stable pointer for old links. The Product Ledger
supersedes the milestone list that used to live here. Git history preserves
that list and its completed M0/M1 record.

## Document ownership

- **Product Ledger:** final goal, roadmap order and status, learning disposition,
  open contradictions, and milestone approval.
- **Architecture decisions:** settled system boundaries and implementation
  choices in [docs/adrs](docs/adrs/README.md).
- **Product decisions:** settled user-facing choices in
  [docs/product-decisions](docs/product-decisions/README.md).
- **APRD:** the build contract for an approved next milestone. It derives from
  the Product Ledger and never owns the long-term roadmap.
- **Issues and plans:** implementation work below an approved milestone.

## Current gate

Sam approved Product Ledger contract v0.1, the Angel Product Ledger, and WS1 on
2026-08-01. Product/repository approval covers **WS1**, which starts after
dotfiles PR #307 and Angel PR #43 merge. Separate evidence-only approval covers
**WS-E** after WS1; its seven decision briefs authorize no product implementation. O10 then gates
**WS2 and Dogfood Round 2**, which remain proposed and unapproved. APRD v2
remains unapproved for implementation.

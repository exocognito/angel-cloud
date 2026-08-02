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

Sam approved Product Ledger contract v0.1 and the Angel Product Ledger on
2026-08-01. Product/repository approval covers WS1, now complete. Separate
evidence-only approval covers WS-E. WS-E is active. All seven briefs exist.
WS-E changed no product behavior, but corrected `docs/faq.md`, added an authoring
cross-reference in `docs/user-manual.md`, added the privacy caveat to PD 0002,
repaired stale plan-of-record pointers, blocked the target install contract on
O1, and reconciled the unapproved O2–O7 APRD, CLI, and eval contracts with the
evidence decisions. WS-E authorizes
no product implementation. O2–O7 and O9 are closed as decisions. O1 blocks
WS-E closure because control of the recommended `@angelmcp` npm namespace is
unverified. O10 waits until that gap closes. **WS2 and Dogfood Round 2**
remain proposed and unapproved. APRD v2 remains unapproved for implementation.

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
evidence-only approval covers WS-E, also complete. WS-E changed no product
behavior, but corrected `docs/faq.md`, added authoring cross-references in
`docs/user-manual.md` and `docs-site/public/SKILL.md`, recorded O7 in PD 0007,
repaired stale plan-of-record pointers, blocked the target install contract on
O1, applied LR-016's outside-candidate/internal-grader split to the eval draft,
and reconciled the unapproved O2–O7 APRD, CLI, and eval contracts with the
evidence decisions.

On 2026-08-03 Sam closed the last two decisions. O1 fixes the public package as
`@angelmcp/cli@0.1.0`, to be installed with `bun add --global
@angelmcp/cli@0.1.0`; he created the `@angelmcp` npm org, and control is
verified. WS2 has since built that package and proved its clean install, but it
is unpublished, so the command becomes normative on publication. O10
approves **WS2 and Dogfood Round 2** as the seven WS-E briefs define them, with
two choices attached: a deleted Account handle becomes a permanent non-resolving
tombstone and re-signup takes a new handle; public charter text and guard
literals stay public with a documented boundary. Every decision is now closed;
what remains is execution proof. APRD v2 remains unapproved for implementation.

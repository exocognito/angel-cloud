# Roadmap

The canonical product goal, roadmap order and status, the commitments each epic
keeps, and build-approval status live in the
[Angel Product Ledger](docs/product-ledger.html), generated from
`datarooms/angel-cloud.json`.

This file remains as a stable pointer for old links. The Product Ledger
supersedes the milestone list that used to live here. Git history preserves
that list and its completed M0/M1 record.

## Document ownership

- **Product Ledger:** final goal, roadmap order and status, the commitments each
  epic keeps, and milestone approval. It no longer carries a learning-disposition
  table or an open-contradictions register: `ledger-roadmap/v0` has no surface for
  either. A finding that is still open is recorded on the gate it blocks; the
  round records themselves are in [dogfooding](docs/dogfooding/README.md) and
  [evidence](docs/evidence/).
- **Architecture decisions:** settled system boundaries and implementation
  choices in [docs/adrs](docs/adrs/README.md).
- **Product decisions:** settled user-facing choices in
  [docs/product-decisions](docs/product-decisions/README.md).
- **APRD:** the build contract for an approved next milestone. It derives from
  the Product Ledger and never owns the long-term roadmap.
- **Issues and plans:** implementation work below an approved milestone.

## Reading documents written before 2026-08-05

The Ledger became a generated artifact on 2026-08-05: `datarooms/angel-cloud.json`
is the source and `docs/product-ledger.html` is rendered from it. Documents dated
before that — the WS-E evidence briefs especially — cite Ledger record ids in their
"sources read" lists. Those lists are a dated record of what was consulted, so they
are left as written. Where each id went:

- **Epics** (M0, M1, WS0, M-DF1, WS1, WS-E, WS2, M-DF2, WS3, WS4) and **deliverables**
  (ID-01 to ID-10, PD-00A, PD-00B, PD-01 to PD-07) keep their ids.
- **Guarantees G01 to G14** keep their ids and are now commitments.
- **Decisions O1 to O10** are retired as Ledger rows, and they do not all live in one
  place. O1 to O7 and O9 were each decided from one [WS-E evidence
  brief](docs/evidence/ws-e/), which records the ruling under `Decision: O#`. O7 also has
  a product decision, [PD 0007](docs/product-decisions/0007-capability-only-public-review.md).
  O8 and O10 are owner approvals with no brief: O8 is recorded on
  [PR #43](https://github.com/exocognito/angelmcp/pull/43#issuecomment-5152622328), and
  O10 in this file and in PD 0007. Where a decision widened a commitment, that commitment
  names it in `notYet.declaredIn`.
- **Contradictions C1 to C16** are retired. The one still open, C16, is a finding on
  the WS2 gate.
- **Scenarios S1 to S3**, **Experience EW1 to EW6**, **Machinery MW1 to MW9**,
  **interfaces SI1 to SI6**, **commands C01 to C13** and the **113 learnings**
  (DF, LR, FB) have no surface in `ledger-roadmap/v0`. Their product truth was folded
  into the commitment or work row it belonged to; the rest is in git history.

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
verified. WS2 built that package and published it on 2026-08-03 as
`@angelmcp/cli@0.1.0`, from a `cli-v0.1.0` tag through npm trusted publishing
with provenance, so `bun add --global @angelmcp/cli@0.1.0` is now the real
install command. O10
approves **WS2 and Dogfood Round 2** as the seven WS-E briefs define them, with
two choices attached: a deleted Account handle becomes a permanent non-resolving
tombstone and re-signup takes a new handle; public charter text and guard
literals stay public with a documented boundary. Every decision is now closed;
what remains is execution proof. APRD v2 remains unapproved for implementation.

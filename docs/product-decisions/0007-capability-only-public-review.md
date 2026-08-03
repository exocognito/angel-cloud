# PD 0007: Public review is a capability-only summary

- Status: Agreed
- Date: 2026-08-01
- Implemented: No — the current public page still implements [PD 0002](0002-public-angel-page.md)
- Tracked: [WS-E PR #46](https://github.com/exocognito/angelmcp/pull/46), Product Ledger O7

## Decision

The reduced public-summary decision (Product Ledger O7) makes
`angel.public-review.v1` a capability-only summary when it ships. Its strict payload contains:

- `schema: "angel.public-review.v1"`;
- `disclosure: "capability-summary-only"`;
- the artifact format;
- canonical operation names;
- guard-presence booleans; and
- a hiding artifact commitment.

It excludes the exact artifact, request templates, scopes, adapter origin,
guard literals, owner identity, deployment data, Version number, nonce,
installation, `identityLabel`, and Connection ids. Fixed,
non-Version-specific provenance and limitation copy may remain outside the
strict payload.

A Version whose raw digest was ever public is permanently ineligible for a
hiding claim: removing the digest later cannot erase an observer's cached copy.
Do not emit `angel.public-review.v1` with a hiding claim for that Version. Show
an explicit non-hiding legacy warning, then retire or replace it with a Version
that has different canonical bytes whose raw digest has never been public.

For each eligible published Version, generate one 32-byte random nonce. Store it
owner-only with that Version's evidence, reuse it for all public responses for
that Version, and delete it through the Account-deletion cascade. Before serving
the summary, prove that no public surface has ever exposed that Version's raw
digest and that none exposes it now. The Version number remains excluded from
the strict summary because it is operational metadata that can reveal publish
and activity cadence. The public
renderer may use the nonce only to derive the commitment. It never renders the
nonce itself.

The unapproved APRD currently names this acceptance contract
[E16 in the APRD's Evidence contracts list](https://github.com/exocognito/angelmcp/blob/main/docs/aprd/angel-cloud-aprd.html).
The proof requirement stands however that draft contract is renumbered: release
still needs exact leak, parity, cached-digest eligibility, and stable-commitment
tests.

## Relationship to PD 0002

This record partly supersedes PD 0002's content list when the reduced summary
ships. It does not change the shipped page today. PD 0002 remains the record of
the current trust page until this decision passes its release proof.

## Settled at O10 on 2026-08-03

- **Privacy of user-authored charter and guard literals outside the strict
  summary.** They stay public. The owner chose a documented boundary over
  narrowing the fields or moving them to a separate opt-in surface. Owners must
  keep private content out of `charter` and `argGuards`. See
  [the current public boundary](../faq.md#why-is-enforcement-not-done-by-the-model-or-a-prompt)
  and the canonical `docs/product-ledger.html` records O7, SI5, and O10.

## What is not decided

- **Widening public content.** Whether another public surface ever shows OAuth
  scopes, provider adapters, or child Angels remains open.

## Consequences

- A public commitment is called hiding only for an eligible Version whose raw
  digest has never been public. Current digest exposure must stay absent.
- Owner-opted-in public source disclosure remains separate from this summary.
- O10 approved WS2 on 2026-08-03, so implementing the summary and its release
  proof is now an execution gate rather than a decision.

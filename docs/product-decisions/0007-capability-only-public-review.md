# PD 0007: Public review is a capability-only summary

- Status: Agreed
- Date: 2026-08-01
- Implemented: No — the current public page still implements [PD 0002](0002-public-angel-page.md)
- Tracked: [WS-E PR #46](https://github.com/exocognito/angelmcp/pull/46), Product Ledger O7

## Decision

The reduced public-summary decision (Product Ledger O7) makes
`angel.public-review.v1` a capability-only summary when it ships. Its strict payload contains:

- the format name;
- canonical operation names;
- guard-presence booleans; and
- a hiding artifact commitment.

It excludes the exact artifact, request templates, scopes, adapter origin,
guard literals, owner identity, deployment data, Version number, nonce,
installation, `identityLabel`, and Connection ids. Fixed,
non-Version-specific provenance and limitation copy may remain outside the
strict payload.

Before `angel.public-review.v1` is served for a Version, the raw policy digest
must leave or be gated on every public surface for that Version. The Version
number remains excluded from the strict summary because it is operational
metadata that can reveal publish and activity cadence.

Generate one 32-byte random nonce for each published Version. Store it
owner-only with that Version's evidence, reuse it for all public responses for
that Version, and delete it through the Account-deletion cascade. The public
renderer may use the nonce only to derive the commitment. It never renders the
nonce itself.

The unapproved APRD currently names this acceptance contract
[E16 in the APRD's Evidence contracts list](https://github.com/exocognito/angelmcp/blob/main/docs/aprd/angel-cloud-aprd.html).
The proof requirement survives if O10 changes, renumbers, or rejects that draft
contract: release still needs exact leak, parity, same-Version digest-gate, and
stable-commitment tests.

## Relationship to PD 0002

This record partly supersedes PD 0002's content list when the reduced summary
ships. It does not change the shipped page today. PD 0002 remains the record of
the current trust page until this decision passes its release proof.

## What is not decided

- **Privacy of user-authored charter and guard literals outside the strict
  summary.** Their final treatment remains for the WS2 approval gate (O10). See
  [the current public boundary](../faq.md#why-is-enforcement-not-done-by-the-model-or-a-prompt)
  and the canonical `docs/product-ledger.html` records O7, SI5, and O10.
- **Widening public content.** Whether another public surface ever shows OAuth
  scopes, provider adapters, or child Angels remains open.

## Consequences

- A public commitment is called hiding only after all same-Version public
  surfaces remove or gate the raw digest.
- Owner-opted-in public source disclosure remains separate from this summary.
- WS2 must implement the summary and its release proof only after O10 approval.

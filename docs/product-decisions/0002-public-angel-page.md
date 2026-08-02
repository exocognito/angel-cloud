# PD 0002: Every Angel has a public page anyone can read without a key

- Status: Agreed
- Date: 2026-07-23; design settled 2026-07-29
  ([the five decisions](https://github.com/exocognito/angelmcp/issues/11#issuecomment-5123175434))
- Implemented: Yes — [#28](https://github.com/exocognito/angelmcp/pull/28);
  the Gateway answers `GET` on the bare production coordinate until the DNS
  cutover moves the renderer to the apex
- Tracked: [#11](https://github.com/exocognito/angelmcp/issues/11)

## Decision

An Angel has a public page at its bare coordinate:
`angelmcp.ai/@account/angel`. No key, no login, no credential touched.

Recorded in the host table in
[domain-architecture.md](../domain-architecture.md), which assigns the apex
"marketing site, plus public Angel www pages at `/@account/angel`".

## Why

An Angel is a thing you hand to someone. Before this page, the only way to
learn what one does was to hold a key and call `tools/list` over MCP — so an
Angel could not be shared, cited, or read before it is trusted.

The self-hosted worker already proved the shape: it answered `/healthz`,
`/tools`, and a rendered help page at `/`, all unauthenticated, touching no
credential and no runtime state. Angel Cloud dropped that surface when the
Gateway became key-only, and this page replaces it.

## The settled design

Design settled with Sam on 2026-07-29, recorded on
[#11](https://github.com/exocognito/angelmcp/issues/11#issuecomment-5123175434):

1. **Placement.** The Gateway answers `GET` on the bare coordinate now, with
   the renderer as its own module so it lifts to the apex dispatcher at the
   DNS cutover. Post-cutover, `mcp.` GET redirects to the apex.
2. **Content — the trust page.** The current page shows charter, tools (provider
   app + operation), argument guards, Version number, raw policy digest, and the
   line that the artifact is immutable and compiled from ANGEL.yaml. When the
   reduced summary ships, the Version number and raw policy digest leave the
   public projection under the [privacy requirement](#what-is-not-decided).
   Fixed, non-Version-specific provenance and limitation copy may remain outside
   the strict payload. Not shown: OAuth scopes, provider adapters, or children
   (this record may widen those later).
3. **Visibility.** Public by default. No opt-out toggle yet — one account
   exists; the field arrives with the second account. A non-public Angel,
   when the toggle exists, must 404 identically to a nonexistent one.
4. **Preview.** No page. `GET …@preview` (and pinned `@N`) return the same
   404 as an unknown coordinate. Production's bare URL is the one public
   address.
5. **Machine output.** Content negotiation on the same GET — HTML by
   default, JSON for `Accept: application/json`, with `Vary: Accept`. One
   renderer input, two serializers, so the two cannot diverge.

Shipped invariants, each pinned by a current test: the page is read-only and
never touches the Broker, custody, or keys; the current renderer takes the
compiled artifact and Version number only, never the installation, so
`identityLabel` and Connection ids cannot leak; every page-route 404 is
byte-identical; no cookies exist on the public surface.

The unbuilt reduced-summary renderer may use the owner-held per-Version nonce
only to derive the commitment. Before release, E16 must pin that it never renders
the Version number, nonce, installation, `identityLabel`, or Connection ids. This
target must be pinned by E16 before the summary ships.

## What is not decided

- **Privacy beyond the reduced summary.** The reduced public-summary decision
  (Product Ledger O7) is settled but not built. Before the
  `angel.public-review.v1` summary is served for a Version, every public surface
  for that Version must remove or gate the raw policy digest. Broader privacy
  treatment for user-authored charter and guard literals remains for the WS2
  approval gate (O10). See
  [the current public boundary](../faq.md#why-is-enforcement-not-done-by-the-model-or-a-prompt)
  and the canonical `docs/product-ledger.html` records O7, SI5, and O10.
- **Widening the content.** Whether the page ever shows OAuth scopes,
  provider adapters, or child Angels stays open; today they are excluded.
- **The retired-handle 301.** PD 0004 wants human-facing pages to redirect a
  retired handle to the current one. The Gateway's handle replica cannot
  tell a retired name from a current one, so the page answers retired
  handles directly (as MCP does) until the directory carries that
  distinction.

## Consequences

- The page is read-only and must never touch the Broker, custody, or a key.
- Public pages are user-shaped content on a shared apex, so no auth cookie is
  ever scoped to `.angelmcp.ai` — sessions stay host-only on `dash.` and
  `auth.`.
- Serving the page needs the coordinate from
  [PD 0001](0001-angel-coordinate-scheme.md), which the Gateway route grammar
  now carries.

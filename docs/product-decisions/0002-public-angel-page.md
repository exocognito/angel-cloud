# PD 0002: Every Angel has a public page anyone can read without a key

- Status: Agreed
- Date: 2026-07-23
- Implemented: No
- Tracked: [#11](https://github.com/exocognito/angel-cloud/issues/11)

## Decision

An Angel has a public page at its bare coordinate, served from the apex:
`angelmcp.ai/@account/angel`. No key, no login, no Durable Object touched.

Recorded in the host table in
[domain-architecture.md](../domain-architecture.md), which assigns the apex
"marketing site, plus public Angel www pages at `/@account/angel`".

## Why

An Angel is a thing you hand to someone. Right now the only way to learn what
one does is to hold a key and call `tools/list` over MCP — so an Angel cannot
be shared, cited, or read before it is trusted.

The self-hosted worker already proved the shape: it answered `/healthz`,
`/tools`, and a rendered help page at `/`, all unauthenticated, touching no
credential and no runtime state. Angel Cloud dropped that surface when the
Gateway became key-only, and nothing replaced it.

## What is not decided

This record exists to mark a settled intent with an unsettled design. Still
open:

- **What the page shows.** Charter and tool list at minimum, but whether it
  exposes guards, the policy digest, or the Version number is unresolved.
- **Whether the policy is public by default** or the Account opts in per
  Angel. A tool list is a description of reach; some owners will not want it
  indexed.
- **Whether staging has a page at all**, or only production.
- **What a machine gets.** The self-hosted worker served JSON at `/tools` and
  HTML at `/`; one content-negotiated route or two paths is an open call.

## What runs instead today

The Gateway has exactly two routes: the internal gate dispatch, and the MCP
endpoint. The MCP route rejects everything but POST and requires a bearer key
before it reads a single byte of the body. A browser visiting an Angel URL
gets `405`.

That 405 is the whole gap, and it is what a person hits first.

## Consequences

- The page is read-only and must never touch the Broker, custody, or a key.
- Public pages are user-shaped content on a shared apex, so no auth cookie is
  ever scoped to `.angelmcp.ai` — sessions stay host-only on `dash.` and
  `auth.`.
- Serving the page needs the coordinate from
  [PD 0001](0001-angel-coordinate-scheme.md); the current route grammar has
  nowhere to put it.

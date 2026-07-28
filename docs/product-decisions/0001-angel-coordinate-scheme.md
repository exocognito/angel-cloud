# PD 0001: Address every Angel as `@account/angel[@suffix]`

- Status: Agreed
- Date: 2026-07-23
- Implemented: No
- Tracked: [#3](https://github.com/exocognito/angel-cloud/issues/3)

## Decision

One coordinate addresses an Angel on every surface:

```
@<account>/<angel>[@<environment-or-version>]
```

`@smcllns/inbox-zero` is production. `@smcllns/inbox-zero@staging` is the
second environment — renamed `@preview` on 2026-07-28, see Amended below.
`@smcllns/inbox-zero@3` is pinned Version 3.

Bare means production. `latest` and `production` are reserved and invalid as
suffixes, so production has exactly one spelling and every Angel has one
canonical URL. The grammar and its validation pattern are stated as reference
in [domain-architecture.md](../domain-architecture.md).

## Why

The URL people say most often should be the shortest. Most users should never
type an environment at all; the suffix is what a power user reaches for, not
a toll every user pays.

Precedent is npm's `@scope/name@tag`. The leading `@` is the account sigil
everywhere — it also removes path collisions with marketing pages on the apex.
The trailing `@suffix` is the environment axis, so switching a URL between
production and staging is appending or removing eight characters, and which
one you are looking at is unmissable.

The suffix is one axis, not two. An environment is a mutable pointer to a
Version, so the suffix always answers the single question "which deployment
pointer, or which pinned snapshot?" — "Version N *in* environment E" does not
exist as an address.

## Rejected alternatives

- **A distinct leading sigil per environment** (e.g. `$account/angel` for
  staging). `$`, `~`, `!`, and `;` all collide with shell expansion or syntax,
  so pasted URLs break silently in terminals; a changed sigil visually mutates
  the account token, reading as a different namespace rather than a different
  environment; it is unpronounceable; and versions would still need the
  `@suffix`, leaving two grammars where one suffices. `@` is the rare symbol
  that is both URL-legal and shell-inert, so it is spent on the account
  namespace alone.
- **An open suffix set.** The alternation stays closed and product-defined, so
  a typo is a 404 rather than a silent new environment.

## Consequences

- Account handles and Angel names must never contain `@`.
- `@<account>` names an Account, not a human — one login enters one Account,
  and a Family handle is shared by its members.
- Staging and production stay independently addressed, matching the
  exact-promotion model in [ADR 0003](../adrs/0003-immutable-version-promotion.md).

## What runs instead today

The Gateway serves one route:

```
/v1/a/{account}/{angel}/{staging|production}/mcp
```

Production is not the default — it is spelled out in full. There is no `@`
anywhere. Every client already pinned to this shape is a future migration:
MCP client configs, the CI acceptance variables, and at least one 1Password
entry.

This gap has no dependency on owning `angelmcp.ai`. The coordinate would work
on the current `workers.dev` host today, so the two are separable and only
the host move is tracked.

## Amended

The suffix vocabulary was left open here and settled on 2026-07-28 by
[PD 0003](0003-preview-is-opt-in.md): the slot reads `@preview`, not
`@staging`. The grammar, the one-axis rule, and everything else above are
unaffected — it edits one alternation in one pattern.

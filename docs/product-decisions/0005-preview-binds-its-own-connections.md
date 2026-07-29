# PD 0005: Preview binds its own Connections

- Status: Agreed
- Date: 2026-07-28
- Implemented: Partly — a preview deploy takes only its own explicit bindings
  and an unbound one fails naming both ways forward; the typed share flag is
  CLI surface and waits on `@smcllns/angel-core`
- Tracked: [#3](https://github.com/exocognito/angel-cloud/issues/3)
- Supersedes: point 3 of [PD 0003](0003-preview-is-opt-in.md)

## Decision

1. **Preview binds its own Connections.** It does not inherit production's.
2. **A preview publish with no preview bindings fails**, and the error names
   the two ways forward: bind a Connection to preview, or ask explicitly to
   share production's.
3. **Sharing production credentials stays supported and stays typed.** It is a
   thing someone asks for, never a thing that happens to them.

Points 1 and 2 of PD 0003 are unaffected: `angel publish` still deploys to
production, and the second environment is still called `preview`.

## Why the earlier decision does not survive its own record

PD 0003 justified shared credentials from observed practice:

> The only real `angel.json` in existence names the same Connection for staging
> and production. The separate-bindings rule was being satisfied by typing the
> same answer twice.

That measurement was taken in a world where `angel publish` forced every user
through staging. Staging was not chosen there; it was the only road. So a
single config naming the same Connection twice says nothing about what someone
wants from a second environment — it says the second environment was
unavoidable.

Points 1 and 2 of the same record removed that road. Everyone who reaches
preview afterwards has typed `--preview` deliberately. The evidence and the
conclusion describe different populations, and only the evidence is old.

## Why opting in is the signal

Asking for preview *is* the statement that this Angel needs somewhere to run
that production is not. Answering that request by wiring it to production's
credentials returns the opposite of what was asked, to the only group that
asked for anything.

The cost of the earlier default landed unevenly, too. Read-only Angels lose
little. An Angel whose tools write sends a previewed, unreviewed Version at the
live mailbox — and the word on the tin says preview.

## The hazard this removes

PD 0003 carried a section headed "The hazard this creates", conceding that
"preview" would stop meaning safe and assigning the implementation the job of
making the shared-credential state impossible to miss — at deployment time, on
the preview surface, and harder still for Angels that write.

None of that is needed now. The warning was compensating for the default, so
changing the default retires the warning rather than relocating it. A decision
whose record has to explain how to survive it is worth re-reading.

## The cost this accepts

Isolation is not free. A second Google Connection is a separate OAuth grant,
most likely against a separate test account, and the first `angel publish
--preview` now stops rather than proceeding.

That stop is the point. It is one instruction at the moment of choice, paid by
someone who has already opted into a second environment, in exchange for
never silently pointing an unreviewed Version at real data. Recovering quietly
would trade a visible cost for an invisible one — the trade this project
declines by default.

## Relationship to ADR 0003

[ADR 0003](../adrs/0003-immutable-version-promotion.md) rejected copying
staging bindings automatically, on the grounds that it violates environment
isolation. PD 0003 overrode that as a product call. This record withdraws the
override, so ADR 0003's isolation stance stands as originally written.

Digest-pinned promotion of exact bytes was never in question in either record.

## Open

- Whether an Angel with no write-capable tools should be allowed to share
  production credentials without the explicit ask. Tempting, and it makes the
  rule conditional on policy analysis at publish time. Not now.
- The exact flag spelling. `--share-production-credentials` is indicative and
  lands with the implementation, alongside PD 0003's open question on the
  spelling of `--preview` itself.
- PD 0003 asked whether promotion from preview needs a confirmation step once
  bindings are shared by default. With bindings no longer shared by default,
  that question loses its trigger and is closed unanswered.

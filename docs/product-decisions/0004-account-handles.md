# PD 0004: Account handles are permanent, renameable once, and never released

- Status: Agreed
- Date: 2026-07-28
- Implemented: No
- Tracked: [#12](https://github.com/exocognito/angel-cloud/issues/12)

## Decision

1. **A handle is unique platform-wide and never released.** Changing it does
   not free the old one. A retired handle stays bound to the Account that held
   it, forever, and nobody else can ever take it.
2. **One rename, ever.** An Account gets at most two handles across its life.
3. **The old handle keeps working, without a redirect.** Handle lookup
   resolves retired names to the same Account, so an MCP call to the old
   coordinate is answered directly with 200. Human-facing pages send a 301 to
   the canonical handle.
4. **Four characters minimum.** One to three characters are reserved for the
   platform rather than rejected as invalid.
5. **Account handles only.** Angel names are out of scope — see below.

## Why never released

GitHub frees a renamed repository name and redirects the old one, so the
redirect can later land on a repository owned by someone else. That failure
fired here on 2026-07-27: after `exocognito/angels` was renamed and the freed
name reused by a new starter repository, a stale remote in the core clone
resolved through the redirect to the wrong repository. `--force-with-lease`
refused the push and caught it. Nothing else in the chain would have.

An Angel coordinate is a worse place for that failure than a git remote. It
sits in MCP client configs nobody re-reads, and agent keys are scoped per
environment rather than per name — so a coordinate that quietly changes owner
can point a live agent at a stranger's Angel with its own key still attached.

Retaining the name removes the failure by construction. A redirect can only
ever reach the Account that already owned it, which is what makes decision 3
safe.

## Why resolve rather than redirect

Redirecting an authenticated POST needs 307 to preserve the method and body,
and depends on every MCP client following redirects with the `Authorization`
header intact — behaviour in code we do not control. Resolving the alias
server-side has none of those failure modes: the request is answered where it
arrives.

Redirects still make sense for pages a person reads, where a canonical URL in
the address bar is the point.

## Why one rename

Because names are never released, each rename permanently consumes a second
name from a global namespace. Without a cap, an Account can accumulate
reserved handles by renaming repeatedly. One rename puts the ceiling at two
names per Account, which is enough for a typo or a life change and not enough
to hoard.

## Why four characters

One to three character handles are the first to be squatted and the ones the
product is most likely to want. Holding them costs nothing now and cannot be
undone later if they are given away.

## Angel names are out of scope

Angel names sit in MCP configs exactly as handles do, so the same reasoning
appears to apply. It does not, because **renaming an Angel is not an
operation that exists.**

The CLI already refuses an inconsistent name: the built artifact must match
the folder and `angel.json`, checked three times over. Renaming means changing
all three together, and `ensureAngel` (`src/management.ts:213-240`) then finds
no Angel with the new slug and creates one, with its own environments and its
own freshly minted keys. The original stays deployed, live, and bound to its
Connections.

So there is nothing to alias, because there is no rename to alias. That is a
missing operation rather than a naming-policy question, and it is tracked in
[#13](https://github.com/exocognito/angel-cloud/issues/13).

## Open

- Whether a retired handle should be visibly retired — an Account listing its
  old handle, or the alias staying silent.
- Confirmable lookalikes. `[a-z0-9-]` blocks unicode homoglyphs, but `rn`/`m`
  and `1`/`l` still permit near-duplicates. Not worth solving at one Account;
  worth deciding before public signup ([#8](https://github.com/exocognito/angel-cloud/issues/8)).

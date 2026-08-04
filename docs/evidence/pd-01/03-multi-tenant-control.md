# PD-01 — the dashboard serves whoever signed in

Run 2026-08-04 against the deployed `angelmcp-control-demo` and `angelmcp-auth`
Workers, from outside the repo. Three people signed up through the sign-in page
and their links were read out of a real inbox. Addresses are redacted here;
Account ids are not, because they are opaque and the run is the record.

This continues [02-better-auth-cutover.md](02-better-auth-cutover.md), which
left a person able to sign up and get an Account that nothing could reach.

## What changed

Control took its Account from `env.ACCOUNT_ID`, so it served one Account
whoever asked, and Cloudflare Access turned everyone else away at the edge. The
Account now comes from the session: Control asks the sign-in Worker who is
calling, over a service binding, forwarding the caller's own credential.

Both Workers moved onto `angelmcp.ai` — `auth.` and `dash.`. That is a
prerequisite rather than a polish. `workers.dev` is on the Public Suffix List,
so no cookie can span two Workers there, and the dashboard could never have
seen a session issued by the sign-in Worker.

The Cloudflare Access application "Angel Cloud Control" was deleted the same
day. Access was also the login page, so this run is the first where the login
page is ours.

## The loop

`POST https://dash.angelmcp.ai/api/sign-in {"email":"…"}` → `200 {"status":true}`

The dashboard proxies this to the sign-in Worker over the service binding, so
the browser stays on one origin and no CORS grant exists. The caller's
`cf-connecting-ip` travels with it, which is what keeps the per-source cap O4
requires meaningful.

Mail arrives from `noreply@e4.angelmcp.ai` carrying a link to
`auth.angelmcp.ai/v1/auth/magic-link/verify`.

Clicking it → `302` to `https://dash.angelmcp.ai/` with
`__Secure-better-auth.session_token`, `Domain=.angelmcp.ai`, `HttpOnly`,
`Secure`, `SameSite=Lax`, `Max-Age=1209600`.

## What was checked, and what came back

| Check | Result |
|---|---|
| A stranger loads the dashboard | `200` — the shell, then the sign-in page |
| That stranger asks for Account data | `401 {"error":"sign-in required"}` |
| Three people sign up | three Accounts, three distinct `acct_*` ids |
| Each opens the dashboard | each sees only their own |
| One is initialized, the others read again | the other two stay uninitialized |
| A signed-in person asks for another's handle | `404 {"error":"not found"}` |
| …for an Account that never existed | `404 {"error":"not found"}` — byte-identical |
| …for a real Account, uninitialized, not theirs | `404 {"error":"not found"}` — byte-identical |
| Reset, with the session cookie and the admin bearer together | `200` |

The three answers in the middle of that list are G07 in one line: cross-Account
resources are indistinguishable from absent ones. Nothing in the response tells
the caller whether the Account they named exists, because
`requireAuthenticatedAccount` refuses before anything is looked up.

## What the live run found that the tests had not

**An unrelated bearer token destroyed a valid session.** The dashboard's reset
button sends the admin token in `Authorization` while the browser attaches the
session cookie. Control forwarded both, Better Auth's bearer plugin read the
admin token as the session, failed to resolve it, and refused somebody who was
properly signed in — `401` to a live session. The cookie now wins whenever both
are present. A bearer alone still works, which is what the CLI will have.

**A spent link stranded people on the wrong Worker.** `callbackURL` was
relative, so it resolved against the sign-in Worker's own origin and the
redirect landed on `auth.angelmcp.ai/`, which serves nothing. Where a link
lands is now decided by Control and the caller cannot name it — which is also
the narrowest reading of O4 clause 8, since the allowlist has one entry that
nobody outside can choose.

Both are pinned by tests that fail with the fix reverted.

## The management surface lost its token

`/v1/` required `MANAGEMENT_API_TOKEN` as well as an identity. Every route
already ended in `requireAuthenticatedAccount`, which is what bounded it; the
token named no Account and so bounded nothing. Under Access that did not show,
because the identity was `env.ACCOUNT_ID` and the same for everyone, leaving the
shared token to do the real work.

With the identity now naming one Account, keeping a shared secret beside it
could only widen what the session already bounds. It was removed rather than
scoped. SI3 asks for a *strict* Account-scoped management contract, and strict
is what the session gives.

## The WS1 bundle baseline moved, and what it now means

`scripts/ws1-release-integrity.ts` pins each Worker's normalized bundle to
`docs/evidence/ws1-release-baseline.json`, and Control's hash changed here for
the first time since that file was written. Broker and Gateway are still
byte-identical, which is worth stating: the guard was not blanket-updated.

The number's meaning changed with it. It was captured to prove the monorepo
migration altered no runtime bytes; Control's source has now legitimately
changed, so for Control it records the last approved build rather than the
pre-migration one. That is a weaker claim, and it should be read as one. The
migration question it was built to answer is closed; the guard's remaining use
is catching a bundle that moves when no source did.

## Not in this run

The pilot Account. `acct_m1` was left behind by owner decision on 2026-08-04:
its Durable Object state stays on disk and nothing routes to it, so the pilot
Angels are dark. Nothing was deleted.

The CLI hand-off is still separate, and it is the piece that will want a
credential outliving a fourteen-day session.

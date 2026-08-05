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

**One named exception, and it is not covered by the above.**
`PUT /v1/accounts/{a}/handle` answers `409 "handle is taken, and handles are
never released"` when the name belongs to another Account, and `200` when it
does not (`src/handles.ts:138`). That is a cross-Account resource plainly
distinguishable from an absent one. It is reachable by anyone who signs up,
where before the shared token bounded it to the operator.

A claim endpoint cannot hide availability by construction — answering the same
thing whether or not a name is free would make claiming impossible — so this is
a product question rather than a defect to fix here: is the handle namespace
public, as it is on every signup form that says a username is taken?

`docs/product-decisions/0004-account-handles.md` defers its naming-policy
questions to public signup, but this one is not among them: its **Open** list
covers retired-handle visibility and confirmable lookalikes
([#8](https://github.com/exocognito/angelmcp/issues/8)), not whether existence
is observable. It has been added there by this work. Signup is now live, so it
is due. Until it is answered, read G07 as holding for reads and not yet for the
claim path, rather than as holding outright.

## What the live run found that the tests had not

**An unrelated bearer token destroyed a valid session.** The golden runner's
reset sends the admin token in `Authorization` while the session rides as a
cookie, exactly as a browser sends it. Control forwarded both, Better Auth's
bearer plugin read the admin token as the session, failed to resolve it, and
refused a caller who was properly signed in — `401` to a live session. A cookie
that carries a session now wins over a bearer. A bearer alone still works, which
is what the CLI will have.

Review narrowed that rule afterwards, and the narrowing matters: "any cookie
wins" would have been wrong once the cookie is scoped to the whole zone. The
browser attaches every cookie any sibling host has set, so a caller holding an
unrelated `.angelmcp.ai` cookie plus a real bearer would have had its bearer
suppressed by a jar that never contained a session. Control now looks for
`better-auth.session_token` by name — prefixed or not — and falls through to the
bearer when it is absent.

**A spent link stranded people on the wrong Worker.** `callbackURL` was
relative, so it resolved against the sign-in Worker's own origin and the
redirect landed on `auth.angelmcp.ai/`, which serves nothing. Where a link
lands is now decided by Control and the caller cannot name it — which is also
the narrowest reading of O4 clause 8, since the allowlist has one entry that
nobody outside can choose.

Both are pinned by tests that fail with the fix reverted.

## What review found that the live run had not

**A brand-new signup could not use the dashboard at all.** The worst of the
findings, and the one the live run walked straight past. An Account with no
stored management state answered `409 "demo Account is not initialized"`, which
was right while the only way to get an Account was an operator running reset.
Signup inverted that: every new tenant starts with no stored state, so the very
first call the dashboard makes answered 409 — and `www/app.js` hides its own
shell on any non-401 failure, leaving a dead end reading "Demo state
unavailable: HTTP 409." with no nav to reach any page that would have fixed it.

The row above recording that "the other two stay uninitialized" is what this
looked like from the outside. It was read as proof of isolation, which it was,
and not as proof that neither of those two people had a usable product, which it
also was. The one Account that worked had been initialized through
`POST /api/demo/reset` — an operator step behind `DEMO_ADMIN_TOKEN`, which is
exactly what PD-01 says must not be needed.

A first read now creates and persists the Account's own empty state, so it
exists from its owner's first page load. Pinned twice: at the registry, and end
to end through `handleControlRequest` with a session and no admin token.

**One rate-limit bucket for the whole platform.** Better Auth reads
`x-forwarded-for` to identify a caller, which is absent behind Cloudflare. It
then resolves no address and — in its own logged warning — falls back to "a
single shared per-path bucket". Control asks `/get-session` on every
authenticated request it serves, so the framework's default of 100 per 10
seconds was a cap on the product rather than on an attacker: past it, everyone
signed in gets `500 session verifier failed` at once, and any one caller
looping a request locks out everybody.

Three things were wrong together and all three are fixed: the address header is
named, `authenticateSessionRequest` forwards it, and `/get-session` carries a
custom rule of 1000 per 10 seconds instead of the default 100. Because the
address header now resolves, that allowance is per-IP: far above anything a
signed-in person can reach, and still a bound on a stranger looping invalid
bearer tokens at a publicly routed Worker, one D1 read each. Removing the cap
outright would have left that loop unbounded.

Read against the framework source rather than taken on trust —
`better-auth/dist/api/rate-limiter/index.mjs` builds the key from
`ip ?? "no-trusted-ip"`, and `@better-auth/core/dist/utils/ip.mjs` defaults
`ipAddressHeaders` to `["x-forwarded-for"]` and returns null when nothing
matches. The test that pins it fails against the old configuration.

**A stranger's malformed body returned a runtime 500.** `/api/sign-in` sits
outside the guarded block, so the 400 it raises for invalid JSON escaped the
handler — on the one route a stranger can reach. The test covering that route
passed a signed-in verifier, which is why it went unnoticed; it now asks with
no session at all, which is the only kind of person who needs a link.

**Cloudflare Access was still in the CLI and the golden runner.** Both
presented Access service-token headers to a control plane with no Access
application in front of it, and the runner demanded `GOLDEN_ACCESS_TOKEN`
before it would start. The runner now carries a real session — bearer on the
management API, cookie on the dashboard's own routes, where the admin token
needs the `Authorization` header to itself.

## The management surface lost its token, and the CLI with it

`/v1/` required `MANAGEMENT_API_TOKEN` as well as an identity. Every route
already ended in `requireAuthenticatedAccount`, which is what bounded it; the
token named no Account and so bounded nothing. Under Access that did not show,
because the identity was `env.ACCOUNT_ID` and the same for everyone, leaving the
shared token to do the real work.

With the identity now naming one Account, keeping a shared secret beside it
could only widen what the session already bounds. It was removed rather than
scoped. SI3 asks for a *strict* Account-scoped management contract, and strict
is what the session gives.

The cost is that no CLI or service can reach that surface today, and saying so
plainly matters more than the tidiness of the change. Measured against the
deployed Worker:

| Credential | Answer |
|---|---|
| A session token as `Authorization: Bearer` | `404 {"error":"not found"}` — authenticated, and Account-scoped |
| A shared secret as a bearer | `401 {"error":"sign-in required"}` |
| No credential at all | `401 {"error":"sign-in required"}` |

So the CLI's transport survives — a session works as a bearer, which is what
`bearer()` is for — but nothing issues one to a terminal. `ANGEL_MANAGEMENT_TOKEN`
keeps its name and changes its meaning, and its error message says so. Renaming
a published package's variable is a separate decision; the CLI login hand-off is
the real fix.

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

The same file also pins the packed `@smcllns/angel-core` against the published
0.3.0 tarball, and `src/cli/client.ts` and `src/cli/commands.ts` now diverge
from it because the CLI stopped speaking Cloudflare Access. They join
`package.json` and `README.md` in `allowedPackedDifferences`, which is the
mechanism the baseline already provides for a divergence that is meant.

Worth being blunt about what that means: **the published 0.3.0 still contains
the Access code.** Anybody installing it from the registry gets a client that
attaches service-token headers no application reads any more. Harmless — the
headers are ignored — but it is one more reason the CLI login hand-off is the
real fix rather than a tidy-up.

`angelmcp-auth` is now pinned too, as a fourth entry. Review argued for leaving
it out while PD-01 is actively moving, on the grounds that a Worker under change
turns its baseline entry into a changelog. That is true, and it is equally true
of Control, which has always been pinned — so the argument proved too much.
Auth now decides which Account every request is served, which is exactly the
kind of code a guard against unexplained bundle movement should cover.

The script refuses to run on anything but Node v26, so the hashes here were
reproduced independently: the same `wrangler deploy --dry-run` bundles, the
same source-path normalisation, hashed in Python. Broker and Gateway came out
byte-identical to the recorded values, which is what makes the Control and Auth
numbers credible rather than merely asserted.

Recorded 2026-08-04, and reproducible without the script — for each Worker,
`pnpm exec wrangler deploy --dry-run --config wrangler.<w>.jsonc --outdir <d>`,
then apply the `normalizedWorkerSha256` replacement in
`scripts/ws1-release-integrity.ts:55-61` to `<d>/<w>.js` and sha256 the result:

- `broker` `78f989e9b778e45718dbb13244594eca5892bbb7eb921d2120723b08de6fb62e`
  — unchanged
- `gateway` `26e2f9235f67912ff4b090781d628d808757b8690cbc73ec98da4b44e8a902f7`
  — unchanged
- `control` `27c8f8acf6dab74ed2e15fba38a4b8193f41d266aaa9ad363fe1c119404693ef`
  — moved with its source
- `auth` `066ec8569ef8cdca0dd3dbf57c3c2f0dc7d2c97ac8e3e90f3d4f7e19b0e2718d`
  — first entry

## Not in this run

The pilot Account. `acct_m1` was left behind by owner decision on 2026-08-04:
its Durable Object state stays on disk and nothing routes to it, so the pilot
Angels are dark. Nothing was deleted.

The CLI hand-off is still separate, and it is the piece that will want a
credential outliving a fourteen-day session.

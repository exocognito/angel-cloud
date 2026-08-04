# PD-01 — sign-up moves to Better Auth

Run 2026-08-04 against the deployed `angelmcp-auth` Worker, from outside the
repo. Mail went to the owner's plus-aliases and the links were read out of the
inbox, not out of the code. Addresses and Account ids are redacted here; the
run itself used real ones.

This replaces the hand-written path proved in
[01-signup-loop.md](01-signup-loop.md). That file stays: it records a real run,
and its findings outlived the code that produced them.

## Why it moved

Seven adversarial review rounds against the hand-written path produced three
HIGH findings, and all three were in machinery rather than in the product rule
being enforced — write ordering, Durable Object input-gate reasoning, and error
classes lost across an RPC boundary. The owner chose on 2026-08-04 to cut over
to Better Auth before building anything further on it, and to carry the change
through to the CLI and Control as separate pieces of work.

## What Better Auth owns now, and what it does not

Minting the link, storing it hashed, and spending it exactly once are the
framework's. Single-use rests on the kysely adapter's `consumeOne`, which for
SQLite compiles to one statement:

```sql
DELETE FROM verification WHERE id IN (SELECT id FROM verification WHERE ... LIMIT 1) RETURNING *
```

Transactions are switched **off** on D1 rather than attempted — the adapter
reports `transaction: false`, so the D1 dialect's "no interactive transactions"
throw is never reached. That single statement is the whole guarantee, which is
the right place for it to rest.

Three things Better Auth does not do stayed in the Worker:

- **The per-address and per-source caps.** Its own limiter keys on IP and
  answers a different question.
- **Newest-link-only.** A verification row is named after the token's own hash,
  so there is no index by address; the address sits in the row's JSON, and
  migration 0002 indexes that expression.
- **Keeping the send off the response path.** The plugin awaits `sendMagicLink`
  before answering, so ours returns without awaiting.

## The loop

`POST /v1/auth/sign-in/magic-link {"email":"owner+ba-a@example.invalid"}`
→ `200 {"status":true}`

The mail arrives from `noreply@angelicagents.com`, subject "Your Angel sign-in
link", carrying one URL to `/v1/auth/magic-link/verify`.

`GET /v1/auth/magic-link/verify?token=…`
→ `302` to `/` with `__Secure-better-auth.session_token`, `HttpOnly`, `Secure`,
`SameSite=Lax`, `Max-Age=1209600`

`GET /v1/auth/get-session` with that session as a bearer token
→ `200` carrying the session and
`"angelAccountId":"acct_<redacted>"`

## What was checked, and what came back

| Check | Result |
|---|---|
| A stranger asks for a link | `200 {"status":true}`, mail arrives |
| First click | Account created, session valid to +14 days |
| The same link again | `302` → `?error=INVALID_TOKEN`, no cookie |
| A link superseded by a newer one | `302` → `?error=INVALID_TOKEN` |
| The newer link | `302` → `/` with the session cookie |
| A link past ten minutes | issued 17:02:57.854Z, clicked 17:13:10.678Z → `?error=INVALID_TOKEN` |
| That expired click | created no user, no session |
| A token nobody issued | same refusal, same wording |
| Four requests for one address (cap 3) | four identical `200 {"status":true}` — **three mails** |
| The eleventh request from one source (cap 10) | `429 {"error":"too many sign-in requests"}` |
| Token as stored | 43-character base64url digest, not the 32-character token |
| Expiry as stored | `expiresAt − createdAt` exactly 600.000s |
| Verify responses | `referrer-policy: no-referrer` |

Three links were mailed to the capped address and **one** verification row
survived the run, so newest-link-only held across the whole sequence rather
than only in the two-link case.

## What the live run found that the tests had not

**The framework's own limiter fired ahead of ours.** Better Auth ships a limit
on the magic-link paths — five requests per sixty seconds per IP — and it
refused the third request of the address-cap proof, in its own wording, before
the cap O4 specifies could bind. The inbox records it: the first capped address
received two mails where it should have received three.

The test that should have caught this asserted only that the eleventh request
returned `429`, which either limiter satisfies. It now asserts whose, and a
second test walks a whole window expecting every answer before the cap to be a
`200`. That one fails without the fix.

**Sessions resolved only from a cookie.** The path this replaces answered on an
`Authorization: Bearer` header, and the CLI has no cookie jar. The `bearer`
plugin restores it.

## Two departures from what shipped, both owner decisions

**The expiry boundary grants one millisecond.** Better Auth refuses on
`expiresAt < now`, so a link spent at exactly `expiresAt` is accepted. O4
clause 2 says equality is expired. Recorded as a dated amendment in
[../ws-e/04-auth-expiry.md](../ws-e/04-auth-expiry.md) rather than wrapped in
code we would then own, and pinned by a test from both sides.

**Addresses are now stored in the clear.** `user.email` is the framework's key
for a person, and the verification row carries the address too — visible in the
run: `{"email":"…"}`. The path this replaces stored no address anywhere,
naming its objects by an HMAC instead.

The property could have been kept: a hook rewriting the address to its HMAC
before storage, with the real one riding in `metadata` to reach the sender. It
was rejected because it makes the framework's idea of a person a hash, so
nothing could ever mail an existing user — no address change, no recovery, no
login alert. The throttle's object names stay keyed under `LOGIN_NAME_KEY`;
that store has different reach and gives the property up for nothing.

## What the identities from slice 1 did

Nothing carried over, and nothing could. `LoginIdentity` stored
`{accountId, createdAt}` under an HMAC of the address and `SessionRecord`
stored the hash; the plaintext address existed nowhere in storage, and Better
Auth's `user` table needs it. There was nothing to read a migration from. The
three Accounts from slice 1 went with `angelmcp-auth-demo`.

## Not in this cutover

Reaching Control. A person who signs up gets an Account this Worker knows about
and the dashboard does not — `defaultAccessVerifier` still builds every
identity with `accountId: env.ACCOUNT_ID`, and `AccountRegistry` refuses
anything else. That is its own piece of work, and it is now unblocked: the
session already carries `angelAccountId`.

The CLI hand-off is likewise separate.

## Residual

The per-address timing gap from slice 1 survives in a smaller form. A capped
address still costs one Durable Object creation less than an uncapped one. What
that leaks is not whether an address has an Account: the window counts requests
*for* an address, and an attacker's own probes fill it. Learning anything about
somebody else means finding their address already capped without having capped
it — which reveals that they asked for a sign-in link in the last fifteen
minutes, and nothing more.

Measured across this run, a capped request answered in 0.329s against 0.355s
and 0.428s for uncapped ones. The gap did not show above the noise.

Two requests for one address at the same instant can each clear the older links
and then each write, leaving two live links. The per-address cap bounds that at
three. Closing it properly means serialising per address, which is a Durable
Object round trip on every sign-in.

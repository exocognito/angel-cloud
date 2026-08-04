# PD-01 slice 1 — a stranger signs up

Run 2026-08-04 against `https://angelmcp-auth-demo.sam-633.workers.dev`, from
outside the repo. Mail went to Gmail plus-aliases and the links were read out
of the inbox, not out of the code.

## What the slice claims

A stranger asks for a link, clicks it once, and lands in an empty Account.
No operator, no pre-provisioned Account, no shared credential.

## The loop

`POST /v1/auth/request-link {"email":"oscollins+angel-fresh@gmail.com"}`
→ `202 {"status":"accepted"}`

The mail arrives from `noreply@angelicagents.com`, subject "Your Angel
sign-in link", carrying one URL back to `/v1/auth/callback`.

`GET /v1/auth/callback?token=…`
→ `200 {"accountId":"acct_53de6cdbdd1da1da2af112eeb82d7d21","accountCreated":true,"session":"…"}`

`GET /v1/auth/session` with that session as a bearer token
→ `200 {"accountId":"acct_53de6cdbdd1da1da2af112eeb82d7d21","expiresAt":1787012876064}`

## What was checked, and what came back

| Check | Result |
|---|---|
| A second stranger signs up | a different Account, `acct_a86edca3…`, and each session names only its own |
| The same address signs in again | the same Account, `accountCreated:false` — one address never becomes two Accounts |
| The link is clicked twice | `400 {"error":"this sign-in link is not valid"}` |
| The verifier is tampered with | `400`, and the untouched link still worked afterwards |
| The selector is unknown | `400`, worded identically |
| The token is malformed | `400`, worded identically |
| A link older than ten minutes | `400` — issued 00:28:39Z, clicked 00:38:54Z at 615 seconds |
| Did that expired click create anything? | No. The next link for the same address still reported `accountCreated:true` |
| Eleven requests from one machine | the first ten answered, then `429 {"error":"too many sign-in requests"}` |
| An address the sender refuses | `202`, the same answer every address gets |
| The sender is down | `502` — true of every address at once, so it gives nothing away |
| The session is missing, unknown or expired | `401 {"error":"sign in required"}` |
| Response headers on the callback | `referrer-policy: no-referrer`, `cache-control: no-store` |
| The session cookie | `HttpOnly; Secure; SameSite=Lax; Max-Age=1209600` |

## Two things the live run caught that the tests could not

**A thrown error does not survive a Durable Object boundary.** `LoginAttempt`
threw a `MagicLinkError` and the Worker checked `instanceof`. Across RPC the
class is gone, so every refusal came back as a `500` instead of a `400`. The
object now reports refusal as a value. In-process test fakes call the class
directly, so they never saw it.

**A provider rejecting one address must not change the answer.** Resend
refuses `example.com` outright. That surfaced as a `500` where every other
address got a `202` — an enumeration oracle, exactly what O4 forbids. An
address-level rejection is now logged and answered like everything else; only
a broken sender, which is true of every address at once, is allowed to show.

## Caps on asking

Deploying signup to a public URL made the endpoint a way to mail anyone,
repeatedly, from our sending domain. Two fixed windows of fifteen minutes,
each counted in its own Durable Object:

- **three links per address**, refused in silence — saying "that address has
  had enough" would answer the question the endpoint must never answer;
- **ten requests per source**, refused with `429` — a source names no address,
  so that refusal is allowed to say what it is. Malformed requests count too.

The source cap is proven live, above. The address cap is proven in tests; both
go through the same object and the same fixed-window rule.

## Why signup is its own Worker

The Control Worker sits behind a Cloudflare Access application that turns away
unauthenticated requests at the edge — `GET /` returns a `302` to the Access
login screen. That is right for the pilot Account and impossible for signup, so
`angelmcp-auth-demo` is deployed without it.

## Not in this slice

Newest-link-only invalidation, the allowlisted redirect, deletion and the
handle tombstone, and the cutover to `api.angelmcp.ai`.

Sign-in mail comes from `angelicagents.com`, not `angelmcp.ai`: the Resend free
plan holds one sending domain and that one already had it. Moving it is a
config change.

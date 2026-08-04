# PD-01 slice 1 — a stranger signs up

Run 2026-08-04 against the deployed demo Worker, from outside the repo. Mail
went to the owner's plus-aliases and the links were read out of the inbox, not
out of the code. Addresses and Account ids are redacted here; the run itself
used real ones.

## What the slice claims

A stranger asks for a link, clicks it once, and lands in an empty Account of
their own, with no operator and no shared credential.

That Account lives only in this Worker's storage. Nothing binds
`angelmcp-auth-demo` to Control, which still serves `acct_m1`, so the Account
grants nothing anywhere yet. Signing up and *reaching* something is not this
slice.

This is a dogfooding implementation. The APRD's target-state spine names Better
Auth on the Control Worker with D1 for auth storage; the owner chose on
2026-08-04 to keep this hand-written magic-link path for dogfooding and switch
to Better Auth later, leaving the spine as written.

## The loop

`POST /v1/auth/request-link {"email":"owner+angel-fresh@example.invalid"}`
→ `202 {"status":"accepted"}`

The mail arrives from `noreply@angelicagents.com`, subject "Your Angel
sign-in link", carrying one URL back to `/v1/auth/callback`.

`GET /v1/auth/callback?token=…`
→ `200 {"accountId":"acct_<redacted>","accountCreated":true,"session":"…"}`

`GET /v1/auth/session` with that session as a bearer token
→ `200 {"accountId":"acct_<redacted>","expiresAt":1787012876064}`

## What was checked, and what came back

| Check | Result |
|---|---|
| A second stranger signs up | a different Account, a second `acct_<redacted>`, and each session names only its own |
| The same address signs in again | the same Account, `accountCreated:false` — one address never becomes two Accounts |
| The link is clicked twice | `400 {"error":"this sign-in link is not valid"}` |
| The verifier is tampered with | `400`, and the untouched link still worked afterwards |
| The selector is unknown | `400`, worded identically |
| The token is malformed | `400`, worded identically |
| A link older than ten minutes | `400` — issued 00:28:39Z, clicked 00:38:54Z at 615 seconds |
| Did that expired click create anything? | No. The next link for the same address still reported `accountCreated:true` |
| Eleven requests from one machine | the first ten answered, then `429 {"error":"too many sign-in requests"}` |
| Five requests for one address | five identical `202`s, three mails delivered |
| An address the sender refuses | `202`, the same answer every address gets |
| The sender is down | `202`, unchanged — the send no longer sits on the response path at all |
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
address got a `202` — an enumeration oracle, exactly what O4 forbids.

The first fix was half a fix: address-level rejections were answered normally
but a sender *outage* still returned `502`. Review caught that a capped address
never reaches the sender at all, so the `502` said "this address was not
capped" — the same oracle through a different door. The second fix was also
half a fix: matching bodies still left matching *timing*, because only the
uncapped path waited on Resend. The send is now handed to `waitUntil` and
happens after the answer, so the status and the body say nothing about the
address and the Resend round trip is off the reply path entirely. A smaller
timing difference remains, and is not closed: a capped request answers before
minting a link, so an uncapped one additionally does one HMAC, one SHA-256 and **two**
Durable Object writes, one of them creating a brand-new object, both awaited
before the reply. The address HMAC is paid on both paths; the writes are not. Equalising that means doing the mint and the write for
capped requests too, which hands an attacker exactly the storage growth the cap
exists to prevent; the alternative, padding every reply to a fixed floor, puts
a permanent cost on every sign-in. The residual is a Durable Object
create-and-write over RPC, not a hash — measurably more than the earlier
description of it claimed.

**Owner decision, 2026-08-04: leave it, recorded here as an open gap.** Two
independent reviewers judged the residual a contract violation and raised it in
three consecutive rounds. It is a real signal against a three-per-fifteen-minutes
cap, and closing it is cheap to do badly. It stays open deliberately, not by
oversight.

That decision was taken on a description of the gap that later review found
wrong twice — first overstating the crypto, then understating the writes. What
it actually costs is a Durable Object create-and-write, so the owner should be
asked again now the arithmetic is right.

## Caps on asking

Deploying signup to a public URL made the endpoint a way to mail anyone,
repeatedly, from our sending domain. Two fixed windows of fifteen minutes,
each counted in its own Durable Object:

- **three links per address**, refused in silence — saying "that address has
  had enough" would answer the question the endpoint must never answer;
- **ten requests per source**, refused with `429` — a source names no address,
  so that refusal is allowed to say what it is. Malformed requests count too.

Both are proven live. Asking five times for one address returned five
identical `202`s and put exactly three mails in the inbox — 00:57:58, 00:57:59
and 00:58:00 — so two requests were dropped without the caller being able to
tell. Asking eleven times from one machine was answered ten times and then
refused.

A fixed window lets a burst through at the boundary: up to twice the cap across
two adjacent windows. A sliding window would not, but it holds a list of
timestamps, which is storage an attacker grows by asking. The burst is the
lesser problem, so the window is fixed.

Refusing costs nothing for the source cap: an over-limit request is not written
back, so hammering the endpoint does not extend the caller's own lockout. That
sentence does not carry over to the address cap, which is keyed by the address
alone. Anyone can spend a known address's three-per-fifteen-minutes from
anywhere, and the owner's own request is then refused in silence, with no mail
and no way to tell why. Making the cap generous enough to be harmless would
make it useless against the abuse it exists for; the answer is to key it by
source as well, which is not in this slice.

Not proven against the deployed Worker: what a login does when the Account
write fails. That state cannot be produced from outside without instrumenting
the Worker, and it is covered by two tests in
`tests/cloud/auth-worker.test.ts` instead.

## What review changed after the first run

Two fresh reviewers, one Claude and one Codex, both returned NOT MERGEABLE on
the first head. Three of their findings were real defects in what this document
had already claimed:

- **The Account was written before the session.** A session-write failure left
  an Account nothing could reach, which is not "a failed login creates nothing".
  The session now names the identity rather than the Account and is written
  first, so a half-finished login leaves a session that resolves to nothing and
  answers `401`.
- **A sender outage answered `502` while a capped address answered `202`.** A
  capped address never reaches the sender, so the `502` said "this address was
  not capped" — the same oracle in different clothes. Every send failure now
  answers `202`.
- **The Worker logged the live token.** `head_sampling_rate: 1` writes request
  URLs to Workers Logs, and the callback carries the verifier in its query
  string, so a spendable token sat in a retained store for the ten minutes it
  worked. Observability stays on, so this Worker's own logs are retained — they are the
only record a send failure leaves now. What is off is the automatic per-request
invocation log, which carried the callback URL and with it a live verifier.

Two more were about naming: stored objects were named by unkeyed SHA-256 over
an email address or an IP, both small enough to enumerate offline by anyone who
could list object names. Names are now HMAC under a `LOGIN_NAME_KEY` secret. The
verifier and session token keep bare digests — 256 random bits have no
dictionary to run against.

## Why signup is its own Worker

The Control Worker sits behind a Cloudflare Access application that turns away
unauthenticated requests at the edge — `GET /` returns a `302` to the Access
login screen. That is right for the pilot Account and impossible for signup, so
`angelmcp-auth-demo` is deployed without it.

## Not in this slice

Wiring this Account into Control, newest-link-only invalidation, the allowlisted
redirect, deletion and the handle tombstone, and the cutover to
`api.angelmcp.ai`.

A source cap is per source address, and an IPv6 caller holds a whole /64, so it
slows a flood rather than stopping one. The per-address cap is what actually
protects a given mailbox from being mailed repeatedly — and, keyed by address
alone, it is also what lets a stranger lock a known address out of signing in.
Keying it by source as well closes both, and belongs with the throttling work.

Sign-in mail comes from `angelicagents.com`, not `angelmcp.ai`: the Resend free
plan holds one sending domain and that one already had it. Moving it is a
config change.

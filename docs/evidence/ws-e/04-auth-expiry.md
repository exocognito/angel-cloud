# WS-E brief 4 — authentication expiry

- Decision: O4
- Evidence status: complete
- Product implementation: none
- Outcome: close O4
- Verified: 2026-08-01

## Question

How long does a magic link live, and is SMS in Round 2?

## Method

Compared the target auth journey with authoritative and widely used single-use-link defaults, then tested the trade among bearer exposure, email delay, CLI/browser handoff, replay, scanner behavior, resend, and server/client clocks. Audited the repository for any SMS provider or phone-data contract.

## Verified results

- Secure comparators range from 3–10 minutes; NIST's out-of-band ceiling is 10 minutes, though email itself is not a NIST-approved OOB authenticator.
- At `6cc2ed5`, before the WS-E reconciliation, days-long target wording created an unjustified stale bearer window.
- The complete CLI/browser/email handoff makes five minutes tight; delayed mail should trigger a fresh link, not extend an old one.
- No SMS provider, phone store, consent, recovery, abuse, cost, or number-recycling contract exists.

## Decision outcome

Outcome: close O4. Email magic links are single-use and expire exactly 600 seconds after server-side commit. `serverNow >= expiresAt` is expired; there is no grace. New issue invalidates older unused links for the same identity/transaction. SMS is out of Round 2.

## Product implication

The APRD and target CLI contract now use the exact ten-minute, single-use rule. Login shows the ten-minute expiry and one resend action. Unknown-email responses stay generic. Login failure creates no Account or provider state.

## Execution gates

- Prove atomic consume-before-session issuance and concurrent replay denial.
- Test exact boundary time, wrong transaction, newest-link-only, delayed mail/resend, allowlisted redirect, no-referrer response, scanner behavior, and per-email/source throttles.
- Confirm Better Auth configuration and storage rather than assuming defaults.
- Measure real dogfood delivery before changing the ten-minute decision.

## Evidence record

Repository state: `evidence/ws-e-decision-briefs` at `6cc2ed5`

### O4 full record

#### O4 full record: Question

How long should one single-use email magic link remain valid, and does SMS belong in Dogfood Round 2?

#### O4 full record: Method

1. Reconciled the approved Product Ledger with the unapproved APRD and target CLI guide.
2. Checked the intended auth framework's current default and other current passwordless defaults.
3. Compared abuse window, usability, replay, clock handling, delayed email, and channel risk.
4. Treated NIST's limits as security evidence, not as a claim that email magic links meet NIST out-of-band authentication requirements. NIST explicitly says email must not be used for out-of-band authentication.

#### O4 full record: Sources and commands

##### O4 full record: Repository sources

- `docs/product-ledger.html`: O4, C4, DF-049, LR-011, PD-01, C02, and G10.
- `docs/aprd/angel-cloud-aprd.html`, §4.1: target Better Auth + D1, “days-long” links, optional passkey, and recovery-contact intent. This is an unapproved draft and conflicts with the Ledger.
- At `6cc2ed5`, before the WS-E reconciliation, the target login guide described a keychain token, email link, browser hop, login nonce, and no management mutation before successful login. WS-E removed the keychain assumption; exact management-token storage remains a WS2 gate.
- `docs/faq.md`: current reality is Cloudflare Access and one pre-provisioned Account; no signup exists.
- `src/oauth-state.ts` and `tests/cloud/oauth-state-registry.test.ts`: the existing Google OAuth state is a separate 10-minute, single-consumption flow; it is useful implementation evidence but is not the future login link.

Representative commands:

```sh
rg -n -i '(O4|magic|email|sms|auth expiry|days-long)' \
  docs/product-ledger.html docs/aprd docs/faq.md docs/user-manual.md

pnpm exec bun test tests/cloud/oauth-state-registry.test.ts
```

##### O4 full record: Authoritative external sources

- [Better Auth magic-link plugin](https://www.better-auth.com/docs/plugins/magic-link): `expiresIn` defaults to **300 seconds (5 minutes)**; current redemption is atomic and single-use. Better Auth warns that multi-instance secondary storage needs an atomic get-and-delete primitive.
- [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html): URL tokens must be random, securely stored, single-use, expire after an appropriate period, use HTTPS, avoid Host-header URL construction, prevent referrer leakage, and be rate-limited.
- [NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html), Out-of-Band Authenticators: out-of-band authentication must complete within **10 minutes** and accept a secret once; it also says **email shall not be used for out-of-band authentication**. This supports a conservative time ceiling and replay rule, not a compliance claim for email login.
- [WorkOS Magic Auth](https://workos.com/docs/user-management/magic-auth): one-time email codes expire after **10 minutes**.
- [Auth0 email OTP](https://auth0.com/docs/authenticate/passwordless/authentication-methods/email-otp): only the newest OTP/link is accepted, use invalidates it, and the default expiry is **3 minutes**.
- [Supabase passwordless email](https://supabase.com/docs/guides/auth/auth-email-passwordless): links are one-time; default expiry is **1 hour** with a 60-second request interval. This is a usability-heavy comparator, not the recommended security default.
- [RFC 5321 §4.5.4.1.1](https://www.rfc-editor.org/rfc/rfc5321.html): SMTP retries may start at 30-minute intervals and continue for days. A login link cannot remain safe for every delayed email; the correct recovery is a fresh request, not a days-long bearer secret.
- [NIST SP 800-63B, PSTN](https://pages.nist.gov/800-63-4/sp800-63b.html): SMS/voice is a restricted authenticator; verifiers should consider SIM changes, device swaps, and number porting and must offer an alternative.

External pages were fetched directly with `curl -L`; relevant statements were mechanically searched with `rg`.

#### O4 full record: Verified results

##### O4 full record: Product truth

- **Verified:** O4 is open because the APRD says days while the owner/Ledger says minutes.
- **Verified:** The intended framework is Better Auth on Control with D1, but Better Auth is not present in `package.json`, no auth migration exists, and no public login implementation exists.
- **Verified:** The target CLI requires an email browser hop and a one-time login nonce. Login must create no Angel, Connection, key, Version, deployment, receipt, or provider object.
- **Verified:** SMS is mentioned only as unresolved product intent. No SMS provider, phone store, consent flow, recovery flow, or test exists.

##### O4 full record: Risk comparison

| Expiry | Abuse and replay | Usability and email delay | Evidence | Assessment |
| --- | --- | --- | --- | --- |
| 3–5 minutes | Smallest mailbox-compromise and forwarded-link window; framework-native at 5 minutes | Higher false-expiry risk during inbox delay, device switching, or CLI/browser handoff | Auth0 3 min; Better Auth 5 min | Secure, but 5 minutes is tight for the complete CLI/browser journey |
| **10 minutes** | Still minute-scale; aligns with the strict NIST OOB ceiling and mandatory one-use rule | Gives a practical margin for ordinary delivery and handoff without turning the inbox into a long-lived credential store | WorkOS 10 min; NIST OOB max 10 min | **Best balance** |
| 15–60 minutes | 1.5–6× the recommended exposure window | More tolerant of delayed mail | Supabase defaults to 1 hour | Too broad for Angel's security posture without measured delivery need |
| Days | A copied, logged, forwarded, or compromised message stays useful long after intent | Covers pathological SMTP delay, but stale mail still produces confusing sign-ins | APRD draft only | Reject |

##### O4 full record: Abuse, replay, clock, and delay findings

- A long expiry does not solve SMTP delay safely. A delayed or expired message should direct the owner to request a fresh link.
- Single-use must mean atomic consumption before session or CLI-token issuance. A read followed by a separate delete is not enough under concurrent redemption.
- Issuing a new link should invalidate older unused links for that login identity/transaction. Otherwise every resend expands the valid-token set.
- The server clock must be authoritative. Client, browser, and email timestamps must not affect validity, and no grace period should extend the deadline.
- Generic request responses and per-email/per-IP throttles are needed to limit account discovery, inbox flooding, and token guessing. These controls do not justify a longer expiry.
- Mail scanners can pre-open links. If Round-2 evidence shows scanner consumption, use an explicit human confirmation step or a short code; do not lengthen the link lifetime.

#### O4 full record: Alternatives

1. **Use Better Auth's 5-minute default.** Simplest and strictest. Rejected as the recommendation because the CLI → browser → inbox → browser → CLI path adds more handoff time than a normal web-only sign-in.
2. **Use 10 minutes.** One explicit override, supported by current secure comparators, with limited added exposure. Recommended.
3. **Use 15 minutes or 1 hour.** Improves tolerance but enlarges the bearer window without repository evidence that 10 minutes fails.
4. **Use days.** Rejected. It resolves delivery trouble by preserving an authentication secret far too long.
5. **Add SMS in Round 2.** Rejected. It adds phone-number personal data, a telephony provider, deliverability/cost abuse, number-recycling and SIM-swap handling, and recovery policy before the email path has passed one clean-room run.

#### O4 full record: Recommendation

- **Magic-link expiry: exactly 10 minutes (600 seconds).**
- **SMS: not in Dogfood Round 2.** Keep it deferred. This does not permit zero recovery: retain the approved email recovery path and optional post-sign-in passkey direction, but do not add a phone channel to this milestone.

#### O4 full record: Exact contract

1. At successful token-record commit, set `expiresAt = issuedAt + 600 seconds` using the server clock.
2. Redemption is valid only while `serverNow < expiresAt`; equality is expired. Add no client-clock grace.
3. The token is cryptographically random, stored as a verifier/hash rather than plaintext, bound to one email identity and one login transaction, and accepted only at an allowlisted HTTPS callback.
4. Redemption atomically consumes the token before issuing a browser session or CLI authorization result. Every later or concurrent redemption fails as invalid/expired.
5. A newly issued link invalidates all older unused links for the same login identity/transaction.
6. Request and failure responses do not reveal whether an email is registered. Requests are throttled by normalized email and source; resend creates a fresh 10-minute token.
7. Expired or delayed mail offers one action: request a new link. It never extends or revives the old token.
8. Redirect targets are fixed/allowlisted; the redemption response uses `Referrer-Policy: no-referrer` and loads no third-party content before the token leaves the URL.
9. No SMS, phone number, SMS recovery contact, or telephony dependency is part of Round 2.

#### O4 full record: Product implication

Replace every “days-long” target statement with “single-use, 10 minutes.” Login copy must show the expiry and a clear resend path. Round-2 acceptance must test exact-time expiry, concurrent replay, newest-link-only behavior, wrong login transaction, delayed email/resend, generic unknown-email response, and no management/provider mutation on failure.

#### O4 full record: Risks

- Email login remains mailbox-dependent and is not phishing-resistant. NIST's 10-minute OOB rule does not make email a NIST-approved OOB authenticator.
- A 10-minute window may still fail for greylisting or a slow inbox. The product should measure this in dogfood and shorten or lengthen only from saved delivery evidence.
- Atomic single-use depends on the actual D1/Better Auth transaction path; framework configuration must be tested rather than assumed.
- Link-scanning products may consume a simple GET link before the human sees it.

#### O4 full record: Closure assessment

**Decision-ready; recommend closing O4 with the contract above.** The evidence resolves minutes versus days and SMS scope. Implementation and measured delivery proof remain WS2 work; they do not keep the product decision open.

---

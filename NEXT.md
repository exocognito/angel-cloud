# Angel Cloud milestones

The plan of record is the [Angel Product Ledger](docs/product-ledger.html); it
owns milestone sequence and status. [ROADMAP.md](ROADMAP.md) remains a stable
pointer for old links. This file keeps the detailed M0/M1 record, locked
decisions, and operator notes behind it. For the broader
portable Angel ecosystem, see the comparison repository.

## Milestone 0: Hosted repository establishment

**Status: Private repository established; package transport complete**

- ✓ Hosted platform candidate extracted into its own repository with independent structure, secrets, and deployment shape
- ✓ Portable Angel core candidate extracted as separate dependency; packed tarball verified
- ✓ Deterministic CI covering all local fixtures and composition patterns (365 tests / 2,537 assertions)
- ✓ Admin and management API surface with stable environment keys
- ✓ Account-scoped deployments with independent staging/production Connection bindings
- ✓ MCP endpoint and Gateway/Broker enforcement
- ✓ Private GitHub repository created and boundary history pushed
- ✓ Public `@smcllns/angel-core@0.1.0` published and pinned by exact version;
  both lockfiles contain the registry integrity and no sibling checkout is used
- ✓ Fresh isolated clone installs with `pnpm install --frozen-lockfile` and
  passes 365 tests / 2,537 assertions plus all typechecks
- ✓ Remote CI installs the public package and passes the canonical hosted check

## Milestone 1: Real Google edge

**Status: Complete — merged to main 2026-07-23 (PR #1; user manual PR #2)**

### Implemented and verified

- ✓ Single-Account authentication via Cloudflare Access
- ✓ Access-backed control/www custody screen and provider lifecycle UI (local desktop/mobile proof via agent-browser mocked responses; see [docs/screenshots](docs/screenshots))
- ✓ Provider App and Connection CRUD APIs (add, list, health, revoke, reauth)
- ✓ Gmail adapter for `gmail.users.messages.list` with seeded test query
- ✓ Docs adapter for `docs.documents.get` with pinned document ID
- ✓ Per-Account envelope custody with refresh token lease (read-only on Broker, write-only in vault)
- ✓ Deterministic acceptance test transcript with exact read-only calls (365 tests / 2,537 assertions)
- ✓ Separate `google-read-proof` policy with exact two-operation allowlist
- ✓ Scheduled/manual acceptance runner receives only gateway URL, Angel key, and test fixtures
- ✓ Public core (`@smcllns/angel-core@0.1.0`) installed through the registry
- ✓ Cloudflare account login and Google consent completed through the live www
- ✓ `google-read-proof` published to staging and promoted exactly to production
- ✓ Live Gmail and Docs reads passed through Gateway, Broker, and custody
- ✓ Revoking the Connection made the live runner fail loudly
- ✓ Row-level **Reauthorize** preserved the same Connection identity; Gmail and
  Docs passed again
- ✓ Scheduled/manual runner passed locally with live secrets

### Closed out with the merge

- ✓ Two-family PR review and merge to main (PR #1, merge commit `5294543`)
- ✓ The acceptance workflow reached the default branch with the merge; its
  schedule and `workflow_dispatch` are runnable

Durable scheduled monitoring is a separate operational follow-up. Move the
Google OAuth app to Production first; External Testing refresh tokens expire
after seven days.

### Verified live deployment and lifecycle

- The canonical hosted and core repository is `exocognito/angelmcp`, public from 2026-07-27 and renamed in place during WS1.
  Its history before that date is kept privately in
  `exocognito/angel-cloud-history`.
- The dedicated Cloudflare account and its scoped operator token are configured;
  deployment-specific identifiers and credentials stay outside these docs.
- Broker, Gateway, and Control pass Wrangler 4.110 dry-run bundling with the
  selected account, service bindings, Durable Objects, Access team/audience,
  and Control/Gateway origins.
- The Control Access application is live with a browser allow policy and a
  non-identity service-token policy. Cloudflare rejected the proposed custom
  single header, so the verified implementation emits standard
  `CF-Access-Client-ID` and `CF-Access-Client-Secret` headers.
- The exact Google callback is saved on the OAuth client. The dedicated
  consumer Gmail identity is on the app's External Testing user list.
- All seven Worker runtime secrets are stored as named keys in the JSON
  credential field of the `Angel Cloud Runtime Secrets` 1Password item. Values
  are never committed.
- Broker, Gateway, and Control are deployed in dependency order from the
  reviewed M1 branch. Access rejects unauthenticated Control requests, accepts
  the automation service token, and the Account reset/state path passes live.
- The BYO Google Provider App is stored write-only in Broker custody and appears
  through Control only as its safe summary.
- Cloudflare account login, Google consent, Connection creation, staging
  publish, exact production promotion, and seeded Gmail/Docs reads pass live.
- Revocation causes a loud runner failure. Row-level **Reauthorize** returns the
  same Connection identity to healthy, after which both reads pass again.
- The acceptance runner passed locally with live secrets. Its workflow
  schedule and manual dispatch became runnable when the M1 merge put the
  workflow on the default branch.

### Not yet implemented (sequence in the [Angel Product Ledger](docs/product-ledger.html))

- Additional providers (Gmail drafts/write, Maps, Slack, WhatsApp, etc.)
- Public signup/onboarding
- Platform-owned Google OAuth app
- Personal/Family/Team Account types and production multi-tenancy
  (deliberately last)

## Decisions locked 2026-07-21

- Publish the portable `@smcllns/angel-core` through public npm.
- Deploy Angel Cloud to a different Cloudflare account from `smcllns`.
- Use a dedicated durable Google test user.
- Keep the product name Angel Cloud. WS1 superseded the repository-name half of this decision by renaming the canonical repository to `angelmcp`.
- Use External Testing for the initial proof; defer durable scheduled
  acceptance until Production because Testing refresh tokens expire after
  seven days.

## Required operator details

- The public package is published from the existing `@smcllns` npm scope. Its
  short-lived publish token is retrieved from 1Password only at publish time;
  revoke the token after the release workflow is complete.
- The selected Cloudflare account, Workers subdomain, scoped deploy token, and
  exact Google callback are configured. Keep operator credentials in 1Password
  and deployment-specific identifiers in Wrangler configuration.
- Access is enabled for the dedicated account; the service token is stored in
  1Password. The Control Access app has one narrow
  browser allow policy and one service-token automation policy.
  The client keeps one opaque JSON environment value and unpacks it into the
  standard `CF-Access-Client-ID` and `CF-Access-Client-Secret` headers; portable
  and hosted suites pass, and the implementation is deployed.
- The dedicated consumer Google identity is on the test-user list. Stable
  Gmail and Docs fixtures exist outside committed docs and passed the live
  runner. External Testing served the initial proof; move to Production before
  claiming durable scheduled acceptance.

## Operational notes

- The real `angel.json` file is local-only and ignored by git
- All example configurations are safe and published; never commit real deployment targets or credentials
- Deterministic fixtures in CI use checked-in policy artifacts and do not require external credentials
- The acceptance runner passed locally with live secrets; no live values are
  recorded in this repository
- GitHub Actions schedule and `workflow_dispatch` became runnable when the
  workflow file reached the default branch with the M1 merge
- External Testing refresh tokens expire after seven days; scheduled checks are
  temporary until the Google OAuth app reaches Production

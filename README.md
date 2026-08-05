# Angel Cloud comparison demo

The smallest hosted AngelMCP vertical slice that makes the fourth upstream
variant testable. It has Accounts, immutable Angel Versions, explicit
Connection bindings, stable Angel keys, and credential custody boundaries. It
has no code-execution engine.

The deployed shape is four Workers:

- **Auth** is the public signup surface and the only authority on what a
  session is: it mails a one-time sign-in link and gives whoever clicks it an
  empty Account. Built on Better Auth over D1.
- **Control** serves whichever Account the caller's session names, plus the
  management API, immutable Versions,
  environment deployments, stable key hashes, and the private www read model.
- **Gateway** exposes each Angel MCP endpoint and independently enforces its
  deployed allowlist, argument guards, key, Connection selector, and
  availability overlay.
- **Broker** is reachable only through service bindings and independently
  enforces the same deployment before invoking the real pinned Gmail/Docs
  provider. Unsupported operations are rejected. Ordinary golden CI injects a
  deterministic provider at the Broker boundary for credential-free tests.

Gateway and Broker use separate SQLite Durable Object namespaces. Control uses
one AccountRegistry SQLite Durable Object. Deployments install Broker first and
Gateway second; production promotion consumes the exact active preview
deployment ID and digest.

## Documentation

- [Roadmap](ROADMAP.md) — browsable pointer to milestone sequence and status.
- Product Ledger source: `docs/product-ledger.html` — canonical plan of record.
- [User manual](docs/user-manual.md) — write, build, publish, deploy, connect,
  and operate an Angel.
- [FAQ](docs/faq.md) — design rationale, security boundaries, and current
  limits.
- [Google read proof operator journey](docs/google-read-proof-manual-journey.md)
  — run the credentialed Gmail and Docs acceptance path.

This README is the quick start and deployment reference. The user manual owns
product mechanics; the FAQ owns rationale and current limits; the Product Ledger
owns sequence and status.

## Verified live status — 2026-08-05

**Anyone can sign up at https://dash.angelmcp.ai.** Enter an email address,
click the one-time link, and you get an Account of your own. There is no
invitation and no waiting list.

- Auth, Broker, Gateway, and Control are deployed in the dedicated Cloudflare
  account, from `main`. `dash.angelmcp.ai` and `auth.angelmcp.ai` are bound;
  the docs site and Gateway still answer on `*.sam-633.workers.dev`.
- **Cloudflare Access is gone.** The Control root answers `200` to anyone and
  serves the app shell; an unauthenticated management (`/v1/...`) or Account
  (`/api/demo/...`) call answers `401 sign-in required`, and the shell sends
  that caller to `/sign-in.html`, which redirects to the sign-in page. The
  sign-in route itself is public, as it has to be.
- Sign-in is an emailed one-time link that lasts ten minutes, issued by the
  Auth Worker over Better Auth on D1.
- Public `@angelmcp/cli@0.1.0` is the published command-line tool — this is what
  you install. Public `@smcllns/angel-core@0.3.0` is
  published as well: it is the library this repository builds and pins, not
  something you install yourself. Canonical source lives at `packages/core`, the
  workspace lockfile links that exact version, and `pnpm run check:ws1` compares
  its packed runtime bytes with the registry tarball.
- Provider App `google-primary` is stored in Broker custody. Reads return only
  its safe summary; the client secret is not returned.

The real credentialed lifecycle now passes. An operator signed in, completed
Google consent, authorized a Connection, published and
deployed `google-read-proof`, and read seeded Gmail and Docs data through the
two pinned tools. Revoking the Connection made the runner fail loudly. The
row-level **Reauthorize** action preserved the same Connection identity, and
both tools passed again after consent.

The scheduled/manual runner passed locally with live secrets, and the M1
merge put its workflow on the default branch, so its schedule and
`workflow_dispatch` are runnable. The Google app remains in External Testing,
so its refresh token has a seven-day lifetime; this is not durable
scheduled-acceptance proof.

## Portable source and deployment

`ANGEL.yaml` contains only portable policy. It either lists canonical tools or
composes local Angels:

```yaml
name: golden-assistant

angels:
  - gmail-read-and-draft
  - gdocs-read
```

`angel.json` separately owns the target, Account, Angel slug, and explicit
per-environment Connection nicknames. Builds emit
canonical, secret-free `build/angel.version.json` and
`build/angel.version.sha256` files.

```text
bun run angel build golden-assistant
bun run angel publish golden-assistant --preview
bun run angel deploy golden-assistant --prod
```

Those are the in-repo forms, for work inside this repository. Anyone who
installed `@angelmcp/cli` instead invokes it as `pnpm exec angel build …` — see
[SKILL.md](docs-site/public/SKILL.md), which is the journey for people who
never clone this repository.

`publish` builds, ensures the Angel, publishes an immutable Version, and deploys
it to production by default. Pass `--preview` to use the separate preview
bindings instead. `deploy --prod` promotes the exact active previewed
deployment; it does not build or publish. The pinned
`@smcllns/angel-core` 0.3.0 owns that command behavior (PD 0003). Control takes
its Account from the caller's session, so CLI publish and deploy need
`ANGEL_MANAGEMENT_TOKEN` set to a control-plane session token. Nothing mints
one for a terminal yet — that is the CLI login hand-off, and until it lands
these commands are reachable only with a session lifted from a browser.

## Canonical CI and deterministic golden proof

```text
bun run check
```

The canonical check runs the hosted and core test suites, fixture checks, and
WS1 release-integrity proof. The hosted suite and golden journey use in-memory Worker and
Durable Object adapters plus a deterministic Broker provider, without Google
credentials. The final release-integrity step needs registry network access and
the pinned toolchain; [ADR 0007](docs/adrs/0007-monorepo-source-and-release-integrity.md#release-integrity)
owns that contract.

Within the check, the golden journey publishes both
checked-in comparison Angels, promotes exact previewed deployments, discovers one
canonical Gmail tool with two opaque Connection choices, proves omission never
fans out, calls each Connection separately, pauses one tuple without pausing
the other, pauses all then resumes one tool, publishes v2 from checked-in
source, promotes it through the www action API, keeps the production key stable,
matches both gate receipts, and proves an outside Account receives only `404`.

## Full deployed comparison golden (operator-only)

```text
GOLDEN_CONTROL_URL=https://<control> \
GOLDEN_GATEWAY_URL=https://<gateway> \
GOLDEN_SESSION_TOKEN=<session-token> \
GOLDEN_ADMIN_TOKEN=<reset-token> \
bun run test:golden
```

This is the full comparison journey against deployed Control and Gateway
origins. It publishes, promotes, resets, and exercises the comparison Angels,
so it receives dedicated session and reset credentials. `GOLDEN_SESSION_TOKEN`
rides as a bearer on the management API and as the session cookie on the
dashboard's own routes, where the reset admin token needs the `Authorization`
header to itself.

Give it the **signed** cookie value — copy `__Secure-better-auth.session_token`
out of a signed-in browser, the `<token>.<signature>` pair, not a bare token.
One value has to satisfy both paths and only the signed form does: Better Auth
reads the cookie with `getSignedCookie` and rejects an unsigned value, while
its bearer plugin accepts either (it signs a bare token itself). A bare token
therefore passes `/v1` and fails reset with `401`.
This runner is distinct from the narrower real Google read acceptance below.

## Local browser proof (mocked)

Desktop and mobile UI proof against the real static shell with safe mocked API
responses (local agent-browser, not deployed):

- [Desktop](docs/screenshots/m1-home-desktop.png)
- [Mobile](docs/screenshots/m1-home-mobile.png)

These images remain deterministic local proof of the UI shell. The deployed
browser flow and real Google lifecycle were verified separately; the images do
not contain live identity or provider data.

## Real Google read proof

`google-read-proof` is the minimal read-only policy:
`gmail.users.messages.list` and `docs.documents.get`, executed from their
sealed request templates like every other reviewed operation. Deterministic CI tests
its transcript without credentials. The separate scheduled/manual acceptance
uses only `GOLDEN_GATEWAY_URL`, `GOLDEN_ANGEL_KEY`, `GOLDEN_GMAIL_QUERY`, and
`GOLDEN_DOC_ID`:

```text
GOLDEN_GATEWAY_URL=https://<gateway>/v1/a/<account>/google-read-proof/production/mcp \
GOLDEN_ANGEL_KEY=<key> \
GOLDEN_GMAIL_QUERY=<query> \
GOLDEN_DOC_ID=<id> \
bun run test:google-read-proof
```

See [`docs/google-read-proof-manual-journey.md`](docs/google-read-proof-manual-journey.md).

`GOLDEN_GATEWAY_URL` is the exact full production MCP endpoint, for example
`https://gateway.example/@<handle>/google-read-proof` (the legacy
`/v1/a/<account>/google-read-proof/production/mcp` shape still answers). It is
not an origin: the runner requires the checked-in Angel slug, calls the supplied
URL unchanged, and verifies both gate receipts against the checked-in build
digest.
The acceptance runner never receives Google credentials, a session, or
management credentials; it only has the public MCP endpoint and Angel key.

The runner has passed locally against the live deployment, including Gmail and
Docs before and after reauthorization, and failed loudly while the Connection
was revoked. GitHub Actions schedule and manual dispatch became runnable when
the M1 merge put the workflow file on the default branch.

The current OAuth app is in External Testing. Google limits that refresh token
to seven days, so move the app to Production before treating scheduled runs as
durable monitoring.

## HTTP surfaces

- `/v1/...` is the strict management resource API used by the CLI.
- `GET /api/demo/state` and `POST /api/demo/action` require a signed-in
  session, and answer for whichever Account that session names. Static shell
  assets are public — with Access gone, the sign-in page has to be reachable
  by somebody who is not signed in yet, and they carry no Account state.
- `POST /api/demo/reset` requires the automation-only admin bearer.
- The old embedded `POST /api/demo/publish` fixture route does not exist.
- `POST /@{handle}/{angel}` is the canonical MCP coordinate (PD 0001): bare is
  production, `/@{handle}/{angel}@preview` is the preview environment, and
  `latest`, `production`, `staging`, and pinned `@N` suffixes are 404s. It
  requires that environment's stable Angel key for initialize, discovery, and
  calls.
- `POST /v1/a/:account/:angel/:environment/mcp` is the legacy MCP route and
  still answers through the cutover; its `staging` segment is the old spelling
  of `preview`.

## Deploy

Deployment requires an operator API token scoped to the target Cloudflare
Account with Workers Scripts Edit, D1 Edit for the sign-in Worker's database
and its migrations, and — because `dash.` and `auth.` are Workers custom
domains, which write DNS — the zone-scoped Workers Routes Edit and Zone Read.
This token configures infrastructure and is never available to Worker code.

The dedicated Cloudflare account is the M1 target. Broker, Gateway, and Control
are deployed there from the hosted repository.

Deploy in dependency order:

```text
bun run wrangler deploy --config wrangler.broker.jsonc
bun run wrangler deploy --config wrangler.gateway.jsonc
bun run wrangler deploy --config wrangler.auth.jsonc
bun run wrangler deploy --config wrangler.control.jsonc
```

`angelmcp-auth` binds to nothing itself, but **Control binds to it** over the
`AUTH` service binding, so it must exist first — on a first deploy in the old
order Control bound a service that was not there yet. Control reaches it over
that binding rather than its public host, so the session question never leaves
Cloudflare's network. It needs two secrets of its own, `RESEND_API_KEY` and
`LOGIN_NAME_KEY`, plus the `AUTH_BASE_URL` and `LOGIN_FROM_ADDRESS` vars set in
`wrangler.auth.jsonc`. `LOGIN_NAME_KEY` is any long random string, and it is not
rotatable in place: it keys the hash that names each identity's storage, so
after a rotation the same address resolves to a fresh, empty identity and the
next sign-in mints a **second** Account for someone who already has one.
Sessions issued before the rotation keep working, because they carry the old
hash — so the two Accounts coexist. Treat it as set-once until identity
migration exists.

Required secrets (Auth needs `RESEND_API_KEY` and `LOGIN_NAME_KEY`; the rest
belong to the three older Workers):

- Broker: `CONTROL_BROKER_TOKEN`, `GATEWAY_BROKER_INVOKE_TOKEN`, `CREDENTIAL_KEK`
- Gateway: `CONTROL_GATEWAY_TOKEN`, `GATEWAY_BROKER_INVOKE_TOKEN`
- Control: `CONTROL_GATEWAY_TOKEN`, `CONTROL_BROKER_TOKEN`,
  `CONTROL_RESPONSE_KEK`, and `DEMO_ADMIN_TOKEN`

`MANAGEMENT_API_TOKEN` is gone. It named no Account, so beside a session that
names exactly one it could only widen what the session already bounds.

`DEMO_ADMIN_TOKEN` is reset-only for the comparison demo (`POST /api/demo/reset`).
`GOLDEN_SESSION_TOKEN` is a runner credential, not a Worker binding.

Three separate authentication paths:

- **Browser**: a session cookie issued by `auth.angelmcp.ai` after an emailed
  sign-in link. It is stamped for `.angelmcp.ai`, which is why both Workers had
  to leave `workers.dev` — that suffix is on the Public Suffix List, so no
  cookie there can span two Workers.
- **CLI and the acceptance runner**: the same session token as a bearer.
  `ANGEL_MANAGEMENT_TOKEN` and `GOLDEN_SESSION_TOKEN` both hold one. No command
  mints one yet.
- **Gateway-only acceptance runner** (`google-read-proof`): no session at all;
  only Gateway MCP endpoint and Angel key (public production surface).

Required Control variables are `CONTROL_BASE_URL` and `GATEWAY_BASE_URL`.
`ACCOUNT_ID`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUDIENCE` are gone with Access.
Control asks the sign-in Worker who is calling, forwarding whichever credential
the caller presented, and takes the Account from the answer.

Each internal token belongs to one caller/callee pair. Control also requires
all of its credentials and its response-replay encryption key to be non-empty
and pairwise distinct before private state or mutations reach the Account
registry. Bearer verification is timing-safe. The Broker has no public route.

## Honest boundary

This comparison proves portable policy build, immutable publish/deploy,
multi-Connection selection, Account-scoped management, stable keys, last-mile
availability, and independent two-gate enforcement. The deterministic golden
harness keeps those checks credential-free by injecting fixture provider
responses. A deployed Broker instead owns encrypted per-Account Google custody,
refreshes the stored grant, and invokes only the pinned Gmail/Docs operations;
unsupported operations and malformed provider results fail closed. A session
issued by `angelmcp-auth` protects Control and the browser custody flow.

Public signup is live: an email address gets a sign-in link good once for ten
minutes, and the person who clicks it lands in one empty Account that only they
can reach. Recovery, self-service deletion, a way for the CLI to obtain a
session, family membership, and production multi-tenant operation remain future
work. The separate credentialed acceptance
runner has exercised the real Google path locally without placing live provider
credentials in deterministic CI.

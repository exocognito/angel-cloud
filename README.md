# Angel Cloud comparison demo

The smallest hosted AngelMCP vertical slice that makes the fourth upstream
variant testable. It has Accounts, immutable Angel Versions, explicit
Connection bindings, stable Angel keys, and credential custody boundaries. It
has no code-execution engine.

The deployed shape is three Workers:

- **Control** owns one demo Account, the management API, immutable Versions,
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
Gateway second; production promotion consumes the exact active staging
deployment ID and digest.

## Documentation

- [Roadmap](ROADMAP.md) — plan of record: milestone sequence and status.
- [User manual](docs/user-manual.md) — write, build, publish, deploy, connect,
  and operate an Angel.
- [FAQ](docs/faq.md) — design rationale, security boundaries, and current
  limits.
- [Google read proof operator journey](docs/google-read-proof-manual-journey.md)
  — run the credentialed Gmail and Docs acceptance path.

This README is the quick start and deployment reference. The user manual owns
product mechanics; the FAQ owns rationale and current limits; the roadmap owns
sequence and status.

## Verified live status — 2026-07-22

- Broker, Gateway, and Control are deployed in the dedicated Cloudflare
  account. The current live revisions include the empty-Account Control fix
  (`9268fe7`), OAuth scope fix (`f8f9dc4`), and provider-error Gateway fix
  (`cb08c25`).
- The Control root redirects an unauthenticated request to Access (`302`) and
  returns the app to a valid Access service token (`200`).
- Live reset and state reads pass through the deployed Control surface.
- The hosted repo pins public `@smcllns/angel-core@0.2.0`, and its remote CI is
  green.
- Provider App `google-primary` is stored in Broker custody. Reads return only
  its safe summary; the client secret is not returned.

The real credentialed lifecycle now passes. An operator completed Cloudflare
account login and Google consent, authorized a Connection, published and
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
staging/production Connection nicknames. Builds emit canonical, secret-free
`build/angel.version.json` and `build/angel.version.sha256` files.

```text
bun run angel build golden-assistant
bun run angel publish golden-assistant
bun run angel deploy golden-assistant --prod
```

`publish` builds, ensures the Angel, publishes an immutable Version, and deploys
it to staging. `deploy --prod` promotes the exact active staged deployment; it
does not build or publish. M1 Control is Access-protected: CLI publish and
deploy require both `ANGEL_MANAGEMENT_TOKEN` and `ANGEL_ACCESS_TOKEN`.

## Deterministic CI (golden proof)

```text
bun run check
```

Ordinary CI runs the deterministic journey against in-memory Worker and
Durable Object adapters and injects a deterministic provider at Broker, without
Google credentials (378 tests / 2,559 assertions). The journey publishes both
checked-in comparison Angels, promotes exact staged deployments, discovers one
canonical Gmail tool with two opaque Connection choices, proves omission never
fans out, calls each Connection separately, pauses one tuple without pausing
the other, pauses all then resumes one tool, publishes v2 from checked-in
source, promotes it through the www action API, keeps the production key stable,
matches both gate receipts, and proves an outside Account receives only `404`.

## Full deployed comparison golden (operator-only)

```text
GOLDEN_ACCESS_TOKEN='{"cf-access-client-id":"...","cf-access-client-secret":"..."}' \
GOLDEN_CONTROL_URL=https://<control> \
GOLDEN_GATEWAY_URL=https://<gateway> \
GOLDEN_MANAGEMENT_TOKEN=<management-token> \
GOLDEN_ADMIN_TOKEN=<reset-token> \
bun run test:golden
```

This is the full comparison journey against deployed Control and Gateway
origins. It publishes, promotes, resets, and exercises the comparison Angels,
so it receives dedicated management and reset credentials. It strictly parses
`GOLDEN_ACCESS_TOKEN` and sends its two values as the standard
`CF-Access-Client-ID` and `CF-Access-Client-Secret` headers on direct Control calls.
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
`https://gateway.example/v1/a/<account>/google-read-proof/production/mcp`. It is
not an origin: the runner requires the checked-in Angel slug, calls the supplied
URL unchanged, and verifies both gate receipts against the checked-in build
digest.
The acceptance runner never receives Google credentials, Cloudflare Access
tokens, or management credentials; it only has the public MCP endpoint and
Angel key.

The runner has passed locally against the live deployment, including Gmail and
Docs before and after reauthorization, and failed loudly while the Connection
was revoked. GitHub Actions schedule and manual dispatch became runnable when
the M1 merge put the workflow file on the default branch.

The current OAuth app is in External Testing. Google limits that refresh token
to seven days, so move the app to Production before treating scheduled runs as
durable monitoring.

## HTTP surfaces

- `/v1/...` is the strict management resource API used by the CLI.
- `GET /api/demo/state` and `POST /api/demo/action` require a verified
  Cloudflare Access identity. Static shell assets contain no Account state.
- `POST /api/demo/reset` requires the automation-only admin bearer.
- The old embedded `POST /api/demo/publish` fixture route does not exist.
- `POST /v1/a/:account/:angel/:environment/mcp` requires that environment's
  stable Angel key for initialize, discovery, and calls.

## Deploy

Deployment requires an operator API token scoped to the target Cloudflare
Account with Workers Scripts Edit, Access: Apps and Policies Edit, and Access:
Service Tokens Edit. This token configures infrastructure and is never
available to Worker code. The Access service token is a separate runtime/client
credential.

The dedicated Cloudflare account is the M1 target. Broker, Gateway, and Control
are deployed there from the hosted repository.

Deploy in dependency order:

```text
bun run wrangler deploy --config wrangler.broker.jsonc
bun run wrangler deploy --config wrangler.gateway.jsonc
bun run wrangler deploy --config wrangler.control.jsonc
```

Required secrets:

- Broker: `CONTROL_BROKER_TOKEN`, `GATEWAY_BROKER_INVOKE_TOKEN`, `CREDENTIAL_KEK`
- Gateway: `CONTROL_GATEWAY_TOKEN`, `GATEWAY_BROKER_INVOKE_TOKEN`
- Control: `CONTROL_GATEWAY_TOKEN`, `CONTROL_BROKER_TOKEN`,
  `MANAGEMENT_API_TOKEN`, `CONTROL_RESPONSE_KEK`, and `DEMO_ADMIN_TOKEN`

`DEMO_ADMIN_TOKEN` is reset-only for the comparison demo (`POST /api/demo/reset`).
`GOLDEN_ACCESS_TOKEN` is a runner credential, not a Worker binding. It is the
complete opaque Access service-token JSON:
`{"cf-access-client-id":"...","cf-access-client-secret":"..."}`.

Four separate authentication paths:

- **Browser**: Cloudflare Access session/cookie after Cloudflare account login.
  The configured interactive identity provider is not one-time PIN.
- **CLI**: `ANGEL_ACCESS_TOKEN` as opaque two-key JSON, parsed into standard
  `CF-Access-Client-ID` and `CF-Access-Client-Secret` headers for Control
  management API calls (publish/deploy).
- **Deployed acceptance runner**: `GOLDEN_ACCESS_TOKEN` (same format as `ANGEL_ACCESS_TOKEN`)
  parsed into the same standard headers for Control state queries, plus Gateway
  MCP endpoint and Angel key for read-only calls.
- **Gateway-only acceptance runner** (`google-read-proof`): no Access credential;
  only Gateway MCP endpoint and Angel key (public production surface).

Required Control variables are `ACCOUNT_ID`, `ACCESS_TEAM_DOMAIN`,
`ACCESS_AUDIENCE`, `CONTROL_BASE_URL`, and `GATEWAY_BASE_URL`. Control
authenticates browser requests through Access and service-token requests
through `CF-Access-Client-ID` and `CF-Access-Client-Secret` headers before
routing to private state or provider custody.

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
unsupported operations and malformed provider results fail closed. Cloudflare
Access protects Control and the browser custody flow.

Public signup, multiple human Accounts, family membership, and production
multi-tenant operation remain future work. The separate credentialed acceptance
runner has exercised the real Google path locally without placing live provider
credentials in deterministic CI.

# Angel Cloud FAQ

Answers to the questions the [user manual](user-manual.md) does not cover: why
the platform works the way it does, what its limits are, and what comes next.
For how to do anything — write, ship, connect, operate — start with the manual;
this file links to it rather than repeat it.

[product-ledger-source]: https://github.com/exocognito/angelmcp/blob/main/docs/product-ledger.html

Present-tense statements describe the live Milestone 1 slice: the deployed
Workers, an Account per person who signs up, and real Google calls for two
pinned operations through bring-your-own OAuth custody. Cloudflare Access is
gone: signing in is an emailed link, and the dashboard serves whichever Account
the session names.
Where a limit bites, it is called out.

## Choosing Angel Cloud

### When should I pick Angel Cloud over the other shapes?

All four shapes begin with the same statically constrained toolbox: the same
charter, allowlist, and guards. They differ in where the provider credential
lives and how many independent checks sit between agent and provider:

- **Executor** — two gates; the credential lives in a general execution engine
  you rent or self-host.
- **Lite** — one worker, one gate; the worker itself holds a provider
  credential bounded only by its OAuth scope. The baseline that shows what the
  extra hop buys.
- **Relay** — two workers you host yourself, two credentials, two gates, two
  trust domains, no execution engine.
- **Angel Cloud** — the hosted evolution of relay's two-gate shape. An Account
  owns immutable Versions, Connection bindings, stable keys, and
  preview/production deployments; a shared Gateway and Broker enforce them.
  Nothing to host per Angel ([what it is](user-manual.md#what-angel-cloud-is)).

Pick lite for the smallest self-hosted footprint, relay to keep two trust
domains under your own control, Executor to lean on an existing engine, and
Angel Cloud when you want deploys, environments, pause controls, and
multi-Connection selection without operating workers per Angel.

### Why not just use OAuth scopes?

Scopes are too coarse. A single Gmail scope can permit several operations when
an Angel needs only one. An Angel narrows below any single scope: a compiled
allowlist plus argument guards ([writing one](user-manual.md#write-an-angel)).

The provider credential is still powerful inside Broker custody. The claim is
that the agent-facing path exposes and enforces less authority — not that OAuth
itself became narrower.

### Why not use Google's official Gmail MCP server?

A hosted MCP server over Gmail is convenient — nothing to host, no refresh token
in a worker you run — but it constrains the *tools*, not the *credential*. A
broad grant such as `gmail.compose` authorizes `messages.send`, so the token
behind such a server can do more than its exposed tools suggest; the safety then
rests on which tools are shown, not on what the credential itself can do. These
servers also give you no argument-level guards, no tool subsetting you control,
and no tamper-evident audit. An Angel gives you both halves: the forbidden
operation is absent from the toolbox, *and* the credential the agent can reach
stays in Broker custody, bounded by the compiled allowlist.

### Is Angel Cloud just relay mode as a hosted service?

No. Relay compiles each Angel into two workers you host; it is a per-Angel tier,
not a shared service Angels register with. Angel Cloud keeps relay's two-gate
idea but is a platform: Accounts, Versions, Connections, environments, and a
management API. One naming trap: the two-box mode was itself once named "cloud"
and was renamed "relay"; "Angel Cloud" now means only the hosted platform. It is
also not a fourth `upstream` value in `ANGEL.yaml` — an early framing now
superseded.

### Why not build it by forking Executor?

We audited that path and rejected it. Executor's execution engine and its fused
credential/integration model are central to its architecture, where Angel Cloud
needs Version, Connection, and binding kept separate. A fork would have started
as a large deletion and domain-remodeling project, not a small hosted product
waiting to be uncovered.

### Does Angel Cloud run my code?

No server runs your code or your build — that is a settled design decision.
Today the publish boundary accepts only a canonical, secret-free artifact.
When www authoring lands, Control will store `ANGEL.yaml` as owner-only data
and the browser will compile it; the publish and runtime boundaries will still
receive only the artifact
([ADR 0006](adrs/0006-browser-source-and-client-compilation.md)).
"Compiled" here means canonical declarative data the runtime interprets but
cannot edit.

## Design choices

### Why are Versions immutable?

So that production is exactly what you tested. Rebuilding or republishing during
promotion could make production differ from the staged bytes; instead, promotion
re-deploys the exact staged Version and digest under production bindings, and changes nothing else
([promote](user-manual.md#promote-the-exact-previewed-deployment)). We considered
building inside `deploy --prod` and promoting "latest", and rejected both: the
first lets bytes drift, the second races and cannot be audited. A Version is
never edited or overwritten, and runtime pause state never changes policy — the
durable path to less authority runs through the source
([pause and resume](user-manual.md#pause-and-resume)).

### Will my agents' keys change when I ship a new Version?

No. Management preserves each environment's keys across publishes and
promotions; a deploy never changes the active key set — only explicit key
actions (mint, rotate, revoke) do. Every successful tool
response carries `x-angel-version` and `x-angel-policy-digest` headers, so
agents can see the policy moved without losing their credentials
([read the results](user-manual.md#read-the-results)).

### Can I rotate an Angel key? Is it shown more than once?

A key's plaintext is shown exactly once, on the first ensure and again each time
you mint or rotate one ([publish](user-manual.md#publish-to-production)). Later
reads show only fingerprints. Rotation and revocation are explicit actions on
the dashboard's Agent Keys pane, never a side effect of a deploy
([the dashboard](user-manual.md#use-the-dashboard)). Keys are hashed at rest, so
a lost plaintext is unrecoverable — save it when it prints, or rotate to mint a
replacement. The last active key cannot be revoked.

### Why can't production reuse my staging bindings automatically?

(The environment is named `preview` since PD 0003; this question keeps its old
title so links keep working.) Implicit reuse would cross an environment
boundary and could promote the right Version with the wrong identity — in
either direction: preview never inherits production's Connections either
([PD 0005](product-decisions/0005-preview-binds-its-own-connections.md)). Each
environment stands alone ([concepts](user-manual.md#concepts)), so
`angel.json` spells out both maps and reviewing bindings at promotion is a
deliberate extra step ([angel.json](user-manual.md#angeljson)).

### What happens when an agent calls an operation outside my policy?

It cannot find one. `tools/list` returns only the deployed allowlist — the build
strips everything else — so `messages.send` never appears, and a well-behaved
framework has nothing to call and no wider-scoped client to fall back to. If the
agent invents the call anyway, the gates return a receipted `unknown_tool`
denial before any provider request ([errors](user-manual.md#errors)). In the
compiled shapes the guarantee is stronger still: the build never registered the
forbidden operation, so it does not exist at all. The same principle scopes
Accounts: an outside Account gets `404`, never a response that confirms the
resource exists.

### What happens if my agent omits `angel_connection`?

It depends on how many Connections are eligible. With exactly one, omission is
accepted. With several, the call returns `connection_required`
([choose a Connection](user-manual.md#choose-a-connection)). Angel Cloud never
fans one tool call out to every Connection: fan-out would silently broaden an
unchanged call the moment you add a Connection, and would drag in aggregation,
ordering, pagination, and partial-failure semantics the platform does not need.

### Will my agent ever see my Connection nicknames?

No. A nickname is management-only data: you set it when you authorize a
Connection and reference it in your local `angel.json`, and the dashboard shows
it back to you — but it never crosses the agent boundary. Agents see an opaque
per-deployment selector (`arc_...`) and a provider-derived identity label such as
`gmail - Google identity` — enough to choose correctly — and never the nickname,
the management Connection ID, or any credential
([discover tools](user-manual.md#discover-tools)). The MCP endpoint URL does
contain your Account ID, but no `tools/list` entry or receipt does. This is also
why tools are not renamed per Connection: a `personal.gmail...` prefix would leak
your private labels and break the agent contract every time you rename one.

### Can I declare or guard `angel_connection` in my own policy?

No. It is platform-reserved: a routing argument, not policy content. The
compiler rejects a schema that defines it, and the platform strips it before the
provider is invoked ([argument guards](user-manual.md#argument-guards)).

### Why three separate Workers?

Privilege separation. Control owns the Account, management API, and www shell;
Gateway faces the public and holds gate 2; Broker is reachable only over service
bindings, holds gate 1, custody, and the pinned provider calls
([how a call flows](user-manual.md#how-a-call-flows)). Only the Broker holds the
credential-encryption key; the Gateway never holds provider credentials; and
Control passes provider client material straight to Broker custody without
persisting or custodying it. Each internal token belongs to exactly one
caller/callee pair. And it is a fixed handful of Workers for the whole platform, not three
per Angel — the deploy count stays constant as Angels multiply.

### Why install the Broker before the Gateway?

The Gateway consults the Broker on every allowed call, and both must agree on
the exact deployment. Updating the inner gate first is safe whether the change
widens or narrows: during the brief mismatch, calls fail closed rather than slip
through. Pause closes the Broker first; resume opens it first. An interrupted
change leaves a repair marker — an identical retry resumes, a different mutation
conflicts with `409` until repair completes
([operate a deployment](user-manual.md#operate-a-deployment)).

### Why two gates at all, if both run in the same Cloudflare account?

Each gate independently evaluates policy, guards, availability, and Connection
resolution; the Broker does not trust the Gateway, and a call succeeds only when
both decisions converge. That catches a bug or compromise in either enforcement
path. The design is honest about the limit: the two gates are not independent
*administrative* trust domains, and both gates share decision code, so a shared
bug can affect both. Deliberately diverse gate implementations are deferred.

### What can a Cloudflare account administrator access?

The Worker split reduces accidental privilege and limits normal call paths, but
it is not a separate administrative trust domain. An administrator who can
replace the Broker or its secrets can reach every tenant's custodied provider
credential — that custody risk is the defining trade of the hosted shape.
Self-hosted relay remains the choice when independent infrastructure ownership
matters more than hosted operation.

### What is the public demo at `/demo/`, and what can it reach?

It is the dashboard itself — the same `index.html`, `app.js` and `app.css` the
signed-in Control worker serves, copied verbatim at build time so the demo
cannot drift from the product. What it is not is an account. The Angels,
Connections and receipts on it come from a fixture generated at build time by
running the real projection code over the checked-in Angel artifacts.

It reaches nothing. The page is served by the assets-only docs worker, which has
no service bindings, no Durable Objects and no secrets, so there is no path from
it to the Control worker, the Broker, or a credential. In the browser, one
injected script replaces `fetch` with an allowlist: three read paths answered
from the bundled fixture, every other request — cross-origin, same-origin, any
method — refused with a 403. Once that replacement is installed nothing reaches
the network at all. The two custody forms are disabled, because they include a
Google client secret field and a public page should not invite anyone to type a
secret into it.

### Why is enforcement not done by the model or a prompt?

Both gates are compiled from your source at build time — no model and no runtime
config sit in the enforcement path. The charter is prose for humans and agents
to read; only `tools` and `argGuards` are enforced
([ANGEL.yaml](user-manual.md#angelyaml)). Committed `ANGEL.yaml` is meant to
be public-safe. The public Angel page currently renders the free-text `charter`,
`argGuards` field names and literal values, and the raw policy digest. Put no
secrets or private content in them. The public-summary decision (O7 in the
[source-repository Product Ledger][product-ledger-source]) is settled but not
built. A Version whose raw digest was ever public remains non-hiding because an
observer can retain it. It must show a legacy warning, then be retired or
replaced by different canonical bytes whose digest has never been public before
a hiding summary can be served. On 2026-08-03 the owner settled the broader
question (O10 in the [source-repository Product Ledger][product-ledger-source]):
charter text and guard literals stay public. The rule above — put no secrets or
private content in `charter` or `argGuards` — is that documented boundary, so
treat both fields as published the moment you commit them.

## Google custody

### How are my credentials stored?

By design, and now implemented: application-level envelope encryption on top of
Cloudflare's at-rest encryption, because a credential custodian should not lean
on the platform default alone. The Broker's CredentialVault gives each Account a
random data key wrapped by a root key (`CREDENTIAL_KEK`) only the Broker holds;
Provider App secrets and Connection refresh tokens are AES-GCM encrypted with
additional authenticated data that binds each ciphertext to its exact record.
You can write credential records but never read them back — no API returns a
stored secret — and decryption or refresh failure throws, with no fixture
fallback. A secret is leased only inside the Broker, to refresh a Google access
token and make a pinned call
([credential boundary](user-manual.md#credential-boundary)). A stored Provider
App proves this write-only boundary in the live stack: it is stored and its safe
summary reads without ever returning the client secret.

### Do I have to bring my own Google OAuth app?

Yes, in Milestone 1. Add one client ID and secret to the signed-in Google
custody UI, then authorize as many Google Connections as you need
([add Google custody](user-manual.md#add-google-custody)). A platform-owned,
verified Google OAuth app is deferred. The current app is in External Testing,
where its refresh token expires after seven days — valid short-term proof, but
reliable scheduled acceptance needs a Production OAuth app.

### Which Google scopes are requested?

Each Provider App carries its own scope set, chosen when you register it with
`POST /api/provider-apps` on the signed-in Control origin; the
consent flow requests that set plus the identity scopes `openid` and `email`
([authorize a Connection](user-manual.md#authorize-a-connection)). A Provider
App registered without scopes — including every one saved through the
dashboard form, which sends none — gets the read-only default:
`https://www.googleapis.com/auth/documents.readonly` and
`https://www.googleapis.com/auth/gmail.readonly`.

Changing scopes needs no code change and no deploy, but a Provider App is
immutable once stored: register a new Provider App with the new set, authorize
new Connections through it, and rebind deployments that should use them.
Existing Connections keep the scopes Google granted them, and the Broker's
reach is bounded by those grants.

The Version still controls which pinned operations an agent can invoke; a
broader OAuth grant does not add a tool to an Angel. The converse now bites,
though: a Connection missing a scope cannot execute an operation the artifact
otherwise allows.

### What are a Provider App and a Connection, and why are they separate?

A Provider App is a reusable OAuth client (ID + secret). A Connection is one
authorized identity: a refresh grant plus its scopes. One Provider App can back
several Connections — your personal and work Google accounts through one client
([save a Provider App](user-manual.md#save-a-provider-app)). Secrets are
write-only after submission. The policy references neither object; `angel.json`
uses only a private Connection nickname, resolved through the authenticated
management API. Reauthorizing a Connection preserves its Provider App, Google
subject, and nickname, and never changes any Angel Version
([manage a Connection](user-manual.md#manage-a-connection)).

### Can one Connection serve several Angels?

Yes. Connections belong to the Account, not to any Angel, so the same Connection
can back many Angels without entering their policy
([concepts](user-manual.md#concepts)). A deployment binds an Angel's exact
requirements to any healthy compatible Connection in that Account.

## Day to day

### What's the difference between `ANGEL.yaml` and `angel.json`?

One holds policy, the other holds deployment detail
([write an Angel](user-manual.md#write-an-angel)). `ANGEL.yaml` is portable and
meant to stay public-safe
([current public boundary](#why-is-enforcement-not-done-by-the-model-or-a-prompt));
`angel.json` is local — target URL, Account, Angel slug, and private Connection
nicknames ([angel.json](user-manual.md#angeljson)). The split keeps policy
reusable: the same `ANGEL.yaml` can target Angel Cloud or a
compatible self-hosted control plane, because `target` is an explicit URL, not a
built-in platform name. It also lets another person reuse the policy without
inheriting your Account identity or credential labels.

### When do I need composition?

Composition (`angels:` instead of `tools:`) is optional — a single Angel listing
tools from several providers is valid
([composing Angels](user-manual.md#composing-angels)). Compose when parts need
independent review or reuse, or when the same provider needs different rules per
identity — one Connection read-only while another, authorized through a Provider
App whose scope set covers drafting, may draft. That takes two children with
different allowlists, bound to different Connections.

### How do I roll back?

By re-promotion. Stage the earlier Version again, then promote that exact staged
deployment through the normal path — a full two-gate deployment, not a pointer
flip ([promote](user-manual.md#promote-the-exact-previewed-deployment)). No
dedicated rollback command exists yet, so today you publish and deploy the old
source again yourself.

### Can I author or publish an Angel from the web UI?

Not today. The dashboard can promote an already-staged Version, manage keys,
and pause or resume tools, but it cannot yet author, build, or publish source
([the dashboard](user-manual.md#use-the-dashboard)).

That is now an implementation gap, not a permanent boundary.
[PD 0006](product-decisions/0006-www-is-a-full-write-surface.md) makes www a
full-parity write surface. Its future editor will write the same `ANGEL.yaml`
shape, use the same compiler, and publish the same immutable artifact as the
CLI. Until that work lands, policy still enters through reviewed source and
the CLI ([ship it](user-manual.md#ship-it)).

### What's the difference between pause/resume and disabling an Angel?

Pause/resume is per environment: one tool, one tool + Connection pair, or
everything in preview or production — a reversible overlay that never creates a
Version or touches a guard ([pause and resume](user-manual.md#pause-and-resume)).
It can remove effective availability but can never add a tool or loosen a guard.
A global "disable Angel" circuit breaker across both environments is on the
deferred list, not built in this slice. You can pause or resume a whole
environment at once (Pause all / Resume all) or toggle individual tools. Pause
all and Resume all reset the environment default and clear every per-tool and
per-Connection override, so after a Resume all nothing stays paused; while the
default is paused, a tool added by a later deployment inherits that paused
default until you resume.

## Enforcement and isolation

### How are Accounts isolated?

Control asks the sign-in Worker who is calling and takes the Account from the
answer, so each person reaches their own and nothing names an Account from
configuration. The Account registry and credential custody key their state by
that Account. A request for another Account's resource returns `404`,
not a denial that confirms the resource exists
([errors](user-manual.md#errors)). General multi-tenant provisioning and
membership are not built yet.

### What is recorded in gate receipts?

The Gateway's gate records every decision it makes — allow, deny, and guard
rejection — with the request, deployment, Version, policy digest, bindings,
availability state, tool, and selected Connection. On the normal path a request
with a missing or malformed Angel key is rejected at the edge with `401` before
the gate runs, so it writes no receipt; the gate's own defense-in-depth key
re-check, if it ever fires, does write a receipt and returns `401` / `-32001`.
The Broker records only the calls that reach it: a call
the Gateway denies never does, so it carries no Broker receipt. Agent-facing
receipts are redacted — no management Connection IDs or nicknames. The two
ledgers are hash-chained and correlated by one request ID, so tampering is
evident. Caveat: no retention, search, or export guarantee exists yet.

## Testing and status

### Does Angel Cloud call real Gmail and Docs?

Yes, through bring-your-own Google OAuth custody. The Broker enumerates no
operations: it executes the request template the artifact sealed for whichever
tool the gates allowed, so any operation the reviewed adapter registry can
derive reaches Google — provided the Connection holds the scope it needs. The
credentialed acceptance proves the path against
`gmail.users.messages.list` and `docs.documents.get`; only the separate
deterministic CI path swaps in an injected adapter. Everything in
front of
the provider — the CLI, artifact bytes and digests, the Account-scoped API, both
gates, MCP auth, Connection selection, availability, and isolation — is the same
path deployed to Cloudflare (Control at `https://dash.angelmcp.ai`, sign-in at
`https://auth.angelmcp.ai`, Gateway still on `*.sam-633.workers.dev`; the
Broker is reachable only over service bindings).

### Does ordinary CI call real Google? Isn't that just mocking?

No — and the distinction matters. Deterministic CI swaps only the last edge, the
provider and its credential, for a deterministic adapter injected at the Broker
boundary ([deterministic CI](user-manual.md#deterministic-ci)). Everything in
front of that edge is real, so CI stays fast, repeatable, secret-free, and
runnable from forks. It does not claim that Google consent or refresh behavior
was exercised — the separate credentialed acceptance does that.

### How is the real Google path proven?

A separate `google-read-proof` acceptance calls the production MCP endpoint with
only an Angel key, a Gmail query, and a Docs ID — no Access, management, Google
password, refresh token, or operator credential
([real Google acceptance](user-manual.md#real-google-acceptance)). It has passed
locally with live secrets: Gmail and Docs read, revocation failed loudly,
row-level reauthorization preserved the same Connection identity, and both reads
passed again. The M1 merge put the workflow on the default branch, so its GitHub
Actions schedule and `workflow_dispatch` run; External Testing still caps the
refresh token at seven days, so this is not yet a durable monitor.

A separate operator-only comparison journey exercises the mutating path —
multiple Connection choices, pause/resume, a v2 Version, stable keys, matching
receipts, and isolation — using dedicated session and reset
credentials ([comparison journey](user-manual.md#full-deployed-comparison-journey)).

### Is Milestone 1 complete?

Yes. It merged to main on 2026-07-23 (PR #1), and Broker, Gateway, and Control
are deployed and live in the dedicated Cloudflare account: an unauthenticated
Control root request serves the public shell (`200`) and every Account route
answers `401 {"error":"sign-in required"}` until a session says who is asking.
Live reset and state reads pass. Public
`@smcllns/angel-core@0.3.0` is published. Canonical source is workspace-linked
at `packages/core` under one workspace lockfile, and the release check compares
its packed runtime with npm
([status](user-manual.md#milestone-1-what-is-live)). Signing in,
Google consent, publish/deploy, seeded Gmail and Docs reads, loud revoke
failure, row-level reauthorization on the same Connection, and the final pass
are all verified. The acceptance workflow reached the default branch with the
merge, so its schedule and manual dispatch run; durable scheduling still waits
for the OAuth app to reach Production. The full milestone sequence and ordering
live in the repository's canonical
[source-repository Product Ledger][product-ledger-source]. `ROADMAP.md` remains
a stable pointer for old links.

### Can I sign up for Angel Cloud today?

Yes. `https://dash.angelmcp.ai` takes an email address, mails a sign-in link
good once for ten minutes, and gives whoever clicks it one empty Account of
their own — which the dashboard then serves. What is missing is recovery if you
lose the address, and self-service deletion.

Control now serves whichever Account the caller's session names, and signing in
is an emailed link rather than a Cloudflare account login. There is still no
waitlist, Account switcher, billing, public catalog, SLA, or team membership —
and no recovery and no self-service deletion. One person holds one Account; to
work in another you sign out and sign in as somebody else.

## Roadmap

### What is not built yet?

The deferred list, straight from the tracking notes: self-service Account
deletion and recovery, membership, and team roles; a platform-owned
verified Google OAuth app; more Gmail operations and providers (Maps, X, Slack,
WhatsApp, Telegram, iMessage); Provider App removal (the API returns `501`),
rollback commands, and a global cross-environment Angel disable; activity
retention, search, export, quotas, billing, custom domains, and service
guarantees; a REST invocation surface (MCP is deliberately the only tool surface
for now), per-token subscopes, approvals, and diverse gate code; and a supported
self-host control-plane guide.

### Which providers come after Gmail and Docs?

The plan: extend Gmail from read-only proof to drafts and writes with real guard
enforcement; then Google Maps and Twitter/X; then differently shaped services
(Slack, WhatsApp, Telegram, iMessage) only once each proves the primitive it
needs. The exact order is an open decision, and the "communications stack"
example in the research notes is illustrative — those adapters do not exist.

### Why did the repos split, and where does what live now?

One canonical repository now owns both product areas. `exocognito/angelmcp`
keeps the hosted Workers, custody, www, deployment, and research at its root. Its
`packages/core` workspace owns the source schema, compiler, artifact format,
target-neutral CLI, and management contract, and publishes unchanged as
`@smcllns/angel-core`. The stable boundary remains the versioned artifact plus
the strict management contract: the core CLI treats `target` as an opaque HTTPS
origin and knows nothing of Cloudflare or Angel Cloud. The move preserves the
standalone source history through a documented rewrite map and a private,
owner-only literal archive. [ADR 0007](adrs/0007-monorepo-source-and-release-integrity.md)
records the ownership and release-integrity contract.

### Can I self-host a compatible control plane?

The contract allows it: the same source files and core package can target any
control plane that speaks the management contract, since `target` is just a URL.
In practice no self-hosting guide exists yet, and the self-hosted adapter work
is explicitly deferred. Angel Cloud is the implemented target; the alternative
is designed for, not yet packaged.

### What questions can't this repo answer yet?

Asked often, answered nowhere in the code or docs — so we say so rather than
guess: pricing; how to get access; SLA, uptime, and support; data residency and
compliance; rate limits and quotas (no numbers); MCP client setup recipes for
specific agents; the full canonical tool catalog beyond Gmail and Docs; Version
deletion and storage limits; team roles and member permissions; and recovery
from a lost Angel key beyond rotating to a replacement.

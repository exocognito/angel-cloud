---
name: create-publish-operate-an-angel
description: >-
  Use when a user wants to create, publish, and operate an Angel on Angel Cloud
  — a hosted, policy-sealed, credential-custodied surface of provider tools
  (e.g. read-only Gmail and Google Docs) that an agent calls over MCP. Walks
  from an empty directory to a promoted Angel answering calls: authenticate
  management calls, author the Angel, add a Google Connection, build, publish to
  preview, promote the exact previewed deployment, mint a key, and connect over
  MCP. Everything runs through the management API and the published
  @angelmcp/cli — do NOT clone the exocognito/angelmcp repository.
---

# Create, publish, and operate an Angel

## The one rule that trips agents up

**Do not clone `exocognito/angelmcp`.** The tooling is a published npm
package (`@angelmcp/cli`), and every deployment step is an HTTP call to
the management API. The source tree is the operator's, not the user's. If you
find yourself running `git clone` or `bun run angel` *inside the product repo*,
stop — you have taken the wrong path. Work in the user's own empty directory.

## Mental model

- **Angel** — a named policy that exposes a fixed set of provider tools, each
  optionally constrained by argument guards. Authored in `ANGEL.yaml`.
- **Version** — an immutable build artifact compiled from `ANGEL.yaml`
  (`build/angel.version.json` + a digest). Same input → same digest.
- **Environment** — `preview` and `production`, each a mutable pointer to one
  Version plus its bindings, keys, and availability. Production is the default:
  the bare coordinate addresses it, and only `@preview` names an environment.
  The server accepts `staging` only as a legacy management-API spelling.
- **Connection** — a custodied provider credential (e.g. a Google OAuth grant).
  Bindings map an Angel's requirements to Connections by nickname.
- **Angel key** — the opaque bearer an agent presents to the MCP endpoint. It
  is the *only* secret the agent holds; enforcement and credentials stay server-side.

Full definitions: [user manual → Concepts](https://docs.angelmcp.ai/user-manual.md#concepts).

## What needs credentials, and what is offline

| Step | How | Credentials |
| --- | --- | --- |
| 1. Install the CLI | `pnpm` + `bun` | No credentials (needs the npm registry) |
| 2. Get the two management credentials | From the Angel Cloud owner | Owner-provisioned |
| 3. Add a Google Connection | Browser (Cloudflare Access + Google consent) | Interactive login — no headless path |
| 4. Author `ANGEL.yaml` + `angel.json` | Text editor | None — offline |
| 5. Build the Version | `angel build` | None — offline, no network |
| 6. Publish to preview (opt in) | `angel publish --preview` / API | Management bearer + Access token |
| 7. Promote to production | `angel deploy --prod` / API | Management bearer + Access token |
| 8. Connect over MCP | HTTP to the Gateway | The minted Angel key only |

Steps 2 and 3 cannot be done from a shell — a person provisions the credentials
and completes the browser OAuth. Everything else you can drive directly.

---

## Step 1 — Install the CLI (no repo clone)

The CLI ships as `@angelmcp/cli` and runs under **Bun** (its entrypoint has a
`#!/usr/bin/env bun` shebang, and the package declares `engines.bun >= 1.3.0`).
Install Bun if it is missing (https://bun.sh), then, in the user's project
directory:

```sh
pnpm add @angelmcp/cli
```

Invoke it with `pnpm exec angel <command>`. The CLI accepts four subcommands —
`build`, `publish`, `deploy … --prod`, and `delete` — and prints a `usage:`
line for anything else, so your first real use is the build in step 5.

If you cannot or prefer not to run the CLI, every publish/promote step has a
raw-HTTP equivalent — see [Appendix: raw management API](#appendix-raw-management-api).
The one step with **no** server endpoint is the build (step 5): the artifact is
compiled locally by the package. That is the only reason tooling is in the loop
at all — it still does **not** require cloning the product repo.

## Step 2 — Get the two management credentials

Both come from the person who owns the Angel Cloud account; there is no
self-service token endpoint.

- `ANGEL_MANAGEMENT_TOKEN` — the Control management bearer, sent as
  `Authorization: Bearer <token>`.
- `ANGEL_ACCESS_TOKEN` — a Cloudflare Access service token as opaque JSON with
  exactly two keys:
  `{"cf-access-client-id":"...","cf-access-client-secret":"..."}`.

Never write either into source, `angel.json`, logs, a command transcript, or an
Angel artifact. Pass them as environment variables only.

## Step 3 — Add a Google Connection (browser, one time)

Provider custody requires an interactive browser flow — there is no headless
API to mint a Google Connection. Ask the owner to, in the Cloudflare
Access-protected dashboard:

1. Save a Provider App (their own Google OAuth client; the secret is stored
   write-only).
2. Authorize a Connection through Google's consent screen and give it a
   **nickname** — you will reference that nickname in `angel.json`.

Detail: [user manual → Add Google custody](https://docs.angelmcp.ai/user-manual.md#add-google-custody).

## Step 4 — Author the Angel

In the user's project, create `angels/<slug>/ANGEL.yaml`. `ANGEL.yaml` is
portable policy only — no targets, no secrets. Before writing `charter` or
`argGuards`, read
[the current public boundary](https://docs.angelmcp.ai/faq.md#why-is-enforcement-not-done-by-the-model-or-a-prompt).
The public Angel page renders the charter verbatim and the guard field names and
literal values:

```yaml
name: google-read-proof
charter: Read bounded Gmail search results and one requested Google Doc. Never create, edit, send, or delete.
tools:
  - tool: gmail.users.messages.list
    argGuards:
      - field: maxResults
        pin: "5"
  - docs.documents.get
```

- `name` is a lowercase slug and must match the directory name.
- Each tool is a bare operation string or `{tool, argGuards}`. A guard is
  `pin` (force a value), `forbid: true` (reject the field), or `forbiddenValues`.
- Milestone 1 only reaches Google with `gmail.users.messages.list` and
  `docs.documents.get`; other operations fail closed.

Then the local deployment config `angels/<slug>/angel.json` — the target Control
origin, the account, and which Connection nickname satisfies each binding
requirement in each environment. Keep the real `angel.json` untracked.

```json
{
  "target": "https://angelmcp-control-demo.sam-633.workers.dev",
  "account": "acct_...",
  "angel": "google-read-proof",
  "bindings": {
    "preview":    { "gmail": "<connection-nickname>", "docs": "<connection-nickname>" },
    "production": { "gmail": "<connection-nickname>", "docs": "<connection-nickname>" }
  }
}
```

Production bindings are explicit and never inherit from preview. Details:
[Write an Angel](https://docs.angelmcp.ai/user-manual.md#write-an-angel).

## Step 5 — Build the Version (offline)

```sh
pnpm exec angel build google-read-proof
```

Compiles `ANGEL.yaml` into `build/angel.version.json` and
`build/angel.version.sha256`. Deterministic, secret-free, makes no network
request.

## Step 6 — Publish to preview

```sh
ANGEL_MANAGEMENT_TOKEN=... \
ANGEL_ACCESS_TOKEN='{"cf-access-client-id":"...","cf-access-client-secret":"..."}' \
pnpm exec angel publish google-read-proof --preview
```

Publish rebuilds, lists healthy Connections, resolves the preview bindings,
ensures the Angel, publishes the immutable Version, and installs it in the
preview environment. Without `--preview`, core 0.3.0 publishes to production.

**On the first ensure, the response prints the shown-once preview and
production Angel keys.** Capture them immediately into a secret store — later reads expose
only fingerprints. Then verify the preview tool list is exactly what you expect
(here: `gmail.users.messages.list` and `docs.documents.get`).

## Step 7 — Promote the exact previewed deployment

```sh
ANGEL_MANAGEMENT_TOKEN=... \
ANGEL_ACCESS_TOKEN='{"cf-access-client-id":"...","cf-access-client-secret":"..."}' \
pnpm exec angel deploy google-read-proof --prod
```

`deploy --prod` reads the active preview deployment, resolves production
bindings, and promotes that exact previewed Version and digest under them. It does
not build, publish, or pick a newer Version — the policy is exact by
construction, though production keeps its own bindings.
Reference: [Promote the exact previewed deployment](https://docs.angelmcp.ai/user-manual.md#promote-the-exact-previewed-deployment).

## Step 8 — Connect an agent over MCP

Each Angel has one canonical MCP coordinate; bare means production:

```text
POST https://<gateway>/@<handle>/<angel>           → production
POST https://<gateway>/@<handle>/<angel>@preview   → preview
Authorization: Bearer <Angel key>
```

`<handle>` is the Account's public handle. `latest` and `production` are
rejected as suffixes, so production has exactly one spelling. The legacy route
`POST /v1/a/<account>/<angel>/<staging|preview|production>/mcp` still answers
through the cutover. Today `<gateway>` is
`angelmcp-gateway-demo.sam-633.workers.dev`. The endpoint
speaks MCP streamable HTTP, protocol version `2025-06-18`. Send:

- `Content-Type: application/json`
- `Accept: application/json, text/event-stream`
- `MCP-Protocol-Version: 2025-06-18` (after `initialize`)
- `Origin`, if sent, must match the endpoint origin.

`tools/list` returns only deployed tools that have an active Connection, with
canonical names (e.g. `gmail.users.messages.list`). If several Connections are
eligible, a `tools/call` must include an `angel_connection` selector (an opaque
`arc_...` value from the schema); with exactly one eligible Connection it may be
omitted. Re-list after each deploy instead of caching. A successful call returns
provider data in `structuredContent`, text in `content`, and redacted gate
receipts in `_meta`. Reference: [Connect an agent](https://docs.angelmcp.ai/user-manual.md#connect-an-agent).

---

## Verify you are done

Acceptance for this journey: an agent holding only the production Angel key can
`initialize`, `tools/list`, and `tools/call` the promoted Angel against the
production MCP endpoint and get real provider data back. That is the whole
user-facing check, and it needs no repo.

[The operator journey](https://docs.angelmcp.ai/operator-journey.md) is a
maintainer's worked run of this same create → publish → promote lifecycle —
including revoking a Connection to prove loud failure, then reauthorizing to
prove recovery. Note its automated acceptance *runner*
(`bun run test:google-read-proof` and repo variables) is the maintainer's CI
harness that does live in the product repo; it is not part of the no-clone user
path, and you do not need it to confirm the check above.

## Common failures

- `401 invalid Angel key` — wrong, revoked, or wrong-environment key, or an
  unknown Account handle in the coordinate (answered like a wrong key on
  purpose). Keys are per environment; the preview key does not work on
  production.
- `connection_required` — several Connections are eligible and the call omitted
  `angel_connection`. Re-run `tools/list` and pass the selector.
- A tool missing from `tools/list` — it is not in the deployed policy for that
  environment, or it is paused / has no active Connection. (An operation outside
  the Milestone 1 Google surface can still appear in `tools/list` if you deployed
  it; it fails closed at call time rather than being hidden.)
- Publish/ensure rejects an `Idempotency-Key` **reused with different input**.
  Resend the same key only to retry the identical call (safe); use a fresh key
  for a genuinely new mutation. Do not confuse this with the shown-once Angel
  key from ensure — that is a bearer secret, not an idempotency key.

More: [user manual → Errors](https://docs.angelmcp.ai/user-manual.md#errors).

## Appendix: raw management API

If you drive the API directly instead of the CLI, the base is
`https://angelmcp-control-demo.sam-633.workers.dev`. Every `/v1/...` route
requires **both** a Cloudflare Access identity (the `CF-Access-Client-ID` /
`CF-Access-Client-Secret` header pair from `ANGEL_ACCESS_TOKEN`) **and**
`Authorization: Bearer <ANGEL_MANAGEMENT_TOKEN>`. The account in the path must
match the Access identity. Every mutating call takes an `Idempotency-Key`
header: generate one key per logical mutation, resend the **same** key to
safely retry that exact call (a lost response is why you retry), and never
reuse a key for different input. This matters most on the first ensure — if you
retry it with a *new* key after a dropped response, you can strand the
shown-once Angel keys; retry with the same key instead.

| Step | Call |
| --- | --- |
| Ensure (create) Angel; returns shown-once keys on first create | `PUT /v1/accounts/{account}/angels/{slug}` |
| Publish immutable Version (send the built artifact + its digest) | `POST /v1/angels/{id}/versions` |
| Deploy Version to preview (`staging` is the accepted legacy spelling) | `POST /v1/angels/{id}/environments/preview/deployments` |
| Deploy Version straight to production in one step | `POST /v1/angels/{id}/environments/production/deployments` |
| Promote previewed → production (send the previewed deployment id, digest, and production bindings) | `POST /v1/angels/{id}/environments/production/promotions` |
| Mint an additional named key | `POST /v1/angels/{id}/environments/{env}/keys` |
| Read an environment (fingerprints, pending/active deployment) | `GET /v1/angels/{id}/environments/{preview\|production}` |
| List Connections (resolve nicknames → ids) | `GET /v1/accounts/{account}/connections` |

The build step (`ANGEL.yaml` → artifact + digest) has **no** server endpoint;
compile it locally with `angel build` and send the resulting artifact to
`POST .../versions`. Provider-App and Connection setup use the Access-session
`/api/...` and `/oauth/...` routes and end in an interactive browser redirect —
they are not scriptable end to end.

## Deeper reading

- [User manual](https://docs.angelmcp.ai/user-manual.md) — canonical mechanics.
- [FAQ](https://docs.angelmcp.ai/faq.md) — rationale, security boundaries, limits.
- [Operator journey](https://docs.angelmcp.ai/operator-journey.md) — worked credentialed lifecycle.

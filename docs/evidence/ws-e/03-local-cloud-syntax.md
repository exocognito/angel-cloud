# WS-E brief 3 — local and cloud consent syntax

- Decision: O3
- Evidence status: complete
- Product implementation: none
- Outcome: close O3 for syntax and custody separation
- Verified: 2026-08-01

## Question

What exact syntax separates local and cloud consent and custody?

## Method

Read the shipped parser and target journeys, ran shipped parser probes in a clean temporary directory, prototyped a strict parser outside the repository, and walked separate fresh local and managed journeys with no repo, fixture, seeded state, old credentials, or hidden interface.

## Verified results

- The shipped CLI has no `apps`, `connect`, or `serve` command.
- At `6cc2ed5`, before the WS-E reconciliation, the target guide ambiguously made bare `apps connect` cloud-owned while `serve` could create local custody.
- A strict parser can reject missing or conflicting custody before OAuth or storage.
- Inferring custody from login, config, machine type, command context, or available keyring can send authority to the wrong custodian.

## Decision outcome

Outcome: close O3. Require exactly one of:

```sh
angel apps connect <provider> --local --nickname <name> --scopes <list> [--app <name>]
angel apps connect <provider> --cloud --nickname <name> --scopes <list> [--app <name>]
```

There is no default. Connect creates custody, not a project binding. Local and cloud App profiles, grants, nicknames, and bindings are separate records even when their labels match. No grant is copied or promoted between them.

## Product implication

Local can remain account-free and cloud can remain separately authenticated. The custody decision is visible before consent, scriptable, and fail-closed. `serve` consumes only local custody; managed publish consumes only cloud Connections.

## Execution gates

- Freeze provider App registration and callback contracts, including a real disposable Google loopback/HTTPS PKCE test.
- Define local and cloud profile/config schemas, exact help, outputs, failures, idempotency, and safe browser handoffs.
- Prove omitted/both flags fail before side effects and local/cloud never inspect or fall back to each other.
- Keep the reconciled target guide and APRD aligned with explicit custody, no implicit binding mutation, and the settled `api.angelmcp.ai` host.

## Evidence record

Repository state: `evidence/ws-e-decision-briefs` at `6cc2ed5`

### O3 full record

#### O3 full record: Question

What exact syntax separates local and cloud consent/custody?

#### O3 full record: Method

1. Read the approved Product Ledger, shipped manual and FAQ, unapproved APRD,
   target CLI guide, package guide, parser source, parser tests, and examples.
2. Reconstructed the shipped and target command trees.
3. Ran the shipped parser from a new temporary directory with only newly written
   source and config. No checked-in fixture, deployed endpoint, credential, or
   seeded state was used.
4. Prototyped a strict target parser in `/tmp` and tested omitted, conflicting,
   and explicit custody modes.
5. Walked two independent fresh-user journeys. Each starts without a repo,
   Account session, provider grant, Angel key, fixture, or seeded state.

#### O3 full record: Commands and sources

Primary sources:

- Product Ledger: `docs/product-ledger.html`, O3, C6, LR-007, LR-013, LR-017.
- Shipped mechanics: `docs/user-manual.md` sections **Add Google custody**,
  **Install the CLI**, **Build locally**, and **Publish to production**.
- Shipped limits and custody rationale: `docs/faq.md` sections **Google custody**,
  **Can I sign up**, and **What is not built yet**.
- Target draft: `docs/aprd/v2.1-cli-user-guide.md` sections **angel apps connect**
  and **angel serve**.
- Unapproved APRD: `docs/aprd/angel-cloud-aprd.html` sections 0, 4.3, 4.4,
  8.1, and the commitment matrix.
- Actual parser: `packages/core/src/cli/commands.ts`, SHA-256
  `418ecb3f6a1fe2ffbe9b55b30b15028ca280c92e2f6fb797b44bc6e39be1e937`.
- Config parser: `packages/core/src/cli/config.ts`.
- Parser tests: `packages/core/tests/cli.test.ts`.
- Public package description: `packages/core/README.md`.
- Safe examples: `examples/angels/*/ANGEL*.yaml`, `angel.example.json`, and
  `examples/angels/FIXTURES.md`.

Executable shipped-parser probes:

```text
angel --help
  exit 1: usage: angel build <angel> | angel publish <angel> ...

angel build demo
  exit 0: built demo 25c136... in <clean-dir>/angels/demo/build

angel apps connect google --nickname personal --scopes gmail.compose --app owner-google
  exit 1: usage: angel build <angel> | angel publish <angel> ...

angel apps connect google --local ...
  exit 1: same usage error

angel apps connect google --cloud ...
  exit 1: same usage error

angel serve demo
  exit 1: same usage error
```

The probe wrote only the expected build files under its temporary directory.
It did not contact a network or credential store.

Strict target-parser prototype, SHA-256
`3825b70396a4cac18ff5d9cebf4fbb3f709911d6105ded9272aab9e15ac2003e`:

```text
REJECT  apps connect google ...
        one of --local or --cloud is required
REJECT  apps connect google --local --cloud ...
        --cloud is not allowed with --local
ACCEPT  apps connect google --local ...
ACCEPT  apps connect google --cloud ...
```

The temporary probe was not committed because this workstream authorizes
saved evidence, not product implementation.

#### O3 full record: Verified results

##### O3 full record: Shipped behavior — FACT

The shipped CLI has exactly four top-level commands:

```text
angel
├── build <angel>
├── publish <angel> [--preview [--share-production-credentials]]
├── deploy <angel> --prod
└── delete <angel> [--confirm <slug>]
```

There is no `help`, `--help`, `account`, `create`, `apps`, `serve`, `verify`,
`receipts`, or `replay` command. Invalid input prints one long usage error and a
Bun stack trace. This makes future custody syntax undiscoverable today.

Current consent is managed-only and browser-only:

1. The owner signs into the private Control site through Cloudflare Access.
2. The owner submits a Google OAuth client to Control.
3. Control passes the material to write-only Broker custody.
4. The owner completes Google consent in the same browser flow.
5. `angel.json` names the managed Connection in separate preview and production
   bindings.

The CLI neither starts this consent nor stores a local provider credential.
`angel build` is local and secret-free, but no local runtime exists. Current
publish needs `ANGEL_MANAGEMENT_TOKEN`, optionally `ANGEL_ACCESS_TOKEN`, a
pre-provisioned Account, and an already healthy managed Connection.

`angel.json` currently has an exact four-key schema: `target`, `account`,
`angel`, and `bindings`, with exactly `preview` and `production`. It has no local
profile or local binding namespace. Unknown keys fail.

##### O3 full record: Target documents — TARGET, not shipped

The target CLI guide defines:

```text
angel apps connect google --nickname <name> --scopes <list> [--app <name>]
angel serve <angel> ... [--grant <nickname>]
```

But its `apps connect` side effect is cloud-specific: it stores the grant in
Broker custody, stores a safe summary in Control, and updates the production
binding. The guide then says `serve` may run a different local consent and store
local tokens in the OS keychain. Nothing in the command name tells the owner
which custody path will run.

The guide also says `apps connect` updates a selected Angel binding, but its
syntax names neither an Angel nor a binding requirement. That side effect is
not composable or exact.

The Product Ledger resolves the product rule but leaves syntax open:

- local and managed are separate passing journeys;
- local use must not require Angel Cloud;
- local and cloud consent and token state stay separate;
- tokens are never copied between them;
- custody must be explicit, with `--local` and `--cloud` recommended;
- inferred custody is rejected.

The APRD is stale on this point. Its golden path logs into cloud before local
serve and says the same OAuth client works in both paths. Reusing an OAuth client
registration may be possible, but reusing or copying a grant is not allowed by
the later Ledger.

#### O3 full record: Alternatives

| Alternative | Discoverability | Custody clarity | Errors and state | Composability | Verdict |
|---|---|---|---|---|---|
| Required flags: `apps connect google --local\|--cloud` | Both modes appear together in one help page. | Explicit at the action that creates custody. | Parser can reject neither/both before OAuth or storage. | One verb and stable options across providers. | **Recommend.** Smallest change from the draft and matches the Ledger. |
| Positional mode: `apps connect local google` / `... cloud google` | Strong tree and completion. | Explicit. | Also easy to reject. | The phrase reads less naturally and changes provider position. | Sound, but no evidence justifies diverging from the Ledger's named flags. |
| Root namespaces: `angel local apps connect` / `angel cloud apps connect` | Very strong if many commands gain two modes. | Explicit across the whole tree. | Clear state ownership. | Adds a hierarchy before evidence shows enough shared commands to need it. | Too broad for O3. |
| Infer from login, config, `serve`, or `publish` | Shortest command. | Hidden; behavior changes with ambient state. | A stale login or old config can send a grant to the wrong custodian. | Poor in scripts and agent runs. | Reject. |
| One consent copied or promoted between local and cloud | Appears convenient. | False custody boundary. | Couples revocation and leaks authority across modes. | Hidden side effect. | Reject by Ledger rule. |

#### O3 full record: Recommendation

Canonical syntax:

```sh
angel apps connect <provider> --local \
  --nickname <nickname> --scopes <comma-separated-scopes> [--app <app-name>]

angel apps connect <provider> --cloud \
  --nickname <nickname> --scopes <comma-separated-scopes> [--app <app-name>]
```

Rules:

1. Exactly one of `--local` and `--cloud` is required. There is no default.
2. Flag order may be parser-flexible, but docs always put the custody flag
   directly after the provider.
3. `--app` is a safe App-profile name, never a client ID or secret.
4. OAuth client secrets enter only through the human browser handoff. They never
   appear in argv, stdout, logs, `ANGEL.yaml`, or `angel.json`.
5. `--local` may read and write only the local App/grant profile. It must not
   require login, call Control, inspect cloud Connections, or fall back to cloud.
6. `--cloud` may read and write only the selected Account's Broker custody. It
   requires Account login and must not inspect, import, or fall back to a local
   token.
7. The same nickname or App name in both namespaces still denotes two records.
8. Connect creates custody, not a project binding. It prints the nickname and
   the exact binding edit or next command. The current draft's automatic binding
   mutation is removed because the command names no Angel or requirement.
9. `serve` consumes local credentials only. `publish` consumes cloud
   Connections only. Each fails rather than crossing custody.

#### O3 full record: Recommended complete command tree

This is the combined target tree after O3 and O5. Existing supporting commands
stay visible. It is a recommendation, not shipped behavior.

```text
angel
├── account
│   └── login [--control <https-origin>] [--account <handle>]
├── create <angel> --template <template> [--directory <path>]
├── apps
│   └── connect <provider> (--local | --cloud)
│       --nickname <nickname> --scopes <scope-list> [--app <app-name>]
├── build <angel> [--out <directory>]
├── serve <angel> [--bundle <path>] [--port <port>]
│   [--grant <local-nickname>]
├── publish <angel> [--preview [--share-production-credentials]]
├── deploy <angel> --prod
├── verify <angel> --production [--bundle <path>]
├── receipts
│   └── pull <angel> --production --from <n> --to <n> --out <path>
├── replay <angel> --receipts <path> --bundle <path>
└── delete <angel> [--confirm <slug>]
```

Top-level help must group paths by effect, not present one flat usage line:

```text
LOCAL       create, apps connect --local, build, serve
ANGEL CLOUD account login, apps connect --cloud, publish, deploy, delete
EVIDENCE    verify, receipts pull, replay
```

`angel apps connect --help` must show `(--local | --cloud)` as required and say
where each mode stores credentials before the owner starts OAuth.

#### O3 full record: Full fresh local journey — RECOMMENDATION

This journey is independent. It starts with no Account session and must still
pass if Angel Cloud is unavailable.

```sh
# Brief 1 supersedes the target draft; this command remains pending O1 namespace control.
bun add --global @angelmcp/cli@0.1.0 # pending O1

angel create draft-check-7k2m --template gmail-draft-without-send
angel build draft-check-7k2m
angel apps connect google --local \
  --nickname local-gmail-7k2m --scopes gmail.compose --app local-google-7k2m
angel serve draft-check-7k2m --port 7423 --grant local-gmail-7k2m
```

State transitions:

```text
blank directory
→ source + local config written
→ owner reviews complete ANGEL.yaml
→ secret-free bundle and digest written
→ human enters own OAuth client in localhost browser handoff
→ human completes Google consent
→ local App + grant stored atomically in the Angel-owned encrypted vault
→ localhost MCP server listens with that local grant
→ agent lists tools and creates a uniquely marked draft
→ owner confirms draft and no sent message
```

Cloud invariants throughout: no Account, login, Control call, cloud Connection,
deployment, Angel key, cloud receipt, or Broker custody record is created.

The success output from connect must include:

```text
connected: google / local-gmail-7k2m
custody: LOCAL — stored on this machine; Angel Cloud was not contacted
identity: <provider-derived label>
scopes: gmail.compose
credential: <local store label>; secret not shown
cloud changes: none
next: angel serve draft-check-7k2m --grant local-gmail-7k2m
```

Human handoffs: review source, enter/confirm the OAuth client, consent, and
inspect the provider side effect. The agent may open the browser and prepare
non-secret fields; it may not consent.

#### O3 full record: Full fresh managed journey — RECOMMENDATION

This is a second independent start. It may reuse reviewed source bytes, but it
must not reuse the local grant, old Account state, or local credential profile.

```sh
bun add --global @angelmcp/cli@0.1.0 # pending O1

angel account login --control https://api.angelmcp.ai --account <fresh-handle>
angel create draft-cloud-9p4r --template gmail-draft-without-send
angel build draft-cloud-9p4r
angel apps connect google --cloud \
  --nickname cloud-gmail-9p4r --scopes gmail.compose --app cloud-google-9p4r

# Apply the printed cloud production-binding edit, then publish.
angel publish draft-cloud-9p4r
angel verify draft-cloud-9p4r --production

# The owner's agent then calls the printed production MCP endpoint.
angel receipts pull draft-cloud-9p4r --production \
  --from <first-sequence> --to <last-sequence> \
  --out receipts/production.ndjson
angel replay draft-cloud-9p4r \
  --receipts receipts/production.ndjson \
  --bundle angels/draft-cloud-9p4r/build/angel.version.json
angel delete draft-cloud-9p4r
```

State transitions:

```text
blank identity and directory
→ human magic-link login; Account-scoped machine session stored
→ reviewed source and secret-free bundle written
→ human enters/confirms own OAuth client in Account browser handoff
→ human completes a new Google consent
→ App secret + refresh grant stored write-only in Broker custody
→ safe Connection summary stored in Control
→ nickname added to reviewed cloud production binding
→ immutable Version + production deployment + shown-once Angel keys created
→ production call creates a uniquely marked draft and two receipts
→ private receipt range downloaded and replayed locally
→ Angel deleted through public management flow
```

Local invariants: no provider grant is written to the local credential store;
no existing local token is read or copied. The Account session is not a provider
token.

The cloud connect success output must include:

```text
connected: google / cloud-gmail-9p4r
custody: CLOUD — Broker custody for Account @<fresh-handle>
identity: <provider-derived label>
scopes: gmail.compose
health: healthy
local provider credential: none
binding value: cloud-gmail-9p4r
```

Human handoffs: Account sign-in, OAuth-client entry/confirmation, Google
consent, source review, and final draft inspection.

#### O3 full record: Exact O3 target contract

##### O3 full record: Inputs and outputs

- Required: provider, one custody flag, nickname, scopes.
- Optional: App-profile name.
- Print only safe summaries, custody destination, identity label, granted
  scopes, health, and next action.
- Never print bearer tokens, OAuth client secrets, refresh tokens, internal
  Connection IDs, or local secret-store contents.

##### O3 full record: Durable side effects

- `--local`: one machine-local App profile and provider grant, stored in the O2
  Angel-owned encrypted vault with TTY/FD unlock. No cloud or project-policy mutation.
- `--cloud`: one Account-owned Provider App/Connection in Broker custody plus a
  safe Control summary. No local provider credential or policy mutation.
- Neither mode edits `ANGEL.yaml`.
- Project binding changes require a named, reviewable follow-up because connect
  does not identify an Angel requirement.

##### O3 full record: Idempotency

- Retrying the same mode + provider + App + nickname + provider identity refreshes
  the same record atomically.
- A lost callback retries with a new nonce and does not create a duplicate.
- Reusing a nickname for another identity or App fails without overwrite.
- A record in the other custody namespace is never considered a retry match.

##### O3 full record: Failures

| Failure | Required behavior |
|---|---|
| Neither or both custody flags | Exit 2 from parsing, before browser, network, or storage. Show both exact forms. |
| `--cloud` without Account login | Exit nonzero before OAuth. Print `next: angel account login`. |
| `--local` with no usable Angel vault (see O2) | Fail before consent is committed. No cloud fallback. |
| Missing App profile | Open or name the mode-specific human App setup handoff. Never search the other mode. |
| Declined or partial consent | Store no healthy grant; name missing scopes and retry command. |
| Nickname/identity/App collision | Preserve the old record; require a new nickname or explicit reauthorization. |
| Local storage failure | No cloud mutation or plaintext fallback file. |
| Broker custody failure | No local token, Connection summary, publish, or provider call. |
| Account mismatch | Return the same isolation-safe error as an absent owned resource. |

##### O3 full record: Handoffs

Only the owner enters/confirms OAuth-client material and completes provider
consent. An agent may run commands, open URLs, and prepare safe fields.

#### O3 full record: Product implication

O3 is not cosmetic syntax. It makes G13 testable: local use remains independent,
managed custody remains separate, and hosting stays optional. The CLI guide must
split its single connect section into two contracts, remove the ambiguous
production-binding side effect, and make both journeys independently runnable.
The config/profile migration and App registration command or browser handoff
need their own build contracts before WS2 approval.

#### O3 full record: Can O3 close?

**Yes.** The evidence supports required, mutually exclusive `--local` and
`--cloud` flags and rejects ambient inference. Closing O3 does not claim that
local credential storage works on Linux (O2), that App registration is fully
specified, or that WS2 is approved (O10).

---

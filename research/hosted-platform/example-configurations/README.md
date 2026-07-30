# Portable Angel configuration examples

Status: design examples for the accepted PR4 contract. The `.hosted.yaml`
suffixes are retained only so existing links keep working; the YAML itself is
not hosted-specific. A source can be built unchanged for Angel Cloud or a
self-hosted compatible control plane.

The checked-in runnable comparison fixtures live under `angels/`:

- `angels/gmail-inbox-zero/ANGEL.yaml` — direct, single-provider policy;
- `angels/gmail-read-and-draft/ANGEL.yaml` and `angels/gdocs-read/ANGEL.yaml` —
  reusable child policies;
- `angels/golden-assistant/ANGEL.yaml` — local composition of those
  children.

This folder explains the same source/deployment boundary and preserves one
larger illustrative stress case.

## The two source forms

A direct Angel lists canonical tools. It may contain one or many providers:

```yaml
name: research-assistant
tools:
  - gmail.users.messages.list
  - gmail.users.messages.get
  - docs.documents.get
```

A composite Angel names local sibling Angels:

```yaml
name: research-assistant
angels:
  - gmail-read-and-draft
  - gdocs-read
```

Exactly one of `tools` or `angels` is present. Local references contain no
Account, Connection alias, target, or `@version`. The build resolves them and
records the child digests in the immutable artifact. Missing children, cycles,
and tool-policy collisions fail the build.

Composition is optional. Use a direct multi-provider Angel when one policy is
the simplest thing. Use children when policies need independent review/reuse or
different deployment binding requirements.

## Tools and guards

A plain string allows one canonical provider operation:

```yaml
- gmail.users.messages.get
```

An object attaches compile-time argument guards:

```yaml
- tool: gmail.users.messages.modify
  argGuards:
    - field: addLabelIds
      forbiddenValues: [TRASH, SPAM, SENT]
    - field: removeLabelIds
      forbiddenValues: [TRASH, SPAM, SENT]
```

`angel_connection` is reserved by the platform and cannot be declared or
guarded in source. It is a runtime routing argument, not policy content.

## Deployment is a separate local file

`angel.json` contains private, target-specific deployment choices:

```json
{
  "target": "https://control.example.com",
  "account": "acct_example",
  "angel": "research-assistant",
  "bindings": {
    "preview": {
      "gmail": ["google-primary", "google-work"],
      "docs": "google-primary"
    },
    "production": {
      "gmail": ["google-primary", "google-work"],
      "docs": "google-primary"
    }
  }
}
```

Connection nicknames are allowed here because this file is local deployment
configuration, not the public Angel policy. The CLI resolves them through the
authenticated management API and sends management Connection IDs. Credentials
never enter either file.

For a direct Angel, binding requirement IDs are provider namespaces such as
`gmail` and `docs`. For a composite Angel, a single-provider child uses its
child name, such as `gmail-read-and-draft`; a multi-provider child uses
`<child>:<provider>`. The artifact declares the exact requirement IDs, so the
CLI does not infer them from nicknames.

A string binds one Connection. An array binds repeated identities to the same
policy. Staging and production maps are always explicit and never copied from
one another implicitly.

## Repeated Connections stay out of public tool names

Two Gmail bindings do not create `personal.gmail...` and `work.gmail...` tools.
There remains one canonical MCP tool, for example:

```text
gmail.users.messages.list
```

After agent-key authentication, `tools/list` adds an `angel_connection`
selector containing environment-scoped opaque refs and provider-derived
identity labels. It never exposes a management Connection ID or a user-authored
nickname. A call may omit the selector only when exactly one active Connection
is eligible. With multiple eligible Connections the selector is required;
omission never fans out.

## Examples

| Source | Purpose | Support level |
|---|---|---|
| `gmail-inbox-zero.hosted.yaml` | reviewed Gmail allowlist and guards | supported source shape and current adapter |
| `golden-research-assistant.v1.hosted.yaml` + `v2` | direct Gmail + Docs policy and one-tool Version diff | supported source shape and current adapters |
| `communications-stack.hosted.yaml` | future mixed communications policy with repeated bindings | illustrative only; most adapters/tool names are not implemented |

The adjacent `*.angel.json` files illustrate private bindings. They use example
targets, Accounts, and nicknames and are not deployable without replacement.

## Broad communications stress case

The illustrative communications source anticipates two Gmail Connections, one
Docs Connection, two X Connections, WhatsApp Business, an iMessage bridge, a
Telegram bot, and two Slack installations. It tests whether the source and
binding concepts scale without account-prefixed tools. It does **not** claim
those adapters or exact operation contracts exist today.

Important provider-shape caveats:

- WhatsApp means Meta WhatsApp Business Cloud API, not arbitrary personal
  WhatsApp history.
- iMessage requires a separately operated device bridge; it is not a hosted
  Apple mailbox API.
- Telegram uses a bot token in this illustration, not a user session.
- Slack represents workspace installations or grants.

Different policies for repeated identities require composition. For example,
if personal Gmail may draft but family Gmail is read-only, create two child
Angels with different allowlists and bind each child requirement separately.
If both identities use the same policy, one direct `gmail` requirement with a
two-element binding array is sufficient.

## Environment and availability invariants

Each environment owns its deployment, bindings, stable agent key, and runtime
availability overlay. `publish --preview` builds and deploys to preview; bare
`publish` goes to production. Production
promotion names the exact active staged deployment and digest while supplying
the production binding map; it does not rebuild or republish.

Pause/resume changes runtime availability, not the immutable Version. It can
target all tools, one canonical tool, or one `(tool, Connection)` tuple. The
management plane accepts a management Connection ID for owner controls and
resolves it server-side to the environment's opaque runtime ref.

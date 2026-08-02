# WS-E brief 5 — replay command shape

- Decision: O5
- Evidence status: complete
- Product implementation: none
- Outcome: close O5 for command shape
- Verified: 2026-08-01

## Question

Is replay `angel replay` or `angel serve --replay`?

## Method

Compared the Ledger, APRD, CLI guide, eval draft, shipped parser, receipt shape, and complete managed journey. Ran shipped parser probes and a strict target-parser prototype outside the repository.

## Verified results

- Neither replay form ships.
- At `6cc2ed5`, before the WS-E reconciliation, the APRD conflicted with itself; the guide, evals, and Ledger used top-level replay.
- Replay is a one-shot, provider-free evidence check after receipt pull. It does not need a listening MCP server or local provider custody.
- Current agent-safe receipts omit original arguments needed to recompute decisions; replay requires a separate private authenticated export.

## Decision outcome

Outcome: close O5. Use only:

```sh
angel replay <angel> --receipts <path> --bundle <path>
```

Do not add `serve --replay` as an alias. Every chain, range, bundle, engine, argument-digest, or decision mismatch is a hard failure; remove optional `--fail-on-tamper`. Replay starts no server, reads no credential store, changes no durable state, and makes zero provider calls.

## Product implication

The journey has three explicit trust actions: `serve` exercises local runtime and may call a provider; `receipts pull` authenticates and downloads private evidence; `replay` verifies it locally without credentials or network calls.

## Execution gates

- Define a private owner-only replay NDJSON schema containing original arguments plus complete Gateway/Broker chain identity.
- Make pull output mode 0600 and never expose raw arguments on public or agent-safe surfaces.
- Prove deterministic stdout/stderr/status, zero network/provider calls, first-mismatch diagnostics, and failures for every tamper or missing field.
- Keep the reconciled APRD, guide, and eval references on the mandatory top-level command.

## Evidence record

Repository state: `evidence/ws-e-decision-briefs` at `6cc2ed5`

### O5 full record

#### O5 full record: Question

Is replay `angel replay` or `angel serve --replay`?

#### O5 full record: Method

1. Traced every replay reference through the Ledger, APRD, target guide, evals,
   shipped parser, tests, manual, and FAQ.
2. Compared both forms in the complete command tree and managed journey.
3. Probed the shipped parser and a strict target parser.
4. Compared process state, credential loading, help, errors, batch use, and
   provider side-effect risk.

#### O5 full record: Commands and sources

- Product Ledger O5: “Recommend separate `angel replay` unless the complete
  journey disproves it.”
- Product Ledger contradiction C13/LR-018: APRD and target guide conflict.
- Product Ledger command C11: replay is read-only unless explicit report output.
- APRD §4.4: `angel serve gmail-inbox-zero --replay activity.json`.
- APRD §8.1: later uses top-level `angel replay ... --fail-on-tamper`.
- APRD commitment matrix: still says `angel serve --replay`.
- Target CLI guide **angel replay**: top-level replay with receipt and bundle
  paths.
- Generative evals: require `angel replay`, tamper naming, and zero provider
  calls.
- Shipped parser and manual: no replay or serve command exists.

Executable probes:

```text
# Shipped parser
angel serve demo --replay activity.json
  exit 1: shipped four-command usage

angel replay demo --receipts activity.ndjson --bundle build/angel.version.json
  exit 1: shipped four-command usage

# Strict recommended target parser
angel serve demo --replay activity.ndjson
  REJECT: unrecognized arguments: --replay activity.ndjson

angel replay demo --receipts activity.ndjson --bundle build/angel.version.json
  ACCEPT

angel replay demo --receipts activity.ndjson
  REJECT: --bundle is required
```

#### O5 full record: Verified results

##### O5 full record: Shipped behavior — FACT

Neither form exists. The current runtime evaluator runs only in Workers, the
agent-safe receipt omits fields needed by the target replay proof, and no public
receipt-range export exists. The FAQ explicitly says receipt retention, search,
and export have no guarantee yet.

##### O5 full record: Target contradiction — TARGET

The APRD's station sketch treats replay as a mode of the long-running local
server. The target CLI guide, normative golden-path list, generative evals, and
Ledger Surface Window treat replay as a separate one-shot command. The APRD
therefore contradicts itself as well as the guide.

The complete journey does not disprove the Ledger's recommendation. Replay
happens after a production call and receipt pull. At that point the owner needs
a deterministic, provider-free batch check, not a listening MCP endpoint.

There is also a data-contract gap: a local decision cannot be recomputed from an
`argumentsDigest` alone. Replay needs the original tool arguments held by the
owner's client or included in a private authenticated export. The current guide
names only a receipt file and bundle, so its input format is not yet executable.

#### O5 full record: Alternatives

| Alternative | Discoverability | Process and credential state | Errors | Composability | Verdict |
|---|---|---|---|---|---|
| `angel replay ...` | Visible at top level and under Evidence in help. | One-shot, read-only, no port, provider token, login, or server lifecycle. | Dedicated parse/integrity/mismatch errors and useful exit status. | Pipes, CI, repeated audit, and tamper tests fit naturally. | **Recommend.** |
| `angel serve <angel> --replay <file>` | Buried under runtime help. | Overloads “serve”: unclear whether it loads a token, opens a port, calls a provider, or exits. | Mode conflicts grow as serve gains flags. | Poor batch semantics; accidental long-running process risk. | Reject. |
| `angel receipts replay ...` | Groups evidence commands. | One-shot and safe. | Clear. | More typing; replay is also local-engine behavior, not merely receipt transport. | Sound but weaker than the already documented top-level command. |

#### O5 full record: Recommendation

Use a separate top-level command. `serve` has one job: start a local MCP server
using local custody. `replay` has one job: recompute recorded decisions without
starting a server or loading any provider credential.

Canonical syntax:

```sh
angel replay <angel> --receipts <path> --bundle <path>
```

Do **not** ship `angel serve --replay` as an alias. No compatibility burden
exists because neither command ships today.

The target draft's optional `--fail-on-tamper` should also be removed. A chain,
digest, engine, argument, or decision mismatch is always a failed verification
and must always produce a nonzero exit. A report-only success status would make
CI and agent use less safe.

#### O5 full record: Exact O5 target contract

##### O5 full record: Purpose and inputs

`angel replay` re-runs each recorded gate decision through the local engine over
exactly one supplied bundle. It never invokes a provider.

Required inputs:

- Angel slug;
- private replay NDJSON path;
- canonical bundle path.

Each NDJSON record must contain enough owner-only data to recompute the decision:

```json
{
  "request": {"tool": "<canonical operation>", "arguments": {}},
  "gateway": {"sequence": 128, "argumentsDigest": "<sha256>", "hash": "<hash>"},
  "broker": {"sequence": 128, "argumentsDigest": "<sha256>", "hash": "<hash>"}
}
```

The real schema must also carry the complete receipt identity, previous hashes,
decision, detail, bundle digest, and engine pin. Raw arguments are private
Account evidence: `receipts pull` writes the file with owner-only permissions
and never prints them. They do not enter a public trust page or agent-safe
receipt. If the export contains only a digest, replay fails instead of guessing.

##### O5 full record: Output

Success:

```text
replay: MATCH
angel: draft-cloud-9p4r
records: 24 (128..151)
bundle digest: <sha256> match
engine pin: <version> match
decisions: 24/24 match
argument digests: 24/24 match
provider calls: 0
```

First mismatch:

```text
replay: MISMATCH
sequence: 137
field: gateway.decision
recorded: allow
local: deny
provider calls: 0
```

The command reports the first mismatch to stderr and exits nonzero. It may print
aggregate counts before that point, but it must not print request arguments by
default.

##### O5 full record: Side effects and state transitions

```text
bundle + private receipt export present
→ validate paths and schemas
→ verify both hash chains and range continuity
→ verify bundle digest and engine pin
→ recompute each argumentsDigest
→ run policy decisions locally
→ compare decision and detail
→ print MATCH or first MISMATCH
→ exit; no durable state changed
```

No server starts. No port binds. No Account session, Angel key, local provider
grant, cloud Connection, Broker, Gateway, or provider is read or contacted.
There is no default report file and no credential-store access.

##### O5 full record: Idempotency

Replay is deterministic and read-only. The same exact bundle and NDJSON bytes
produce the same stdout, stderr, and exit status. File timestamps and ambient
profiles do not affect the result.

##### O5 full record: Exit and failure contract

| Exit | Meaning | Required output |
|---|---|---|
| `0` | Every record and comparison matches. | `replay: MATCH`, counts, digest, pin, and `provider calls: 0`. |
| `1` | Input I/O/schema failure, chain break, range gap, digest/pin mismatch, missing original arguments, argumentsDigest mismatch, decision/detail divergence, or tamper. | First failing sequence and field path when available; no provider call. |
| `2` | CLI usage error. | Exact syntax and missing/unknown option. |

Errors must distinguish unreadable file, malformed NDJSON line, wrong Angel,
wrong bundle digest, unsupported engine pin, chain break, sequence gap, missing
arguments, argument digest mismatch, and policy divergence. Every error ends
with `provider calls: 0` when replay began.

##### O5 full record: Handoffs

None. Receipt acquisition may require Account login in the prior `receipts pull`
step; replay itself is fully local and non-interactive.

##### O5 full record: Help and discoverability

Top-level help lists `replay` under **Evidence**. Dedicated help is:

```text
usage: angel replay <angel> --receipts <path> --bundle <path>

Recompute recorded decisions locally. Never starts a server or calls a provider.
```

`angel serve --help` contains no replay option and says it may make provider
calls through a local grant. The contrast makes credential and side-effect
boundaries visible before execution.

#### O5 full record: Full journey placement

Replay belongs in the managed journey after the agent's production call:

```sh
angel receipts pull <angel> --production --from <n> --to <n> --out <path>
angel replay <angel> --receipts <path> --bundle <path>
```

It executes locally but is not part of local provider custody. A pure local
journey has no cloud receipt range to pull. This placement keeps “where the
command runs” separate from “where the evidence came from.”

#### O5 full record: Product implication

Choosing top-level replay separates three trust operations:

- `serve`: exercise a real local runtime and may call a provider;
- `receipts pull`: authenticate to Control and download private evidence;
- `replay`: inspect that evidence locally with zero credentials or provider
  calls.

The APRD §4.4 transcript and commitment matrix must change from
`serve --replay` to `angel replay`. The target CLI guide must define a
replay-capable private export, not only `argumentsDigest`. The eval must assert
zero network/provider calls and deterministic nonzero exits for every tamper.

#### O5 full record: Can O5 close?

**Yes.** The complete tree and both journeys favor `angel replay`; no evidence
supports coupling replay to server startup. The private receipt/export schema
still needs implementation proof, but it does not change the command-shape
decision.

---

#### O5 full record: Verification commands

Commands run after the investigation:

```text
pnpm --dir packages/core test tests/cli.test.ts
  41 pass, 0 fail

bun test tests/cloud/aprd-v2.test.ts tests/cloud/product-ledger.test.ts
  38 pass, 0 fail
```

These passing tests prove the current parser and the saved target-document
contradiction. They do not prove the recommended commands exist.

Repository files were not changed.

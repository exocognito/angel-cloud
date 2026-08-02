# WS-E brief 7 — public review and self-hosting boundaries

- Decision: O7
- Decision: O9
- Evidence status: complete
- Product implementation: none
- Outcome: close O7 to a reduced public summary and close O9 to status-only wording
- Verified: 2026-08-01

## Question

What minimum public review artifact can ship without leaking private state, and how should Round 2 describe self-hosting?

## Method

Ran a field-by-field threat/privacy review over artifact, source, public page, demo, management, custody, binding, Connection, receipt, and deployment data. Compared that with what anonymous users can verify. Separately audited source/package licensing, portable contracts, Worker buildability, manifests, deployment notes, support claims, self-host guides, clean-room evidence, and conformance proof.

## Verified results

- The exact v2 artifact and current demo/public projection can carry charter, guard literals, source/composition names, scopes, provider and operational details, identity labels, or deployment metadata.
- A capability-only projection can disclose canonical operation names, whether guards exist, and a hiding artifact commitment without revealing exact guards or identity.
- `@smcllns/angel-core@0.3.0` is public and MIT licensed; `ANGEL.yaml`, v2 artifacts, and the management client are target-neutral by design.
- The hosted repository is publicly readable but has no repository-wide detected license. Its real Worker implementation builds, but manifests and operator notes are tied to the current demo.
- No fresh-account setup, conformance suite, upgrade/recovery/teardown proof, independent implementation, or support promise exists.

## Decision outcome

Outcome: close O7 and O9.

O7 becomes a **public review summary**, not a full independently verifiable bundle:

```json
{
  "schema": "angel.public-review.v1",
  "disclosure": "capability-summary-only",
  "artifact": {"format": "angel.version.v2", "commitment": "<sha256>"},
  "tools": [{"operation": "<canonical operation>", "hasArgumentGuards": true}]
}
```

Unknown keys fail. A Version whose raw digest was ever publicly observable remains permanently non-hiding: an observer can retain that digest and test low-entropy artifact guesses after the live surface removes it. Do not emit `angel.public-review.v1` with a hiding claim for such a Version. Show an explicit non-hiding legacy warning, retire or replace it, and use a replacement Version with different canonical bytes whose raw digest has never been public. For each eligible published Version, generate one nonce, store it owner-only alongside the Version evidence, and reuse it for every public summary response for that Version. Prove that no public surface has ever exposed that Version's raw `policyDigest` and that none exposes it now. The commitment is SHA-256 over a domain separator, that fresh 32-byte owner-held random nonce, and the canonical artifact bytes. The nonce, raw digest, exact source, guards, artifact, scopes, and bindings remain owner-only within the summary contract. A separate owner-opted-in public-source surface is outside `angel.public-review.v1`; it may disclose chosen charter, guard, or source fields, but never include intentionally disclosed source fields in the summary or publish the same-Version raw digest while calling the commitment hiding. The copy must say the summary cannot independently verify the artifact or inspect exact guards.

O9 ships one honest status note: portable design and current Worker source exist; supported, licensed, reproducible self-hosting does not. Round 2 tests local and managed journeys only. Local use is not self-hosting.

## Product implication

G11 narrows from “full public review bundle” to public capability summary. The current charter/guard public page needs an explicit privacy treatment before adding a download surface. G13 remains unproved for supported self-hosting; ID-07 is a status note, not a setup guide.

## Execution gates

- Implement an exact-key validator and adversarial leak corpus for the public summary; prove anonymous live output contains none of the explicit exclusions. Prove fresh nonce generation, owner-only nonce custody, and resistance to offline guesses of low-entropy charter and guard values.
- Add a cached-digest adversary: capture the current raw digest, remove it from live surfaces, and prove the historical Version remains non-hiding and cannot emit `angel.public-review.v1` with a hiding claim.
- Retire or replace every digest-exposed Version. Serve the summary only for replacement canonical bytes whose raw digest has never been public, and prove current surfaces do not expose it.
- Decide whether the current charter/guard page is narrowed or moved to a separate owner-opted-in public-source surface. Never include intentionally disclosed source fields in the summary; the summary's owner-only claim does not apply to fields the owner publishes separately.
- Do not claim digest recomputability, exact-policy review, open source, turnkey setup, cross-implementation compatibility, support, upgrades, recovery, SLA, or security maintenance.
- A future self-host claim requires a repository-wide license, parameterized manifests, public least-privilege setup, clean-room deployment, full lifecycle/recovery proof, versioned conformance tests, and a support boundary.

## Evidence record

### O7 and O9 full record

Evidence date: 2026-08-01  
Repository state: `evidence/ws-e-decision-briefs` at `6cc2ed5`
Scope: evidence only; no product or repository files changed.

---

### O7 full record

#### O7 full record: Question

What exact minimum public review bundle should managed publish expose without
leaking identity, Connection, credential, secret, nickname, private source,
private deployment, or operational metadata?

#### O7 full record: Method

1. Read the Product Ledger records for O7, PD-00B, G03, G08, and G11.
2. Read the APRD terminology and public-trust claims.
3. Traced the v2 artifact from compiler to publish validation, gate install,
   public projection, receipts, and custody.
4. Read PD 0002, PD 0007, and their privacy tests.
5. Inspected the generated demo fixture and the deployed read-only demo.
6. Ran an adversarial local artifact through the real compiler and public-page
   projection with a placeholder email in the charter and a private document ID
   in a guard.
7. Ran focused artifact, public-page, and public-demo tests.
8. Probed the documented live Gateway and docs hosts without credentials.

#### O7 full record: Commands and sources

Principal sources:

- `docs/product-ledger.html` — O7, PD-00B, G03, G08, G11
- `docs/aprd/angel-cloud-aprd.html` — terminology and trust boundaries
- `docs/product-decisions/0002-public-angel-page.md`
- `docs/adrs/0001-portable-angel-source-and-deployment-separation.md`
- `docs/adrs/0002-authenticated-multi-connection-selection.md`
- `docs/adrs/0005-spec-derived-execution-closure.md`
- `docs/core/format-v2.md`
- `packages/core/src/domain.ts`
- `packages/core/src/artifact-validate.ts`
- `packages/core/src/build.ts`
- `src/public-angel-page.ts`
- `src/gate.ts`, `src/mcp.ts`, `src/custody.ts`
- `src/demo-view.ts`, `scripts/build-demo-fixture.ts`
- `tests/cloud/public-angel-page.test.ts`
- `tests/cloud/public-demo.test.ts`

Commands run, with private/public identity values scrubbed:

```text
bun test tests/cloud/public-angel-page.test.ts \
  tests/cloud/public-demo.test.ts \
  packages/core/tests/artifact-v2.test.ts \
  packages/core/tests/artifact-validate.test.ts \
  packages/core/tests/portable-build.test.ts

curl -H 'Accept: application/json' \
  https://angelmcp-gateway-demo.sam-633.workers.dev/@<documented-handle>/<angel>

curl https://angelmcp-docs-demo.sam-633.workers.dev/demo/fixture.json

agent-browser --session wse-o7-o9 open \
  https://angelmcp-docs-demo.sam-633.workers.dev/demo/
```

A local `bun -e` probe compiled this placeholder source and passed it through
`publicAngelView`: a charter containing `alice@example.test` and a
`documentId` guard pinned to `private-doc-123`.

#### O7 full record: Verified results

##### O7 full record: Artifact and public-page boundary

- **Verified:** `angel.version.v2` canonical content has exactly
  `format`, `name`, `charter`, `children`, `providers`,
  `bindingRequirements`, and `tools`; each tool also carries its sealed request
  template. The SHA-256 digest covers all of those canonical bytes.
- **Verified:** the compiler never inserts Account IDs, Connection IDs,
  Connection refs, nicknames, identity labels, tokens, keys, or deployment
  state into the artifact.
- **Verified:** “secret-free artifact” is narrower than “cannot contain private
  data.” `charter`, child/source names, requirement IDs, guard field names, and
  guard values originate in user source and can contain sensitive literals.
- **Verified:** current publish validation checks adapter pins, request
  templates, scopes, tool closure, and canonical content. It does not reject
  identity or private-target text in charter or guard literals.
- **Verified:** the current public JSON has exactly `name`, `charter`,
  `version`, `policyDigest`, `provenance`, and tools with `name`, `provider`,
  `app`, `operation`, and rendered guard strings.
- **Verified:** current construction prevents installation-only data from
  reaching the renderer. Tests prove no Connection ID/ref, identity label,
  provider origin, scope, child, or canonical source marker reaches either
  serializer.
- **Verified threat:** the real public projection reproduced the placeholder
  email from the charter and the private document ID from the guard. HTML
  escaping prevents script injection; it does not prevent privacy disclosure.
  Therefore the current page does **not** meet the requested hard rule that no
  identity or private source leaks.
- **Verified:** a redacted projection cannot let a stranger recompute the
  current `policyDigest`, because that digest commits to the hidden charter,
  child/source fields, guard literals, provider pins, scopes, and request
  templates. Publishing the exact artifact restores verification but violates
  the requested disclosure boundary for valid current source.

##### O7 full record: Current public proof

- **Verified in code/tests:** the page can show a server-asserted association
  among a production Version, digest, canonical operation list, and rendered
  guards. It does not expose bytes from which the digest can be recomputed and
  does not prove which code the hosted service executed.
- **Verified live:** the interim docs demo was reachable and loaded only the
  bundled `fixture.json`. It clearly says it is sample data and all changes are
  off. The fixture reports `angelmcp.demo.v4` and two generated Angels.
- **Verified:** the demo proves the real dashboard can render a generated
  read-model projection and that the shim refuses non-fixture reads and all
  writes. It does not prove a managed production artifact or live custody.
- **Verified:** the demo fixture contains sample Account/Connection IDs,
  nicknames, identity labels, scopes, endpoints, deployment IDs, health,
  availability, lifecycle times, and fingerprints. Its schema must never be
  reused as a public live review bundle.
- **Not proved live:** probes of the documented Gateway with candidate public
  coordinates returned the uniform 404. The canonical `docs.angelmcp.ai` host
  did not resolve; the documented interim workers.dev docs host did. Thus this
  run proved the implementation and deployed sample demo, but not a live public
  trust page for a deployed Angel.
- **Tests:** 65 focused tests passed, 0 failed.

#### O7 full record: Threat and field matrix

| Candidate field | Review value | Threat/privacy result | Public decision |
|---|---|---|---|
| Fixed review schema ID | Lets clients reject another shape | No user or runtime data | **Include** |
| Artifact format | States which portable contract applies | Public protocol fact | **Include** |
| Hiding artifact commitment | Lets the owner correlate the summary with publish evidence after revealing the nonce | A cached raw digest makes that Version permanently non-hiding; only replacement canonical bytes whose digest has never been public can qualify | **Include only for a never-exposed Version; keep the nonce and raw digest owner-only** |
| Canonical operation name | Shows the capability the agent can discover | Registry-controlled; reveals intended capability, which is the purpose of a public trust surface | **Include** |
| `hasArgumentGuards` boolean | Warns that the operation is more constrained | Reveals no field or literal | **Include** |
| Angel name/slug | Human navigation | User-authored and can encode identity/private project names; route already supplies it | **Exclude from payload** |
| Account ID or handle | None once route is known | Tenant/person identification and enumeration | **Exclude** |
| Charter | Helpful intent notes, not authority | Arbitrary user text; verified identity leak | **Exclude** |
| Guard field names | Helps understand the exact restriction | Current schema accepts arbitrary user strings | **Exclude from the capability summary** |
| Guard pin/forbidden values | Needed for exact policy review | Can be email, label, document ID, path, or other private target; verified leak | **Exclude** |
| Children and requirement `source`/IDs | Explains composition | User-chosen source names and private topology | **Exclude** |
| Provider adapter, origin, source digest | Explains execution derivation | Public registry data, but not needed for minimum; PD 0002 intentionally withholds it | **Exclude** |
| Required OAuth scopes | Explains provider consent floor | Reveals authority footprint; not identity, but not needed for minimum and currently excluded | **Exclude** |
| Credential kind | Explains binding type | Credential/custody metadata; no public-review need | **Exclude** |
| Sealed request template | Proves provider mapping | Exposes implementation details and is not needed for minimum capability disclosure | **Exclude** |
| Raw `ANGEL.yaml`, draft, source path | Exact source review | Private source and free text; Control drafts are owner-only by ADR 0006 | **Exclude** |
| `canonicalSource` or complete artifact | Makes digest independently recomputable | Carries every sensitive user-source candidate above | **Exclude until a public-safe artifact contract exists** |
| Version number/publish count | Helps history navigation | Operational metadata and activity inference | **Exclude** |
| Environment, endpoint, deployment ID | Helps invocation/operations | Private deployment topology and operational metadata | **Exclude** |
| Connection ID/ref, identity label, nickname | None for public policy review | Direct identity and Connection disclosure | **Exclude** |
| Provider App/client identifiers, tokens, secrets, key/fingerprint | None | Credential or secret disclosure | **Exclude** |
| Receipts, request IDs, arguments digests, chain hashes | Runtime audit | Call timing/correlation, selected Connection ref, deployment and availability metadata; may support traffic analysis | **Exclude** |
| Availability, health, gate alignment, timestamps, logs | Operator use | Operational state and timing disclosure | **Exclude** |
| Fixed provenance copy | Explains origin | No leak, but prose is not schema evidence | **Exclude; document semantics outside payload** |

#### O7 full record: Recommendation

Do **not** publish the exact v2 artifact or reuse the demo projection as the
minimum public bundle. Publish a closed, capability-only projection and call it
a **public review summary**, not a verifiable artifact bundle.

##### O7 full record: Exact minimum public schema

```json
{
  "schema": "angel.public-review.v1",
  "disclosure": "capability-summary-only",
  "artifact": {
    "format": "angel.version.v2",
    "commitment": "<64 lowercase hexadecimal SHA-256 characters>"
  },
  "tools": [
    {
      "operation": "<canonical reviewed operation name>",
      "hasArgumentGuards": true
    }
  ]
}
```

Contract details:

- Every object rejects unknown keys.
- `schema`, `disclosure`, and `artifact.format` are fixed literals.
- `tools` uses the artifact's deterministic operation order; operation names
  must come from the reviewed registry.
- `hasArgumentGuards` is `artifactTool.argGuards.length > 0`; guard fields and
  values are not copied.
- The payload has no Angel or Account identity. The public route is the only
  coordinate disclosure.
- Generate one nonce per eligible published Version, store it owner-only
  alongside the Version evidence, and reuse it for every public summary response
  for that Version. Never generate a new nonce per request.
- A Version is eligible only if its canonical bytes and raw digest have never
  been public. A historically exposed Version remains non-hiding even after the
  live digest disappears. Refuse the hiding schema for it, show an explicit
  legacy warning, and require replacement canonical bytes.
- `artifact.commitment` is SHA-256 of the UTF-8 domain separator
  `angel.public-review.v1\0`, that fresh 32-byte owner-held random nonce, and
  the exact canonical artifact bytes, in that order. The nonce and raw artifact
  digest stay owner-only. Copy must say: **“This summary contains a hiding
  commitment, not enough data to verify the artifact or inspect exact argument
  guards.”**
- A separate owner-opted-in public-source surface is outside
  `angel.public-review.v1`. It may disclose chosen charter, guard, or source
  fields, but those fields never enter the summary and are not called
  owner-only once intentionally published. An eligible Version's raw digest
  never becomes public while the commitment is called hiding.
- No optional extension bag is allowed. A later field requires a schema version
  and another threat review.

##### O7 full record: Explicit exclusions

Never add: Account/handle/Angel names; charter; source/drafts/source paths;
child/source/requirement names; guard fields or values; provider origin or
adapter details; scopes or credential kinds; raw or canonical artifact bytes;
bindings; Connection IDs/refs, identity labels, nicknames, or health; Provider
App/client data; keys, fingerprints, credentials, or secrets; environment,
endpoint, deployment, Version count, availability, gate state, timestamps,
logs, receipts, raw artifact or request/argument digests, the commitment nonce, or chain metadata.

A full owner review remains authenticated/local: reviewed source plus exact
artifact, digest, adapter pins, scopes, request templates, and deployment
bindings. Public and owner review are separate claims.

#### O7 full record: Product implication

- G11 cannot honestly say “full public review bundle” or “a stranger can verify
  the artifact.” For an eligible Version whose raw digest has never been public,
  the safe claim is: **“A public capability summary lists the canonical operations
  and a hiding artifact commitment without private deployment or identity data. Exact source, guards, and artifact verification remain
  owner-only.”**
- The current public page needs a separate privacy decision because it exposes
  charter and guard literals. Adding a download button to its JSON would make
  the existing leak easier to automate; it would not create stronger proof.
- If Round 2 requires strangers to recompute the digest or inspect exact guards,
  this schema is insufficient by design. That requires a new public-safe policy
  contract (or explicit opt-in disclosure), not another projection.

#### O7 full record: Remaining proof

Before shipping the recommendation:

1. Add a schema validator and exact-key tests.
2. Add adversarial fixtures with emails, Connection-like IDs, nicknames,
   document IDs, source names, URLs, tokens, timestamps, and deployment IDs in
   every omitted artifact/installation field; assert zero occurrence.
3. Prove the renderer receives only the proposed projection, not an
   installation, management view, custody summary, receipt, or full artifact.
4. Run a cached-digest adversary against a historically exposed Version. Prove
   the renderer refuses a hiding summary and shows an explicit non-hiding legacy
   warning even after the live digest is removed.
5. Publish replacement canonical bytes whose raw digest has never been public;
   prove all current surfaces withhold it. Separately decide whether charter and
   guard literals are narrowed or moved to an owner-opted-in public-source
   surface outside the summary.
6. Run a live anonymous GET after deployment and save the exact response.

#### O7 full record: Closure assessment

**Evidence investigation: complete. Recommendation: close O7 to the reduced
schema above and rename the deliverable “public review summary.”** A claim of a
full, independently verifiable public bundle remains **not closable** under the
current artifact/source contract and the required privacy exclusions.

---

### O9 full record

#### O9 full record: Question

How should Round 2 describe self-hosting while separating source availability,
portable contracts, protocol compatibility, implementation existence, support,
and clean-room proof?

#### O9 full record: Method

1. Read the Ledger O9, ID-07, G13, WS2, and Round-2 scenario boundaries.
2. Read every ADR, with special attention to ADRs 0001, 0004, 0005, and 0007.
3. Read the README deployment section, package docs, user manual, FAQ, Wrangler
   manifests, management client/contract, MCP protocol, custody, and Worker
   entry points.
4. Verified repository and package visibility/licensing through GitHub and the
   public package registry.
5. Built all three Workers with Wrangler dry-run.
6. Searched for a self-host guide, clean-room attestation, conformance suite,
   upgrade/recovery procedure, and support commitment.

#### O9 full record: Commands and sources

Principal sources:

- `docs/product-ledger.html` — O9, ID-07, G13
- `docs/adrs/0001-portable-angel-source-and-deployment-separation.md`
- `docs/adrs/0004-repository-ownership-and-compatibility.md`
- `docs/adrs/0005-spec-derived-execution-closure.md`
- `docs/adrs/0007-monorepo-source-and-release-integrity.md`
- `docs/adrs/README.md`
- `README.md#deploy`
- `packages/core/README.md`
- `docs/faq.md#can-i-self-host-a-compatible-control-plane`
- `docs/user-manual.md`
- `packages/core/src/management-contract.ts`
- `packages/core/src/cli/client.ts`, `packages/core/src/cli/config.ts`
- `src/workers/{control,gateway,broker,protocol}.ts`
- `wrangler.{control,gateway,broker}.jsonc`

Commands:

```text
gh repo view exocognito/angelmcp --json visibility,licenseInfo,url
curl https://api.github.com/repos/exocognito/angelmcp
pnpm view @smcllns/angel-core@0.3.0 \
  name version license repository dist.tarball dist.integrity --json

for worker in broker gateway control; do
  pnpm exec wrangler deploy --dry-run \
    --config wrangler.$worker.jsonc --outdir /tmp/wse-o7-o9-$worker
done

rg -n -i 'self.host|clean.room|conformance|support|management contract' \
  README.md docs packages/core src tests
```

#### O9 full record: Verified results

- **Source availability:** `exocognito/angelmcp` is publicly readable. The
  hosted repository has no repository-wide detected license. Public visibility
  alone does not grant an open-source or supported-self-hosting claim.
- **Licensed portable package:** public `@smcllns/angel-core@0.3.0` is MIT
  licensed and downloadable with registry integrity metadata. It contains the
  compiler, v2 artifact types/validation, target-neutral management client,
  build wrapper, and CLI.
- **Portable source/artifact contract:** `ANGEL.yaml` excludes deployment
  targets and Account/Connection identity; `angel.json.target` accepts an
  arbitrary HTTPS origin. Portable build and artifact tests passed.
- **Management protocol contract:** the package exports strict request/response
  types and a client for ensure, list Connections, publish, deploy, promote,
  read, and delete. This is an implementation contract, not proof that an
  independent server conforms.
- **MCP contract:** the Gateway implements MCP streamable HTTP protocol version
  `2025-06-18`. That proves the Angel Cloud Gateway surface, not broad client or
  third-party control-plane compatibility.
- **Implementation existence:** the public tree contains real Control, Gateway,
  Broker, gate, custody, provider, OAuth, and Durable Object code. All three
  Worker manifests compiled in Wrangler dry-run. The managed implementation is
  also documented as deployed.
- **Current setup is product-specific:** checked-in Worker names, service
  bindings, Account/tenant values, Access settings, and public origins target
  the M1 Angel Cloud demo. README lists deploy order and required secrets, but
  it does not provide a parameterized new-account setup, Access bootstrap,
  least-privilege token creation journey, first-tenant provisioning, DNS,
  migrations/upgrades, backup/restore, rotation, recovery, or teardown proof.
- **No clean-room proof:** no saved run shows a fresh operator deploying into a
  new Cloudflare account from public instructions and completing publish,
  custody, MCP call, upgrade, recovery, and deletion without private knowledge.
- **No compatibility proof:** no independent control-plane implementation or
  conformance kit was run against the exported management contract.
- **No support claim:** the FAQ explicitly says a supported self-host control
  plane guide is deferred. The repo also gives no self-host support, SLA,
  upgrade, or security-maintenance promise.
- **Local is separate:** Round 2's proposed local `angel serve` path is not
  self-hosting a compatible cloud control plane. It is also currently unbuilt.
- **Legacy shapes are separate:** old lite/relay comparison variants do not
  prove that current `angel.version.v2` plus the current management contract can
  be cleanly self-hosted.

#### O9 full record: Claim matrix

| Layer | Verified claim Round 2 may make | Claim Round 2 must not make |
|---|---|---|
| Source availability | “The current Worker source is publicly readable.” | “Angel Cloud is open source” or “you may run it” without a repository-wide license |
| Package availability | “`@smcllns/angel-core@0.3.0` is public and MIT licensed.” | “The package includes a self-hosted control plane” |
| Source portability | “`ANGEL.yaml` omits target, Account, Connection, and credential identity.” | “Every Angel source is safe to publish” |
| Artifact portability | “v2 canonical artifacts and digests are target-neutral.” | “The same artifact has run on an independent control plane” |
| Management protocol | “The package exports a strict client and TypeScript contract for an HTTPS target.” | “The protocol is standardized, stable across vendors, or certified compatible” |
| MCP protocol | “The current Gateway speaks MCP `2025-06-18`.” | “Self-host compatibility follows from MCP compatibility” |
| Implementation | “The three current Cloudflare Workers exist and dry-run bundle.” | “Self-hosting is only three deploy commands” |
| Managed operation | “Angel Cloud's M1 deployment exists.” | “A managed deployment proves a new account can reproduce it” |
| Runnable self-host setup | No positive claim yet | “Self-hostable today,” “ready to deploy,” or setup instructions presented as tested |
| Clean-room proof | None | “Reproducible,” “turnkey,” or “works from a fresh account” |
| Independent compatibility | None | “Any compatible control plane works” as an observed fact; it is design intent only |
| Support | “Unsupported; no self-host guide or support promise.” | “Supported self-hosting,” upgrades, recovery, SLA, or security response |
| Local use | “Local and managed are separate target journeys.” | “Local serve is self-hosting” |

#### O9 full record: Recommendation

Round 2 should ship a status note only. It should not publish self-host setup
instructions and should not add self-hosting to Round-2 acceptance.

#### O9 full record: Exact Round-2 status wording

> ### Self-hosting status — source available, not supported
>
> Angel policy source and `angel.version.v2` artifacts are designed to be
> portable. The MIT-licensed `@smcllns/angel-core` CLI can target any HTTPS
> origin that implements its exported management contract. The public Angel
> repository also contains the current Cloudflare Worker implementation, and
> its Control, Gateway, and Broker Workers build successfully.
>
> Angel does not yet ship supported self-hosting. The checked-in deployment is
> the Angel Cloud M1 demo configuration, not a clean-room setup for a new
> Cloudflare account. We have not published or passed a fresh-account journey
> covering infrastructure setup, Access, secrets, custody, migrations,
> upgrades, recovery, teardown, or an independent implementation's protocol
> conformance. Publicly readable Worker source is not a repository-wide
> open-source license, and protocol portability is not compatibility proof.
> No self-hosting support, upgrade, recovery, SLA, or security-maintenance
> commitment is offered.
>
> Round 2 tests local use and Angel Cloud managed hosting only. Local use is not
> self-hosting a control plane. Treat the repository's deploy commands as
> operator notes for the current managed demo, not as a self-hosting guide.
> Self-host setup instructions can ship only after a separately scoped,
> licensed clean-room deployment and conformance proof passes.

#### O9 full record: Product implication

- Close ID-07 as an honest status note, not as a self-hosting feature.
- G13 should keep “supported self-hosting” unproved and must not let “hosting is
  optional” imply a supported alternative cloud deployment.
- Round 2 may test local and managed journeys. It should neither fail nor pass
  on self-hosting.
- The README deploy section remains evidence that an implementation exists; it
  is not evidence of a supported public setup journey.
- Do not describe the hosted repository as open source until its root licensing
  is explicit.

#### O9 full record: Remaining proof to upgrade the claim

A future self-hosting claim needs, at minimum:

1. An explicit license covering the hosted implementation.
2. Parameterized manifests with no project-specific account, Access, host, or
   service names.
3. Public new-account prerequisites and least-privilege setup instructions.
4. A clean-room deploy by a fresh operator using only those instructions.
5. Real create, publish, custody, MCP call, receipt, revoke/reauthorize, delete,
   and teardown evidence.
6. Upgrade/migration, secret rotation, backup/restore, and failed-deploy recovery
   proof.
7. A versioned management-contract conformance suite run against at least the
   shipped implementation; an independent implementation is needed before
   claiming cross-implementation compatibility.
8. A stated support and security-maintenance boundary.

#### O9 full record: Closure assessment

**Evidence investigation: complete. O9 can close now to the exact status-only
wording above.** Supported or clean-room self-hosting remains a later outcome;
no Round-2 product build or acceptance gate should depend on it.

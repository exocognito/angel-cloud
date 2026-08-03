# WS-E brief 1 — package and install identity

- Decision: O1
- Evidence status: complete
- Product implementation: none
- Outcome: exact gap — keep O1 open until namespace control is proved
- Verified: 2026-08-01

## Question

What exact public package and install path does Round 2 use?

## Method

Compared the live `@smcllns/angel-core@0.3.0` contract with the `@angelmcp/cli` and `angelmcp` names, which were registry-absent when tested. Tested current package packing and clean-consumer CLI behavior, pnpm and Bun global installs against the registry tarball, npm registry metadata, package provenance, the merged public starter, and the proposed install host. Bun-global registry-tarball install passed; the candidate package itself remains unbuilt and unpublished. No package was published or reserved.

## Verified results

- `@smcllns/angel-core@0.3.0` works, but its personal namespace and combined core/CLI surface are the WS1 compatibility baseline, not the Round-2 product identity.
- `@angelmcp/cli` and `angelmcp` were absent from npm when tested; absence does not reserve either name or the `@angelmcp` scope.
- Bun is the proven runtime, and an isolated Bun-global install of the current registry tarball exposed bare `angel` and ran the expected CLI usage path. The candidate package itself remains unbuilt. Canonical pnpm-global install adds avoidable Node/pnpm setup.
- No Angel curl installer, install route, checksum/signing contract, upgrade path, or uninstall path exists.

## Decision outcome

Outcome: exact gap. The evidence recommends one CLI-only package, `@angelmcp/cli@0.1.0`, with binary `angel`, but O1 remains open because control of the `@angelmcp` npm namespace is unverified. The canonical exact install is `bun add --global @angelmcp/cli@0.1.0`, followed by `angel --version`. Keep `@smcllns/angel-core@0.3.0` available for compatibility; do not teach it in the Round-2 journey. Defer a curl installer.

The exact closure action is to prove control of `@angelmcp` or obtain an owner-approved replacement identity. A registry 404 is not a reservation. The package, scope, and release workflow do not exist today.

## Product implication

The public journey becomes a product CLI journey with one prerequisite, Bun, rather than a core-library journey that requires Bun plus pnpm/Node. Internal core layout may change without changing the package users install or the `angel` command.

## Execution gates

- Build the CLI-only package without a second public core install or workspace link.
- Declare the tested Bun minimum; use no lifecycle scripts.
- Publish through GitHub OIDC/trusted publishing with npm provenance.
- Save SRI, file/mode manifest, attestation, clean Linux/macOS consumers, and merged-starter proof.
- Let the package age at least seven days before the clean-room dogfood run.
- Keep public docs free of `@smcllns/angel-core` install instructions.

## Evidence record

Repository state: `evidence/ws-e-decision-briefs` at `6cc2ed5`

Editorial disposition: the first draft of this record recommended closing O1 with scope control as an execution gate; it was corrected to keep O1 open because namespace ownership can invalidate the identity itself.

### O1 full record

**Investigated:** 2026-08-01  
**Decision status:** provisional recommendation only; O1 remains open until namespace control is proved or the owner approves another identity.

#### O1 full record: Question

What exact public package and install path should Angel Round 2 use, given the current `@smcllns/angel-core`, the candidate names `@angelmcp/cli` and `angelmcp`, package-manager prerequisites, and the proposed curl installer?

#### O1 full record: Method

1. Read the canonical Product Ledger decision O1, contradiction C7, and learning DF-029/DF-047/DF-048/LR-012 entries and the current and target install contracts.
2. Inspected the root workspace, current package manifest, executable, exports, runtime imports, release proof, and public starter.
3. Queried npm's real registry for all three names and inspected the published 0.3.0 metadata and tarball.
4. Installed the 0.3.0 registry tarball into clean local and isolated global consumers; ran its binary with and without Bun and imported all public entry points with Bun and Node.
5. Cloned the public starter at merged `main`, installed the registry tarball without a workspace link, and built its checked-in Angel.
6. Probed the proposed Angel installer URLs and checked the official Bun, pnpm, and npm publication/provenance contracts.
7. Did not publish, reserve, or change any package or repository file.

#### O1 full record: Commands and sources

Representative commands:

```sh
curl -sS -w '%{http_code}' https://registry.npmjs.org/%40angelmcp%2Fcli
curl -sS -w '%{http_code}' https://registry.npmjs.org/angelmcp
curl -sS https://registry.npmjs.org/%40smcllns%2Fangel-core
pnpm view @smcllns/angel-core@0.3.0 name version bin engines dependencies dist.integrity dist.attestations --json
curl -fsSL https://registry.npmjs.org/@smcllns/angel-core/-/angel-core-0.3.0.tgz
pnpm add --ignore-scripts --save-exact file:<registry-tarball>
pnpm add --global --global-dir <isolated-dir> --ignore-scripts file:<registry-tarball>
pnpm exec angel
BUN_INSTALL=<isolated-bun-dir> bun add --global file:<registry-tarball>
PATH=<isolated-bun-dir>/bin:$PATH angel
node node_modules/@smcllns/angel-core/src/scripts/angel.ts
git clone --depth 1 https://github.com/exocognito/angels.git <temp>
pnpm exec angel build gmail-read-and-draft
curl -I https://angelmcp.ai/install.sh
curl -I https://angelmcp-docs-demo.sam-633.workers.dev/install.sh
```

Repository sources:

- Product decision and unresolved evidence: [`docs/product-ledger.html`](../../../docs/product-ledger.html), decision O1, contradiction C7, and learnings DF-029, DF-047, DF-048, and LR-012.
- Root toolchain/workspace contract: [`package.json:2-20`](../../../package.json).
- Current package contract: [`packages/core/package.json:2-44`](../../../packages/core/package.json).
- Bun executable contract: [`packages/core/src/scripts/angel.ts:1-8`](../../../packages/core/src/scripts/angel.ts).
- Current install docs: [`docs/user-manual.md`](../../../docs/user-manual.md#install-the-cli), [`docs-site/public/SKILL.md:59-71`](../../../docs-site/public/SKILL.md#step-1--install-the-cli-no-repo-clone), and [`docs-site/public/llms.txt`](../../../docs-site/public/llms.txt).
- Target guide install contract: [`docs/aprd/v2.1-cli-user-guide.md:9-23`](../../../docs/aprd/v2.1-cli-user-guide.md#install-contract--decided-not-yet-published). When this brief ran, that section held an O1-blocked placeholder.
- Monorepo/package boundary: [`docs/adrs/0007-monorepo-source-and-release-integrity.md:9-29`](../../../docs/adrs/0007-monorepo-source-and-release-integrity.md#decision) and lines 71-78.
- Existing evidence: [`docs/evidence/ws1-release-baseline.json`](../../../docs/evidence/ws1-release-baseline.json) and [`docs/evidence/ws1-starter-proof.json`](../../../docs/evidence/ws1-starter-proof.json).
- Package-age failure: [GitHub issue #42](https://github.com/exocognito/angelmcp/issues/42).
- Public starter at the tested commit: [exocognito/angels README at `2a635bf`](https://github.com/exocognito/angels/blob/2a635bf863a572a6c02e66d2a9e8e93b6d94243b/README.md).
- Registry records: [`@angelmcp/cli`](https://registry.npmjs.org/%40angelmcp%2Fcli), [`angelmcp`](https://registry.npmjs.org/angelmcp), and [`@smcllns/angel-core`](https://registry.npmjs.org/%40smcllns%2Fangel-core).
- Official install/publication contracts: [Bun installation](https://bun.sh/docs/installation), [Bun global add](https://bun.sh/docs/pm/cli/add), [pnpm installation](https://pnpm.io/installation), [pnpm setup](https://pnpm.io/cli/setup), [npm scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/), and [npm provenance](https://docs.npmjs.com/generating-provenance-statements/).

#### O1 full record: Verified results

##### O1 full record: Current fact

1. **Both candidate package records are absent now.** npm returned `404 Not found` for `@angelmcp/cli` and `angelmcp`. Exact-name registry search returned no `angelmcp` result. This proves absence, not reservation or guaranteed future acceptance.
2. **The `@angelmcp` scope is not established in the public registry.** `GET /-/org/angelmcp/user` returned `404 {"error":"Scope not found"}` and the public user endpoint returned 404. The authenticated owner identity could not be checked: `pnpm whoami` was unauthorized and the 1Password service-account token returned 403. Therefore scope ownership is an exact, preserved gap.
3. **`@smcllns/angel-core@0.3.0` is real and usable under Bun.** npm reports `latest=0.3.0`, bin `angel → src/scripts/angel.ts`, dependency `yaml ^2.4.5`, and integrity `sha512-taID3iPF89XFzjyZnEi+ZF6rA3GlvzlNH8F/UOBY4mSvQBHPW7dQqGmQz4a2PhzHgzbmYt/rkn4cKcfK5rvcXg==`.
4. **The current public package is a combined core/API/CLI package, not a product CLI package.** It exports `.`, `./build`, and `./cli`; ships raw TypeScript; and has no `engines` field. Its executable has `#!/usr/bin/env bun`.
5. **Bun is a hard runtime prerequisite today.** Clean Bun imports of all three exports passed. The `angel` binary ran and printed its usage error under Bun. With Bun removed from `PATH`, the bin exited 127 (`bun: not found`). Direct Node 24.14.1 execution and all Node imports failed with `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` for TypeScript under `node_modules`.
6. **The existing package's registry metadata is stale.** The published 0.3.0 tarball points to `https://github.com/exocognito/angels.git`, `packages/angel-core`; the current workspace manifest correctly points to `https://github.com/exocognito/angelmcp.git`, `packages/core`.
7. **0.3.0 has no npm provenance attestation.** Registry metadata has no `dist.attestations`, and npm's attestation endpoint returned 404. This matches the Product Ledger gap.
8. **Clean external-consumer behavior passes once the tarball is installable.** A clean local tarball install exposed the bin and all package exports. Isolated pnpm and Bun global installs both exposed bare `angel`. pnpm required configuring `PNPM_HOME` and its v11 `bin` subdirectory. Bun installed two packages in 343 ms; the bare binary reached the expected current usage error under Bun 1.3.11.
9. **The merged public starter still builds exactly.** Fresh `exocognito/angels@2a635bf` plus the registry 0.3.0 tarball built `gmail-read-and-draft` with digest `11542429eff4698ac6f7a121b91bd5ce5d9284c13bf7fba8773c78eb361fd0d4` and artifact SHA-256 `a122ce265d3daf51aec681866cc962ba8ec890073f44707ab62e85d18cb61411`, matching `docs/evidence/ws1-starter-proof.json`.
10. **A direct registry install is temporarily blocked on this machine by the managed seven-day package-age policy.** npm says 0.3.0 was published `2026-07-29T23:26:04.037Z`; `pnpm add @smcllns/angel-core@0.3.0` rejected it as too recent. The tarball clean test passed. Round-2 dogfood must wait seven days after publication rather than add a policy exception.
11. **pnpm global adds avoid a project clone but add setup burden.** pnpm 11 global bins live in `PNPM_HOME/bin`; the first isolated attempt failed until that path was configured. Current pnpm docs also require Node 22+ unless pnpm itself came from the standalone installer. Since Angel still needs Bun, a pnpm-global path asks users for two toolchains.
12. **Bun already supplies both required roles.** Official Bun docs support `bun add --global <package>` for CLI tools, and the isolated registry-tarball proof passed. This removes Node/pnpm from the public install prerequisites while retaining the runtime the current CLI demonstrably needs.
13. **No Angel curl installer exists.** `angelmcp.ai` is registered and delegated to Cloudflare nameservers, but it has no resolvable apex/custom-docs address record from the tested resolver. `https://angelmcp.ai/install.sh` could not resolve; `/install` and `/install.sh` both returned 404 on the live interim docs Worker. `docs/domain-architecture.md:102-103` also calls an install-script redirect a possible future surface, not current infrastructure.

#### O1 full record: Options

| Option | Registry/current proof | Prerequisites | Fit with the product decision | Decision |
|---|---|---|---|---|
| **`@angelmcp/cli`** | Package absent; scope also absent | Bun can install and run it alone | Clear product namespace and role; allows core to remain an internal workspace boundary | **Recommend** after creating/controlling the npm scope |
| **`angelmcp`** | Package absent | Same runtime choices | Shorter install spelling, but role is unclear, the unscoped name is a single contested global name, and it does not create a governed package family | Reject as the Round-2 package |
| **`@smcllns/angel-core`** | Published, integrity-checked, clean-consumer/starter proven | Bun plus pnpm in current docs | Personal namespace; combines API/core/CLI; directly contradicts C7/LR-012's public product-package decision | Keep as a compatibility baseline only; do not teach it for Round 2 |
| **`pnpm add --global @angelmcp/cli`** | pnpm-global mechanics tested with current tarball | pnpm plus Bun; usually Node as well; `PNPM_HOME/bin` setup | Works, but preserves the exact prerequisite friction O1 is meant to remove | Supported fallback, not canonical |
| **`bun add --global @angelmcp/cli`** | Current CLI proven under Bun; Bun documents global CLI installs | Bun only | Smallest package-manager path and produces bare `angel` from an empty directory | **Canonical Round-2 install path** |
| **`curl -fsSL https://angelmcp.ai/install.sh \| sh`** | URL does not exist or resolve today | Would need a maintained cross-platform installer, checksums/signing, upgrade/uninstall semantics | Useful later, but cannot be Round-2 evidence without building and independently proving another distribution system | Defer; do not document as shipped in Round 2 |

#### O1 full record: Recommendation

Publish one public user-facing package, **`@angelmcp/cli`**, and keep core separate from the public product contract. Start the new package at **`0.1.0`**. Make the canonical Round-2 install:

```sh
bun add --global @angelmcp/cli@0.1.0
angel --version
```

Prerequisite: **Bun 1.3.11 or newer**, the currently proven runtime baseline. If Bun is absent, link to Bun's official platform instructions; do not make pnpm or a product-repository clone another prerequisite.

Do not use `@v2.1` as an npm version or dist-tag. It is a document/product target label, not a valid immutable release identity. Round-2 evidence should pin `0.1.0`; ordinary docs may later omit the version after the exact release passes.

Do not ship an `angelmcp` alias package. One public product package means one name to install and audit.

#### O1 full record: Exact Round-2 contract

##### O1 full record: Identity and boundary

- Public package: `@angelmcp/cli@0.1.0`.
- Installed binary: `angel` on `PATH`.
- Public surface: CLI only; no promise that package-root/core module imports are supported.
- Internal core: a separate private/workspace implementation boundary, bundled into or compiled into the public CLI tarball. Round 2 must not require consumers to install `@smcllns/angel-core` or a second public core package.
- Compatibility: leave `@smcllns/angel-core@0.3.0` available for existing consumers and the WS1 baseline. Do not silently repoint or remove it.

##### O1 full record: Installation

```sh
# Required first
bun --version                 # >= 1.3.11

# Canonical Round-2 install
bun add --global @angelmcp/cli@0.1.0

# Required install check
angel --version               # must print 0.1.0 and exit 0
```

- No repository clone.
- No Node or pnpm prerequisite in the canonical user journey.
- No install lifecycle scripts.
- No curl installer claim in Round-2 docs.
- A pnpm-local install may remain a contributor/starter alternative, but it is not the zero-state Round-2 path and must still state the Bun runtime requirement.

##### O1 full record: Publication

Before publication work starts:

1. Create or gain control of the `@angelmcp` npm organization/scope; this was not done by O1.
2. Publish with public visibility from the canonical `exocognito/angelmcp` GitHub repository.
3. Use a GitHub Actions trusted-publishing/OIDC path that produces an npm provenance attestation; do not publish from a maintainer laptop.
4. Put the correct repository URL and `packages/cli` directory in registry metadata.
5. Pin or bundle production dependencies so the tested tarball is the installed runtime contract.
6. Save registry SRI, tarball file/mode manifest, attestation URL, packed clean-consumer result, and public-starter result.
7. Wait at least seven days after publication before the managed Round-2 clean-room run.

##### O1 full record: Acceptance

The package/install gate passes only when a fresh consumer with Bun—but no product clone, Node, pnpm, workspace link, seeded output, or old package—can:

1. install exact `@angelmcp/cli@0.1.0` globally;
2. run `angel --version` and `angel --help` by bare command;
3. execute the Round-2 create/build journey;
4. build the merged public starter against the registry package;
5. verify the npm provenance attestation and tarball integrity; and
6. prove no `@smcllns/angel-core` install appears in public journey docs.

#### O1 full record: Product implication

Round 2 becomes a product CLI journey rather than a core-library journey. The package name says what users install; the bare `angel` command stays stable even if internal core/compiler boundaries change. Bun serves as both package manager and runtime, cutting the current Bun + pnpm/Node prerequisite stack to one tool.

After approval, the owning docs that must change together are:

- `docs/user-manual.md` — canonical shipped install mechanics;
- `docs-site/public/SKILL.md` and `docs-site/public/llms.txt` — agent-only onboarding;
- `docs/aprd/v2.1-cli-user-guide.md` — target install contract;
- `packages/core/README.md` — old-package compatibility boundary;
- public starter [`exocognito/angels/README.md`](https://github.com/exocognito/angels/blob/main/README.md); and
- `docs/product-ledger.html` — close O1/C7 and reconcile DF-029/DF-047/DF-048/LR-012.

Teach the full install once in the user manual and link from the other surfaces, per `AGENTS.md`.

#### O1 full record: Risks and exact gaps

1. **Scope race:** `@angelmcp` is not created or controlled. A 404 is not a reservation. This is the first publication prerequisite.
2. **Candidate package absent:** the exact candidate install cannot run until `@angelmcp/cli@0.1.0` exists. Substitute Bun-global mechanics passed with the current registry tarball; the actual candidate must still pass the acceptance above.
3. **Seven-day gate:** publishing immediately before dogfood will make this machine reject the package. Schedule the release lead time.
4. **Runtime declaration:** current 0.3.0 has no `engines` field despite requiring Bun. The new manifest and README must state the same tested minimum.
5. **Internal-core packaging:** the repo has not yet split CLI from core. The public package must not leak a second required public install or workspace-only link.
6. **Provenance automation absent:** `.github/workflows` has CI and Google proof only; there is no release workflow today.
7. **Curl remains unproved:** DNS, host route, script, signing/checksum, architecture matrix, upgrade, and uninstall behavior are all absent.
8. **Platform matrix:** O1 tested macOS arm64. Round-2 Linux and any Windows claim require their own clean tests; O2 owns Linux storage/OAuth evidence, not this package identity decision.

#### O1 full record: Saved-evidence candidates

Promote these as durable `docs/evidence/` records during implementation rather than relying on terminal transcripts:

- `wse-o1-registry-name-baseline.json` — timestamped HTTP/status bodies for all three registry names and the `@angelmcp` scope probe.
- `wse-o1-current-package-contract.json` — 0.3.0 metadata, SRI, tarball SHA-512, file/mode list, shebang, exports, missing engines, and missing attestation.
- `wse-o1-clean-consumer.json` — local/global Bun-required results, Node failure codes, toolchain versions, and command outputs.
- `wse-o1-starter-proof.json` — starter commit, exact registry package, command, digest, artifact SHA-256, and no-workspace boundary.
- `wse-o1-install-host-baseline.json` — apex/docs DNS and `/install{,.sh}` responses.
- Future `round2-cli-release.json` — `@angelmcp/cli@0.1.0` SRI, provenance attestation, GitHub workflow/run/commit, seven-day maturity time, and cross-platform clean-consumer results.

#### O1 full record: Is evidence enough to close O1?

**No—not yet.** The evidence distinguishes the working legacy package from the preferred product identity and shows why Bun-global is the smallest feasible package-manager path. O1 remains open until control of `@angelmcp` is proved or the owner approves another identity. Package implementation/publication, seven-day maturity, provenance, docs migration, and clean platform tests remain later Round-2 execution gates.

It is **not** enough to claim the package or installer ships today. Neither `@angelmcp/cli` nor the Angel curl installer exists, and npm scope control is unverified.

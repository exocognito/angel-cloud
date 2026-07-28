# Roadmap

This file is the canonical plan of record. The main-branch view on GitHub is
the master copy — worktree checkouts are just copies of it. Detail lives in
the linked docs and issues; when any document disagrees with this list on
sequence or status, fix that document.

The order is deliberate: make Angel Cloud work deeply for one person, then
make that one-player product public and useful to others, and only then add
multiplayer Account shapes. Multi-Account and Family work moved from second
place to last on 2026-07-24 for that reason.

## Key

- ✅ done · ⬜ not started
- `M` milestones are strictly sequenced: M0 → M1 → M2 → M3 → M4.
- Unnumbered items must all land in the gap where they appear, but in any
  order among themselves.
- Every open item links its tracking issue. The PR that completes an item
  ticks its box here and closes the issue in the same change
  (`Closes #NN`). Issue references are written as explicit links because
  GitHub does not auto-link `#NN` inside repository markdown files.
- Issues #21–#32 stayed in the private `exocognito/angel-cloud-history`
  repository when the clean-history cut created this public one, so every link
  here used to 404. They were recreated in this repository on 2026-07-28 and
  the links below now point at the live numbers. The originals cannot be
  closed or annotated — that repository is archived and read-only.
- This list sequences **milestones**. Decisions that are agreed but not yet
  built are indexed separately, with a build status each, in
  [docs/adrs](docs/adrs/README.md) and
  [docs/product-decisions](docs/product-decisions/README.md). Anything that
  shapes the product belongs in one of those before it belongs here.

## Shortform

- ✅ M0 — split repos, publish `@smcllns/angel-core` to npm
- ✅ M1 — real Google OAuth edge, custody, parity UI
- Between M1 and M2, any order:
  - ⬜ dogfood the first Angel end-to-end through the publishing API
    ([#5](https://github.com/exocognito/angel-cloud/issues/5))
  - ⬜ public agent docs: docs index, `llms.txt`, `SKILL.md`
    ([#4](https://github.com/exocognito/angel-cloud/issues/4))
  - ⬜ move the `angelmcp.ai` zone and wire the hosts
    ([#6](https://github.com/exocognito/angel-cloud/issues/6))
  - ✅ give Accounts a public handle
    ([#12](https://github.com/exocognito/angel-cloud/issues/12))
  - ⬜ address Angels as `@account/angel`, production by default
    ([#3](https://github.com/exocognito/angel-cloud/issues/3)), after #12
  - ⬜ give every Angel a public page readable without a key
    ([#11](https://github.com/exocognito/angel-cloud/issues/11))
- ⬜ M2 — deepen the one-player product, one adapter at a time
  ([#7](https://github.com/exocognito/angel-cloud/issues/7))
- ⬜ M3 — public hosted product for one-player Accounts
  ([#8](https://github.com/exocognito/angel-cloud/issues/8))
- ⬜ M4 — multiplayer
  ([#9](https://github.com/exocognito/angel-cloud/issues/9))

## Longform

| Milestone | Definition of done |
| --- | --- |
| ✅ **M0 — split repos, publish `@smcllns/angel-core` to npm.** Comparison baseline is kept in the archived `angels-comparison` repo; this repo owns the hosted product. | The hosted repo stands alone: a fresh clone installs the published core from the npm registry with a frozen lockfile and passes full CI. |
| ✅ **M1 — real Google OAuth edge, custody, parity UI.** Merged 2026-07-23 (PR #1, user manual PR #2); deployed to the dedicated Cloudflare account. | Live proof behind real Access login: BYO Google credentials held write-only in Broker custody; Gmail and Docs pass through both gates; revoke fails loudly; row-level reauthorize restores the same Connection; both pass again with deployment, key, Version, and policy unchanged. |
| ⬜ **Dogfood the first Angel end-to-end through the publishing API.** Tracked in [#5](https://github.com/exocognito/angel-cloud/issues/5). | Starting from an empty directory with no repo clone, Sam and an agent create, publish, promote, and query a new Angel over MCP; every friction found becomes an issue. |
| ⬜ **Public agent docs: docs index, `llms.txt`, `SKILL.md`** so agents use the API, not the repo. Tracked in [#4](https://github.com/exocognito/angel-cloud/issues/4). The host is an open call: the issue asks for `docs.angelmcp.ai`, while [docs/domain-architecture.md](docs/domain-architecture.md) reserves the apex path `/docs`. | An agent given only the docs URL — no repo access — can walk a user through the whole first-Angel journey to a promoted Angel answering MCP calls. |
| ⬜ **Move the `angelmcp.ai` zone to the dedicated Cloudflare account and wire the hosts.** Tracked in [#6](https://github.com/exocognito/angel-cloud/issues/6); migration checklist in [docs/domain-architecture.md](docs/domain-architecture.md). | `dash.`, `mcp.`, `api.`, and `auth.` serve the live workers on `angelmcp.ai`; Access and the Google OAuth callback point at the new hosts; `workers.dev` URLs are retired after the cutover. |
| ✅ **Give Accounts a public handle.** Tracked in [#12](https://github.com/exocognito/angel-cloud/issues/12). The rename policy is decided in [PD 0004](docs/product-decisions/0004-account-handles.md): permanent, renameable once, never released. The opaque `acct_*` identifier stays the internal key. | An Account has a unique handle matching the coordinate grammar, reserved words are rejected, resolution works on the request path, and the rename policy is decided and enforced. |
| ⬜ **Address Angels as `@account/angel`, with production as the default.** Renames the second environment to `preview` and makes `angel publish` go live in one step. Tracked in [#3](https://github.com/exocognito/angel-cloud/issues/3); decided in [PD 0001](docs/product-decisions/0001-angel-coordinate-scheme.md) and [PD 0003](docs/product-decisions/0003-preview-is-opt-in.md). Needs account handles, which do not exist yet. | An Angel answers MCP at `/@handle/angel` with no environment in the URL; `angel publish` on a fresh Angel produces a live, callable Angel in one command; the old route still answers through the cutover. |
| ⬜ **Give every Angel a public page readable without a key.** Tracked in [#11](https://github.com/exocognito/angel-cloud/issues/11); decided in [PD 0002](docs/product-decisions/0002-public-angel-page.md). Depends on the coordinate above. | An Angel URL opened in a browser renders its charter and tools with no key and no login, and nothing on that path can reach a credential. |
| ⬜ **M2 — deepen the one-player product, one adapter at a time.** Gmail write with real guard enforcement first, then Maps, then differently shaped integrations, each only after it proves the primitive it needs. Tracked in [#7](https://github.com/exocognito/angel-cloud/issues/7). | Each new adapter ships with real guard enforcement, deterministic CI, and live credentialed acceptance — and Angel Cloud runs one person's real daily workflows across several providers. |
| ⬜ **M3 — public hosted product for one-player Accounts.** Still one login, one Account. Tracked in [#8](https://github.com/exocognito/angel-cloud/issues/8). | A stranger signs up, connects Google through a platform-owned verified OAuth app, publishes an Angel, and is billed within quotas — with no operator help. |
| ⬜ **M4 — multiplayer.** Personal and Family Account shapes and memberships; deliberately last: it starts only once the one-player product is proven useful to others. Tracked in [#9](https://github.com/exocognito/angel-cloud/issues/9). | Two isolated Accounts run side by side and one Family Account has two or more members; the tenant boundary holds under test and one login still enters exactly one Account. |

Milestone detail lives in [NEXT.md](NEXT.md) (M0/M1 record, locked
decisions, operator notes) and the comparison repo's `NEXT.md` (design
prose, settled anchors). Where their milestone numbering or ordering
predates the 2026-07-24 reordering, this list wins.

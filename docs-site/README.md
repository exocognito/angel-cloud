# docs-site — the public Angel Cloud docs

Stands up `docs.angelmcp.ai`: a public docs site plus the two agent-facing
files, `/llms.txt` and `/SKILL.md`. It renders the repo's own markdown so there
is no forked content to drift.

## What it serves

| Path | What |
| --- | --- |
| `/` | Front-page index (overview, doc cards, credential table) |
| `/#/user-manual`, `/#/faq`, `/#/operator-journey`, `/#/domain-architecture`, `/#/skill` | Human-readable rendered docs with linkable heading anchors |
| `/user-manual.md`, `/faq.md`, `/operator-journey.md`, `/domain-architecture.md` | The raw markdown (agent-consumable) |
| `/llms.txt` | LLM site map ([llmstxt.org](https://llmstxt.org) convention) |
| `/SKILL.md` | The create → publish → operate journey as a Claude Code skill |

The human view is a dependency-free single-page app (`public/index.html` +
`viewer.js`) that fetches the raw markdown and renders it with pinned `marked`
and `mermaid` from a CDN. Agents ignore all of that and fetch the `.md` / `.txt`
directly.

## Source of truth

`build.sh` copies `../docs/*.md` verbatim into `dist/`. The only doc renamed is
`google-read-proof-manual-journey.md` → `operator-journey.md` (a shorter public
slug). Editing the docs is the only way to change the site's prose — do not edit
copies. `llms.txt` and `SKILL.md` are authored here because they describe the
site itself.

## Build and deploy

```sh
# Canonical build — URLs point at https://docs.angelmcp.ai
./build.sh

# Interim build for a workers.dev deploy (rewrites the canonical base URL
# inside llms.txt and SKILL.md so handed-off links resolve)
DOCS_BASE_URL=https://angelmcp-docs-demo.sam-633.workers.dev ./build.sh

# Deploy the assets-only worker (public, no Cloudflare Access)
CLOUDFLARE_API_TOKEN=... pnpm exec wrangler deploy -c wrangler.docs.jsonc
```

Preview locally with any static server over `dist/`, e.g.
`pnpm exec wrangler dev -c wrangler.docs.jsonc`.

## Hosting status and the domain caveat

Nothing is wired to `angelmcp.ai` yet — the whole stack runs on
`*.sam-633.workers.dev` (see `../docs/domain-architecture.md`). This worker gets
a stable interim URL, `https://angelmcp-docs-demo.sam-633.workers.dev`, with no
zone move required.

**Custom domain (decided):** `docs.angelmcp.ai` is the canonical docs host, and
`angelmcp.ai/docs` + `angelmcp.ai/llms.txt` redirect to it (see
`../docs/domain-architecture.md`). Once the zone moves into the dedicated
account (migration checklist step 1), add a `routes`/`custom_domain` entry for
`docs.angelmcp.ai` to `wrangler.docs.jsonc` and wire the two apex redirects.

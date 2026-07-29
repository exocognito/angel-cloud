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
| `/google-read-proof-manual-journey.md` | The operator journey under its source name, so raw cross-links from the other docs resolve |
| `/product-decisions/*.md`, `/adrs/*.md` | The decision records the docs link to, so no served link dangles |
| `/manual-images/*` | The screenshots the user manual embeds |
| `/styles.css`, `/viewer.js` | The SPA's own assets |
| `/llms.txt` | LLM site map ([llmstxt.org](https://llmstxt.org) convention) |
| `/SKILL.md` | The create → publish → operate journey as a Claude Code skill |
| `/demo/` | The dashboard itself on generated sample data — read-only, keyless |

Anything else answers 404 — no SPA fallback, so a typo'd URL fails loudly
instead of returning the shell as `200 text/html`.

The human view is a dependency-free single-page app (`public/index.html` +
`viewer.js`) that fetches the raw markdown and renders it with pinned `marked`
and `mermaid` from a CDN. Agents ignore all of that and fetch the `.md` / `.txt`
directly.

## Source of truth

The demo at `/demo/` follows the same rule for the app instead of the prose:
`build.sh` copies `../www/index.html`, `app.js` and `app.css` verbatim, so the
demo is whatever the dashboard currently is — there is no second UI to keep in
step. Two mechanical edits are applied and no others: the shell's absolute
`/app.css` and `/app.js` become siblings under `/demo/`, and one `<script>` tag
is injected above the deferred `app.js`.

That script, `public/demo/shim.js`, is the whole backend. It answers the
dashboard's three read calls out of `fixture.json` and refuses everything else
with a 403, seals every input so the credential fields cannot be typed into, and
adds a banner saying what the page is. The fixture is generated at build time by
`../scripts/build-demo-fixture.ts`, which drives the real `ManagementControl`,
projects it through `buildDemoView`, and checks the result with `assertDemoView`
— the producer half of the contract `www/app.js` validates on the other side. A
read-model change therefore fails the build rather than shipping a stale page.

`tests/cloud/public-demo.test.ts` holds the seams that would otherwise break
quietly: every literal `/api/` path `app.js` reads must be one the shim answers,
the shim must answer nothing else, and `www/index.html` must still have the shape
`build.sh` rewrites. Adding a read call to the dashboard fails CI until the shim
covers it.

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

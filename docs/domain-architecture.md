# Domain architecture (target)

Status: direction agreed 2026-07-23. The coordinate path grammar is live on
the Gateway as of 2026-07-28 (issue #3); the host move is not — everything
currently runs on `workers.dev` URLs in the dedicated Cloudflare account, and
that carries us until the public-product milestone. This document exists so
the URL scheme is settled before anything public depends on it.

This is reference — what the addresses are. Why they are shaped this way, and
whether they are built yet, lives in the product decision records:
[PD 0001](product-decisions/0001-angel-coordinate-scheme.md)
for the coordinate (implemented — the Gateway answers it on the current host)
and
[PD 0002](product-decisions/0002-public-angel-page.md)
for public Angel pages (implemented — the Gateway serves the page at the bare
production coordinate until the apex dispatcher exists).

## The angel coordinate

Every surface addresses an Angel with one coordinate:

```
@<account>/<angel>[@<environment-or-version>]
```

- `@smcllns/inbox-zero` — production. Bare means production; the URL people
  say most often stays shortest.
- `@smcllns/inbox-zero@preview` — preview, the opt-in second environment.
- `@smcllns/inbox-zero@3` — reserved extension: pinned immutable Version 3,
  for the rollback and inspection work already on the deferred punch list
  (unrelated to the `@preview` environment). A pinned
  Version carries no environment (see below); the bare URL is always the
  only address that means "whatever production runs now".

The grammar follows npm's `@scope/name@tag`. The leading `@` is the account
sigil everywhere; the trailing `@suffix` is the environment axis.

The suffix is **one axis, not two**. An environment is a mutable pointer to a
Version (preview points at the previewed Version, production at the promoted
one), so the suffix always answers the single question "which deployment
pointer, or which pinned snapshot?" — the combination "Version N *in*
environment E" does not exist as an address. Invocation targets an
environment (its gate, Connections, keys, and currently bound Version); a
pinned `@N` address exists only on inspection surfaces (an immutable
Version's page or metadata), which carry no environment.

Parsing rules, inherited from npm: a suffix of all digits is a Version;
anything else must be a name from the closed environment list, and
**environment names must not start with a digit**. `latest` and `production`
are reserved and invalid as suffixes — production has exactly one spelling,
the bare coordinate — so every Angel has one canonical production URL.

The suffix set is closed and product-defined — today just `preview` (bare =
production), with room for a small fixed set later (e.g. per-PR builds).
The canonical validation pattern, to be reused verbatim wherever coordinates
are parsed (a surface that accepts only a subset — like the acceptance
runner's production-only URL check — embeds that subset instead):

```
^@([a-z][a-z0-9-]*)/([a-z][a-z0-9-]*)(?:@(preview|[0-9]+))?$
```

The account segment additionally carries PD 0004's four-character floor and a
32-character cap, enforced by the registry in `src/handles.ts`
(`^[a-z][a-z0-9-]{3,31}$`); the pattern above stays the shape of a
coordinate, not the claimability of a name.

Growing the set means editing one alternation in one pattern. The suffix
vocabulary is under review — see PD 0001, which also records the rejected
alternatives.

Consequences:
- Account handles and Angel names must never contain `@`.
- `@<account>` names an **Account** (Personal or Family), not a human — one
  login enters one Account, and a Family handle is shared by its members.
- Preview and production stay independently addressed and independently bound,
  matching the exact-promotion model. Preview binds its own Connections
  (PD 0005).

## Hosts

| Host | Serves | Backed by |
| --- | --- | --- |
| `angelmcp.ai` | Marketing site, plus public Angel www pages at `/@account/angel` | apex dispatcher (future) |
| `docs.angelmcp.ai` | Public docs site (user manual, FAQ, operator journey), plus `/llms.txt` and `/SKILL.md` for agents | Docs worker (static assets) |
| `dash.angelmcp.ai` | Control dashboard for the logged-in Account | Control worker |
| `mcp.angelmcp.ai` | MCP endpoint per Angel: `/@account/angel[@suffix]` | Gateway worker |
| `api.angelmcp.ai` | Control-plane API (exists today behind Control; the CLI consumes it) and, later, per-Angel REST invocation at `/@account/angel[@suffix]` | Control worker; invocation surface TBD |
| `auth.angelmcp.ai` | Upstream-provider OAuth callbacks; later, first-party session issuance if we outgrow Cloudflare Access | Control worker (or a small dedicated worker) |

`docs.angelmcp.ai` is the canonical docs host — it is the URL handed to agents,
so it stays stable and needs no auth. It is a subdomain rather than an apex path
so agents fetch `/llms.txt` and `/SKILL.md` from a stable host root; keeping docs
on their own host also keeps the public surface cleanly separate from the
authenticated `dash.` and `api.` hosts.

Deliberate absences:

- **The Broker gets no hostname, ever.** It is reachable only over service
  bindings from Gateway and Control. "The credential vault has no public URL"
  is a security property, not an omission.
- **No `cli.angelmcp.ai`.** The CLI is a client, not a server. At most the
  name becomes an install-script redirect one day; it is not infrastructure.

## Why `auth.` is its own host

Google OAuth clients pin exact redirect URIs, and changing them means touching
the Google client config (and, for a verified production OAuth app,
re-review). The callback lives on a small, stable host that never serves user
content and never changes, regardless of what `dash.` becomes.

## Apex rules

The apex is shared between marketing paths and `@handle` pages. The `@` sigil
removes the collision by construction, and two further rules keep it safe:

- Non-`@` top-level paths belong to the product (`/pricing`, `/docs`,
  `/blog`, …). `@pricing` and `/pricing` are different paths, so a handle
  cannot reach a product path and the registry needs no product-word list.
  What it does reserve is **authority words** — `admin`, `support`, `official`
  and the like. That risk is impersonation rather than collision: it works
  because the sigil marks the name as an Account, and the Account is called
  `support`.
- `angelmcp.ai/docs` and `angelmcp.ai/llms.txt` redirect to `docs.angelmcp.ai`
  and `docs.angelmcp.ai/llms.txt` — the docs host is canonical, and the apex
  paths exist only so the reserved words resolve to one place.
- No auth cookie is ever scoped to `.angelmcp.ai`. Angel www pages are
  user-shaped content; session cookies stay host-only on `dash.` / `auth.`.

## Migration checklist (when this becomes real)

1. Move the `angelmcp.ai` zone into the dedicated Cloudflare account. This
   moves **all** DNS for the domain — audit email routing and any other
   records on the personal account first.
2. Add Workers custom domains/routes for Control (`dash.`, `api.`, `auth.`),
   Gateway (`mcp.`), and the Docs worker (`docs.`); add apex redirects for
   `/docs` and `/llms.txt` to `docs.angelmcp.ai`.
3. Add `dash.`, `api.`, and `auth.angelmcp.ai` to the Cloudflare Access
   application. `auth.` must be listed: the callback is a Control path, so it
   needs an Access identity like every other one. Because Access cookies are
   host-only, Google's redirect reaches `auth.` without one and Access
   re-issues from the existing team-domain session — verify a live connect
   through the new host rather than assuming that hop is transparent.
4. **Add** `auth.angelmcp.ai/oauth/google/callback` to the Google OAuth client
   alongside the existing `workers.dev` URI — do not replace it (an
   operator-in-a-browser step in Google Cloud Console). An authorization issued
   just before step 5 carries the old redirect URI inside its stored state, and
   the token exchange replays that stored string, so removing the old URI now
   would break those in-flight callbacks. Registering `dash.` too costs nothing
   and makes a callback rollback a var change with no Google edit.
5. Only now update `CONTROL_BASE_URL` (`dash.`), `AUTH_BASE_URL` (`auth.`), and
   `GATEWAY_BASE_URL` (`mcp.`) vars in `wrangler.control.jsonc`, regenerate
   `types/control.d.ts` (the generated types embed var values, and `bun run
   check` fails on drift), and redeploy. Steps 3 and 4 are prerequisites, not
   follow-ups: this deploy is the moment new authorizations start sending the
   `auth.` redirect URI and the post-connect redirect starts landing on `dash.`,
   so an unregistered URI fails consent with `redirect_uri_mismatch` and a host
   missing from the Access application 401s every path.
6. Keep `workers.dev` URLs and the old redirect URI alive through the cutover,
   then disable and remove them.

## Open questions

1. Does preview need more company (per-PR builds, a third environment), and
   if so, which names join the closed suffix alternation?
2. What does the apex dispatcher look like — one worker routing marketing vs
   `@` pages, or marketing on Pages with a route carve-out?
3. When the REST invocation surface lands on `api.`, does the control-plane
   API move under a `/v1/` prefix on the same host or keep a separate path
   root?

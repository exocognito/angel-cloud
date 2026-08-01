# Format decision: `angel.version.v2`

- Status: Accepted
- Date: 2026-07-24

## Decision

`angel.version.v2` replaces v1 as the compiled artifact format. Three changes:

1. Every tool carries a `request` object — a tagged union the gates never
   read. The only kind today is `http`: the request template
   (method, path template, path/query params, defaults, body flag) derived
   from a reviewed, narrowed OpenAPI spec. Future non-HTTP adapter kinds
   (`mcp`, `local`) extend the union with a format bump.
2. A `providers` block pins each used provider namespace to its reviewed
   adapter ID (`google-discovery@1`), HTTPS origin, and the SHA-256 digest of
   the narrowed spec the templates came from.
3. Binding requirements carry `requiredScopes`: the least-authority consent
   covering the requirement's tools, chosen from the adapter's curated scope
   ranking (covers compared by broadest scope first, then next-broadest, with
   fewest scopes as the final tie-break — several narrow scopes always beat
   one broad one). Broad or functionally restricted scopes are excluded
   from the ranking and are never selected automatically.

Reviewed adapter sources live in `packages/core/adapters/<provider>/`
(`adapter.yaml` + `openapi.angel.yaml`); `pnpm --dir packages/core run generate:adapters`
regenerates the Worker-safe registry (`src/adapters.generated.ts`), and a
staleness test enforces agreement. `validateArtifactAdapters` gives every
control plane the publish-time check: templates, pins, and scopes must equal
what the registry derives, so an operation without a reviewed template cannot
publish.

The tagged `request` union supersedes the untagged `requestTemplate` sketch in
the hosted platform design document (decided with Sam, 2026-07-24).

## Migration

Versions are immutable; no v1 artifact is rewritten. Control planes adopting
v2 stop accepting v1 publishes, and existing Angels republish from unchanged
`ANGEL.yaml` sources (only `google-read-proof` v1 exists in production).

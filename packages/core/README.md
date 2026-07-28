# `@smcllns/angel-core`

This package owns the portable Angel standard:

- `ANGEL.yaml` source parsing and local composition;
- canonical, secret-free `angel.version.v1` artifacts and SHA-256 digests;
- portable argument-guard semantics;
- `angel.json` validation; and
- the target-neutral `angel build`, `angel publish`, and
  `angel deploy --prod` client.

The CLI treats `angel.json.target` as an opaque HTTPS origin. It does not know
Cloudflare, Angel Cloud, OAuth, or any hosted product. A compatible hosted or
self-hosted control plane implements the management contract exported by this
package.

## Module boundaries

The package root is the stable Worker-safe interface. It exports the portable
compiler and artifact types, Web Crypto helpers, decisions, management
contract, Angel types, and the fetch-based `ManagementClient`.

Node-side filesystem and CLI features use explicit entrypoints:

```ts
import { buildPortableAngel } from "@smcllns/angel-core/build";
import {
  loadAngelDeploymentConfig,
  runAngelCommand,
} from "@smcllns/angel-core/cli";
```

Only `.`, `./build`, and `./cli` are exported. Other package subpaths are not
part of the compatibility surface.

## Local development

From the `angels` repository:

```text
pnpm install
pnpm --dir packages/angel-core run check
pnpm --dir packages/angel-core run angel -- build <angel>
```

The checked-in `ANGEL.yaml` files are the primary policy artifacts. Deployment
identities belong in untracked `angel.json` files; safe examples use
`angel.example.json`.

## Management credentials

`angel publish` and `angel deploy --prod` read two environment variables:

- `ANGEL_MANAGEMENT_TOKEN` (required) — bearer token for the management API.
- `ANGEL_ACCESS_TOKEN` (optional) — service token for a control plane behind
  Cloudflare Access, sent as the `CF-Access-Client-ID` and
  `CF-Access-Client-Secret` headers.

`ANGEL_ACCESS_TOKEN` must be exactly this JSON object, with no surrounding
whitespace and no other keys:

```json
{"cf-access-client-id":"<id>","cf-access-client-secret":"<secret>"}
```

The CLI rejects anything else — including a trailing newline — instead of
trimming, because the value is a credential and silent normalisation hides
mistakes. Secret managers often end output with a newline; strip it when
exporting:

```sh
export ANGEL_ACCESS_TOKEN=$(op read "op://<vault>/<item>/credential" | jq -c . | tr -d '\n\r')
```

## Distribution

The source repository remains private for Milestone 0. The package is published
publicly as exact version `@smcllns/angel-core@0.1.0`, so compatible hosted and
self-hosted control planes can install the versioned interface without a
repository credential. The exact tarball boundary and a public-publish dry run
are covered by the package tests.

# `@smcllns/angel-core`

This package owns the portable Angel standard:

- `ANGEL.yaml` source parsing and local composition;
- canonical, secret-free `angel.version.v2` artifacts and SHA-256 digests (see the
  [format contract](https://github.com/exocognito/angelmcp/blob/main/docs/core/format-v2.md));
- portable argument-guard semantics;
- `angel.json` validation; and
- the target-neutral `angel build`, `angel publish`, `angel deploy --prod`,
  and `angel delete` client.

`angel publish <angel>` deploys the built Version straight to production.
`angel publish <angel> --preview` deploys to the preview environment instead,
using `angel.json`'s `bindings.preview`; preview binds its own Connections and
never inherits production's. Adding `--share-production-credentials` sends
production's bindings to preview explicitly. `angel deploy <angel> --prod`
promotes the exact active preview deployment. Older `angel.json` files must
rename `bindings.staging` to `bindings.preview`.

The CLI treats `angel.json.target` as an opaque HTTPS origin. It does not know
Angel Cloud, OAuth, or any hosted product: it presents one bearer token and
nothing else. A compatible hosted or self-hosted control plane implements the
management contract exported by this package.

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

From the `exocognito/angelmcp` repository:

```text
pnpm install
pnpm --dir packages/core run check
pnpm run angel -- build <angel>
```

The checked-in `ANGEL.yaml` files are the primary policy artifacts. Deployment
identities belong in untracked `angel.json` files; safe examples use
`angel.example.json`.

## Management credentials

`angel publish` and `angel deploy --prod` read one environment variable:

- `ANGEL_MANAGEMENT_TOKEN` (required) — presented as `Authorization: Bearer` on
  every management call. What the control plane makes of it is the control
  plane's business; Angel Cloud resolves it as a session.

Keep it out of source, `angel.json`, logs, and any artifact. Secret managers
often end output with a newline; strip it when exporting:

```sh
export ANGEL_MANAGEMENT_TOKEN=$(op read "op://<vault>/<item>/credential" | tr -d '\n\r')
```

## Distribution

Source lives publicly in `exocognito/angelmcp/packages/core`. The package is
published as exact versions so compatible control planes can install the
versioned interface without a repository checkout. The current public release
is `@smcllns/angel-core@0.3.0`. `pnpm run check:ws1` downloads that registry
tarball, verifies its SRI, and compares its file, manifest, and runtime contract
with this tree. O1 owns any later public package identity or package split.

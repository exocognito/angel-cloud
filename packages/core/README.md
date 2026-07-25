# `@exocognito/angel-core`

This package owns the portable Angel standard:

- `ANGEL.yaml` source parsing and local composition;
- canonical, secret-free `angel.version.v2` artifacts and SHA-256 digests;
- portable argument-guard semantics;
- `angel.json` validation; and
- the target-neutral `angel build`, `angel publish`, and
  `angel deploy --prod` client.

The CLI treats `angel.json.target` as an opaque HTTPS origin. It does not know
Cloudflare, Angel Cloud, OAuth, or any hosted product. A compatible hosted or
self-hosted control plane implements the management contract exported by this
package.

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

## Distribution decision still required

The implementation is ready for any of these final transports, but Milestone 0
does not select one implicitly:

| Transport | Exact publication/install command | Credential requirement |
| --- | --- | --- |
| Public source repo | `gh repo edit exocognito/angels --visibility public` | Repository admin; consumers need none |
| Public npm package from private source | `cd packages/angel-core && pnpm publish --access public` | Maintainer needs an npm publish token; consumers need none |
| Private npm/Git package | `cd packages/angel-core && pnpm publish --access restricted` or pin `git+https://github.com/exocognito/angels.git#v0.1.0` | Maintainer needs registry/GitHub publish access; consumers and CI need an explicit read credential |
| Temporary workspace | `pnpm install` from a parent workspace | None, but it is not an independent fresh-clone boundary |

No publication or visibility mutation has been performed.

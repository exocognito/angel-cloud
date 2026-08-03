# @angelmcp/cli

The Angel CLI. Write, build, publish, and deploy an inspectable agent toolbox.

## Install

Angel runs on [Bun](https://bun.sh). With Bun installed:

```sh
bun add --global @angelmcp/cli@0.1.0
angel --version
```

That gives you a bare `angel` command on `PATH` from any directory. No
repository clone and no other package manager are required.

## Commands

```sh
angel build <angel>
angel publish <angel> [--preview [--share-production-credentials]]
angel deploy <angel> --prod
angel delete <angel> [--confirm <slug>]
```

Run `angel --help` for the current list.

## Documentation

- [User manual](https://github.com/exocognito/angelmcp/blob/main/docs/user-manual.md)
  — write, build, publish, deploy, connect, and operate an Angel.
- [FAQ](https://github.com/exocognito/angelmcp/blob/main/docs/faq.md) — design
  rationale, security boundaries, and current limits.

## Licence

MIT. See [LICENSE](./LICENSE).

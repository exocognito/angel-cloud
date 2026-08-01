# Angel Fixtures

This directory contains **golden copies** of portable Angel definitions and compiled artifacts. The canonical policy sources and @smcllns/angel-core are in the separate portable [exocognito/angel-core](https://github.com/exocognito/angel-core) repository. This hosted repo consumes the installed @smcllns/angel-core package and maintains checked-in copies of portable Angel configurations as public examples.

## Layout

- `{angelId}/ANGEL.yaml` — portable policy definition (copied from portable repo)
- `{angelId}/ANGEL.v2.yaml` — optional v2 variant (e.g., gmail-read-and-draft)
- `{angelId}/angel.example.json` — safe example of deployment configuration
- `{angelId}/build/` — compiled artifacts (golden fixtures, checked in for verification)

`google-read-proof` is the pinned direct multi-provider fixture for the real
read-only Google acceptance. Its `docs` and `gmail` requirements intentionally
use the same example Connection nickname; the actual `angel.json` remains local
and ignored.

## Actual deployment configuration

The actual `angel.json` file is **local only** and ignored by git. To set up local execution:

```bash
cp angels/{angelId}/angel.example.json angels/{angelId}/angel.json
# Edit target, account, and bindings as needed for your deployment
```

Tests use deterministic fixture paths with no fallback magic. Checked-in artifacts are verified to match recompilation with installed @smcllns/angel-core.

## Keeping fixtures current

When portable Angel definitions change, recompile and update the checked-in artifacts:

```bash
bun run angel build {angelId}
```

The `pnpm check` command verifies artifacts match their sources without modifying files.

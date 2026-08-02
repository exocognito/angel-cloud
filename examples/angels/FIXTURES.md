# Angel Fixtures

This directory is the canonical checked-in source for portable Angel examples and compiled fixtures. The compiler and CLI live beside it at `packages/core`; the hosted Workers consume the same workspace package. The external `exocognito/angels` repository is a starter, not another compiler or fixture source.

## Layout

- `{angelId}/ANGEL.yaml` — canonical portable example policy
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
cp examples/angels/{angelId}/angel.example.json examples/angels/{angelId}/angel.json
# Edit target, account, and bindings as needed for your deployment
```

Tests use deterministic fixture paths with no fallback magic. Checked-in artifacts are verified to match recompilation with installed @smcllns/angel-core.

## Keeping fixtures current

When portable Angel definitions change, recompile and update the checked-in artifacts:

```bash
cd examples && pnpm exec angel build {angelId}
```

The `pnpm check` command verifies artifacts match their sources without modifying files.

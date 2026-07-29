# Project agent instructions

Follow the global agent instructions, plus this repository-specific contract.

## Documentation ownership and upkeep

- `README.md` is the quick start and deployment reference.
- `docs/user-manual.md` owns user-visible mechanics: source files, CLI commands,
  management and MCP flows, dashboard controls, errors, and operator setup.
- `docs/faq.md` owns rationale, security boundaries, shipped-versus-deferred
  status, and known product limits.
- `docs/google-read-proof-manual-journey.md` owns the credentialed Google
  acceptance procedure.
- `docs/aprd/` owns the target-state product spine — goals, non-goals,
  invariants, priority rules — and, in its Terminology section, the words every
  other document must use. Check that section before writing product prose
  anywhere: it says what each term means and which phrasings are forbidden.
- Teach each fact fully once. Link from the other documents instead of copying
  it.

Any PR that changes user-facing CLI, API, authentication, OAuth/custody,
runtime, MCP, UI, deployment, error, or acceptance-test behavior must update
the owning manual or FAQ in the same PR. Otherwise state `Documentation impact:
none` with code or test evidence.

Verify documentation claims against the current cloud branch, not the
comparison snapshot. Before review, run the relevant journey, run the test
suite, and mechanically verify relative Markdown links and heading anchors.

Use placeholder identities and use placeholder targets in examples unless a
public deployed endpoint is the subject of the operator documentation. Never
commit personal data, private Account or Connection identifiers, OAuth client
data, tokens, provider fixture values, secret-service paths, or other secrets
to documentation.

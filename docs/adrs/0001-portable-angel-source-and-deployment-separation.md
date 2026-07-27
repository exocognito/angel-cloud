# ADR 0001: Separate portable Angel policy from deployment configuration

- Status: Accepted
- Date: 2026-07-20

## Context

An Angel should be reviewable, reusable, and deployable unchanged to Angel
Cloud or a self-hosted Cloudflare runtime. Account identifiers, Connection
names, credentials, and platform targets would make that policy private and
host-specific if they appeared in `ANGEL.yaml`.

The hosted platform also must not execute a user's build or accept source YAML.
It needs immutable, secret-free policy bytes that both runtime gates can enforce
identically.

## Decision

`ANGEL.yaml` contains policy only. It has two source forms:

```ts
type AngelSource = DirectAngelSource | CompositeAngelSource;

interface DirectAngelSource {
  name: string;
  tools: readonly CanonicalToolPolicy[];
}

interface CompositeAngelSource {
  name: string;
  angels: readonly string[];
}

interface CanonicalToolPolicy {
  name: string;
  guards?: readonly ArgumentGuard[];
}
```

A direct Angel may contain tools from one or many providers. A composite Angel
names local sibling Angels through `angels:`. References contain no deployment
target, Account, Connection, alias, or source Version suffix. Missing sources,
cycles, non-local references, and incompatible duplicate policies fail the
build.

The local build resolves composition and emits canonical, secret-free bytes:

```ts
interface AngelVersionArtifact {
  format: "angel.version.v1";
  name: string;
  tools: readonly CanonicalToolPolicy[];
  children: readonly { name: string; digest: string }[];
  bindingRequirements: readonly ProviderBindingRequirement[];
}
```

Each `ProviderBindingRequirement` carries an explicit stable `id`. Direct
multi-provider Angels use the provider namespace (`gmail`, `docs`). A composite
uses the child Angel name when that child needs one provider
(`gmail-read-and-draft`), or `<child>:<provider>` when one child spans providers.
The build rejects resulting ID collisions. `angel.json` keys its environment
binding maps by these artifact IDs.

The digest covers the canonical artifact. The output is
`build/<angel>/angel.version.json`. Rebuilding the same source must produce the
same bytes and digest.

`angel.json` is local deployment configuration:

```ts
interface AngelDeploymentConfig {
  target: `https://${string}`;
  account: string;
  angel: string;
  bindings: {
    staging: BindingMap;
    production: BindingMap;
  };
}

type BindingMap = Readonly<Record<string, string | readonly string[]>>;
```

`target` is the explicit management API base URL, not a built-in platform name
or implicit Account lookup. This keeps the same file usable with Angel Cloud or
a self-hosted compatible control plane without a hidden target registry.

Its human-readable Connection nicknames are resolved locally. The management
API receives opaque Connection IDs and the built artifact, never source YAML or
credentials.

## Boundaries and invariants

- Public source, artifacts, and Version review contain no Account or Connection
  identity.
- The same artifact can be installed in different Accounts and runtimes.
- The platform validates and re-digests uploaded canonical bytes; it never
  builds user source.
- A deployment binds every requirement explicitly for its environment.
- Composition is optional. A single direct multi-provider Angel is valid.

## Consequences

Policy review and deployment review are separate operations. Reusable child
Angels add local authoring files, but users with one simple deployment can omit
composition. Moving the hosted platform and personal configs into separate
repositories preserves the same artifact/API boundary already exercised here.

## Rejected alternatives

- Put target, Account, or credentials in `ANGEL.yaml`: not portable or safely
  publishable.
- Put Connection aliases in canonical tool names: leaks private management
  labels and makes agent contracts brittle on rename.
- Let Angel Cloud build YAML: expands the trust boundary into user-controlled
  build execution and makes comparisons less static.
- Require composition for multi-provider Angels: unnecessary authoring cost.

## Revisit when

Only revisit if a real provider policy cannot be represented without a
deployment identity. First try a provider-neutral policy primitive and record
the failing artifact before coupling source to deployment.

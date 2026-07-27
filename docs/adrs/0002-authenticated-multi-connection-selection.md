# ADR 0002: Select repeated Connections through authenticated tool arguments

- Status: Accepted
- Date: 2026-07-20

## Context

One Angel may bind the same canonical tool to several authenticated identities,
such as personal and work Gmail. Prefixing public tool names with a user-authored
Connection nickname leaks possibly sensitive management data and makes the
agent contract change when that nickname changes.

Calling every eligible Connection when the caller omits a selector is also not
a safe default. Adding a Connection would silently broaden an unchanged call and
would require aggregation, pagination, ordering, cost, and partial-failure
semantics that the minimal platform does not need.

## Decision

A repeated canonical tool remains one MCP tool. The runtime adds a reserved
`angel_connection` argument whose values are opaque agent-plane references.

```ts
type AngelConnectionRef = string & { readonly __brand: "AngelConnectionRef" };

interface RuntimeConnectionChoice {
  ref: AngelConnectionRef;
  provider: string;
  identity: string;
}

interface InstalledToolBinding {
  tool: string;
  connectionRef: AngelConnectionRef;
  managementConnectionId: string;
  policy: CanonicalToolPolicy;
}
```

Authenticated MCP `tools/list` overlays the choices onto the canonical Tool:

```json
{
  "name": "gmail.users.messages.list",
  "inputSchema": {
    "type": "object",
    "properties": {
      "angel_connection": {
        "type": "string",
        "oneOf": [
          { "const": "arc_7H2K", "title": "Google - sam@example.com" },
          { "const": "arc_Q91P", "title": "Google - work@example.com" }
        ]
      }
    },
    "required": ["angel_connection"]
  },
  "_meta": {
    "angelmcp.dev/connections": [
      { "ref": "arc_7H2K", "provider": "gmail", "identity": "sam@example.com" },
      { "ref": "arc_Q91P", "provider": "gmail", "identity": "work@example.com" }
    ]
  }
}
```

If exactly one active Connection is eligible, `angel_connection` may be omitted
and that Connection is selected. If more than one is eligible, it is required.
Unknown, stale, paused, or ineligible references fail before credential access.
The selector is removed before invoking the provider.

The compiler reserves `angel_connection` and rejects a provider schema that
already defines it. Opaque refs are scoped to one Angel environment, differ
between staging and production, and are invalidated when the corresponding
binding is replaced. Clients refresh `tools/list` after deployment changes.

Both Gateway and Broker independently resolve and authorize the same
`(canonicalTool, connectionRef)` tuple. Per-tool/per-Connection pause is an
availability overlay on that tuple, not a Version mutation.

## Disclosure boundary

Authenticated agent clients may see provider-derived identity labels needed to
choose correctly, such as an email address, handle, or workspace. They never see
the management Connection ID, user-authored nickname, credentials, OAuth token,
or Provider App details. Public Angel source, Version artifacts, and unauthenticated
read-only materials contain no identity choices.

## Consequences

Clients gain a small platform-reserved argument. Tool names remain stable and
portable, while one Angel key can use several identities without creating a
tool-name explosion. Cached refs can become stale and must fail clearly.

## Rejected alternatives

- `<alias>.<canonicalTool>`: leaks/bakes in private mutable labels.
- Opaque namespace in each tool name: avoids the leak but duplicates tools and
  still makes their names deployment-specific.
- Implicit fan-out: silently broadens calls and introduces an aggregation model.
- One Connection per provider: cannot support common personal/work use.
- Exact tool-to-Connection mapping with no selector: prevents caller choice.

## Revisit when

Consider explicit fan-out only after a real operation proves a need and defines
a typed opt-in selector, result envelope, pagination, ordering, cost limits, and
partial-failure contract. Omission must never mean fan-out.

# Product decisions

Decisions about what the product does and how it feels: URL grammar, defaults,
naming, what a stranger sees. Taste, not architecture.

[Architecture decisions](../adrs/README.md) live next door and answer a
different question. An ADR settles how the system is built — boundaries,
formats, enforcement. A product decision settles what a person types, reads,
or expects. When a choice would survive a full rewrite of the internals, it
belongs here.

## Why this directory exists

Three decisions agreed on 2026-07-23 — the `@account/angel` coordinate,
production as the bare default, and public Angel pages — sat inside a document
titled "Domain architecture", tracked only by an issue about moving a DNS
zone. Nobody could answer "what have we agreed but not built?" without reading
every doc in the repo, and twice in one week nobody did.

So every decision here carries its build status in its header, and the table
below is the answer to that question.

## Status convention

Each record opens with four lines:

```
- Status: Agreed | Superseded by NNNN | Reversed
- Date: YYYY-MM-DD
- Implemented: No | Partly | Yes
- Tracked: #NN, or "none yet"
```

`Status` is about the decision; `Implemented` is about the code. A decision can
be settled for months and still be unbuilt — that gap is the thing this
directory refuses to hide.

Records are dated and kept verbatim, like ADRs. Reversing a decision means
writing a new record that supersedes the old one, never editing the old one.

## Index

| # | Decision | Agreed | Implemented | Tracked |
| --- | --- | --- | --- | --- |
| [0001](0001-angel-coordinate-scheme.md) | Address every Angel as `@account/angel[@suffix]`; bare means production | 2026-07-23 | No | none yet |
| [0002](0002-public-angel-page.md) | Every Angel has a public page anyone can read without a key | 2026-07-23 | No | none yet |

Both are live-facing gaps: the running Gateway serves
`/v1/a/{account}/{angel}/{environment}/mcp`, POST-only and key-only, which
matches neither record.

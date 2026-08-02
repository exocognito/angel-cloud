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
- Status: Agreed | Superseded by NNNN | Partly superseded by NNNN | Reversed
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
| [0001](0001-angel-coordinate-scheme.md) | Address every Angel as `@account/angel[@suffix]`; bare means production | 2026-07-23 | Yes | [#3](https://github.com/exocognito/angelmcp/issues/3) |
| [0002](0002-public-angel-page.md) | Every Angel has a public page anyone can read without a key | 2026-07-23 | Yes | [#11](https://github.com/exocognito/angelmcp/issues/11) |
| [0003](0003-preview-is-opt-in.md) | Publishing goes live; `preview` is opt-in and shares credentials | 2026-07-28 | Yes | [#3](https://github.com/exocognito/angelmcp/issues/3) |
| [0004](0004-account-handles.md) | Account handles are permanent, renameable once, and never released | 2026-07-28 | Partly | [#12](https://github.com/exocognito/angelmcp/issues/12) |
| [0005](0005-preview-binds-its-own-connections.md) | Preview binds its own Connections; sharing production's must be asked for | 2026-07-28 | Yes | [#3](https://github.com/exocognito/angelmcp/issues/3) |
| [0006](0006-www-is-a-full-write-surface.md) | www can create, edit, build, and publish through the same artifact contract | 2026-07-30 | Partly | none yet |
| [0007](0007-capability-only-public-review.md) | Public review is a capability-only summary | 2026-08-01 | No | [PR #46](https://github.com/exocognito/angelmcp/pull/46) |

0007 partly supersedes 0002's content list when the reduced summary ships.
The current page still implements 0002.

0005 supersedes point 3 of 0003 — same day, before either shipped. The reversal
is a record rather than an edit because the convention has to hold at one day
old to hold at one year.

For decisions 0001–0005, no whole live-facing gap remains. The Gateway answers the
`/@handle/angel[@preview]` coordinate with bare meaning production (0001),
renders 0002's trust page at the bare production coordinate, the
second environment is named `preview` and binds only its own explicit
Connections (0003/0005), and the server deploys a published Version straight
to production in one step.

PD 0006 adds a deliberate product gap. The dashboard already promotes,
changes availability, and manages keys, but it cannot author, build, or publish
source. Those www controls are agreed and unbuilt. PD 0007 adds a second gap:
the current page still exposes more than the agreed capability-only summary.
CLI spellings that remain unfinished are tracked separately in the APRD.

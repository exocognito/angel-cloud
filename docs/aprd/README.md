# APRD — the dataroom

`angel-cloud-aprd.html` is the Agentic Product Requirements Document for the
target one-player product: the single page a frontier model can build from and
the product team can read and approve. Open it in a browser.

## What is normative

The dataroom is the source of truth. Where any other page here disagrees with
it, the dataroom wins.

Terminology (§0) defines the words used everywhere. The goals map (§2) and
commitments (§3) state the complete target product; station detail (§4) expands
them. The system diagram (§5), non-goals (§6), and open questions (§7) set its
boundary. Phasing (§8) chooses build order and never narrows that design.

ROADMAP.md owns delivery sequence and status. The ADR/PD index Status line says
whether a record governs; when a settled record and the APRD conflict, fix the
APRD.

## The audience views

`views/` and `aprd-views.html` still hold the four audience renderings generated
from v1. They are stale snapshots, not v2 requirements. Regenerate all four
from the finished v2 dataroom before publishing them as current.

## The embedded dashboard

The v2 APRD does not frame the demo. `/demo/` remains separate proof: the docs
build serves the real `www/` shell over a generated read-only fixture, not a
screenshot. The canonical `docs.angelmcp.ai` host still waits on the zone move
([#6](https://github.com/exocognito/angel-cloud/issues/6)).

## Hosting

`PUBLISH=1 ./publish.sh` uploads each page over its own stable URL. A bare
`./publish.sh` prints the six targets and stops — replacing live pages people
already hold links to should take a deliberate second word. Those URLs are the
identity of each page — the script never mints new ones, so a link shared once
keeps working. `DRY_RUN=<dir> ./publish.sh` stages the rewritten pages without
uploading, which is the way to check a change before it ships. The target must
be an empty directory — staging into this one would overwrite the committed
pages with their hosted rewrites.

Both modes need the six page URLs, in an untracked `urls.env` beside the script
(`APRD_URL_DATAROOM`, `APRD_URL_HUB`, `APRD_URL_ENGINEERING`, `APRD_URL_DESIGN`,
`APRD_URL_MARKETING`, `APRD_URL_SUPPORT`) or exported. They are capability URLs
— the random segment is the read credential — so they are not committed, and the
script refuses to run without them rather than guessing.

Uploading additionally needs `files-blog-upload`, which lives in the maintainer's dotfiles
rather than in this repository, so publishing works only from a checkout that
has it. Point `FILES_BLOG_UPLOAD` at your own copy to use a different one.
`DRY_RUN` does not need it.

Local copies use relative links so cross-links resolve from a local checkout;
the hosted copies get absolute ones. That rewrite is the only difference between
what is committed here and what is served. Neither copy works offline: every
page loads Tailwind from a CDN, and the dataroom and engineering view load
Mermaid too.

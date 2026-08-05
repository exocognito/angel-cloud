# APRD — next-milestone build contracts

`angel-cloud-aprd.html` is the current APRD draft. Open it in a browser.

## What is normative

The [Angel Product Ledger](../product-ledger.html) owns the final goal, roadmap,
the commitments each epic keeps, and build-approval status. An APRD owns only the
build contract for the next milestone after that milestone is approved.

WS-E reconciled O2–O7 into this draft without approving implementation. It is
**not approved for implementation**. On 2026-08-03 O10 approved WS2 and M-DF2 as
the seven WS-E briefs define them — not this draft. Its terminology, commitments,
commands, and evals stay target-state source material until a WS2 build contract
derives from the approved Ledger.

For an approved APRD, terminology defines the words used everywhere; goals and
commitments state the milestone outcome; station detail expands them; the
system diagram and non-goals set the boundary; and the CLI/eval documents own
exact commands and proof. Where an APRD conflicts with a governing ADR or
product decision, fix the APRD. Where it conflicts with the Product Ledger on
scope, sequence, disposition, or approval, fix the APRD.

The current user manual remains the shipped Milestone 1 manual. Do not rewrite
target commands into current user docs before implementation ships.

## The audience views

`views/` and `aprd-views.html` still hold the four audience renderings generated
from v1. They are stale snapshots, not current requirements. Regenerate all four
only after the next APRD is approved.

## The embedded dashboard

The current APRD does not frame the demo. `/demo/` remains separate proof: the
docs build serves the real `www/` shell over a generated read-only fixture, not
a screenshot. The canonical `docs.angelmcp.ai` host still waits on the zone move
([#6](https://github.com/exocognito/angelmcp/issues/6)).

## Hosting

`PUBLISH=1 ./publish.sh` uploads each page over its stable capability URL. A
bare `./publish.sh` prints the targets and stops. `DRY_RUN=<dir> ./publish.sh`
stages rewrites without upload. Do not publish an unapproved APRD as current.

Both modes need the page URLs in an untracked `urls.env` beside the script or
exported. Uploading also needs `files-blog-upload`; dry-run does not. Local pages
use relative links and hosted pages use absolute links. Both load Tailwind from
a CDN; the dataroom and engineering view also load Mermaid.

# APRD — the dataroom

`angel-cloud-aprd.html` is the Agentic Product Requirements Document for the
target one-player product: the single page a frontier model can build from and
the product team can read and approve. Open it in a browser.

## What is normative

The dataroom is the source of truth. Where any other page here disagrees with
it, the dataroom wins.

Inside the dataroom, precedence runs **Spine > Evals > System diagram >
Prototype > FAQ**, and the Spine wins all conflicts. Terminology (§0) sits
outside that order: it states no requirement, it defines the words the
requirements are written in, and it governs how the product is described
anywhere — docs, help articles, commit messages, marketing copy. Change a word
there and it changes everywhere.

Every passage has two renderings, switched in place by the toggle at the bottom
right. **Developer** is the binding statement. **User** is derived from it — the
consequence a person will notice, written for the internal product team. The
two are one requirement rendered twice, never two requirements.

## The audience views

`views/` holds four renderings of the same content, organised the way each
specialist reads: `engineering`, `design`, `marketing`, `support`. Open
`aprd-views.html` for a full-screen carousel across all four. They are derived,
not authoritative — the marketing view's claim guardrails, for instance, apply
the terminology table rather than restating it.

## The embedded dashboard

Prototype flow F frames the deployed public demo at `/demo/`, which is assembled
from the real `www/` shell — the live product rather than a picture of it, so it
never needs refreshing here. The page is deployed and the frame renders, but the
build step that assembles it arrives with
[#21](https://github.com/exocognito/angel-cloud/pull/21); until that merges,
[docs-site](../../docs-site/README.md) documents no `/demo/` path and flow F is
tagged as an intended change rather than observed behaviour.

## Hosting

`./publish.sh` uploads each page over its own stable URL. Those URLs are the
identity of each page — the script never mints new ones, so a link shared once
keeps working. `DRY_RUN=<dir> ./publish.sh` stages the rewritten pages without
uploading, which is the way to check a change before it ships.

Uploading needs `files-blog-upload`, which lives in Sam's dotfiles rather than
in this repository, so publishing works only from a checkout that has it. Point
`FILES_BLOG_UPLOAD` at your own copy to use a different one. `DRY_RUN` needs
nothing beyond this directory.

Local copies use relative links so the set works offline from this directory;
the hosted copies get absolute ones. That rewrite is the only difference between
what is committed here and what is served.

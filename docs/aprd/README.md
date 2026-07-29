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

Prototype flow F frames the public demo at `/demo/`, which is assembled from the
real `www/` shell — the live product rather than a picture of it, so it never
needs refreshing here.

The build step that assembles it arrives with
[#21](https://github.com/exocognito/angel-cloud/pull/21), so until that is on
`main` the frame is only as good as the last deploy of the docs worker: a deploy
from a branch without the step removes `/demo/`, and the frame goes blank. That
is why flow F is tagged as an intended change rather than observed behaviour, and
why [docs-site](../../docs-site/README.md) documents no `/demo/` path yet.

## Hosting

`./publish.sh` uploads each page over its own stable URL. Those URLs are the
identity of each page — the script never mints new ones, so a link shared once
keeps working. `DRY_RUN=<dir> ./publish.sh` stages the rewritten pages without
uploading, which is the way to check a change before it ships.

Both modes need the six page URLs, in an untracked `urls.env` beside the script
(`APRD_URL_DATAROOM`, `APRD_URL_HUB`, `APRD_URL_ENGINEERING`, `APRD_URL_DESIGN`,
`APRD_URL_MARKETING`, `APRD_URL_SUPPORT`) or exported. They are capability URLs
— the random segment is the read credential — so they are not committed, and the
script refuses to run without them rather than guessing.

Uploading additionally needs `files-blog-upload`, which lives in Sam's dotfiles
rather than in this repository, so publishing works only from a checkout that
has it. Point `FILES_BLOG_UPLOAD` at your own copy to use a different one.
`DRY_RUN` does not need it.

Local copies use relative links so the set works offline from this directory;
the hosted copies get absolute ones. That rewrite is the only difference between
what is committed here and what is served.

#!/usr/bin/env bash
# Assemble the docs site into ./dist for `wrangler deploy`.
#
# Single source of truth: the site renders the same markdown the repo ships in
# ../docs. Nothing here forks or rewrites doc prose — it copies the markdown
# verbatim and lets the browser render it. The only transform is an optional
# base-URL rewrite for interim hosting (see DOCS_BASE_URL below).
#
# Usage:
#   ./build.sh                 # canonical build (URLs point at docs.angelmcp.ai)
#   DOCS_BASE_URL=https://angelmcp-docs-demo.sam-633.workers.dev ./build.sh
#                              # interim build for a workers.dev deploy
#   DOCS_DIST=/some/dir ./build.sh   # build somewhere other than ./dist
#                              # (the contract tests build into temp dirs)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$here/.."
docs="$root/docs"
dist="${DOCS_DIST:-$here/dist}"

rm -rf "$dist"
mkdir -p "$dist"

# 1. Static shell (SPA + assets) and the agent-facing files.
cp -R "$here/public/." "$dist/"

# 2. Repo markdown, copied verbatim, at stable root paths the SPA and llms.txt
#    reference. google-read-proof-manual-journey.md is surfaced as the shorter
#    "operator-journey" slug the index and llms.txt use.
cp "$docs/user-manual.md"          "$dist/user-manual.md"
cp "$docs/faq.md"                  "$dist/faq.md"
cp "$docs/domain-architecture.md"  "$dist/domain-architecture.md"
cp "$docs/google-read-proof-manual-journey.md" "$dist/operator-journey.md"
# Also serve the journey under its source name so the raw cross-links in
# user-manual.md and faq.md ([...](google-read-proof-manual-journey.md)) resolve
# for agents fetching the raw markdown. The SPA routes both names to the same slug.
cp "$docs/google-read-proof-manual-journey.md" "$dist/google-read-proof-manual-journey.md"

# 3. The decision records the served docs link to. The user manual and FAQ
#    reference docs/product-decisions/*.md by relative path, and those records
#    reference docs/adrs/*.md and ../domain-architecture.md; copying both
#    directories under their repo-relative paths closes the link graph, so no
#    served markdown link dangles. (tests/cloud/docs-site.test.ts crawls the
#    closure and fails the build contract if a link ever dangles again.)
cp -R "$docs/product-decisions" "$dist/product-decisions"
cp -R "$docs/adrs" "$dist/adrs"

# 4. Images the served markdown references. Only the user manual's
#    manual-images/ are used; docs/screenshots/ is referenced solely by the
#    (unserved) README, so it is deliberately not copied — no dead 9 MB payload.
cp -R "$docs/manual-images" "$dist/manual-images"

# 5. The public demo at /demo: the real dashboard on generated sample data.
#    Same rule as the markdown above — the shell is copied verbatim from ../www,
#    never forked, so the demo shows whatever the dashboard currently is. Two
#    mechanical changes are unavoidable and are the only ones allowed here:
#      a. /app.css and /app.js are absolute in the shipped shell; under /demo/
#         they must resolve as siblings.
#      b. one <script> tag, above the deferred app.js, installs the read-only
#         fetch shim that answers from fixture.json.
#    There is no server: the fixture is generated at build time by the same
#    projection code the live dashboard reads, and mutations are refused.
mkdir -p "$dist/demo"
cp "$root/www/app.css" "$root/www/app.js" "$dist/demo/"
LC_ALL=C sed \
  -e 's#href="/app\.css"#href="app.css"#' \
  -e 's#<script src="/app\.js" defer></script>#<script src="shim.js"></script>\n    <script src="app.js" defer></script>#' \
  "$root/www/index.html" > "$dist/demo/index.html"

# Fail loudly rather than publishing a shell whose assets or shim did not land.
for marker in 'href="app.css"' '<script src="shim.js">' '<script src="app.js" defer>'; do
  grep -qF "$marker" "$dist/demo/index.html" \
    || { echo "demo build: expected '$marker' in dist/demo/index.html — www/index.html changed shape" >&2; exit 1; }
done

bun run "$root/scripts/build-demo-fixture.ts" "$dist/demo/fixture.json"

# 6. Optional interim base-URL rewrite. The committed llms.txt and SKILL.md name
#    the canonical https://docs.angelmcp.ai; a workers.dev deploy rewrites those
#    to the live interim host so the handed-off URLs actually resolve.
if [[ -n "${DOCS_BASE_URL:-}" ]]; then
  for f in "$dist/llms.txt" "$dist/SKILL.md"; do
    tmp="$(mktemp)"
    LC_ALL=C sed "s#https://docs.angelmcp.ai#${DOCS_BASE_URL}#g" "$f" > "$tmp"
    mv "$tmp" "$f"   # temp-file + mv is portable across BSD (macOS) and GNU sed
  done
  echo "Rewrote canonical base URL to ${DOCS_BASE_URL}"
fi

echo "Built docs site into $dist"

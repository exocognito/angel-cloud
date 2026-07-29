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
docs="$here/../docs"
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

# 3. Images the served markdown references. Only the user manual's
#    manual-images/ are used; docs/screenshots/ is referenced solely by the
#    (unserved) README, so it is deliberately not copied — no dead 9 MB payload.
cp -R "$docs/manual-images" "$dist/manual-images"

# 4. Optional interim base-URL rewrite. The committed llms.txt and SKILL.md name
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

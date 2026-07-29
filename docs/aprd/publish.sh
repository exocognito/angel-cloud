#!/usr/bin/env bash
# Publish the APRD dataroom and its audience views to their existing R2 URLs.
#
# Local copies use relative links so the set works offline from this directory.
# The hosted copies need absolute links, so this script stages a rewritten copy
# and uploads each page over its own stable URL with --replace. Each URL is the
# identity of its page — never mint a new one for a page that already has one.
#
# The URLs themselves are NOT in this file. They are capability URLs: the random
# segment is the read credential, so anyone holding the URL can read the page,
# and this is a public repository. They live in an untracked `urls.env` beside
# this script (or come from the environment), and the script refuses to run
# without them rather than guessing.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

# urls.env fills in only what the environment has not already set, so an operator
# who exports a URL gets the one they asked for rather than whatever the file
# happens to hold.
if [[ -f "$here/urls.env" ]]; then
  for var in APRD_URL_DATAROOM APRD_URL_HUB APRD_URL_ENGINEERING APRD_URL_DESIGN APRD_URL_MARKETING APRD_URL_SUPPORT; do
    [[ -n "${!var:-}" ]] && continue
    line="$(grep -E "^${var}=" "$here/urls.env" | tail -1)" || true
    [[ -n "$line" ]] && eval "export $line"
  done
fi

missing=()
for var in APRD_URL_DATAROOM APRD_URL_HUB APRD_URL_ENGINEERING APRD_URL_DESIGN APRD_URL_MARKETING APRD_URL_SUPPORT; do
  [[ -n "${!var:-}" ]] || missing+=("$var")
done
if (( ${#missing[@]} > 0 )); then
  echo "publish: missing page URLs: ${missing[*]}" >&2
  echo "  These are capability URLs and are deliberately not committed." >&2
  echo "  Put them in $here/urls.env (untracked) as VAR=\"https://...\" lines," >&2
  echo "  or export them. See README.md." >&2
  exit 1
fi

dataroom="$APRD_URL_DATAROOM"
hub="$APRD_URL_HUB"
engineering="$APRD_URL_ENGINEERING"
design="$APRD_URL_DESIGN"
marketing="$APRD_URL_MARKETING"
support="$APRD_URL_SUPPORT"

mkdir -p "$stage/views"
cp "$here/angel-cloud-aprd.html" "$here/aprd-views.html" "$stage/"
cp "$here/views/"*.html "$stage/views/"

# Rewrite every relative cross-link to its hosted URL. The bare forms are
# anchored on a leading double quote, so `"engineering.html` only matches a link
# that starts at the filename and can never fire inside `views/engineering.html`
# or `../angel-cloud-aprd.html`. That anchor is what keeps the prefixed and bare
# forms apart — keep it if you add a page.
rewrite() {
  LC_ALL=C sed \
    -e "s#views/engineering\.html#$engineering#g" \
    -e "s#views/design\.html#$design#g" \
    -e "s#views/marketing\.html#$marketing#g" \
    -e "s#views/support\.html#$support#g" \
    -e "s#\.\./angel-cloud-aprd\.html#$dataroom#g" \
    -e "s#\.\./aprd-views\.html#$hub#g" \
    -e "s#\"engineering\.html#\"$engineering#g" \
    -e "s#\"design\.html#\"$design#g" \
    -e "s#\"marketing\.html#\"$marketing#g" \
    -e "s#\"support\.html#\"$support#g" \
    -e "s#\"angel-cloud-aprd\.html#\"$dataroom#g" \
    -e "s#\"aprd-views\.html#\"$hub#g" \
    "$1" > "$1.hosted" && mv "$1.hosted" "$1"
}

for f in "$stage"/*.html "$stage"/views/*.html; do rewrite "$f"; done

# DRY_RUN=<dir> stages the rewritten pages there and uploads nothing, so the
# rewrite can be diffed against what is already live before anything ships.
if [[ -n "${DRY_RUN:-}" ]]; then
  mkdir -p "$DRY_RUN"
  target="$(cd "$DRY_RUN" && pwd)"
  # Staging into this directory would overwrite the committed pages with their
  # hosted rewrites, leaving absolute capability URLs in the working tree ready
  # to be committed. Refuse any target that is not empty.
  if [[ "$target" == "$here" || -n "$(ls -A "$target")" ]]; then
    echo "publish: DRY_RUN target must be an empty directory, not $target" >&2
    exit 1
  fi
  cp -R "$stage/." "$target/"
  echo "staged rewritten pages in $target (nothing uploaded)"
  exit 0
fi

# Uploading overwrites six live pages that people already hold links to, so it is
# opt-in. A reviewer ran this script to inspect it and published for real; the
# default is now to report and stop. The URLs are masked: the random segment is
# the read credential, and a bare run is exactly the run whose output ends up in
# a transcript or a pasted comment.
if [[ "${PUBLISH:-}" != "1" ]]; then
  echo "publish: would replace these six pages:" >&2
  for url in "$dataroom" "$hub" "$engineering" "$design" "$marketing" "$support"; do
    echo "  ${url%/*}/<redacted>" >&2
  done
  echo "Nothing was uploaded. Re-run with PUBLISH=1 to replace them," >&2
  echo "or DRY_RUN=<empty-dir> to write the rewritten pages to disk instead." >&2
  exit 0
fi

# Uploading needs files-blog-upload, which lives in the maintainer's dotfiles and
# not in this repository. Check it before the first upload rather than failing
# partway through the set; DRY_RUN and the report above never need it.
uploader="${FILES_BLOG_UPLOAD:-$HOME/Projects/dotfiles/scripts/files-blog-upload}"
if [[ ! -x "$uploader" ]]; then
  echo "publish: no uploader at $uploader" >&2
  echo "  These pages are hosted from the maintainer's dotfiles checkout. Set FILES_BLOG_UPLOAD" >&2
  echo "  to your own copy, or use DRY_RUN=<dir> to stage the rewritten pages only." >&2
  exit 1
fi

upload() {
  local file="$1" url="$2"
  printf '%-16s ' "$(basename "$file" .html)"
  "$uploader" "$file" --replace "$url"
}

upload "$stage/angel-cloud-aprd.html" "$dataroom"
upload "$stage/aprd-views.html"       "$hub"
upload "$stage/views/engineering.html" "$engineering"
upload "$stage/views/design.html"      "$design"
upload "$stage/views/marketing.html"   "$marketing"
upload "$stage/views/support.html"     "$support"

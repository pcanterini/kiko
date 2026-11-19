#!/bin/sh
# Copies install.sh to the website (a Cloudflare Worker serving public/), where
# `curl -fsSL https://kiko.sh | sh` fetches it. Copies only: deploying the site is its own step
# (its README). The website's checkout: KIKO_SITE, else ~/git/<slug>-site.
set -eu
cd "$(dirname "$0")/.."
SLUG=$(node -e 'import("./src/core/name.ts").then((m) => console.log(m.SLUG))')
SITE=${KIKO_SITE:-$HOME/git/$SLUG-site}
[ -n "$SITE" ] && [ -d "$SITE/public" ] || { echo "sync-site: no site checkout with a public/ folder (set KIKO_SITE)" >&2; exit 1; }
cp install.sh "$SITE/public/install.sh"
echo "Copied install.sh to $SITE/public/install.sh (not deployed)."

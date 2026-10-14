#!/usr/bin/env bash
# Rebuild ../audiom-integration.patch from an Audiom working tree that has the
# integration applied (branch feature/camio, uncommitted is fine), check that it
# applies to a clean export of the base commit, and copy the controller
# templates back next to this folder.
#
#   AUDIOM=../../../explore/Audiom-Front-End AUDIOM_BASE=origin/master bash regen.sh
#
# Read-only on the Audiom repo: `git diff`, `git archive`; nothing is checked
# out, staged or committed. The apply check runs in a temporary directory.
set -e
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "$0")" && pwd)"
AUDIOM="${AUDIOM:-$HERE/../../../explore/Audiom-Front-End}"
BASE="${AUDIOM_BASE:-origin/master}"
OUT="$HERE/../audiom-integration.patch"
. "$HERE/files.sh"
cd "$AUDIOM"
BASE_SHA="$(git rev-parse --short "$BASE")"
# Tracked files: diff the working tree against the base, EOL-normalised (Audiom's
# blobs are LF; Windows checkouts may be CRLF).
git -c core.autocrlf=true diff --no-color "$BASE" -- $CAMIO_UPSTREAM_FILES | sed 's/\r$//' > "$OUT"
for f in $CAMIO_NEW_FILES; do
	[ -f "$f" ] || { echo "missing new file: $f" >&2; exit 1; }
	git -c core.autocrlf=false diff --no-index --no-color /dev/null "$f" | sed 's/\r$//' >> "$OUT" || true
done
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git -c core.autocrlf=false archive "$BASE" $CAMIO_UPSTREAM_FILES | tar -x -C "$TMP"
(cd "$TMP" && git init -q && git -c core.autocrlf=false apply --check "$(cygpath -m "$OUT" 2>/dev/null || echo "$OUT")" && echo "patch applies cleanly to $BASE ($BASE_SHA)")
awk '/^diff --git/{f=$4} /^\+[^+]/{a[f]++} /^-[^-]/{d[f]++} /^\+$/{a[f]++} /^-$/{d[f]++} END{for(k in a) printf "%s +%d -%d\n", k, a[k], d[k]+0}' "$OUT" | sort
for f in createCamioController.ts createCamioController.test.ts; do
	cp "src/modules/tactile/camio/$f" "$HERE/../$f"
done

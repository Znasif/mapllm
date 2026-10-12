#!/usr/bin/env bash
set -e
export MSYS_NO_PATHCONV=1
SPD="$(cd "$(dirname "$0")" && pwd)"
cd "$SPD"
node make_patched.cjs >/dev/null
B="$SPD/../../node_modules/.bin/biome"
$B check --write patched/src >/dev/null 2>&1 || true
$B ci patched/src patched/documentation 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "Found|Checked"
OUT="$SPD/../audiom-integration.patch"
: > "$OUT"
for f in src/components/MapViewer/MapViewer.tsx src/stores/MapStateStore.ts src/modules/tactile/index.ts src/components/MapMenu/DotPadControls.tsx src/components/MapMenu/DisplayOptionsMenu.tsx public/locales/en/translation.json src/lib/build-embed-string.ts documentation/embedding.md; do
  git -c core.autocrlf=false diff --no-index --no-color "upstream/$f" "patched/$f" | sed "s#a/upstream/#a/#g; s#b/patched/#b/#g" >> "$OUT" || true
done
for f in src/modules/tactile/camio/createCamioPointer.ts src/modules/tactile/camio/createCamioPointer.test.ts; do
  git -c core.autocrlf=false diff --no-index --no-color /dev/null "patched/$f" | sed "s#a/patched/#a/#g; s#b/patched/#b/#g" >> "$OUT" || true
done
rm -rf applytest && mkdir applytest && cp -r upstream/. applytest/ && (cd applytest && git -c core.autocrlf=false apply --check "$(cygpath -m "$OUT" 2>/dev/null || echo "$OUT")" && echo "patch applies cleanly to origin/master copies")
awk '/^diff --git/{f=$4} /^\+[^+]/{a[f]++} /^-[^-]/{d[f]++} /^\+$/{a[f]++} /^-$/{d[f]++} END{for(k in a) printf "%s +%d -%d\n", k, a[k], d[k]+0}' "$OUT" | sort
cp patched/src/modules/tactile/camio/createCamioPointer.ts patched/src/modules/tactile/camio/createCamioPointer.test.ts "$SPD/../"

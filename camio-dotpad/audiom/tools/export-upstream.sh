#!/usr/bin/env bash
# Export the Audiom files the integration touches from origin/master (read-only:
# `git show`, no checkout) into ./upstream, next to make_patched.cjs. Then run
# regen.sh to rebuild ../audiom-integration.patch, verify it applies, run Biome.
#   AUDIOM=../../../explore/Audiom-Front-End bash export-upstream.sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
AUDIOM="${AUDIOM:-$HERE/../../../explore/Audiom-Front-End}"
export MSYS_NO_PATHCONV=1
cd "$AUDIOM"
for f in src/components/MapViewer/MapViewer.tsx src/stores/MapStateStore.ts src/modules/tactile/index.ts \
  src/components/MapMenu/DotPadControls.tsx src/components/MapMenu/DisplayOptionsMenu.tsx \
  public/locales/en/translation.json src/lib/build-embed-string.ts documentation/embedding.md biome.json .editorconfig; do
  mkdir -p "$HERE/upstream/$(dirname "$f")"
  git show "origin/master:$f" > "$HERE/upstream/$f"
done
cp "$HERE/upstream/biome.json" "$HERE/biome.json"
sed -i 's/"vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },/"vcs": { "enabled": false },/' "$HERE/biome.json"
cp "$HERE/upstream/.editorconfig" "$HERE/.editorconfig"
echo "exported to $HERE/upstream"

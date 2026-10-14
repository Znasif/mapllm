# The Audiom files the CamioPointer 0.2.0 integration changes (sourced by
# regen.sh). Paths are relative to the Audiom root. The vendored bundle
# (src/vendor/camio/) and the self-hosted assets (public/vendor/) are copied,
# not patched (AUDIOM_INTEGRATION.md §1).
CAMIO_LOCALES="de en es fr hi it ko nl pt-BR ru zh"
# Existing upstream files the patch edits.
CAMIO_UPSTREAM_FILES="src/components/MapViewer/MapViewer.tsx src/stores/MapStateStore.ts src/stores/MapStateStore.tactile.test.ts src/modules/tactile/index.ts src/components/MapMenu/DotPadControls.tsx src/components/MapMenu/DisplayOptionsMenu.tsx src/lib/build-embed-string.ts src/lib/build-embed-string.test.ts documentation/embedding.md"
for l in $CAMIO_LOCALES; do CAMIO_UPSTREAM_FILES="$CAMIO_UPSTREAM_FILES public/locales/$l/translation.json"; done
# New files the patch adds (the controller's templates: ../createCamioController.ts and .test.ts).
CAMIO_NEW_FILES="src/modules/tactile/camio/createCamioController.ts src/modules/tactile/camio/createCamioController.test.ts src/components/MapMenu/CameraPointerControls.tsx src/components/MapMenu/CameraPointerControls.test.tsx"

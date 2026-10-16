# Vendored CamioPointer

`CamioPointer-0.2.0.js` and `CamioPointer-0.2.0.d.ts` are byte copies of
`camio-pointer/dist/` (built by `camio-pointer/scripts/build.mjs`; that `dist/`
is git-ignored, so the starter must not import from `../camio-pointer`). Do not
edit them here: change `camio-pointer/src`, then refresh with

```
cd camio-pointer && npm run build
cp dist/CamioPointer-<version>.js dist/CamioPointer-<version>.d.ts ../starter/src/vendor/camio/
```

and update the import in `starter/src/CamioPointerPanel.jsx` if the version changed.
Used only by `CamioPointerPanel.jsx` (`audiom.html?pointer=camio`), lazy-loaded, and by
`src/lib/sheetOverlay.js` (its camera overlay; `applyH`, `invert3`) in the same chunk.

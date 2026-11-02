# libvoikko (vendored)

`libvoikko.min.js` is copied unchanged from the npm package `voikko@1.0.1`, file `build/libvoikko.min.js`
(sha256 `a0c383b882b1e639fb5ce5eea5d3d2b7f7b7d354a40d40b26c0b8930a226d984`).

- It contains libvoikko 4.3.2 compiled to WebAssembly with Emscripten, with the Voikko Finnish "morpho" dictionary
  (voikko-snapshot-v5) embedded.
- libvoikko is GPL-3.0 (see `COPYING`).
- Source code:
  - libvoikko: https://github.com/voikko/corevoikko/tree/rel-libvoikko-4.3.2/libvoikko
  - JS build scripts: https://github.com/Aattola/voikko-js
  - Dictionary: https://www.puimula.org/htp/testing/voikko-snapshot-v5/dict-morpho.zip

It is loaded only inside `morph-worker.js`.

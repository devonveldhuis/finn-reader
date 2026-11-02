// Classic Web Worker: runs Voikko (GPL-3.0, see vendor/voikko) off the main thread.
// Message in:  { id, words: string[] }
// Message out: { id, results: { [word]: Analysis[] } } or { id, error }
// libvoikko compiles its embedded wasm synchronously, which browsers only allow in a worker.

let voikko = null;

// Fields kept from Voikko's analysis. FSTOUTPUT/STRUCTURE are internal and dropped.
const KEEP = ['BASEFORM', 'CLASS', 'SIJAMUOTO', 'NUMBER', 'PERSON', 'MOOD', 'TENSE', 'NEGATIVE',
  'PARTICIPLE', 'POSSESSIVE', 'FOCUS', 'KYSYMYSLIITE', 'COMPARISON', 'WORDBASES'];

function analyze(word) {
  const seen = new Set();
  const out = [];
  for (const a of voikko.analyze(word)) {
    const r = {};
    for (const k of KEEP) if (a[k] !== undefined) r[k] = a[k];
    const key = JSON.stringify(r);
    // Voikko often repeats the same reading (e.g. "voi" → voida ×3); keep each once.
    if (!seen.has(key)) { seen.add(key); out.push(r); }
  }
  return out;
}

self.onmessage = (e) => {
  const { id, words } = e.data;
  try {
    if (!voikko) {
      importScripts('vendor/voikko/libvoikko.min.js');
      voikko = Libvoikko().init('fi');
    }
    const results = {};
    for (const w of words) results[w] = analyze(w);
    self.postMessage({ id, results });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};

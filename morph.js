// Morphological analysis of Finnish words via Voikko in a worker.
// The worker (and its ~7 MB bundle) loads only on first use; results are cached per surface form.

let worker = null;
let nextId = 1;
const waiting = new Map();
const cache = new Map(); // surface form → Analysis[]  ([] = Voikko doesn't know it)

function getWorker() {
  if (!worker) {
    worker = new Worker('morph-worker.js');
    worker.onmessage = (e) => {
      const { id, results, error } = e.data;
      const p = waiting.get(id);
      waiting.delete(id);
      if (error) p.reject(new Error(error));
      else p.resolve(results);
    };
  }
  return worker;
}

// Words: runs of letters, allowing inner hyphens/apostrophes (linja-auto, vaa'an).
const WORD = /\p{L}+(?:['’-]\p{L}+)*/gu;
export const tokenize = (text) => text.match(WORD) || [];

/** Analyze any words not yet cached. Resolves to the shared cache. */
export async function analyzeWords(words) {
  const todo = [...new Set(words)].filter(w => !cache.has(w));
  if (todo.length) {
    const id = nextId++;
    const results = await new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      getWorker().postMessage({ id, words: todo });
    });
    for (const [w, a] of Object.entries(results)) cache.set(w, a);
  }
  return cache;
}

/** Analyze every unique word in a parsed book (chapters → paras → lines). */
export function analyzeBook(book) {
  const words = new Set();
  for (const ch of book.chapters)
    for (const p of ch.paras)
      for (const l of p.lines) tokenize(l).forEach(w => words.add(w));
  const t0 = performance.now();
  return analyzeWords([...words]).then(c => {
    const unknown = [...words].filter(w => !c.get(w)?.length).length;
    console.info(`[morph] ${words.size} unique words analyzed in ${Math.round(performance.now() - t0)} ms, ${unknown} unknown to Voikko`);
    return c;
  });
}

export const getAnalyses = (word) => cache.get(word);

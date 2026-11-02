#!/usr/bin/env node
// Builds the lemma → English gloss dictionary served from dict/.
//
//   node scripts/build-dict.mjs [--limit 20000] [--freq full|50k] [--max-glosses 3] [--max-gloss-len 70] [--chunk-kb 512]
//
// --freq full (default) uses the complete frequency list (39 MB download); 50k is the top 50k word forms only.
// The 50k list yields at most ~12k lemmas; use full for larger limits.
//
// Sources (downloaded once into .cache/, which is not committed):
//   - Wiktionary via kaikki.org, Finnish entries with English glosses (CC BY-SA 4.0 / GFDL)
//   - hermitdave/FrequencyWords fi_50k / fi_full, from OpenSubtitles 2018 (CC BY-SA 4.0), used only to rank lemmas
//
// Frequency is per surface form, so each form is lemmatized with the vendored Voikko and its count is
// split across its distinct base forms. The --limit most frequent lemmas that have a Wiktionary entry are kept.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache');
const OUT = path.join(ROOT, 'dict');

const SOURCES = {
  kaikki: {
    url: 'https://kaikki.org/dictionary/Finnish/kaikki.org-dictionary-Finnish.jsonl.gz',
    file: 'kaikki-finnish.jsonl.gz',
  },
};
const freqSource = (name) => ({
  url: `https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/fi/fi_${name}.txt`,
  file: `fi_${name}.txt`,
});

const opts = { limit: 20000, freq: 'full', maxGlosses: 3, maxGlossLen: 70, chunkKb: 512 };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase());
  if (!(key in opts)) { console.error(`Unknown option ${process.argv[i]}`); process.exit(1); }
  opts[key] = typeof opts[key] === 'number' ? Number(process.argv[i + 1]) : process.argv[i + 1];
}

// Parts of speech that aren't useful as reading glosses.
const SKIP_POS = new Set(['character', 'symbol', 'prefix', 'suffix', 'infix', 'interfix', 'affix', 'punct', 'phrase', 'proverb']);
// Senses with these tags are dropped when the entry has any other sense.
const MINOR_TAGS = new Set(['obsolete', 'archaic', 'dialectal', 'rare', 'nonstandard', 'dated']);

async function download({ url, file }) {
  const dest = path.join(CACHE, file);
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(CACHE, { recursive: true });
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest + '.part'));
  fs.renameSync(dest + '.part', dest);
  return dest;
}

function lemmaFrequencies(freqFile) {
  const require = createRequire(import.meta.url);
  const voikko = require(path.join(ROOT, 'vendor/voikko/libvoikko.min.js'))().init('fi');
  const freq = new Map();
  const add = (lemma, n) => freq.set(lemma, (freq.get(lemma) || 0) + n);
  const lines = fs.readFileSync(freqFile, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (i % 100000 === 0 && lines.length > 100000) process.stdout.write(`\r  ${i.toLocaleString()} / ${lines.length.toLocaleString()} word forms…`);
    const [word, count] = line.trim().split(' ');
    // Singletons in the full list are mostly typos and OCR noise.
    if (!word || !/^\p{L}/u.test(word) || +count < 2) return;
    const lemmas = [...new Set(voikko.analyze(word).map(a => a.BASEFORM).filter(Boolean))];
    // Unknown to Voikko (slang, loanwords): count the surface form itself.
    if (!lemmas.length) add(word, +count);
    else lemmas.forEach(l => add(l, +count / lemmas.length));
  });
  if (lines.length > 100000) process.stdout.write('\n');
  voikko.terminate?.();
  return freq;
}

function cleanGloss(g) {
  g = g.replace(/\s+/g, ' ').replace(/\.$/, '').trim();
  // Long bracketed explanations ("street (paved part of road in a village…)") crowd out the meaning;
  // short ones like "(of a phone or bell)" stay.
  const stripped = g.replace(/\s*\([^()]{26,}\)/g, '').trim();
  if (stripped) g = stripped;
  if (g.length <= opts.maxGlossLen) return g;
  const cut = g.slice(0, opts.maxGlossLen);
  return cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : cut.length) + '…';
}

function sensesToGlosses(senses) {
  const isFormOf = s => s.form_of || (s.tags || []).includes('form-of');
  let usable = senses.filter(s => !isFormOf(s) && (s.glosses?.length || s.alt_of));
  // Words Voikko treats as base forms but Wiktionary lists only as "form of" (participles like
  // "ollut", plural pronouns like "nämä") keep that gloss, e.g. "past active participle of olla".
  const formOnly = !usable.length;
  if (formOnly) usable = senses.filter(s => s.glosses?.length);
  const major = usable.filter(s => !(s.tags || []).some(t => MINOR_TAGS.has(t)));
  const out = [];
  for (const s of (major.length ? major : usable)) {
    // Nested senses list parent glosses first; the last one is the specific meaning. For inflected
    // forms the parent holds the base word ("inflection of suoda:"), so add it back if missing.
    let g = s.alt_of ? `variant of ${s.alt_of[0].word}` : s.glosses.at(-1);
    const base = s.form_of?.[0]?.word;
    if (base && !g.includes(base)) g = `${g} of ${base}`;
    const c = cleanGloss(g);
    if (c && !out.includes(c)) out.push(c);
  }
  return { glosses: out, formOnly };
}

async function readKaikki(file, wanted) {
  const entries = new Map(); // lemma → { pos → { glosses[], formOnly } }
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    if (++n % 200000 === 0) process.stdout.write(`\r  ${n.toLocaleString()} entries scanned…`);
    // Cheap pre-filter before JSON.parse: most of the 4.7 GB are entries we don't want.
    // Nested objects (synonyms, derived terms…) also have "word" keys, so check every occurrence.
    let hit = false;
    for (const m of line.matchAll(/"word": ?"((?:[^"\\]|\\.)*)"/g)) {
      if (wanted.has(JSON.parse(`"${m[1]}"`))) { hit = true; break; }
    }
    if (!hit) continue;
    const e = JSON.parse(line);
    if (e.lang_code !== 'fi' || SKIP_POS.has(e.pos)) continue;
    const { glosses, formOnly } = sensesToGlosses(e.senses || []);
    if (!glosses.length) continue;
    const byPos = entries.get(e.word) || {};
    const prev = byPos[e.pos];
    byPos[e.pos] = {
      glosses: [...new Set([...(prev?.glosses || []), ...glosses])],
      formOnly: (prev?.formOnly ?? true) && formOnly,
    };
    entries.set(e.word, byPos);
  }
  process.stdout.write(`\r  ${n.toLocaleString()} entries scanned.          \n`);
  return entries;
}

function writeOutput(dict, meta) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const json = JSON.stringify(dict);
  const files = {};
  if (json.length <= opts.chunkKb * 1024) {
    fs.writeFileSync(path.join(OUT, 'fi-en.json'), json);
    files['*'] = 'fi-en.json';
  } else {
    // Chunk by lowercase first letter so a lookup fetches one small file. File names stay ASCII.
    const chunks = {};
    const ascii = { 'ä': 'ae', 'ö': 'oe', 'å': 'ao' };
    for (const [k, v] of Object.entries(dict)) {
      const c = k[0].toLowerCase();
      const key = /^[a-z]$/.test(c) ? c : ascii[c] || '_';
      (chunks[key] ||= {})[k] = v;
    }
    for (const [c, part] of Object.entries(chunks)) {
      files[c] = `fi-en.${c}.json`;
      fs.writeFileSync(path.join(OUT, files[c]), JSON.stringify(part));
    }
  }
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ ...meta, files }, null, 2));
  return json.length;
}

const t0 = Date.now();
const FREQ = freqSource(opts.freq);
const [kaikkiFile, freqFile] = await Promise.all([download(SOURCES.kaikki), download(FREQ)]);

console.log('Lemmatizing frequency list with Voikko…');
const freq = lemmaFrequencies(freqFile);
// Read entries for more lemmas than the limit, since some frequent lemmas have no Wiktionary entry.
const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
const wanted = new Set(ranked.slice(0, opts.limit * 3));
console.log(`  ${freq.size.toLocaleString()} lemmas; reading Wiktionary entries for the top ${wanted.size.toLocaleString()}`);

console.log('Reading kaikki.org extract…');
const entries = await readKaikki(kaikkiFile, wanted);

const dict = {};
let rank = 0;
const missing = [];
for (const lemma of ranked) {
  if (rank >= opts.limit) break;
  if (!wanted.has(lemma)) break;
  const byPos = entries.get(lemma);
  if (!byPos) { if (missing.length < 40) missing.push(lemma); continue; }
  rank++;
  // "Form of" readings (suomi as a form of suoda) only add noise when the word has a meaning of its own;
  // Voikko already yields the other base form as a separate reading.
  let groups = Object.entries(byPos);
  if (groups.some(([, g]) => !g.formOnly)) groups = groups.filter(([, g]) => !g.formOnly);
  // Leading number = frequency rank (1 = most common), used at lookup time to order ambiguous readings.
  dict[lemma] = [rank, ...groups.map(([pos, g]) => [pos, g.glosses.slice(0, opts.maxGlosses)])];
}

const bytes = writeOutput(dict, {
  format: 2,
  built: new Date().toISOString(),
  count: Object.keys(dict).length,
  options: opts,
  // Entry shape: lemma → [frequencyRank, [partOfSpeech, [gloss, …]], …]
  attribution: {
    text: 'Definitions from Wiktionary (https://en.wiktionary.org), extracted by kaikki.org / Wiktextract. ' +
      'Licensed CC BY-SA 4.0 and GFDL. Word frequency ranking from hermitdave/FrequencyWords (OpenSubtitles 2018), CC BY-SA 4.0.',
    license: 'CC BY-SA 4.0',
    sources: [SOURCES.kaikki.url, FREQ.url],
  },
});

console.log(`Wrote ${Object.keys(dict).length} lemmas, ${(bytes / 1024).toFixed(0)} KB, to dict/ in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
console.log(`Frequent lemmas with no Wiktionary entry (first ${missing.length}): ${missing.join(', ')}`);

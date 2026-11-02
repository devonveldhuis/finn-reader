// Local word lookup: Voikko analyses (morph.js) → base forms → Wiktionary glosses (dict/).
// Returns readings ranked most-likely first; callers fall back to Google Translate when none are found.

import * as morph from './morph.js';

/* ---------------- Dictionary loading ---------------- */

let manifestP = null;
const chunks = new Map(); // file → Promise<object>
const ASCII = { 'ä': 'ae', 'ö': 'oe', 'å': 'ao' };

function manifest() {
  return (manifestP ||= fetch('dict/manifest.json').then(r => {
    if (!r.ok) throw new Error('Dictionary not found (dict/manifest.json). Run scripts/build-dict.mjs.');
    return r.json();
  }));
}

async function dictGet(lemma) {
  const m = await manifest();
  for (const key of [lemma, lemma.toLowerCase()]) {
    const c = key[0].toLowerCase();
    const file = m.files['*'] || m.files[/^[a-z]$/.test(c) ? c : ASCII[c] || '_'];
    if (!file) continue;
    if (!chunks.has(file)) chunks.set(file, fetch('dict/' + file).then(r => r.json()));
    const entry = (await chunks.get(file))[key];
    // Entry: [rank, [pos, glosses]…]. The rank rides along on the senses array.
    if (entry) return Object.assign(entry.slice(1), { rank: entry[0] });
  }
  return null;
}

export async function attribution() {
  return (await manifest()).attribution;
}

/* ---------------- Learner-friendly grammar labels ---------------- */

const CASES = {
  nimento: ['nominative', 'basic form'],
  omanto: ['genitive', "'s, of"],
  osanto: ['partitive', 'some, part of; after numbers'],
  sisaolento: ['inessive', 'in'],
  sisaeronto: ['elative', 'out of, from, about'],
  sisatulento: ['illative', 'into'],
  ulkoolento: ['adessive', 'on, at; has'],
  ulkoeronto: ['ablative', 'off, from'],
  ulkotulento: ['allative', 'onto, to'],
  olento: ['essive', 'as'],
  tulento: ['translative', 'becoming, into a state'],
  vajanto: ['abessive', 'without'],
  seuranto: ['comitative', 'together with'],
  keinonto: ['instructive', 'by means of'],
  kerrontosti: ['adverb form', '-ly'],
};
const POSSESSIVE = { '1s': 'my', '2s': 'your', '1p': 'our', '2p': 'your (pl.)', '3': 'his/her/their' };
const FOCUS = { kin: '-kin: also, even', kaan: '-kaan: not even, either' };
const PERSONS = {
  '1singular': 'I', '2singular': 'you', '3singular': 'he/she/it',
  '1plural': 'we', '2plural': 'you (pl.)', '3plural': 'they', '4': 'passive (one, people)',
};
const MOODS = { conditional: 'conditional: would', imperative: 'command', potential: 'potential: probably' };
const TENSES = { present_simple: 'present', past_imperfective: 'past' };
const PARTICIPLES = {
  present_active: 'present participle (-va: …ing, who …s)',
  present_passive: 'passive participle (-tava: to be …ed)',
  past_active: 'past participle (-nut: has …ed)',
  past_passive: 'past passive participle (-tu: …ed)',
  agent: 'agent participle (-ma: …ed by)',
  negation: 'negative participle (-maton: un…ed, without)',
};
const INFINITIVES = {
  'A-infinitive': 'basic form (to …)',
  'E-infinitive': 'E-infinitive (while …ing)',
  'MA-infinitive': 'MA-infinitive',
  'MINEN-infinitive': '-minen noun (the act of …ing)',
  'MAINEN-infinitive': '-mainen form',
};
const MA_CASES = {
  sisatulento: 'going to …, in order to …', sisaolento: 'in the middle of …ing',
  sisaeronto: 'from …ing', ulkoolento: 'by …ing', vajanto: 'without …ing',
};
const NEGATIONS = /^(ei|en|et|emme|ette|eivät|älä|älkää|älköön)$/i;

// Voikko word class → Wiktionary part of speech, used to pick the matching dictionary sense.
const CLASS_POS = {
  nimisana: ['noun'], laatusana: ['adj'], nimisana_laatusana: ['noun', 'adj'], teonsana: ['verb'],
  seikkasana: ['adv'], asemosana: ['pron', 'det'], lukusana: ['num'], sidesana: ['conj'],
  suhdesana: ['postp', 'prep', 'adv'], huudahdussana: ['intj'], kieltosana: ['verb'],
  etunimi: ['name'], sukunimi: ['name'], paikannimi: ['name'], nimi: ['name'],
};
const NAME_CLASSES = new Set(['etunimi', 'sukunimi', 'paikannimi', 'nimi']);
const CLASS_LABEL = {
  nimisana: 'noun', laatusana: 'adjective', nimisana_laatusana: 'adjective', teonsana: 'verb',
  seikkasana: 'adverb', asemosana: 'pronoun', lukusana: 'number', sidesana: 'conjunction',
  suhdesana: 'postposition', huudahdussana: 'interjection', kieltosana: 'negation verb',
  etunimi: 'first name', sukunimi: 'surname', paikannimi: 'place name', nimi: 'name', lyhenne: 'abbreviation',
};

/** Short grammar description of one Voikko analysis, e.g. "adessive · on, at; has". */
export function grammarHint(a, prevWord = '') {
  const bits = [];
  const afterNeg = NEGATIONS.test(prevWord);
  if (a.CLASS === 'teonsana' || a.CLASS === 'kieltosana' || a.MOOD || a.PARTICIPLE) {
    if (a.PARTICIPLE) {
      // "ei soinut" = didn't ring: Voikko reads "soinut" as a participle.
      if (afterNeg && a.PARTICIPLE === 'past_active') bits.push('negative past (with ei): didn’t …');
      else if (afterNeg && a.PARTICIPLE === 'past_passive') bits.push('negative past passive (with ei)');
      else bits.push(PARTICIPLES[a.PARTICIPLE] || a.PARTICIPLE);
    } else if (afterNeg && a.MOOD === 'imperative' && a.PERSON === '2' && a.NUMBER === 'singular') {
      // "ei ehdi" = doesn't make it: the negative form looks like a 2nd person command.
      bits.push('negative present (with ei): doesn’t …');
    } else if (INFINITIVES[a.MOOD]) {
      bits.push(INFINITIVES[a.MOOD]);
      if (a.MOOD === 'MA-infinitive' && MA_CASES[a.SIJAMUOTO]) bits.push(MA_CASES[a.SIJAMUOTO]);
    } else {
      const who = PERSONS[a.PERSON === '4' ? '4' : `${a.PERSON}${a.NUMBER}`];
      if (who) bits.push(who);
      if (MOODS[a.MOOD]) bits.push(MOODS[a.MOOD]);
      if (TENSES[a.TENSE] && a.MOOD === 'indicative') bits.push(TENSES[a.TENSE]);
    }
  }
  if (a.SIJAMUOTO && !a.MOOD?.endsWith('infinitive') && !(a.SIJAMUOTO === 'nimento' && !a.PARTICIPLE && a.NUMBER !== 'plural')) {
    const [name, hint] = CASES[a.SIJAMUOTO] || [a.SIJAMUOTO, ''];
    if (a.SIJAMUOTO !== 'nimento') bits.push(hint ? `${name}: ${hint}` : name);
  }
  if (a.NUMBER === 'plural' && a.SIJAMUOTO) bits.push('plural');
  if (POSSESSIVE[a.POSSESSIVE]) bits.push(POSSESSIVE[a.POSSESSIVE]);
  if (a.COMPARISON === 'comparative') bits.push('comparative: more, -er');
  if (a.COMPARISON === 'superlative') bits.push('superlative: most, -est');
  if (FOCUS[a.FOCUS]) bits.push(FOCUS[a.FOCUS]);
  if (a.KYSYMYSLIITE === 'true') bits.push('-ko/-kö: question');
  return bits.join(' · ');
}

/* ---------------- Lookup ---------------- */

// "+bussi(bussi)+pysäkki(pysäkki)" → ["bussi", "pysäkki"]; "+soi(soida)+n+ut(+ut)" → ["soida"].
function wordBases(a) {
  const out = [];
  for (const m of (a.WORDBASES || '').matchAll(/\+([^+(]*)(?:\(([^)]*)\))?/g)) {
    const base = m[2] ?? m[1];
    if (base && !base.startsWith('+') && /\p{L}{2,}/u.test(base)) out.push(base);
  }
  return out;
}

function pickSenses(entry, cls) {
  if (!entry) return null;
  const want = CLASS_POS[cls];
  const match = want ? entry.filter(([pos]) => want.includes(pos)) : [];
  return match.length ? Object.assign(match, { rank: entry.rank }) : entry;
}

/**
 * Look up one word as it appears in the text.
 * Returns { word, known: bool, readings: [{ lemma, label, senses, hint, compound?, source? }] }.
 * senses: [[pos, [gloss…]]…]; compound: [{ lemma, senses }]; source: { lemma, senses } for participles/derivations.
 */
export async function lookupWord(word, prevWord = '') {
  const analyses = (await morph.analyzeWords([word])).get(word) || [];
  const groups = new Map();
  for (const a of analyses) {
    const lemma = a.BASEFORM || word;
    const key = `${lemma}|${a.PARTICIPLE ? 'participle' : CLASS_LABEL[a.CLASS] || a.CLASS}`;
    const hint = grammarHint(a, prevWord);
    if (groups.has(key)) {
      const g = groups.get(key);
      if (hint && !g.hints.includes(hint)) g.hints.push(hint);
      continue;
    }
    const senses = pickSenses(await dictGet(lemma), a.CLASS);
    const label = a.PARTICIPLE ? 'participle' : CLASS_LABEL[a.CLASS] || '';
    const r = { lemma, cls: a.CLASS, label, senses, hints: hint ? [hint] : [], possessive: !!a.POSSESSIVE };
    const parts = wordBases(a);
    if (parts.length > 1 && (!senses || parts.length === 2)) {
      // Compound: show parts too (always for two-part words, it helps memory; required when there's no entry).
      const comp = await Promise.all(parts.map(async p => ({ lemma: p, senses: await dictGet(p) })));
      if (comp.some(c => c.senses)) r.compound = comp;
    } else if (parts.length === 1 && parts[0] !== lemma && (!senses || a.PARTICIPLE)) {
      // Participle or derivation: "soinut" → soida.
      const src = await dictGet(parts[0]);
      if (src) r.source = { lemma: parts[0], senses: pickSenses(src, 'teonsana') };
    }
    groups.set(key, r);
  }

  const capitalized = /^\p{Lu}/u.test(word);
  const score = r =>
    (r.senses ? 4 : 0) + (r.source ? 3 : 0) + (r.compound ? 2 : 0) +
    (NAME_CLASSES.has(r.cls) ? (capitalized ? -1 : -4) : 0) +
    // Voikko over-generates possessive readings for words ending in -si/-nsa (kuusi → "your moon").
    (r.possessive ? -1.5 : 0) +
    (/^\p{Lu}/u.test(r.lemma) && !capitalized ? -3 : 0) +
    // Tie-break by frequency: jaloille is far more often jalka "leg" than jalo "noble".
    (r.senses?.rank ? 1 - r.senses.rank / 100000 : 0);
  let readings = [...groups.values()].sort((a, b) => score(b) - score(a));
  const found = readings.filter(r => r.senses || r.source || r.compound);
  if (found.length) readings = found;
  return { word, known: found.length > 0, readings: readings.slice(0, 4) };
}

/** One-line summary for lists: "katu 'street' · adessive: on, at; has". */
export async function shortGloss(text, prevWord = '') {
  const words = morph.tokenize(text);
  if (words.length !== 1) return null;
  const { known, readings } = await lookupWord(words[0], prevWord);
  if (!known) return null;
  const r = readings[0];
  const gloss = r.senses?.[0]?.[1]?.[0] ||
    (r.source && `${r.source.lemma} '${r.source.senses?.[0]?.[1]?.[0]}'`) ||
    r.compound?.map(c => `${c.lemma} '${c.senses?.[0]?.[1]?.[0] || '?'}'`).join(' + ');
  return { lemma: r.lemma, gloss, hint: r.hints[0] || '' };
}

export const tokenize = morph.tokenize;

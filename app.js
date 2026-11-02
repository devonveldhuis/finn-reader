import { parseFile } from './parsers.js';
import * as db from './db.js';
import * as morph from './morph.js';
import * as lookup from './lookup.js';

const app = document.getElementById('app');
const topnav = document.getElementById('topnav');
const selpop = document.getElementById('selpop');
const hlpop = document.getElementById('hlpop');

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content; };
const uid = () => Math.random().toString(36).slice(2, 10);
const fmtDate = t => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const translateUrl = s => `https://translate.google.com/?sl=fi&tl=en&op=translate&text=${encodeURIComponent(s)}`;
const pref = (k, v) => {
  try {
    if (v === undefined) return localStorage.getItem('lukija.' + k);
    localStorage.setItem('lukija.' + k, v);
  } catch { return null; }
};

const RATINGS = [
  { v: 1, label: 'Lost', desc: 'I had no idea' },
  { v: 2, label: 'Fragments', desc: 'A few bits were right' },
  { v: 3, label: 'The gist', desc: 'Main events right, details off' },
  { v: 4, label: 'Nailed it', desc: 'Very close to the text' },
];

let cache = { book: null, progress: null };
async function load(bookId) {
  if (cache.book?.id !== bookId) {
    cache.book = await db.getBook(bookId);
    cache.progress = await db.getProgress(bookId);
    // Warm the morphology cache in the background; the reader doesn't wait for it.
    if (cache.book) cache.morph = morph.analyzeBook(cache.book).catch(e => console.error('[morph]', e));
  }
  return cache;
}
const save = () => db.putProgress(cache.progress);
const chState = (ch) => (cache.progress.chapters[ch] ||= { reads: 0, attempts: [] });
const chText = (ch) => cache.book.chapters[ch].paras.map(p => p.lines.join('\n')).join('\n\n');

/* ---------------- Router ---------------- */

async function route() {
  hidePops();
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  window.scrollTo(0, 0);
  try {
    if (parts[0] === 'b' && parts[1]) {
      await load(parts[1]);
      if (!cache.book) return (location.hash = '#/');
      if (parts[2] === 'words') return renderWords();
      const ch = Math.min(+parts[2] || 0, cache.book.chapters.length - 1);
      if (parts[3] === 'recall') return renderRecall(ch);
      if (parts[3] === 'compare') return renderCompare(ch);
      if (parts[3] === 'morph') return renderMorphDebug(ch);
      return renderReader(ch);
    }
    if (parts[0] === 'settings') return renderSettings();
    return renderLibrary();
  } catch (e) {
    console.error(e);
    app.replaceChildren(h(`<div class="wrap"><p class="error">Something went wrong: ${esc(e.message)}</p></div>`));
  }
}
window.addEventListener('hashchange', route);

function setNav(html) { topnav.innerHTML = html + `<a href="#/settings" title="Settings">Settings</a>`; }

/* ---------------- Library ---------------- */

async function renderLibrary() {
  setNav('');
  const books = (await db.getBooks()).sort((a, b) => b.addedAt - a.addedAt);
  const progress = await Promise.all(books.map(b => db.getProgress(b.id)));
  app.replaceChildren(h(`
    <div class="wrap">
      <section class="intro">
        <h1>Read through. Don't stop. Translate later.</h1>
        <p>Read each chapter end to end and work out the meaning from context. If a word or phrase stops you, select it and
        <b>mark it for later</b>, then keep reading. At the end, write down what you think happened and compare it with the text.</p>
      </section>
      <label class="drop" id="drop">
        <input type="file" accept=".pdf,.epub,.txt,.md,.lcpl" id="file" hidden>
        <strong>Drop a PDF, EPUB or TXT here</strong>
        <span>or click to choose a file · stored only in this browser</span>
      </label>
      <p id="status" class="muted"></p>
      <div class="books">
        ${books.map((b, i) => {
          const p = progress[i];
          const done = Object.values(p.chapters).filter(c => c.attempts?.length).length;
          return `
          <article class="book">
            <a href="#/b/${b.id}/${p.last || 0}" class="book-main">
              <h3>${esc(b.title)}</h3>
              <p class="muted">${b.chapters.length} chapters · ${b.fileName ? esc(b.fileName) : ''}</p>
              <div class="bar"><i style="width:${(done / b.chapters.length) * 100}%"></i></div>
              <p class="muted small">${done}/${b.chapters.length} recalled · ${p.highlights.length} marked</p>
            </a>
            <div class="book-actions">
              <a href="#/b/${b.id}/${p.last || 0}" class="btn primary">${p.last ? 'Continue' : 'Start reading'}</a>
              <a href="#/b/${b.id}/words" class="btn">Marked words</a>
              <button class="btn ghost" data-del="${b.id}">Delete</button>
            </div>
          </article>`;
        }).join('')}
      </div>
    </div>`));

  const input = app.querySelector('#file');
  const drop = app.querySelector('#drop');
  const status = app.querySelector('#status');
  const handle = async (file) => {
    if (!file) return;
    status.textContent = `Reading ${file.name}…`;
    try {
      const parsed = await parseFile(file);
      const book = { id: uid(), fileName: file.name, addedAt: Date.now(), ...parsed };
      await db.putBook(book);
      location.hash = `#/b/${book.id}/0`;
    } catch (e) {
      console.error(e);
      status.innerHTML = `<span class="error">${esc(e.message)}</span>`;
    }
  };
  input.onchange = () => handle(input.files[0]);
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); handle(e.dataTransfer.files[0]); };
  app.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this book and all its marks and recalls?')) return;
    await db.deleteBook(b.dataset.del);
    cache = { book: null, progress: null };
    renderLibrary();
  });
}

/* ---------------- Text rendering with marks ---------------- */

function paraHtml(text, marks, interactive = true) {
  const ms = marks.slice().sort((a, b) => a.start - b.start);
  let out = '', pos = 0;
  for (const m of ms) {
    if (m.start < pos) continue;
    out += esc(text.slice(pos, m.start));
    out += `<mark data-hid="${m.id}"${interactive ? ' tabindex="0"' : ''}>${esc(text.slice(m.start, m.end))}</mark>`;
    pos = m.end;
  }
  return out + esc(text.slice(pos));
}

function chapterHtml(ch, { showMarks = true, interactive = true } = {}) {
  const marks = showMarks ? cache.progress.highlights.filter(m => m.ch === ch) : [];
  return cache.book.chapters[ch].paras.map((p, pi) => {
    const text = p.lines.join('\n');
    const inner = paraHtml(text, marks.filter(m => m.para === pi), interactive);
    return p.kind === 'h'
      ? `<h3 class="para" data-pi="${pi}">${inner}</h3>`
      : `<p class="para" data-pi="${pi}">${inner}</p>`;
  }).join('');
}

/* ---------------- Reader ---------------- */

function chapterList(current) {
  return cache.book.chapters.map((c, i) => {
    const st = cache.progress.chapters[i];
    const n = cache.progress.highlights.filter(m => m.ch === i).length;
    return `<a href="#/b/${cache.book.id}/${i}" class="${i === current ? 'active' : ''}">
      <span>${esc(c.title)}</span>
      <span class="badges">${st?.reads ? `<em title="Times read and recalled">${st.reads}×</em>` : ''}${n ? `<b title="Marked">${n}</b>` : ''}</span>
    </a>`;
  }).join('');
}

function renderReader(ch) {
  const { book, progress } = cache;
  progress.last = ch; save();
  const st = chState(ch);
  const showMarks = pref('showMarks') !== '0';
  setNav(`<a href="#/">Library</a><a href="#/b/${book.id}/words">Marked words</a>`);
  const total = book.chapters.length;

  app.replaceChildren(h(`
    <div class="reader">
      <aside class="toc">
        <h4>${esc(book.title)}</h4>
        <nav>${chapterList(ch)}</nav>
        <p class="small"><a href="#/b/${book.id}/${ch}/morph" class="muted">Word analyses (debug)</a></p>
      </aside>
      <article class="page">
        <div class="page-head">
          <span class="chip">Chapter ${ch + 1} of ${total}</span>
          <span class="chip">${st.reads ? `Read ${st.reads}× · now pass ${st.reads + 1}` : 'First read'}</span>
          <label class="toggle"><input type="checkbox" id="showMarks" ${showMarks ? 'checked' : ''}> Show marks</label>
        </div>
        <h2>${esc(book.chapters[ch].title)}</h2>
        <div class="hint" id="hint">Keep going even when you don't understand. Select a word or phrase to mark it for later.</div>
        <div class="text" id="text">${chapterHtml(ch, { showMarks })}</div>
        <div class="endcard">
          <p><b>Finished?</b> Before you look anything up, write down what you think happened.</p>
          <div class="row">
            <a class="btn primary" href="#/b/${book.id}/${ch}/recall">What happened? →</a>
            ${st.attempts.length ? `<a class="btn" href="#/b/${book.id}/${ch}/compare">See past recalls</a>` : ''}
          </div>
        </div>
        <div class="pager">
          ${ch > 0 ? `<a href="#/b/${book.id}/${ch - 1}">← ${esc(book.chapters[ch - 1].title)}</a>` : '<span></span>'}
          ${ch < total - 1 ? `<a href="#/b/${book.id}/${ch + 1}">${esc(book.chapters[ch + 1].title)} →</a>` : '<span></span>'}
        </div>
      </article>
    </div>`));

  if (pref('hintSeen')) app.querySelector('#hint').remove();
  app.querySelector('#showMarks').onchange = e => { pref('showMarks', e.target.checked ? '1' : '0'); renderReader(ch); };
  bindMarking(app.querySelector('#text'), ch, () => renderReaderText(ch));
}

function renderReaderText(ch) {
  const el = document.querySelector('#text');
  if (el) el.innerHTML = chapterHtml(ch, { showMarks: pref('showMarks') !== '0' });
  const toc = document.querySelector('.toc nav');
  if (toc) toc.innerHTML = chapterList(ch);
}

/* ---- Selection → marks ---- */

let pending = null; // { ch, text: el, onChange }

function offsetIn(paraEl, node, off) {
  const r = document.createRange();
  r.setStart(paraEl, 0);
  r.setEnd(node, off);
  return r.toString().length;
}

function selectionMarks() {
  const sel = window.getSelection();
  if (!pending || !sel.rangeCount || sel.isCollapsed) return [];
  const range = sel.getRangeAt(0);
  if (!pending.el.contains(range.commonAncestorContainer)) return [];
  const out = [];
  pending.el.querySelectorAll('.para').forEach(pEl => {
    if (!range.intersectsNode(pEl)) return;
    const pi = +pEl.dataset.pi;
    const text = cache.book.chapters[pending.ch].paras[pi].lines.join('\n');
    let start = pEl.contains(range.startContainer) ? offsetIn(pEl, range.startContainer, range.startOffset) : 0;
    let end = pEl.contains(range.endContainer) ? offsetIn(pEl, range.endContainer, range.endOffset) : text.length;
    // Snap to whole words.
    while (start > 0 && /[\p{L}\p{N}'’-]/u.test(text[start - 1])) start--;
    while (end < text.length && /[\p{L}\p{N}'’-]/u.test(text[end])) end++;
    while (start < end && /\s|[.,!?:;–—"”“]/.test(text[start])) start++;
    while (end > start && /\s|[.,!?:;–—"”“]/.test(text[end - 1])) end--;
    if (end > start) out.push({ para: pi, start, end, text: text.slice(start, end) });
  });
  return out;
}

function addMarks() {
  const ms = selectionMarks();
  if (!ms.length) return;
  for (const m of ms) {
    const hl = cache.progress.highlights;
    // Merge with any overlapping mark in the same paragraph.
    const overlapping = hl.filter(x => x.ch === pending.ch && x.para === m.para && x.start < m.end && x.end > m.start);
    let { start, end } = m;
    let note = '';
    overlapping.forEach(x => { start = Math.min(start, x.start); end = Math.max(end, x.end); note ||= x.note; });
    cache.progress.highlights = hl.filter(x => !overlapping.includes(x));
    const text = cache.book.chapters[pending.ch].paras[m.para].lines.join('\n');
    cache.progress.highlights.push({
      id: uid(), ch: pending.ch, para: m.para, start, end,
      text: text.slice(start, end).replace(/\n/g, ' '), note, createdAt: Date.now(),
    });
  }
  pref('hintSeen', '1');
  save();
  window.getSelection().removeAllRanges();
  hidePops();
  pending.onChange();
}

function bindMarking(el, ch, onChange, { wordLookup = false } = {}) {
  pending = { el, ch, onChange };
  el.addEventListener('click', e => {
    if (!window.getSelection().isCollapsed) return;
    const m = e.target.closest('mark');
    if (m) {
      const hl = cache.progress.highlights.find(x => x.id === m.dataset.hid);
      if (hl) openLookup({ ch, para: hl.para, start: hl.start, end: hl.end, hid: hl.id, rect: m.getBoundingClientRect() });
      return;
    }
    // On the compare page any word can be looked up; in the reader only marks can, to keep reading flowing.
    const w = wordLookup && wordAtPoint(e.clientX, e.clientY);
    if (w) openLookup({ ch, ...w });
    else hlpop.hidden = true;
  });
}

// The word under the pointer as { para, start, end, rect }, using paragraph-level offsets.
function wordAtPoint(x, y) {
  let node, off;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y); node = p?.offsetNode; off = p?.offset;
  } else {
    const r = document.caretRangeFromPoint?.(x, y); node = r?.startContainer; off = r?.startOffset;
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const pEl = node.parentElement.closest('.para');
  if (!pEl) return null;
  for (const m of node.data.matchAll(/\p{L}+(?:['’-]\p{L}+)*/gu)) {
    if (off < m.index || off > m.index + m[0].length) continue;
    const r = document.createRange();
    r.setStart(node, m.index); r.setEnd(node, m.index + m[0].length);
    // caretFromPoint snaps to the nearest character, so make sure the pointer is really over the word.
    const rect = r.getBoundingClientRect();
    if (x < rect.left - 2 || x > rect.right + 2 || y < rect.top - 2 || y > rect.bottom + 2) return null;
    const start = offsetIn(pEl, node, m.index);
    return { para: +pEl.dataset.pi, start, end: start + m[0].length, rect };
  }
  return null;
}

let lookupSeq = 0;
async function openLookup({ ch, para, start, end, hid, rect }) {
  const paraText = cache.book.chapters[ch].paras[para].lines.join('\n');
  const text = paraText.slice(start, end).replace(/\n/g, ' ');
  const prevWord = lookup.tokenize(paraText.slice(0, start)).at(-1) || '';
  const seq = ++lookupSeq;
  hlpop.dataset.hid = hid || '';
  hlpop._target = { ch, para, start, end };
  hlpop.innerHTML = lookupCard(text, null, !!hid);
  showPop(hlpop, rect);
  const words = lookup.tokenize(text);
  let body;
  try {
    if (words.length === 1) {
      body = lookupResultHtml(await lookup.lookupWord(words[0], prevWord));
    } else {
      // Phrases: a quick gloss per word; idioms are what the Google link is for.
      const rows = [];
      let prev = prevWord;
      for (const w of words.slice(0, 8)) {
        const g = await lookup.shortGloss(w, prev);
        rows.push(`<li><b>${esc(w)}</b> ${g ? `→ ${esc(g.lemma)} <i>${esc(g.gloss || '')}</i>` : '<span class="muted">?</span>'}</li>`);
        prev = w;
      }
      body = `<ul class="lk-words">${rows.join('')}</ul><p class="muted small">Word by word only. Use Google for the meaning of the phrase.</p>`;
    }
  } catch (err) {
    console.error(err);
    body = `<p class="error small">${esc(err.message)}</p>`;
  }
  if (seq !== lookupSeq || hlpop.hidden) return;
  hlpop.innerHTML = lookupCard(text, body, !!hid);
  showPop(hlpop, rect);
}

function lookupCard(text, body, isMark) {
  return `<div class="lk-head"><span class="lk-word">${esc(text)}</span></div>
    <div class="lk-body">${body ?? '<p class="muted small">Looking up…</p>'}</div>
    <div class="lk-actions">
      <a class="btn small" href="${translateUrl(text)}" target="_blank" rel="noopener">Google Translate ↗</a>
      ${isMark ? '<button class="btn small ghost" data-act="remove">Remove mark</button>' : '<button class="btn small ghost" data-act="mark">Mark for later</button>'}
    </div>
    <div class="lk-src">Definitions: Wiktionary, CC BY-SA</div>`;
}

function lookupResultHtml({ known, readings }) {
  const gl = senses => senses.map(([pos, g]) =>
    `<div class="lk-gl">${senses.length > 1 ? `<span class="lk-pos">${esc(pos)}</span> ` : ''}${g.map(esc).join('; ')}</div>`).join('');
  const short = s => esc(s?.[0]?.[1]?.[0] || '?');
  const rows = readings.slice(0, 3).map(r => `
    <div class="lk-r">
      <div><b class="lk-lemma">${esc(r.lemma)}</b> <span class="lk-pos">${esc(r.label)}</span></div>
      ${r.senses ? gl(r.senses) : ''}
      ${r.source ? `<div class="lk-sub">from <b>${esc(r.source.lemma)}</b> <i>${short(r.source.senses)}</i></div>` : ''}
      ${r.compound ? `<div class="lk-sub">= ${r.compound.map(c => `<b>${esc(c.lemma)}</b> <i>${c.senses ? short(c.senses) : '?'}</i>`).join(' + ')}</div>` : ''}
      ${r.hints.length ? `<div class="lk-hint">${r.hints.map(esc).join('<br><span class="muted">or</span> ')}</div>` : ''}
    </div>`).join('');
  return (known ? '' : '<p class="lk-miss">Not in the offline dictionary. Try Google Translate.</p>') + rows;
}

function addMarkAt({ ch, para, start, end }) {
  const text = cache.book.chapters[ch].paras[para].lines.join('\n');
  cache.progress.highlights.push({
    id: uid(), ch, para, start, end, text: text.slice(start, end).replace(/\n/g, ' '), note: '', createdAt: Date.now(),
  });
  save();
}

function showPop(pop, rect) {
  hidePops();
  pop.hidden = false;
  const w = pop.offsetWidth;
  pop.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, rect.left + rect.width / 2 - w / 2)) + 'px';
  // Above the word if it fits, otherwise below.
  const above = rect.top - pop.offsetHeight - 8;
  pop.style.top = (above > 60 ? above : rect.bottom + 8) + window.scrollY + 'px';
}
function hidePops() { selpop.hidden = true; hlpop.hidden = true; }

document.addEventListener('selectionchange', () => {
  clearTimeout(document._selT);
  document._selT = setTimeout(() => {
    const sel = window.getSelection();
    if (!pending || !document.body.contains(pending.el) || sel.isCollapsed || !sel.rangeCount) {
      selpop.hidden = true; return;
    }
    const range = sel.getRangeAt(0);
    if (!pending.el.contains(range.commonAncestorContainer)) { selpop.hidden = true; return; }
    showPop(selpop, range.getBoundingClientRect());
  }, 120);
});
document.addEventListener('keydown', e => {
  if (e.target.closest?.('input,textarea')) return;
  if ((e.key === 'h' || e.key === 'H') && !selpop.hidden) { e.preventDefault(); addMarks(); }
  if (e.key === 'Escape') hidePops();
});
document.addEventListener('mousedown', e => { if (!e.target.closest?.('.popover,mark,.para')) hlpop.hidden = true; });
selpop.addEventListener('mousedown', e => e.preventDefault()); // keep selection alive
selpop.querySelector('[data-act=mark]').onclick = addMarks;
hlpop.addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'remove') {
    cache.progress.highlights = cache.progress.highlights.filter(x => x.id !== hlpop.dataset.hid);
    save(); hidePops(); pending?.onChange();
  } else if (act === 'mark' && hlpop._target) {
    addMarkAt(hlpop._target); hidePops(); pending?.onChange();
  }
});

/* ---------------- Recall ---------------- */

function renderRecall(ch) {
  const { book } = cache;
  const st = chState(ch);
  setNav(`<a href="#/">Library</a><a href="#/b/${book.id}/${ch}">Back to text</a>`);
  const draftKey = `draft.${book.id}.${ch}`;
  app.replaceChildren(h(`
    <div class="wrap narrow">
      <span class="chip">${esc(book.chapters[ch].title)} · recall ${st.attempts.length + 1}</span>
      <h2>What happened?</h2>
      <p class="muted">From memory, without looking back. Write in English, Finnish or a mix, and include anything you picked up:
      who was in it, where it happened, what went on, how it ended, how people felt. Guesses are fine.</p>
      <textarea id="recall" rows="12" placeholder="I think the story is about…">${esc(pref(draftKey) || '')}</textarea>
      <div class="row">
        <button class="btn primary" id="submit">Compare with the text →</button>
        <a class="btn ghost" href="#/b/${book.id}/${ch}">Read it again first</a>
      </div>
    </div>`));
  const ta = app.querySelector('#recall');
  ta.focus();
  ta.oninput = () => pref(draftKey, ta.value);
  app.querySelector('#submit').onclick = async () => {
    const text = ta.value.trim();
    if (!text) return ta.focus();
    st.attempts.push({ at: Date.now(), text, rating: null, ai: null });
    st.reads = (st.reads || 0) + 1;
    await save();
    pref(draftKey, '');
    location.hash = `#/b/${book.id}/${ch}/compare`;
  };
}

/* ---------------- Compare ---------------- */

function renderCompare(ch, attemptIdx) {
  const { book, progress } = cache;
  const st = chState(ch);
  if (!st.attempts.length) return (location.hash = `#/b/${book.id}/${ch}/recall`);
  const ai = attemptIdx ?? st.attempts.length - 1;
  const at = st.attempts[ai];
  const marks = progress.highlights.filter(m => m.ch === ch);
  const hasKey = !!pref('apiKey');
  setNav(`<a href="#/">Library</a><a href="#/b/${book.id}/words">Marked words</a>`);

  app.replaceChildren(h(`
    <div class="wrap wide">
      <div class="compare-head">
        <div>
          <span class="chip">${esc(book.chapters[ch].title)}</span>
          <h2>How close were you?</h2>
        </div>
        <div class="row">
          <a class="btn" href="#/b/${book.id}/${ch}">Read it again</a>
          ${ch < book.chapters.length - 1 ? `<a class="btn primary" href="#/b/${book.id}/${ch + 1}">Next chapter →</a>` : ''}
        </div>
      </div>
      <div class="compare">
        <section class="pane">
          <div class="pane-head">
            <h4>Your recall</h4>
            ${st.attempts.length > 1 ? `<select id="attempt">${st.attempts.map((a, i) =>
              `<option value="${i}" ${i === ai ? 'selected' : ''}>Recall ${i + 1} · ${fmtDate(a.at)}</option>`).join('')}</select>` : `<span class="muted small">${fmtDate(at.at)}</span>`}
          </div>
          <div class="recall-text">${esc(at.text)}</div>

          <h4>Rate yourself</h4>
          <div class="ratings">${RATINGS.map(r =>
            `<button class="rate ${at.rating === r.v ? 'on' : ''}" data-r="${r.v}"><b>${r.label}</b><span>${r.desc}</span></button>`).join('')}</div>

          <h4>Feedback from Claude</h4>
          <div id="ai">${at.ai ? aiHtml(at.ai) : hasKey
            ? `<p class="muted small">Claude reads the original, compares it with your recall, and points out what you got right, what you missed and what you misread.</p><button class="btn" id="askAi">Check my recall</button>`
            : `<p class="muted small">Optional: add an Anthropic API key in <a href="#/settings">Settings</a> to get automatic feedback on your recall.</p>`}</div>

          <h4>Marked in this chapter (${marks.length})</h4>
          ${marks.length ? `<ul class="marklist">${marks.map(markRow).join('')}</ul>` : '<p class="muted small">You didn\'t mark anything. Select text on the right to mark it now.</p>'}
        </section>
        <section class="pane original">
          <div class="pane-head"><h4>The text</h4><span class="muted small">Tap any word to look it up</span></div>
          <div class="text" id="text">${chapterHtml(ch)}</div>
        </section>
      </div>
    </div>`));

  app.querySelector('#attempt')?.addEventListener('change', e => renderCompare(ch, +e.target.value));
  app.querySelectorAll('.rate').forEach(b => b.onclick = () => {
    at.rating = +b.dataset.r; save();
    app.querySelectorAll('.rate').forEach(x => x.classList.toggle('on', x === b));
  });
  app.querySelector('#askAi')?.addEventListener('click', async e => {
    e.target.disabled = true; e.target.textContent = 'Reading…';
    try {
      at.ai = await aiFeedback(ch, at.text);
      await save();
      app.querySelector('#ai').innerHTML = aiHtml(at.ai);
    } catch (err) {
      app.querySelector('#ai').innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  });
  bindMarkRows(app, () => renderCompare(ch, ai));
  bindMarking(app.querySelector('#text'), ch, () => renderCompare(ch, ai), { wordLookup: true });
  app.querySelectorAll('#text mark').forEach(m => m.addEventListener('mouseenter', () => {
    app.querySelector(`.marklist li[data-hid="${m.dataset.hid}"]`)?.classList.add('flash');
  }));
}

function markRow(m) {
  return `<li data-hid="${m.id}">
    <div><span class="fi">${esc(m.text)}</span><div class="lg" data-lg="${m.id}"></div></div>
    <input class="note" data-hid="${m.id}" value="${esc(m.note || '')}" placeholder="meaning…">
    <a href="${translateUrl(m.text)}" target="_blank" rel="noopener" class="small">Google&nbsp;↗</a>
  </li>`;
}
// Fills each [data-lg] slot with the offline dictionary's best guess, e.g. "katu: street · adessive: on, at; has".
async function markGloss(m) {
  const paraText = cache.book.chapters[m.ch].paras[m.para].lines.join('\n');
  const prev = lookup.tokenize(paraText.slice(0, m.start)).at(-1) || '';
  return lookup.shortGloss(m.text, prev).catch(() => null);
}
async function fillMarkGlosses(root) {
  for (const el of root.querySelectorAll('[data-lg]')) {
    const m = cache.progress.highlights.find(x => x.id === el.dataset.lg);
    const g = m && await markGloss(m);
    if (g) el.innerHTML = `${esc(g.lemma)}: <i>${esc(g.gloss || '')}</i>${g.hint ? ` · ${esc(g.hint)}` : ''}`;
  }
}

function bindMarkRows(root) {
  fillMarkGlosses(root);
  root.querySelectorAll('input.note').forEach(inp => inp.onchange = () => {
    const m = cache.progress.highlights.find(x => x.id === inp.dataset.hid);
    if (m) { m.note = inp.value.trim(); save(); }
  });
}

function aiHtml(a) {
  const list = (t, xs) => xs?.length ? `<h5>${t}</h5><ul>${xs.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  return `<div class="ai">
    <div class="score"><b>${esc(a.score)}</b><span>/100 · ${esc(a.verdict || '')}</span></div>
    ${list('You got right', a.got_right)}
    ${list('You missed', a.missed)}
    ${list('Misunderstood', a.misunderstood)}
    <details><summary>What actually happens (spoiler)</summary><p>${esc(a.summary_en)}</p></details>
    ${a.tip ? `<p class="tip">${esc(a.tip)}</p>` : ''}
  </div>`;
}

/* ---------------- Claude API (optional) ---------------- */

async function claude(prompt, maxTokens = 1500) {
  const key = pref('apiKey');
  if (!key) throw new Error('No API key set. Add one in Settings.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: pref('model') || 'claude-sonnet-5-5',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `API error ${res.status}`);
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const json = text.match(/[\[{][\s\S]*[\]}]/);
  if (!json) throw new Error('Unexpected response from Claude.');
  return JSON.parse(json[0]);
}

function aiFeedback(ch, recall) {
  return claude(`You are helping someone learn Finnish by reading extensively. They read a short Finnish text once without translating it, then wrote down what they understood from memory. Compare their recall with the actual text, and be encouraging but precise.

<finnish_text title="${cache.book.chapters[ch].title}">
${chText(ch)}
</finnish_text>

<learner_recall>
${recall}
</learner_recall>

Respond with only a JSON object:
{
  "score": <0-100, how well the recall captures who/what/where/how it ends>,
  "verdict": "<2-5 word verdict>",
  "got_right": ["<specific things they understood correctly>"],
  "missed": ["<important events or details they didn't mention>"],
  "misunderstood": ["<things they got wrong, with the correct meaning and the Finnish word/phrase that likely confused them>"],
  "summary_en": "<a short plain-English summary of what actually happens>",
  "tip": "<one short tip, e.g. a key word or grammar pattern to learn from this text>"
}`);
}

/* ---------------- Marked words ---------------- */

function renderWords() {
  const { book, progress } = cache;
  setNav(`<a href="#/">Library</a><a href="#/b/${book.id}/${progress.last || 0}">Back to reading</a>`);
  const byCh = {};
  progress.highlights.forEach(m => (byCh[m.ch] ||= []).push(m));
  const chs = Object.keys(byCh).map(Number).sort((a, b) => a - b);
  const context = m => {
    const text = book.chapters[m.ch].paras[m.para].lines.join(' ');
    return text.length > 160 ? text.slice(0, 160) + '…' : text;
  };
  app.replaceChildren(h(`
    <div class="wrap">
      <div class="compare-head">
        <div><span class="chip">${esc(book.title)}</span><h2>Marked for later</h2></div>
        <div class="row">
          ${progress.highlights.length ? '<button class="btn" id="dictFill">Fill meanings from dictionary</button>' : ''}
          ${pref('apiKey') && progress.highlights.length ? '<button class="btn" id="aiTr">Fill meanings with Claude</button>' : ''}
          ${progress.highlights.length ? '<button class="btn" id="csv">Export CSV</button>' : ''}
        </div>
      </div>
      <p id="status" class="muted small"></p>
      ${chs.length ? chs.map(ch => `
        <section class="wordgroup">
          <h4><a href="#/b/${book.id}/${ch}">${esc(book.chapters[ch].title)}</a></h4>
          <ul class="marklist big">${byCh[ch].map(m => `
            <li data-hid="${m.id}">
              <div><span class="fi">${esc(m.text)}</span><div class="lg" data-lg="${m.id}"></div><div class="ctx">${esc(context(m))}</div></div>
              <input class="note" data-hid="${m.id}" value="${esc(m.note || '')}" placeholder="meaning…">
              <a href="${translateUrl(m.text)}" target="_blank" rel="noopener" class="small">Google&nbsp;↗</a>
              <button class="x" data-rm="${m.id}" title="Remove">×</button>
            </li>`).join('')}</ul>
        </section>`).join('') : '<p class="muted">Nothing marked yet. While reading, select a word or phrase and press <kbd>H</kbd>.</p>'}
    </div>`));
  bindMarkRows(app);
  app.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
    progress.highlights = progress.highlights.filter(x => x.id !== b.dataset.rm); save(); renderWords();
  });
  app.querySelector('#dictFill')?.addEventListener('click', async e => {
    e.target.disabled = true;
    let n = 0;
    for (const m of progress.highlights.filter(m => !m.note)) {
      const g = await markGloss(m);
      if (g?.gloss) { m.note = `${g.lemma}: ${g.gloss}`; n++; }
    }
    await save();
    renderWords();
    app.querySelector('#status').textContent = n
      ? `Filled ${n} meaning${n > 1 ? 's' : ''} from the offline dictionary. Phrases and unknown words still need Google or Claude.`
      : 'Nothing to fill. Every mark has a meaning, or the dictionary has no entry for it.';
  });
  app.querySelector('#csv')?.addEventListener('click', () => {
    const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = [['finnish', 'meaning', 'chapter', 'context'],
      ...progress.highlights.map(m => [m.text, m.note, book.chapters[m.ch].title, context(m)])];
    const blob = new Blob([rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${book.title} - words.csv` });
    a.click();
  });
  app.querySelector('#aiTr')?.addEventListener('click', async e => {
    const todo = progress.highlights.filter(m => !m.note);
    if (!todo.length) return (app.querySelector('#status').textContent = 'Every mark already has a meaning.');
    e.target.disabled = true; app.querySelector('#status').textContent = `Translating ${todo.length} items…`;
    try {
      const res = await claude(`Translate these Finnish words/phrases into short English meanings as used in their context sentence. If a word is inflected, add the base form in parentheses, e.g. "to the bus stop (bussipysäkki)".

${JSON.stringify(todo.map(m => ({ id: m.id, phrase: m.text, context: context(m) })), null, 1)}

Respond with only a JSON array: [{"id": "...", "meaning": "..."}]`, 3000);
      res.forEach(r => { const m = progress.highlights.find(x => x.id === r.id); if (m && !m.note) m.note = r.meaning; });
      await save(); renderWords();
    } catch (err) {
      app.querySelector('#status').innerHTML = `<span class="error">${esc(err.message)}</span>`;
      e.target.disabled = false;
    }
  });
}

/* ---------------- Morphology debug view ---------------- */

async function renderMorphDebug(ch) {
  const { book } = cache;
  setNav(`<a href="#/">Library</a><a href="#/b/${book.id}/${ch}">Back to text</a>`);
  app.replaceChildren(h(`<div class="wrap wide"><span class="chip">${esc(book.chapters[ch].title)}</span>
    <h2>Voikko analyses (debug)</h2><p class="muted" id="mstatus">Loading Voikko…</p><div id="mout"></div></div>`));
  const words = [...new Set(book.chapters[ch].paras.flatMap(p => p.lines.flatMap(morph.tokenize)))];
  const t0 = performance.now();
  await morph.analyzeWords(words);
  const status = app.querySelector('#mstatus');
  if (!status) return;
  const unknown = words.filter(w => !morph.getAnalyses(w)?.length);
  status.textContent = `${words.length} unique words · ${unknown.length} unknown · ${Math.round(performance.now() - t0)} ms (includes worker start on first use)`;
  const cell = a => Object.entries(a).filter(([k]) => k !== 'BASEFORM')
    .map(([k, v]) => `<span class="kv">${k}=<b>${esc(v)}</b></span>`).join(' ');
  app.querySelector('#mout').innerHTML = `<table class="morph"><thead><tr><th>Word</th><th>Base form</th><th>Analysis</th></tr></thead><tbody>
    ${words.map(w => {
      const as = morph.getAnalyses(w);
      if (!as.length) return `<tr class="unk"><td>${esc(w)}</td><td colspan="2">(unknown → Google Translate fallback)</td></tr>`;
      return as.map((a, i) => `<tr${i ? ' class="alt"' : ''}><td>${i ? '' : esc(w)}</td><td>${esc(a.BASEFORM || '')}</td><td>${cell(a)}</td></tr>`).join('');
    }).join('')}</tbody></table>`;
}

/* ---------------- Settings ---------------- */

function renderSettings() {
  setNav(`<a href="#/">Library</a>`);
  app.replaceChildren(h(`
    <div class="wrap narrow">
      <h2>Settings</h2>
      <p class="muted">Everything (books, marks, recalls) is stored in this browser's IndexedDB. Nothing is uploaded.</p>
      <h4>Claude feedback (optional)</h4>
      <p class="muted small">With an Anthropic API key, Claude can score your recall against the text and fill in meanings for your marked words.
      The key is stored in this browser's localStorage and sent only to api.anthropic.com.</p>
      <label class="field">API key <input type="password" id="key" value="${esc(pref('apiKey') || '')}" placeholder="sk-ant-…" autocomplete="off"></label>
      <label class="field">Model <input id="model" value="${esc(pref('model') || 'claude-sonnet-5-5')}"></label>
      <div class="row"><button class="btn primary" id="saveS">Save</button><span id="ok" class="muted small"></span></div>
      <h4>Credits</h4>
      <p class="muted small">Word definitions from <a href="https://en.wiktionary.org" target="_blank" rel="noopener">Wiktionary</a>,
      extracted by <a href="https://kaikki.org" target="_blank" rel="noopener">kaikki.org</a>, licensed
      <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noopener">CC BY-SA 4.0</a>.
      Word frequency ranking from <a href="https://github.com/hermitdave/FrequencyWords" target="_blank" rel="noopener">FrequencyWords</a>
      (OpenSubtitles 2018), CC BY-SA 4.0.
      Finnish word analysis by <a href="https://voikko.puimula.org" target="_blank" rel="noopener">Voikko</a>, licensed GPL-3.0
      (source and license in <code>vendor/voikko/</code>).</p>
    </div>`));
  app.querySelector('#saveS').onclick = () => {
    pref('apiKey', app.querySelector('#key').value.trim());
    pref('model', app.querySelector('#model').value.trim() || 'claude-sonnet-5-5');
    app.querySelector('#ok').textContent = 'Saved.';
  };
}

route();

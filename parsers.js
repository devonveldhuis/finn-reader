// Turns an uploaded file into { title, chapters: [{ title, paras: [{ kind, lines }] }] }.
// kind is "p" (body paragraph) or "h" (sub-heading inside a chapter).

import * as pdfjs from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

export async function parseFile(file) {
  const name = file.name.replace(/\.[^.]+$/, '');
  const ext = file.name.split('.').pop().toLowerCase();
  const buf = await file.arrayBuffer();
  if (ext === 'pdf') return parsePdf(buf, name);
  if (ext === 'epub') return parseEpub(buf, name);
  if (ext === 'txt' || ext === 'md') return parseText(new TextDecoder().decode(buf), name);
  if (ext === 'lcpl' || ext === 'lcpdf') throw new Error(
    'This is a Readium LCP (DRM-protected) loan, e.g. from a library app. Lukija can\'t open it: ' +
    'only certified readers such as Thorium Reader can decrypt LCP books. Use a DRM-free PDF, EPUB or TXT instead.');
  throw new Error(`Unsupported file type: .${ext} (use PDF, EPUB or TXT)`);
}

const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const cleanLine = s => s.replace(/\s+/g, ' ').replace(/\.{4,}\s*\d*\s*$/, '').replace(/\.{4,}/g, ' … ').trim();

/* ---------------- PDF ---------------- */

async function parsePdf(buf, fallbackTitle) {
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  let pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push(groupLines(tc.items));
  }

  // Body font size = the size carrying the most characters.
  const sizeChars = new Map();
  pages.flat().forEach(l => {
    const k = Math.round(l.size * 2) / 2;
    sizeChars.set(k, (sizeChars.get(k) || 0) + l.text.length);
  });
  const bodySize = [...sizeChars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 11;

  // Normal line spacing = most common gap between consecutive body lines; bigger gaps start a paragraph.
  pages = pages.map(stripPageNumbers);
  const gaps = [];
  pages.forEach(lines => lines.forEach((l, i) => {
    const prev = lines[i - 1];
    if (prev && Math.abs(prev.size - bodySize) < 1 && Math.abs(l.size - bodySize) < 1) gaps.push(prev.y - l.y);
  }));
  gaps.sort((a, b) => a - b);
  const lineGap = gaps[Math.floor(gaps.length * 0.3)] || bodySize * 1.2;

  // Flatten into blocks (paragraphs / headings) tagged with their page.
  const blocks = [];
  pages.forEach((lines, pi) => {
    let cur = null;
    lines.forEach((l, li) => {
      const isHead = l.size >= bodySize * 1.25 && l.text.length < 120;
      const prev = lines[li - 1];
      const gap = prev ? prev.y - l.y : Infinity;
      const newBlock = !cur || gap > Math.max(lineGap * 1.35, Math.max(prev.size, l.size) * 1.1) ||
        (cur.kind === 'h') !== isHead || Math.abs(prev.size - l.size) > 1;
      if (newBlock) {
        cur = { kind: isHead ? 'h' : 'p', size: l.size, page: pi, lines: [] };
        blocks.push(cur);
      }
      cur.lines.push(l.text);
    });
  });

  // Chapter starts: prefer the PDF outline (bookmarks), else large headings.
  let starts = [];
  const outline = await pdfOutline(doc);
  if (outline.length >= 2) {
    for (const o of outline) {
      const t = norm(o.title);
      let idx = blocks.findIndex(b => b.kind === 'h' && b.page >= (o.page ?? 0) - 1 &&
        norm(b.lines.join(' ')).startsWith(t.slice(0, 25)));
      if (idx < 0 && o.page != null) idx = blocks.findIndex(b => b.page >= o.page);
      if (idx >= 0 && !starts.some(s => s.idx === idx)) starts.push({ idx, title: o.title.trim() });
    }
    starts.sort((a, b) => a.idx - b.idx);
  }
  if (starts.length < 2) {
    // Most common heading size (≥ 2 occurrences) = chapter level; also treat bigger ones as chapters.
    const counts = new Map();
    blocks.filter(b => b.kind === 'h').forEach(b => {
      const k = Math.round(b.size); counts.set(k, (counts.get(k) || 0) + 1);
    });
    const lvl = [...counts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1])[0]?.[0];
    starts = blocks.map((b, idx) => ({ b, idx }))
      .filter(({ b }) => b.kind === 'h' && lvl != null && Math.round(b.size) >= lvl)
      .map(({ b, idx }) => ({ idx, title: b.lines.join(' ') }));
  }

  const chapters = [];
  const meta = await doc.getMetadata().catch(() => ({}));
  const title = meta?.info?.Title?.trim() ||
    blocks.find(b => b.kind === 'h')?.lines.join(' ') || fallbackTitle;

  if (!starts.length) {
    // No structure at all: one chapter per ~6 pages.
    for (let p = 0; p < pages.length; p += 6) {
      const paras = blocks.filter(b => b.page >= p && b.page < p + 6);
      chapters.push({ title: `Pages ${p + 1}–${Math.min(p + 6, pages.length)}`, paras });
    }
  } else {
    if (starts[0].idx > 0) chapters.push({ title: 'Front matter', paras: blocks.slice(0, starts[0].idx) });
    starts.forEach((s, i) => {
      const slice = blocks.slice(s.idx, starts[i + 1]?.idx ?? blocks.length);
      // Drop the heading block itself; it becomes the chapter title.
      const body = slice[0]?.kind === 'h' ? slice.slice(1) : slice;
      chapters.push({ title: s.title, paras: body });
    });
  }
  return finalize(title, chapters);
}

function groupLines(items) {
  const parts = items
    .filter(it => it.str !== undefined)
    .map(it => ({
      str: it.str, x: it.transform[4], y: it.transform[5], w: it.width,
      size: Math.hypot(it.transform[2], it.transform[3]) || it.height || 10,
    }))
    .filter(p => p.str.length);
  parts.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const p of parts) {
    const line = lines.find(l => Math.abs(l.y - p.y) < Math.max(l.size, p.size) * 0.45);
    if (line) line.parts.push(p), line.size = Math.max(line.size, p.str.trim() ? p.size : 0);
    else lines.push({ y: p.y, size: p.str.trim() ? p.size : 0, parts: [p] });
  }
  return lines
    .map(l => {
      l.parts.sort((a, b) => a.x - b.x);
      let text = '', end = null;
      for (const p of l.parts) {
        if (end !== null && p.x - end > l.size * 0.2 && !/\s$/.test(text) && !/^\s/.test(p.str)) text += ' ';
        text += p.str; end = p.x + p.w;
      }
      return { y: l.y, size: l.size, text: cleanLine(text) };
    })
    .filter(l => l.text)
    .sort((a, b) => b.y - a.y);
}

function stripPageNumbers(lines) {
  const isNum = l => /^(\d{1,4}|[ivxlc]{1,6})$/i.test(l.text);
  if (lines.length && isNum(lines[lines.length - 1])) lines = lines.slice(0, -1);
  if (lines.length && isNum(lines[0])) lines = lines.slice(1);
  return lines;
}

async function pdfOutline(doc) {
  const outline = await doc.getOutline().catch(() => null);
  if (!outline) return [];
  const out = [];
  for (const o of outline) {
    let page = null;
    try {
      const dest = typeof o.dest === 'string' ? await doc.getDestination(o.dest) : o.dest;
      if (dest) page = await doc.getPageIndex(dest[0]);
    } catch { /* unresolved dest */ }
    out.push({ title: o.title, page });
  }
  return out;
}

/* ---------------- EPUB ---------------- */

async function parseEpub(buf, fallbackTitle) {
  const zip = await JSZip.loadAsync(buf);
  const read = p => zip.file(decodeURIComponent(p))?.async('string');
  const xml = s => new DOMParser().parseFromString(s, 'application/xml');
  // Watermarked EPUBs are plain text (at most fonts are obfuscated). Encrypted text means DRM.
  const encXml = await read('META-INF/encryption.xml');
  if (encXml && [...xml(encXml).getElementsByTagNameNS('*', 'CipherReference')]
    .some(r => /\.x?html?$/i.test(r.getAttribute('URI') || ''))) {
    throw new Error('This EPUB is DRM-encrypted (e.g. Adobe DRM or LCP), so Lukija can\'t read it. ' +
      'Watermarked ("vesileima") or DRM-free EPUBs work.');
  }
  const container = xml(await read('META-INF/container.xml'));
  const opfPath = container.querySelector('rootfile').getAttribute('full-path');
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const opf = xml(await read(opfPath));
  const title = opf.getElementsByTagNameNS('*', 'title')[0]?.textContent?.trim() || fallbackTitle;
  const manifest = {};
  let navHref = null, ncxHref = null;
  [...opf.getElementsByTagNameNS('*', 'item')].forEach(it => {
    const href = it.getAttribute('href');
    manifest[it.getAttribute('id')] = href;
    if (/\bnav\b/.test(it.getAttribute('properties') || '')) navHref = href;
    if (it.getAttribute('media-type') === 'application/x-dtbncx+xml') ncxHref = href;
  });
  // The book's own table of contents (EPUB3 nav or EPUB2 NCX) gives chapter names; the nav page itself is skipped.
  const tocLabels = {};
  const fileOf = h => h.split('#')[0].split('/').pop();
  if (navHref) {
    const nav = new DOMParser().parseFromString(await read(base + navHref) || '', 'text/html');
    nav.querySelectorAll('nav a[href]').forEach(a => tocLabels[fileOf(a.getAttribute('href'))] ??= cleanLine(a.textContent));
  } else if (ncxHref) {
    const ncx = xml(await read(base + ncxHref) || '<x/>');
    [...ncx.getElementsByTagNameNS('*', 'navPoint')].forEach(np => {
      const src = np.getElementsByTagNameNS('*', 'content')[0]?.getAttribute('src');
      const label = np.getElementsByTagNameNS('*', 'text')[0]?.textContent;
      if (src && label) tocLabels[fileOf(src)] ??= cleanLine(label);
    });
  }
  const spine = [...opf.getElementsByTagNameNS('*', 'itemref')]
    .map(r => manifest[r.getAttribute('idref')])
    .filter(href => href && href !== navHref);

  const chapters = [];
  for (const href of spine) {
    if (!href) continue;
    const html = await read(base + href.split('#')[0]);
    if (!html) continue;
    const d = new DOMParser().parseFromString(html, 'text/html');
    const paras = [];
    let chTitle = null;
    d.body?.querySelectorAll('h1,h2,h3,h4,p,li,blockquote,pre').forEach(el => {
      if (el.closest('li') && el.tagName !== 'LI') return;
      const isHead = /^H\d$/.test(el.tagName);
      if (el.innerHTML.match(/<br/i)) el.innerHTML = el.innerHTML.replace(/<br\s*\/?>/gi, '\n');
      const lines = el.textContent.split('\n').map(cleanLine).filter(Boolean);
      if (!lines.length) return;
      if (isHead && !chTitle && !paras.length) { chTitle = lines.join(' '); return; }
      paras.push({ kind: isHead ? 'h' : 'p', lines });
    });
    if (!paras.length) continue;
    chapters.push({ title: chTitle || tocLabels[fileOf(href)] || `Section ${chapters.length + 1}`, paras });
  }
  return finalize(title, chapters);
}

/* ---------------- Plain text ---------------- */

function parseText(text, title) {
  const chapters = [];
  let cur = null;
  text.replace(/\r/g, '').split(/\n\s*\n/).forEach(block => {
    const lines = block.split('\n').map(cleanLine).filter(Boolean);
    if (!lines.length) return;
    const m = lines.length === 1 && lines[0].match(/^(#+\s*|chapter\s+|luku\s+|\d+\.\s+)(.*)$/i);
    if (m || !cur) {
      cur = { title: m ? lines[0].replace(/^#+\s*/, '') : 'Start', paras: [] };
      chapters.push(cur);
      if (m) return;
    }
    cur.paras.push({ kind: 'p', lines });
  });
  return finalize(title, chapters);
}

function finalize(title, chapters) {
  chapters = chapters
    .map(c => ({ title: c.title, paras: c.paras.map(p => ({ kind: p.kind, lines: p.lines })) }))
    .filter(c => c.paras.length);
  if (!chapters.length) throw new Error('No readable text found. Scanned PDFs (images) are not supported.');
  return { title, chapters };
}

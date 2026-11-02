# Lukija: read first, translate later

A browser reader for extensive reading practice. You read whole chapters without stopping, mark words to look up later, write down what you think happened, and then compare that with the text.

## Run

```bash
python3 -m http.server 8765
```

Open http://localhost:8765. ES modules don't load from `file://`, so the app needs to be served.

## Files

- `index.html`, `styles.css`: the page and its styles
- `app.js`: views (library, reader, recall, compare, marked words, settings) and the marking logic
- `parsers.js`: turns PDF (pdf.js), EPUB (JSZip) or TXT into chapters and paragraphs. PDF chapters come from the bookmarks, or from large headings if there are no bookmarks. Paragraphs come from line spacing.
- `db.js`: IndexedDB storage. Everything stays in this browser.

## Dictionary

`dict/` holds the Finnish → English lemma dictionary: `manifest.json` plus `fi-en.<letter>.json` chunks, with
non-ASCII first letters as `ae` (ä), `oe` (ö) and `ao` (å). Each entry has the shape `lemma → [frequencyRank, [partOfSpeech, [gloss, …]], …]`.
To rebuild it (Node 18+):

```bash
node scripts/build-dict.mjs --limit 20000
```

The script downloads the kaikki.org Wiktionary extract (273 MB) and a word frequency list (39 MB) into `.cache/`, which is
not committed. It lemmatizes the frequency list with Voikko and keeps the `--limit` most frequent lemmas that have an
English gloss. A rebuild takes about a minute. Definitions are CC BY-SA 4.0 (Wiktionary), and credits are shown in Settings.

Optional: add an Anthropic API key in Settings for recall feedback and automatic meanings for marked words.

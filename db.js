// Minimal IndexedDB wrapper. Two stores: "books" (parsed text) and "progress" (per-book study data).

const open = () => new Promise((res, rej) => {
  const req = indexedDB.open('lukija', 1);
  req.onupgradeneeded = () => {
    req.result.createObjectStore('books', { keyPath: 'id' });
    req.result.createObjectStore('progress', { keyPath: 'bookId' });
  };
  req.onsuccess = () => res(req.result);
  req.onerror = () => rej(req.error);
});
const dbp = open();

async function tx(store, mode, fn) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => res(r?.result);
    t.onerror = () => rej(t.error);
  });
}

export const getBooks = () => tx('books', 'readonly', s => s.getAll());
export const getBook = id => tx('books', 'readonly', s => s.get(id));
export const putBook = b => tx('books', 'readwrite', s => s.put(b));
export const deleteBook = async id => {
  await tx('books', 'readwrite', s => s.delete(id));
  await tx('progress', 'readwrite', s => s.delete(id));
};

export async function getProgress(bookId) {
  const p = await tx('progress', 'readonly', s => s.get(bookId));
  return p || { bookId, highlights: [], chapters: {}, last: 0 };
}
export const putProgress = p => tx('progress', 'readwrite', s => s.put(p));

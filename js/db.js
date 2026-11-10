// Local storage in IndexedDB. Nothing leaves the device.

const DB_NAME = 'scanner74';
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('docs', { keyPath: 'id' });
      const pages = db.createObjectStore('pages', { keyPath: 'id' });
      pages.createIndex('docId', 'docId');
      db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(stores, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result;
    Promise.resolve(fn(t)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('aborted'));
  }));
}
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const db = {
  async listDocs() {
    const docs = await tx(['docs'], 'readonly', (t) => req(t.objectStore('docs').getAll()));
    return docs.sort((a, b) => b.updated - a.updated);
  },
  getDoc: (id) => tx(['docs'], 'readonly', (t) => req(t.objectStore('docs').get(id))),
  putDoc: (doc) => tx(['docs'], 'readwrite', (t) => { t.objectStore('docs').put(doc); }),
  getPage: (id) => tx(['pages'], 'readonly', (t) => req(t.objectStore('pages').get(id))),
  putPage: (page) => tx(['pages'], 'readwrite', (t) => { t.objectStore('pages').put(page); }),
  async getPages(doc) {
    const all = await tx(['pages'], 'readonly', (t) => req(t.objectStore('pages').index('docId').getAll(doc.id)));
    const map = new Map(all.map((p) => [p.id, p]));
    return doc.pageIds.map((id) => map.get(id)).filter(Boolean);
  },
  deletePage: (id) => tx(['pages'], 'readwrite', (t) => { t.objectStore('pages').delete(id); }),
  async deleteDoc(id) {
    const keys = await tx(['pages'], 'readonly', (t) => req(t.objectStore('pages').index('docId').getAllKeys(id)));
    return tx(['docs', 'pages'], 'readwrite', (t) => {
      t.objectStore('docs').delete(id);
      keys.forEach((k) => t.objectStore('pages').delete(k));
    });
  },
  getKV: (k) => tx(['kv'], 'readonly', (t) => req(t.objectStore('kv').get(k))),
  setKV: (k, v) => tx(['kv'], 'readwrite', (t) => { t.objectStore('kv').put(v, k); }),
  clearAll: () => tx(['docs', 'pages', 'kv'], 'readwrite', (t) => { ['docs', 'pages', 'kv'].forEach((s) => t.objectStore(s).clear()); }),
};

const COLLECTION_STORES = Object.freeze({
  days: 'days',
  fuel: 'fuel',
  exp: 'exp',
  goals: 'goals',
  profiles: 'profiles',
  vehicles: 'vehicles',
  outbox: 'outbox',
  conflicts: 'conflicts',
  meta: 'meta',
});

const COLLECTION_NAMES = Object.values(COLLECTION_STORES);

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function storeName(kind) {
  const name = COLLECTION_STORES[kind] ?? kind;
  if (!COLLECTION_NAMES.includes(name)) throw new Error(`Coleção local desconhecida: ${kind}`);
  return name;
}

export function createMemoryStore() {
  const collections = new Map(COLLECTION_NAMES.filter((name) => name !== 'meta').map((name) => [name, new Map()]));
  const metadata = new Map();
  return {
    async init() {},
    async get(kind, id) {
      const name = storeName(kind);
      return clone(name === 'meta' ? metadata.get(id) : collections.get(name).get(id));
    },
    async list(kind) {
      const name = storeName(kind);
      return clone(name === 'meta' ? [...metadata.values()] : [...collections.get(name).values()]);
    },
    async put(kind, value) {
      const name = storeName(kind);
      if (!value || value.id === undefined && name !== 'meta') throw new Error(`Registro sem id em ${name}`);
      if (name === 'meta') metadata.set(value.key, clone(value));
      else collections.get(name).set(value.id, clone(value));
      return clone(value);
    },
    async putMany(kind, values) {
      for (const value of values) await this.put(kind, value);
    },
    async delete(kind, id) {
      const name = storeName(kind);
      if (name === 'meta') metadata.delete(id);
      else collections.get(name).delete(id);
    },
    async enqueue(operation) {
      return this.put('outbox', operation);
    },
    async listOutbox() {
      return this.list('outbox');
    },
    async updateOutbox(id, patch) {
      const current = await this.get('outbox', id);
      if (current) await this.put('outbox', { ...current, ...patch, id });
    },
    async listConflicts() {
      return this.list('conflicts');
    },
    async addConflict(conflict) {
      return this.put('conflicts', conflict);
    },
    async getMeta(key, fallback = null) {
      const value = await this.get('meta', key);
      return value?.value ?? fallback;
    },
    async setMeta(key, value) {
      return this.put('meta', { key, value });
    },
  };
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Falha no IndexedDB'));
  });
}

function transactionPromise(db, name, mode, callback) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(name, mode);
    let result;
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error ?? new Error('Falha na transação IndexedDB'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Transação IndexedDB abortada'));
    try { result = callback(transaction.objectStore(name)); } catch (error) { reject(error); }
  });
}

export function createIndexedDbStore({ indexedDBRef = globalThis.indexedDB, dbName = 'saldo-final-local-v1' } = {}) {
  if (!indexedDBRef) return createMemoryStore();
  let dbPromise;
  const open = () => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDBRef.open(dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of COLLECTION_NAMES) {
          if (db.objectStoreNames.contains(name)) continue;
          if (name === 'meta') db.createObjectStore(name, { keyPath: 'key' });
          else db.createObjectStore(name, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Não foi possível abrir o IndexedDB'));
    });
    return dbPromise;
  };

  return {
    async init() { await open(); },
    async get(kind, id) {
      const db = await open();
      return clone(await transactionPromise(db, storeName(kind), 'readonly', (store) => requestPromise(store.get(id))));
    },
    async list(kind) {
      const db = await open();
      return clone(await transactionPromise(db, storeName(kind), 'readonly', (store) => requestPromise(store.getAll())));
    },
    async put(kind, value) {
      const db = await open();
      const name = storeName(kind);
      await transactionPromise(db, name, 'readwrite', (store) => { store.put(clone(value)); });
      return clone(value);
    },
    async putMany(kind, values) {
      const db = await open();
      const name = storeName(kind);
      await transactionPromise(db, name, 'readwrite', (store) => { values.forEach((value) => store.put(clone(value))); });
    },
    async delete(kind, id) {
      const db = await open();
      await transactionPromise(db, storeName(kind), 'readwrite', (store) => { store.delete(id); });
    },
    async enqueue(operation) { return this.put('outbox', operation); },
    async listOutbox() { return this.list('outbox'); },
    async updateOutbox(id, patch) {
      const current = await this.get('outbox', id);
      if (current) await this.put('outbox', { ...current, ...patch, id });
    },
    async listConflicts() { return this.list('conflicts'); },
    async addConflict(conflict) { return this.put('conflicts', conflict); },
    async getMeta(key, fallback = null) {
      const value = await this.get('meta', key);
      return value?.value ?? fallback;
    },
    async setMeta(key, value) { return this.put('meta', { key, value }); },
  };
}

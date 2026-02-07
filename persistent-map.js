/**
 * PersistentMap - Drop-in Map replacement backed by Supabase
 * 
 * Write-through cache: reads from memory, writes to both memory + Supabase.
 * On cold start (Vercel), loads all data from Supabase into memory.
 * 
 * Usage:
 *   const { createStore } = require('./persistent-map');
 *   const store = createStore('my-mechanism');
 *   const projects = store.map('projects');
 *   await store.ready(); // Wait for initial load
 *   
 *   // Then use like a normal Map (reads are sync, writes fire-and-forget to DB)
 *   projects.set('abc', { title: 'Hello' });
 *   projects.get('abc'); // { title: 'Hello' }
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://toofwveskfzruckkvqwv.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

class PersistentMap {
  constructor(mechanism, collection) {
    this._mechanism = mechanism;
    this._collection = collection;
    this._cache = new Map();
    this._loadPromise = null;
  }

  /** Load all items from Supabase into cache */
  async _load() {
    if (!SUPABASE_KEY) {
      console.log(`[STORE] No Supabase key, using memory-only for ${this._mechanism}/${this._collection}`);
      return;
    }
    try {
      const url = `${SUPABASE_URL}/rest/v1/mechanism_store?mechanism=eq.${encodeURIComponent(this._mechanism)}&collection=eq.${encodeURIComponent(this._collection)}&select=item_key,data`;
      const response = await fetch(url, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        }
      });
      if (!response.ok) {
        console.error(`[STORE] Load failed for ${this._mechanism}/${this._collection}: ${response.status}`);
        return;
      }
      const rows = await response.json();
      for (const row of rows) {
        this._cache.set(row.item_key, row.data);
      }
      console.log(`[STORE] Loaded ${rows.length} items for ${this._mechanism}/${this._collection}`);
    } catch (err) {
      console.error(`[STORE] Load error for ${this._mechanism}/${this._collection}: ${err.message}`);
    }
  }

  /** Persist a single item to Supabase (fire-and-forget) */
  _persist(key, value) {
    if (!SUPABASE_KEY) return;
    const url = `${SUPABASE_URL}/rest/v1/mechanism_store`;
    fetch(url, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        mechanism: this._mechanism,
        collection: this._collection,
        item_key: String(key),
        data: value,
        updated_at: new Date().toISOString()
      })
    }).catch(err => console.error(`[STORE] Persist error: ${err.message}`));
  }

  /** Remove a single item from Supabase (fire-and-forget) */
  _remove(key) {
    if (!SUPABASE_KEY) return;
    const url = `${SUPABASE_URL}/rest/v1/mechanism_store?mechanism=eq.${encodeURIComponent(this._mechanism)}&collection=eq.${encodeURIComponent(this._collection)}&item_key=eq.${encodeURIComponent(String(key))}`;
    fetch(url, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      }
    }).catch(err => console.error(`[STORE] Remove error: ${err.message}`));
  }

  // === Map-compatible interface (sync reads, async writes) ===

  get(key) { return this._cache.get(String(key)); }
  has(key) { return this._cache.has(String(key)); }
  get size() { return this._cache.size; }

  set(key, value) {
    const k = String(key);
    this._cache.set(k, value);
    this._persist(k, value);
    return this;
  }

  delete(key) {
    const k = String(key);
    const existed = this._cache.delete(k);
    if (existed) this._remove(k);
    return existed;
  }

  clear() {
    this._cache.clear();
    // Bulk delete from Supabase
    if (!SUPABASE_KEY) return;
    const url = `${SUPABASE_URL}/rest/v1/mechanism_store?mechanism=eq.${encodeURIComponent(this._mechanism)}&collection=eq.${encodeURIComponent(this._collection)}`;
    fetch(url, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      }
    }).catch(err => console.error(`[STORE] Clear error: ${err.message}`));
  }

  keys() { return this._cache.keys(); }
  values() { return this._cache.values(); }
  entries() { return this._cache.entries(); }
  forEach(fn, thisArg) { return this._cache.forEach(fn, thisArg); }
  [Symbol.iterator]() { return this._cache[Symbol.iterator](); }
}

/**
 * Create a store for a mechanism.
 * Returns an object with .map(collection) and .ready() methods.
 */
function createStore(mechanism) {
  const maps = {};
  const loadPromises = [];
  let _readyPromise = null;

  const store = {
    /**
     * Get or create a PersistentMap for a collection.
     * @param {string} collection - e.g. 'projects', 'votes', 'pools'
     * @returns {PersistentMap}
     */
    map(collection) {
      if (!maps[collection]) {
        const pm = new PersistentMap(mechanism, collection);
        maps[collection] = pm;
        loadPromises.push(pm._load());
      }
      return maps[collection];
    },

    /**
     * Wait for all maps to finish loading from Supabase.
     * Call this before starting the server.
     * @returns {Promise} - resolves when all maps are loaded
     */
    async ready() {
      if (!_readyPromise) {
        _readyPromise = Promise.all(loadPromises);
      }
      return _readyPromise;
    },

    /**
     * Express middleware that ensures the store is loaded before handling requests.
     * Usage: app.use(store.middleware());
     * Fixes Vercel serverless cold start race conditions.
     */
    middleware() {
      const p = store.ready();
      return async (req, res, next) => {
        await p;
        next();
      };
    }
  };

  return store;
}

module.exports = { createStore, PersistentMap };

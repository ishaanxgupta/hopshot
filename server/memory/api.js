// Supermemory access for Hopshot: a tiny client for the v5 HTTP API (plain fetch, no SDK) and an
// in-process mock with the same interface (SUPERMEMORY_MOCK=1, used by the offline tests).
//
// v5 routes used (https://supermemory.ai/docs/v5/api-reference; v3/v4 are deprecated). The
// namespace (= Supermemory "container tag") is always in the path; every option is in the body.
//   POST  /ns/{ns}/document        { content, id, metadata, date, dreaming: 'instant',
//                                    supportingContext, taskType }  -> { id, status }
//                                  Same id again = APPEND (diffed), never a replace.
//   PATCH /ns/{ns}/document/{id}   { metadata } -> metadata merges key by key, no reindex
//   GET   /ns/{ns}/document/{id}   -> { id, content, metadata (verbatim), system: { status, dreamingStatus } }
//   POST  /ns/{ns}/search          { query, searchMode: 'hybrid', limit, threshold }
//                                  -> { results: [{ memory? | chunk?, metadata, similarity }] }
//   POST  /ns/{ns}/profile         {} -> { profile: { static: [{memory}], dynamic: [{memory}] } }
//   POST  /ns/{ns}/list/memories   (?limit=) {} -> { memories: [{ memory, metadata, ... }] }
//   GET   /ns/{ns}                 -> { namespace, supportingContext }
//   PATCH /ns/{ns}                 { supportingContext } (the namespace must exist)
// Auth: `Authorization: Bearer <key>`. The key is read once from process.env by the caller and is
// never logged: errors carry only the method, the route template, the status and a short reason.
//
// Every call has a timeout; writes are retried (network errors, 408/409/429/5xx) with backoff; at
// most MAX_INFLIGHT requests run at once (the rest wait in a FIFO), so a burst at match end can
// never pile up sockets or CPU on a 0.1-CPU host.

const BASE_URL = 'https://api.supermemory.ai';
const MAX_INFLIGHT = 3;
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class MemoryHttpError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

/** Route template for logs: /ns/<ns>/document/<id> -> /ns/:ns/document/:id (no ids, no secrets). */
function routeOf(path) {
  return path.replace(/^\/ns\/[^/]+/, '/ns/:ns').replace(/\/document\/[^/?]+/, '/document/:id').replace(/\?.*$/, '');
}

export function createSupermemoryClient({ apiKey, baseUrl = BASE_URL, fetchImpl = globalThis.fetch, stats = {} } = {}) {
  if (!apiKey) throw new Error('supermemory: no api key');
  const queue = [];
  let inflight = 0;
  stats.requests = stats.requests || 0; stats.failures = stats.failures || 0; stats.retries = stats.retries || 0;

  function slot() {
    if (inflight < MAX_INFLIGHT) { inflight++; return Promise.resolve(); }
    return new Promise((resolve) => queue.push(resolve));
  }
  function release() {
    const next = queue.shift();
    if (next) next(); else inflight--;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function once(method, path, body, timeoutMs) {
    const r = await fetchImpl(baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, ok: r.ok, json, retryAfter: +r.headers.get('retry-after') || 0 };
  }

  /**
   * One API call. Resolves to the parsed JSON (or null for an empty body); 404 resolves to
   * undefined when opts.allow404. Throws MemoryHttpError otherwise (after retries).
   */
  async function request(method, path, body, { timeoutMs = 6000, retries = 0, allow404 = false } = {}) {
    await slot();
    try {
      for (let attempt = 0; ; attempt++) {
        stats.requests++;
        let res = null, err = null;
        try { res = await once(method, path, body, timeoutMs); } catch (e) { err = e; }
        if (res && res.ok) return res.json;
        if (res && res.status === 404 && allow404) return undefined;
        const status = res ? res.status : 0;
        const retryable = !res || RETRYABLE.has(status);
        if (attempt < retries && retryable) {
          stats.retries++;
          const wait = res && res.retryAfter ? Math.min(10000, res.retryAfter * 1000) : 800 * 3 ** attempt;
          await sleep(wait);
          continue;
        }
        stats.failures++;
        const why = res ? (res.json && (res.json.error || res.json.message)) || `HTTP ${status}` : (err && err.name === 'TimeoutError' ? 'timeout' : 'network error');
        throw new MemoryHttpError(`${method} ${routeOf(path)}: ${String(why).slice(0, 120)}`, status);
      }
    } finally {
      release();
    }
  }

  const ns = (n) => `/ns/${encodeURIComponent(n)}`;
  return {
    kind: 'supermemory',
    addDocument(n, doc, o) { return request('POST', `${ns(n)}/document`, doc, { timeoutMs: 15000, retries: 2, ...o }); },
    patchDocument(n, id, patch, o) { return request('PATCH', `${ns(n)}/document/${encodeURIComponent(id)}`, patch, { timeoutMs: 8000, retries: 2, ...o }); },
    getDocument(n, id, o) { return request('GET', `${ns(n)}/document/${encodeURIComponent(id)}`, undefined, { timeoutMs: 3000, allow404: true, ...o }); },
    getDocumentWithMemories(n, id, o) { return request('GET', `${ns(n)}/document/${encodeURIComponent(id)}?include=memories`, undefined, { timeoutMs: 5000, allow404: true, ...o }); },
    search(n, query, { limit = 8, threshold = 0.3, ...o } = {}) {
      return request('POST', `${ns(n)}/search`, { query, searchMode: 'hybrid', limit, threshold }, { timeoutMs: 4500, ...o });
    },
    profile(n, o) { return request('POST', `${ns(n)}/profile`, {}, { timeoutMs: 3000, allow404: true, ...o }); },
    listMemories(n, limit = 100, o) { return request('POST', `${ns(n)}/list/memories?limit=${limit | 0}`, {}, { timeoutMs: 8000, ...o }); },
    getNamespace(n, o) { return request('GET', ns(n), undefined, { timeoutMs: 4000, allow404: true, ...o }); },
    get pending() { return inflight + queue.length; },
  };
}

// ------------------------------------------------------------------ mock (SUPERMEMORY_MOCK=1)

/**
 * In-process stand-in with the same methods and the same semantics that matter to the game:
 * POST with an existing id appends, PATCH merges metadata, GET returns metadata verbatim,
 * search is a deterministic word-overlap ranking over one "memory" per sentence of every
 * non-superrag document, profile lists recent memories. `store` can be shared between two mock
 * clients to simulate a server restart. Every request is recorded in `log` (for the tests).
 */
export function createMockStore() { return { namespaces: new Map(), log: [] }; }

export function createMockClient({ store = createMockStore(), latencyMs = 0, stats = {} } = {}) {
  stats.requests = stats.requests || 0; stats.failures = stats.failures || 0; stats.retries = stats.retries || 0;
  const delay = () => new Promise((r) => (latencyMs > 0 ? setTimeout(r, latencyMs) : setImmediate(r)));
  const nsOf = (n, create) => {
    let s = store.namespaces.get(n);
    if (!s && create) { s = { docs: new Map(), supportingContext: null }; store.namespaces.set(n, s); }
    return s;
  };
  const words = (t) => String(t).toLowerCase().match(/[a-z0-9%]+/g) || [];
  const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'with', 'to', 'this', 'does', 'did', 'which', 'what', 'where', 'how', 'player', 'is', 'it', 'for', 'has', 'have']);
  function memoriesOf(s) {
    const out = [];
    for (const d of s.docs.values()) {
      if (d.taskType === 'superrag') continue;
      for (const sent of d.content.split(/(?<=[.!?])\s+|\n+/)) {
        const m = sent.trim();
        if (m.length > 12) out.push({ id: d.id + ':' + out.length, memory: m, metadata: { ...d.metadata }, at: d.updatedAt });
      }
    }
    return out;
  }
  async function op(kind, n, payload, fn) {
    stats.requests++;
    store.log.push({ kind, ns: n, payload: payload === undefined ? undefined : JSON.parse(JSON.stringify(payload)) });
    await delay();
    return fn();
  }
  let clock = 0;
  return {
    kind: 'mock',
    store,
    addDocument(n, doc) {
      return op('add', n, doc, () => {
        const s = nsOf(n, true);
        if (typeof doc.supportingContext === 'string') s.supportingContext = doc.supportingContext;
        const id = doc.id || `doc${s.docs.size + 1}`;
        const prev = s.docs.get(id);
        const t = ++clock;
        if (prev) {
          if (!prev.content.includes(doc.content)) prev.content += '\n' + doc.content;
          if (doc.metadata) Object.assign(prev.metadata, doc.metadata);
          prev.updatedAt = t;
        } else {
          s.docs.set(id, { id, content: String(doc.content || ''), metadata: { ...(doc.metadata || {}) }, taskType: doc.taskType || 'memory', dreaming: doc.dreaming, createdAt: t, updatedAt: t });
        }
        return { id, status: 'done' };
      });
    },
    patchDocument(n, id, patch) {
      return op('patch', n, { id, ...patch }, () => {
        const s = nsOf(n, false);
        const d = s && s.docs.get(id);
        if (!d) { stats.failures++; throw new MemoryHttpError('PATCH /ns/:ns/document/:id: Document not found', 404); }
        if (patch.metadata) Object.assign(d.metadata, patch.metadata);
        if (typeof patch.content === 'string') d.content = patch.content;
        d.updatedAt = ++clock;
        return { id, status: 'done' };
      });
    },
    getDocument(n, id) {
      return op('get', n, { id }, () => {
        const s = nsOf(n, false);
        const d = s && s.docs.get(id);
        if (!d) return undefined;
        return { id: d.id, content: d.content, metadata: { ...d.metadata }, system: { status: 'done', dreamingStatus: 'done' } };
      });
    },
    getDocumentWithMemories(n, id) { return this.getDocument(n, id); },
    search(n, query, { limit = 8 } = {}) {
      return op('search', n, { query, searchMode: 'hybrid', limit }, () => {
        const s = nsOf(n, false);
        if (!s) return { results: [] };
        const q = new Set(words(query).filter((w) => !STOP.has(w)));
        const scored = [];
        for (const m of memoriesOf(s)) {
          let hit = 0;
          for (const w of new Set(words(m.memory))) if (q.has(w)) hit++;
          if (hit > 0) scored.push({ id: m.id, memory: m.memory, metadata: m.metadata, similarity: Math.min(0.99, 0.3 + hit * 0.08), at: m.at });
        }
        scored.sort((a, b) => b.similarity - a.similarity || b.at - a.at);
        return { results: scored.slice(0, limit).map(({ at, ...r }) => r), searchTime: 1 };
      });
    },
    profile(n) {
      return op('profile', n, {}, () => {
        const s = nsOf(n, false);
        if (!s) return undefined;
        const mem = memoriesOf(s).slice(-20).map((m) => ({ id: m.id, memory: m.memory }));
        return { profile: { static: [], dynamic: mem, buckets: {} } };
      });
    },
    listMemories(n) { return op('list', n, {}, () => { const s = nsOf(n, false); return { memories: s ? memoriesOf(s) : [] }; }); },
    getNamespace(n) { return op('ns', n, {}, () => { const s = nsOf(n, false); return s ? { namespace: n, supportingContext: s.supportingContext } : undefined; }); },
    get pending() { return 0; },
  };
}

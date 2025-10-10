// worker.mjs — Solara API v11.0 (Op‑log + Server Sequencer + Ephemeral Awareness)
// Cloudflare Worker + Durable Object (ROOM)
//
// Durable (persisted):
//   - POST /ops                 -> append op (idempotent), assign global seq, materialize (periodic snapshot), broadcast
//   - GET  /sync?workspace_id&since=N  -> incremental ops if small gap; else snapshot
//   - GET  /state?workspace_id  -> latest snapshot + base_seq
//   - RBAC, shares, presence endpoints kept
// Ephemeral (WS only):
//   - aware:update / aware:blur (typing, caret)
//   - delta:content (tiny live text deltas; NOT persisted)
//
// DB (D1) tables (created/migrated automatically):
//   users, workspaces, shares, presence
//   workspace_state(workspace_id PK, tabs_json TEXT, base_seq INTEGER, updated_at TEXT)
//   ops(ws TEXT, seq INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT UNIQUE, client_id TEXT, base_seq INTEGER, ts INTEGER, type TEXT, payload TEXT)
//
// Env bindings: DB (D1), ROOM (Durable Object binding),
//               STYTCH_PROJECT_ID, STYTCH_SECRET (auth),
//               RESEND_API_KEY (optional), INVITE_FROM (optional),
//               ALLOWED_ORIGINS, ROUTE_PREFIX, APP_BASE_URL (optional)

const SNAPSHOT_EVERY = 1500;     // ops
const MAX_SYNC_OPS   = 1500;     // ops window before sending snapshot

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    const method = req.method.toUpperCase();

    if (method === 'OPTIONS') return withCORS(env, origin, new Response(null, { status: 204 }));

    const path = normalizePath(url.pathname, env);

    await ensureSchema(env);

    // Index
    if (path === '/' && method === 'GET') {
      return J({ ok: true, service: 'Solara API v11.0', endpoints: [
        'GET /__health','POST /logout','GET /auth/check',
        'GET /workspaces','POST /workspaces','GET /workspaces/:id/role','POST /workspaces/:id/transfer_owner',
        'GET /shares?workspace_id=...','POST /shares','POST /shares/accept','PATCH /shares/:id','DELETE /shares/:id',
        'POST /presence/beat','GET /presence?workspace_id=...',
        'GET /state?workspace_id=...','GET /sync?workspace_id=...&since=...','POST /ops',
        'GET /live?ws=...&token=...'
      ], prefix: env.ROUTE_PREFIX || '' }, 200, origin, env);
    }

    // Health
    if (path === '/__health' && method === 'GET') {
      const dbOK = await quickDbCheck(env).catch(() => false);
      const hasStytch = !!(env.STYTCH_PROJECT_ID && env.STYTCH_SECRET);
      const hasDO = !!env.ROOM;
      return J({ ok: true, dbOK, hasStytch, hasDO }, 200, origin, env);
    }

    // No-op logout (for UI convenience)
    if (path === '/logout' && method === 'POST') {
      return J({ ok: true }, 200, origin, env);
    }

    // Live (WS upgrade -> DO)
    if (path === '/live' && method === 'GET') {
      const wsId = url.searchParams.get('ws') || '';
      const token = url.searchParams.get('token') || '';
      if (!wsId || !token) return J({ error: 'bad_request' }, 400, origin, env);

      let auth;
      try { auth = await verifySessionToken(token, env); }
      catch { return J({ error: 'unauthorized' }, 401, origin, env); }

      const can = await canAccessWorkspace(env, auth, wsId);
      if (!can) return J({ error: 'not_found' }, 404, origin, env);
      if (!env.ROOM) return J({ error: 'live_not_configured' }, 501, origin, env);

      const upgrade = req.headers.get('Upgrade') || '';
      if (upgrade.toLowerCase() !== 'websocket') return J({ error: 'upgrade_required' }, 426, origin, env);

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const stub = env.ROOM.get(wsDoId(env, wsId));
      await stub.fetch(`https://do/live?ws=${encodeURIComponent(wsId)}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'Upgrade': 'websocket' },
        body: JSON.stringify({ auth, token }), webSocket: server
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    // Auth
    if (path === '/auth/check' && method === 'GET') {
      const auth = await verifySession(req, env); await upsertUser(env, auth);
      return J({ user_id: auth.user_id, email: auth.email, name: auth.name }, 200, origin, env);
    }

    // Workspaces
    if (path === '/workspaces' && method === 'GET') {
      const auth = await verifySession(req, env); await upsertUser(env, auth);
      const rows = await listWorkspaces(env, auth);
      return J({ workspaces: rows }, 200, origin, env);
    }
    if (path === '/workspaces' && method === 'POST') {
      const auth = await verifySession(req, env); await upsertUser(env, auth);
      const body = await readJson(req);
      const name = (body?.name || '').trim(); if (!name) return J({ error: 'name_required' }, 400, origin, env);
      const ws = await createWorkspace(env, auth, name);
      return J({ workspace: ws }, 201, origin, env);
    }
    if (path.startsWith('/workspaces/') && path.endsWith('/role') && method === 'GET') {
      const auth = await verifySession(req, env); await upsertUser(env, auth);
      const id = path.split('/')[2];
      const role = await roleFor(env, auth, id);
      if (role === 'none') return J({ error: 'not_found' }, 404, origin, env);
      return J({ role }, 200, origin, env);
    }
    if (path.startsWith('/workspaces/') && path.endsWith('/transfer_owner') && method === 'POST') {
      const auth = await verifySession(req, env); await upsertUser(env, auth);
      const id = path.split('/')[2];
      if (!(await isOwner(env, auth, id))) return J({ error: 'forbidden' }, 403, origin, env);
      const body = await readJson(req);
      const toEmail = (body?.to_email || '').trim().toLowerCase(); if (!toEmail) return J({ error: 'to_email_required' }, 400, origin, env);
      const ok = await transferOwner(env, id, toEmail);
      if (!ok) return J({ error: 'not_found_or_not_member' }, 404, origin, env);
      return J({ ok: true }, 200, origin, env);
    }

    // Presence (HTTP fallback)
    if (path === '/presence/beat' && method === 'POST') {
      const auth = await verifySession(req, env); await upsertUser(env, auth);
      const { workspace_id = '' } = await readJson(req);
      const wid = workspace_id.trim(); if (!wid) return J({ error: 'workspace_id_required' }, 400, origin, env);
      if (!(await canAccessWorkspace(env, auth, wid))) return J({ error: 'not_found' }, 404, origin, env);
      await env.DB.prepare(`
        INSERT INTO presence (workspace_id, user_id, name, email, last_seen)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(workspace_id, user_id) DO UPDATE SET
          name = excluded.name, email = excluded.email, last_seen = CURRENT_TIMESTAMP
      `).bind(wid, auth.user_id, auth.name || null, (auth.email||'') || null).run();
      await env.DB.prepare(`DELETE FROM presence WHERE datetime(last_seen) < datetime('now','-2 days')`).run();
      return J({ ok: true }, 200, origin, env);
    }
    if (path === '/presence' && method === 'GET') {
      const auth = await verifySession(req, env); await upsertUser(env, auth);
      const wid = new URL(req.url).searchParams.get('workspace_id') || '';
      if (!wid) return J({ error: 'workspace_id_required' }, 400, origin, env);
      if (!(await canAccessWorkspace(env, auth, wid))) return J({ error: 'not_found' }, 404, origin, env);
      const rs = await env.DB.prepare(`
        SELECT user_id AS id, COALESCE(name,'') AS name, COALESCE(email,'') AS email
        FROM presence
        WHERE workspace_id = ? AND datetime(last_seen) >= datetime('now','-40 seconds')
      `).bind(wid).all();
      return J({ online: rs.results || [] }, 200, origin, env);
    }

    // State (snapshot) for cold start
    if (path === '/state' && method === 'GET') {
      const auth = await verifySession(req, env); await upsertUser(env, auth);
      const wid = new URL(req.url).searchParams.get('workspace_id'); if (!wid) return J({ error: 'workspace_id_required' }, 400, origin, env);
      const can = await canAccessWorkspace(env, auth, wid); if (!can) return J({ error: 'not_found' }, 404, origin, env);
      const snap = await getSnapshot(env, wid);
      return J(snap, 200, origin, env); // {tabs, base_seq, updated_at}
    }

    // Append op (HTTP path). Prefer WS, but HTTP works offline/fallback.
    if (path === '/ops' && method === 'POST') {
      const auth = await verifySession(req, env); await upsertUser(env, auth);
      const body = await readJson(req);
      const wid = (body?.workspace_id || '').trim(); if (!wid) return J({ error: 'workspace_id_required' }, 400, origin, env);
      const role = await roleFor(env, auth, wid); if (role === 'viewer' || role === 'none') return J({ error: 'forbidden' }, 403, origin, env);

      const op = sanitizeOp(body?.op, auth.user_id);
      if (!op) return J({ error: 'invalid_op' }, 400, origin, env);

      // Use DO as sequencer to avoid multi-edge races
      const stub = env.ROOM.get(wsDoId(env, wid));
      const r = await stub.fetch(`https://do/append?ws=${encodeURIComponent(wid)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op })
      });
      if (!r.ok) return J({ error: 'append_failed' }, 500, origin, env);
      const data = await r.json(); // {seq}
      return J({ ok: true, seq: data.seq }, 200, origin, env);
    }

    // Sync (ops since)
    if (path === '/sync' && method === 'GET') {
      const auth = await verifySession(req, env); await upsertUser(env, auth);
      const wid = new URL(req.url).searchParams.get('workspace_id'); if (!wid) return J({ error: 'workspace_id_required' }, 400, origin, env);
      const since = Math.max(0, parseInt(new URL(req.url).searchParams.get('since')||'0',10));
      const can = await canAccessWorkspace(env, auth, wid); if (!can) return J({ error: 'not_found' }, 404, origin, env);
      const topRow = await env.DB.prepare('SELECT MAX(seq) AS maxseq FROM ops WHERE ws=?').bind(wid).first();
      const maxseq = Number(topRow?.maxseq||0);
      if (maxseq - since > MAX_SYNC_OPS) {
        const snap = await getSnapshot(env, wid);
        return J({ mode:'snapshot', ...snap }, 200, origin, env);
      }
      const rs = await env.DB.prepare('SELECT seq, op_id, client_id, base_seq, ts, type, payload FROM ops WHERE ws=? AND seq>? ORDER BY seq ASC LIMIT ?').bind(wid, since, MAX_SYNC_OPS+10).all();
      const ops = (rs.results||[]).map(r=>({ seq:r.seq, op_id:r.op_id, client_id:r.client_id, base_seq:r.base_seq, ts:r.ts, type:r.type, payload: tryParseJSON(r.payload) }));
      return J({ mode:'ops', ops, maxseq }, 200, origin, env);
    }

    return J({ error: 'not_found', path }, 404, origin, env);
  }
};

/* -------------------- Durable Object: Room (sequencer + WS fanout) -------------------- */
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map();   // user_id -> Set<WebSocket>
    this.meta = new Map();      // user_id -> {name,email,ws}
    this.aware = new Map();     // user_id -> { taskId, caretStart, caretEnd, color, name, ts, wsId }
    this.acks = new Map();      // user_id -> lastSeqAck
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/live' && req.method === 'POST') {
      const body = await req.json();
      const { auth } = body || {};
      const ws = req.webSocket; ws.accept();

      const wsId = url.searchParams.get('ws') || '';
      const uid = auth.user_id;

      if (!this.sockets.has(uid)) this.sockets.set(uid, new Set());
      this.sockets.get(uid).add(ws);
      this.meta.set(uid, { name: auth.name || '', email: auth.email || '', ws: wsId });

      ws.addEventListener('close', () => this._leave(uid, ws));
      ws.addEventListener('error', () => this._leave(uid, ws));
      ws.addEventListener('message', (ev) => this._onMessage(uid, ev));

      // Initial hello: snapshot meta (aware state comes from this.aware)
      const awareInit = [...this.aware.entries()].map(([id, a]) => ({ id, ...a })).filter(a => a.wsId === wsId);
      // We do not push snapshot here (HTTP /state handles cold start). We do expose current top seq.
      const topRow = await this.env.DB.prepare('SELECT MAX(seq) AS maxseq FROM ops WHERE ws=?').bind(wsId).first();
      const maxseq = Number(topRow?.maxseq||0);

      ws.send(JSON.stringify({ type:'hello', ws: wsId, you: { user_id: uid, email: auth.email, name: auth.name }, online: this._others(wsId, uid), aware: awareInit, maxseq }));
      this._broadcast({ type: 'presence/join', ws: wsId, by: uid, name: auth.name || '', email: auth.email || '' }, uid, wsId);
      return new Response('ok', { status: 200 });
    }

    // Append op via DO (authoritative sequencer)
    if (path === '/append' && req.method === 'POST') {
      const urlWs = url.searchParams.get('ws') || '';
      const { op } = await req.json();
      const saved = await appendOpAndMaybeSnapshot(this.env, urlWs, op);
      // Broadcast to room
      this._broadcast({ type:'op', ws: urlWs, seq: saved.seq, op: saved.op }, null, urlWs);
      return new Response(JSON.stringify({ seq: saved.seq }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    return new Response('not_found', { status: 404 });
  }

  async _onMessage(uid, ev) {
    let msg = null; try { msg = JSON.parse(ev.data || '{}'); } catch { return; }
    const wsId = msg?.ws || '';
    if (!wsId) return;

    // Awareness
    if (msg.type === 'aware:update') {
      const { taskId, caretStart, caretEnd, color, name } = msg;
      this.aware.set(uid, { taskId, caretStart, caretEnd, color, name, ts: Date.now(), wsId });
      this._broadcastAwareness(wsId);
      return;
    }
    if (msg.type === 'aware:blur') {
      this.aware.delete(uid); this._broadcastAwareness(wsId); return;
    }

    // Ephemeral text delta (not persisted)
    if (msg.type === 'delta:content') {
      const { taskId, field = 'content', value, upd = Date.now() } = msg;
      this._broadcast({ type: 'tabs:delta', ws: wsId, by: uid, delta: { taskId, field, value, upd } }, null, wsId);
      return;
    }

    // Durable op via WS
    if (msg.type === 'op:append') {
      try {
        const saved = await appendOpAndMaybeSnapshot(this.env, wsId, sanitizeOp(msg.op, uid));
        this._broadcast({ type:'op', ws: wsId, seq: saved.seq, op: saved.op }, null, wsId);
      } catch {}
      return;
    }

    if (msg.type === 'op:ack') {
      const seq = Number(msg.seq||0); this.acks.set(uid, seq); return;
    }
  }

  _others(wsId, excludeUid) {
    return [...this.meta.entries()].filter(([id, m]) => id !== excludeUid && m.ws === wsId).map(([id, m]) => ({ id, name: m.name, email: m.email }));
  }

  _leave(uid, ws) {
    const set = this.sockets.get(uid);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        const m = this.meta.get(uid);
        this.sockets.delete(uid);
        this.meta.delete(uid);
        this.aware.delete(uid);
        this._broadcast({ type: 'presence/leave', by: uid, ws: m?.ws || '' }, uid, m?.ws || '');
        this._broadcastAwareness(m?.ws || '');
      }
    }
  }

  _broadcast(payload, exceptUserId = null, wsIdScope = null) {
    const data = JSON.stringify(payload);
    for (const [uid, set] of this.sockets.entries()) {
      if (exceptUserId && uid === exceptUserId) continue;
      const meta = this.meta.get(uid); if (wsIdScope && meta?.ws !== wsIdScope) continue;
      for (const ws of set) { try { ws.send(data); } catch {}
      }
    }
  }

  _pruneAwareness() {
    const now = Date.now();
    for (const [uid, a] of this.aware) if (!a || now - a.ts > 8000) this.aware.delete(uid);
  }

  _broadcastAwareness(wsId) {
    this._pruneAwareness();
    const snapshot = [...this.aware.entries()].map(([id, a]) => ({ id, ...a })).filter(a => a.wsId === wsId);
    this._broadcast({ type: 'aware:state', ws: wsId, aware: snapshot }, null, wsId);
  }
}

/* -------------------- Op persistence + snapshotting -------------------- */
function tryParseJSON(s){ try{ return JSON.parse(s); }catch{ return null; } }

function sanitizeOp(op, client_id){
  if (!op || typeof op !== 'object') return null;
  const type = String(op.type||'').trim();
  if (!type) return null;
  const op_id = String(op.op_id||'').trim();
  if (!op_id) return null;
  const base_seq = Number(op.base_seq||0);
  const ts = Number(op.ts||Date.now());
  const payload = (op.payload && typeof op.payload === 'object') ? op.payload : {};
  return { op_id, client_id: String(op.client_id||client_id||'').trim(), base_seq, ts, type, payload };
}

async function appendOpAndMaybeSnapshot(env, wsId, op){
  // Insert op idempotently; if duplicate, return existing seq
  const payloadStr = JSON.stringify(op.payload||{});
  let row = null; let seq = null;
  try {
    await env.DB.prepare('INSERT INTO ops (ws, op_id, client_id, base_seq, ts, type, payload) VALUES (?,?,?,?,?,?,?)')
      .bind(wsId, op.op_id, op.client_id, op.base_seq, op.ts, op.type, payloadStr).run();
    const r2 = await env.DB.prepare('SELECT seq FROM ops WHERE op_id = ?').bind(op.op_id).first();
    seq = Number(r2?.seq||0);
  } catch (e) {
    const r3 = await env.DB.prepare('SELECT seq FROM ops WHERE op_id = ?').bind(op.op_id).first();
    seq = Number(r3?.seq||0);
  }

  if (!seq) {
    const r = await env.DB.prepare('SELECT seq FROM ops WHERE op_id = ?').bind(op.op_id).first();
    seq = Number(r?.seq||0);
  }

  // Periodic snapshot: apply op to current snapshot and bump base_seq
  if (seq % SNAPSHOT_EVERY === 0) {
    try {
      const snap = await getSnapshot(env, wsId);
      const tabs = applyOpToTabs(snap.tabs, op);
      await saveSnapshot(env, wsId, tabs, seq);
    } catch {}
  }

  return { seq, op };
}

function deepClone(x){ return JSON.parse(JSON.stringify(x||{})); }

function ensureTabShape(tabs, tab){
  if (!tabs[tab]) tabs[tab] = { todo:[], inprogress:[], done:[] };
  const cols = ['todo','inprogress','done'];
  cols.forEach(c=>{ if (!Array.isArray(tabs[tab][c])) tabs[tab][c] = []; });
}

function normalizeTask(t){
  return {
    id: String(t.id||'').trim() || `task-${Math.random().toString(36).slice(2)}`,
    content: typeof t.content==='string'?t.content:'',
    dueDate: (/^\d{4}-\d{2}-\d{2}$/.test(t.dueDate||''))?t.dueDate:'',
    priority: ['High','Medium','Low'].includes(t.priority)?t.priority:'Medium',
    pos: Number.isFinite(+t.pos)?+t.pos:0,
    upd: Number.isFinite(+t.upd)?+t.upd:Date.now(),
    by: t.by||null
  };
}

function reindex(list){ list.forEach((t,i)=> t.pos = i+1); }
function newPosBetween(prev, next){ const A=Number.isFinite(prev)?+prev:0; const B=Number.isFinite(next)?+next:A+2; if (B-A>1e-6) return A+(B-A)/2; return A+0.000001; }

function applyOpToTabs(currTabs, op){
  const tabs = deepClone(currTabs||{});
  const cols = ['todo','inprogress','done'];
  const p = op.payload||{};

  if (op.type === 'create_task'){
    const tab = String(p.tab||'').trim()||'Default'; ensureTabShape(tabs, tab);
    const col = cols.includes(p.column)?p.column:'todo';
    const task = normalizeTask(p.task||{});
    const list = tabs[tab][col];
    // insert at pos (fractional) or end
    if (Number.isFinite(+task.pos)){
      // find insert index by position relative to neighbors
      let idx = list.findIndex(x=>x.pos>task.pos);
      if (idx<0) idx = list.length;
      list.splice(idx,0,task);
      reindex(list);
    } else { task.pos=(list[list.length-1]?.pos||0)+1; list.push(task); }
    return tabs;
  }

  if (op.type === 'update_task_field'){
    const id = String(p.task_id||''); const field = String(p.field||'');
    for (const tab of Object.keys(tabs)){
      for (const c of cols){
        const list = tabs[tab][c]; const t = list.find(x=>x.id===id);
        if (t){
          if (field==='content') t.content = String(p.value||'');
          else if (field==='dueDate') t.dueDate = (/^\d{4}-\d{2}-\d{2}$/.test(p.value||''))?p.value:'';
          else if (field==='priority' && ['High','Medium','Low'].includes(p.value)) t.priority = p.value;
          t.upd = Number(op.ts||Date.now()); t.by = op.client_id;
          return tabs;
        }
      }
    }
    return tabs;
  }

  if (op.type === 'move_task'){
    const id = String(p.task_id||''); const to = cols.includes(p.to)?p.to:'todo'; const tab = String(p.tab||'').trim()||'';
    let sourceTab = tab; // allow cross-tab later; for now assume within active tab
    // find task
    let foundTab=null, fromCol=null, idx=-1, task=null;
    for (const tb of Object.keys(tabs)){
      for (const c of cols){
        const i = tabs[tb][c].findIndex(x=>x.id===id);
        if (i!==-1){ foundTab=tb; fromCol=c; idx=i; task = tabs[tb][c][i]; break; }
      }
      if (task) break;
    }
    if (!task) return tabs;
    const pos = Number.isFinite(+p.pos)?+p.pos:null;
    // remove
    tabs[foundTab][fromCol].splice(idx,1); reindex(tabs[foundTab][fromCol]);
    // insert
    ensureTabShape(tabs, foundTab);
    const list = tabs[foundTab][to];
    if (pos==null) { task.pos=(list[list.length-1]?.pos||0)+1; list.push(task); }
    else {
      let insertAt = list.findIndex(x=>x.pos>pos); if (insertAt<0) insertAt=list.length;
      task.pos = pos; list.splice(insertAt,0,task); reindex(list);
    }
    task.upd = Number(op.ts||Date.now()); task.by = op.client_id;
    return tabs;
  }

  if (op.type === 'delete_task'){
    const id = String(p.task_id||'');
    for (const tab of Object.keys(tabs)){
      for (const c of cols){
        const i = tabs[tab][c].findIndex(x=>x.id===id);
        if (i!==-1){ tabs[tab][c].splice(i,1); reindex(tabs[tab][c]); return tabs; }
      }
    }
    return tabs;
  }

  if (op.type === 'rename_tab'){
    const from = String(p.from||''); const to = String(p.to||'');
    if (!from || !to || from===to) return tabs;
    if (!tabs[from]) return tabs;
    if (tabs[to]) return tabs; // no overwrite
    tabs[to] = tabs[from]; delete tabs[from];
    return tabs;
  }

  return tabs;
}

async function getSnapshot(env, wid){
  const row = await env.DB.prepare('SELECT tabs_json, base_seq, updated_at FROM workspace_state WHERE workspace_id=?').bind(wid).first();
  let tabs = {}; let base_seq = 0; let updated_at = null;
  if (row && row.tabs_json) { try { tabs = JSON.parse(row.tabs_json); } catch { tabs = {}; } }
  base_seq = Number(row?.base_seq||0); updated_at = row?.updated_at||null;
  return { tabs: sanitizeTabs(tabs), base_seq, updated_at };
}

function sanitizeTabs(tabs){
  const out = {}; const cols=['todo','inprogress','done'];
  Object.keys(tabs||{}).forEach(tab=>{ out[tab] = { todo:[], inprogress:[], done:[] }; cols.forEach(c=>{ const list = Array.isArray(tabs[tab]?.[c])?tabs[tab][c]:[]; const mapped=list.map(normalizeTask); mapped.sort((a,b)=> (a.pos||0)-(b.pos||0)); mapped.forEach((t,i)=> t.pos=i+1); out[tab][c]=mapped; }); });
  return out;
}

async function saveSnapshot(env, wid, tabs, base_seq){
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO workspace_state (workspace_id, tabs_json, base_seq, updated_at)
    VALUES (?,?,?,?)
    ON CONFLICT(workspace_id) DO UPDATE SET tabs_json=excluded.tabs_json, base_seq=excluded.base_seq, updated_at=excluded.updated_at
  `).bind(wid, JSON.stringify(sanitizeTabs(tabs)), Number(base_seq||0), now).run();
}

/* -------------------- Utilities & Schema -------------------- */
function normalizePath(pathname, env) {
  const prefix = (env.ROUTE_PREFIX || '').trim();
  if (!prefix) return pathname.replace(/\/+$/,'') || '/';
  const want = prefix.startsWith('/') ? prefix : '/' + prefix;
  let p = pathname; if (p.startsWith(want)) p = p.slice(want.length) || '/';
  return p.replace(/\/+$/,'') || '/';
}
function withCORS(env, origin, res) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allow = allowed.length ? (allowed.includes(origin) ? origin : allowed[0]) : (origin || '*');
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', allow);
  h.set('Vary', 'Origin');
  h.set('Access-Control-Allow-Credentials', 'true');
  h.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'authorization, content-type');
  return new Response(res.body, { status: res.status, headers: h });
}
function J(data, status, origin, env) { return withCORS(env, origin, new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })); }
async function readJson(req){ if(!req.body) return {}; try{ return await req.json(); } catch { return {}; } }
function wsDoId(env, wsId){ return env.ROOM.idFromName(`ws:${wsId}`); }

async function verifySession(req, env){
  const h = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i); const jwt = m ? m[1] : null; if (!jwt) throw new Error('unauthorized');
  return await verifySessionToken(jwt, env);
}
async function verifySessionToken(jwt, env){
  if (!env.STYTCH_PROJECT_ID || !env.STYTCH_SECRET) throw new Error('server_misconfig');
  const auth = btoa(`${env.STYTCH_PROJECT_ID}:${env.STYTCH_SECRET}`);
  const res = await fetch(`${stytchBase(env)}/v1/sessions/authenticate`, { method:'POST', headers:{ 'content-type':'application/json', authorization:`Basic ${auth}` }, body: JSON.stringify({ session_jwt: jwt }) });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error('stytch_error');
  const data = await res.json();
  const user = data?.user || {};
  const user_id = data?.user_id || user?.user_id || data?.session?.user_id || '';
  const email = (user?.email_addresses?.[0]?.email_address) || data?.email || '';
  const name = [user?.name?.first_name, user?.name?.last_name].filter(Boolean).join(' ') || data?.name || '';
  if (!user_id) throw new Error('unauthorized');
  return { user_id, email, name };
}
function stytchBase(env){ const pid=env.STYTCH_PROJECT_ID||'', sec=env.STYTCH_SECRET||''; return (/test/.test(pid)||/test/.test(sec))?'https://test.stytch.com':'https://api.stytch.com'; }
async function quickDbCheck(env){ try{ await env.DB.exec('PRAGMA foreign_keys = ON;'); await env.DB.exec('SELECT 1;'); return true; }catch{ return false; } }

async function ensureSchema(env){
  await env.DB.batch([
    env.DB.prepare('PRAGMA foreign_keys = ON;'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, name TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE CASCADE);`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, email TEXT, invited_at TEXT DEFAULT CURRENT_TIMESTAMP, accepted_by_user_id TEXT, role TEXT DEFAULT 'editor', token TEXT, UNIQUE(workspace_id,email), FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE);`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS presence (workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT, email TEXT, last_seen TEXT, PRIMARY KEY(workspace_id, user_id));`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_state (workspace_id TEXT PRIMARY KEY, tabs_json TEXT NOT NULL DEFAULT '{}', base_seq INTEGER NOT NULL DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE);`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS ops (ws TEXT NOT NULL, seq INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT UNIQUE, client_id TEXT, base_seq INTEGER, ts INTEGER, type TEXT, payload TEXT)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_id);'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_shares_ws ON shares(workspace_id);'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_presence_ws_seen ON presence(workspace_id, last_seen);'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_ops_ws_seq ON ops(ws, seq);')
  ]);
  // Idempotent migrations
  await env.DB.prepare(`ALTER TABLE shares ADD COLUMN role TEXT DEFAULT 'editor';`).run().catch(()=>{});
  await env.DB.prepare(`ALTER TABLE shares ADD COLUMN token TEXT;`).run().catch(()=>{});
  await env.DB.prepare(`ALTER TABLE shares ADD COLUMN accepted_by_user_id TEXT;`).run().catch(()=>{});
  await env.DB.prepare(`ALTER TABLE workspace_state ADD COLUMN base_seq INTEGER NOT NULL DEFAULT 0;`).run().catch(()=>{});
}

async function upsertUser(env, { user_id, email, name }){
  const now = new Date().toISOString();
  const row = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(user_id).first();
  if (row) await env.DB.prepare('UPDATE users SET email=?, name=?, updated_at=? WHERE id=?').bind(email||null, name||null, now, user_id).run();
  else await env.DB.prepare('INSERT INTO users (id,email,name,created_at,updated_at) VALUES (?,?,?,?,?)').bind(user_id, email||null, name||null, now, now).run();
}

function uuid(){ try { return crypto.randomUUID(); } catch { return Math.random().toString(36).slice(2); } }

async function listWorkspaces(env, auth){
  const q = `
    SELECT DISTINCT w.id, w.name, w.owner_id, w.created_at, w.updated_at
    FROM workspaces w
    LEFT JOIN shares s ON s.workspace_id = w.id
    WHERE w.owner_id = ?
       OR s.accepted_by_user_id = ?
       OR (s.email IS NOT NULL AND LOWER(s.email) = ?)
    ORDER BY COALESCE(w.updated_at,w.created_at) DESC`;
  const rs = await env.DB.prepare(q).bind(auth.user_id, auth.user_id, (auth.email||'').toLowerCase()).all();
  return rs.results || [];
}
async function isOwner(env, auth, wid){
  const row = await env.DB.prepare('SELECT owner_id FROM workspaces WHERE id=?').bind(wid).first();
  return !!row && row.owner_id === auth.user_id;
}
async function roleFor(env, auth, wid){
  const own = await env.DB.prepare('SELECT owner_id FROM workspaces WHERE id=?').bind(wid).first();
  if (own && own.owner_id === auth.user_id) return 'owner';
  const s = await env.DB.prepare('SELECT role,accepted_by_user_id,email FROM shares WHERE workspace_id=? AND (accepted_by_user_id=? OR LOWER(email)=?) LIMIT 1')
    .bind(wid, auth.user_id, (auth.email||'').toLowerCase()).first();
  return s ? (s.role || 'editor') : 'none';
}
async function canAccessWorkspace(env, auth, wid){
  const row = await env.DB.prepare(`
    SELECT 1 FROM workspaces w
    LEFT JOIN shares s ON s.workspace_id = w.id
    WHERE w.id = ?
      AND (w.owner_id = ? OR s.accepted_by_user_id = ? OR (s.email IS NOT NULL AND LOWER(s.email) = ?))
    LIMIT 1`).bind(wid, auth.user_id, auth.user_id, (auth.email||'').toLowerCase()).first();
  return !!row;
}
async function createWorkspace(env, auth, name){
  const id = uuid(); const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO workspaces (id, owner_id, name, created_at, updated_at) VALUES (?,?,?,?,?)').bind(id, auth.user_id, name, now, now),
    env.DB.prepare('INSERT INTO workspace_state (workspace_id, tabs_json, base_seq, updated_at) VALUES (?,?,?,?)').bind(id, '{}', 0, now)
  ]);
  return { id, name, owner_id: auth.user_id, created_at: now, updated_at: now };
}
async function transferOwner(env, wid, toEmailLower){
  const target = await env.DB.prepare('SELECT accepted_by_user_id,email FROM shares WHERE workspace_id=? AND LOWER(email)=?').bind(wid, toEmailLower).first();
  const userId = target?.accepted_by_user_id || null; if (!userId) return false;
  const now = new Date().toISOString(); await env.DB.prepare('UPDATE workspaces SET owner_id=?, updated_at=? WHERE id=?').bind(userId, now, wid).run();
  return true;
}

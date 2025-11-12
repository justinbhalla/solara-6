// solara-sync.global.js
// Global (non-module) version of the sync utilities so the HTML can include it with a plain <script src="...">
// Exposes window.SolaraSync = { CONFIG, apiUrl, apiFetch, safeJson, RealtimeWs, OpSender, SyncClient }
(function(){
  const CONFIG = {
    API_BASE: 'https://shy-smoke-ab8e.justinbhalla28.workers.dev/',
    PENDING_OPS_KEY: 'solara:pendingOps',
    CLIENT_ID_KEY: 'solara:clientId',
    LAST_SEQ_KEY: 'solara:lastSeq',
    PING_INTERVAL: 10000,
    PRESENCE_POLL: 5000,
    SYNC_POLL_MS: 1500,
  };

  function apiUrl(path){ const base = CONFIG.API_BASE.replace(/\/+$/,''); return base + '/' + String(path||'').replace(/^\/+/, ''); }
  async function apiFetch(path, opts={}){ const headers = Object.assign({'Content-Type':'application/json'}, opts.headers||{}); const cfg = Object.assign({}, opts); cfg.headers = headers; cfg.credentials = 'include'; return fetch(apiUrl(path), cfg); }
  function safeJson(res){ try{ return res.ok? res.json().catch(()=>null) : null; }catch(e){ return null; } }

  class RealtimeWs {
    constructor({ wsUrl, workspaceId, onMessage, onOpen, clientId, sessionJWT }={}){
      this.wsUrl = wsUrl; this.workspaceId = workspaceId; this.onMessage = onMessage||(()=>{}); this.onOpen = onOpen||(()=>{});
      this.clientId = clientId || localStorage.getItem(CONFIG.CLIENT_ID_KEY) || RealtimeWs._genId(); localStorage.setItem(CONFIG.CLIENT_ID_KEY,this.clientId);
      this.sessionJWT = sessionJWT || null; this.ws = null; this.backoff = 1000; this.maxBackoff = 30000; this.shouldReconnect = true;
      this.connect();
    }
    static _genId(){ return 'c_'+Math.random().toString(36).slice(2,10); }
    connect(){ try{ this.ws = new WebSocket(this.wsUrl); this.ws.addEventListener('open', ()=>{ this.backoff=1000; this.onOpen(); this._hello(); }); this.ws.addEventListener('message', ev=>{ let msg; try{ msg=JSON.parse(ev.data); }catch(e){ return; } this.onMessage(msg); }); this.ws.addEventListener('close', ()=>{ if(!this.shouldReconnect) return; setTimeout(()=>this.connect(), this.backoff); this.backoff = Math.min(this.backoff*1.5,this.maxBackoff); }); this.ws.addEventListener('error', ()=>{ try{ this.ws.close(); }catch{} }); }catch(e){ setTimeout(()=>this.connect(), this.backoff); this.backoff=Math.min(this.backoff*1.5,this.maxBackoff); } }
    _hello(){ const lastSeq = Number(localStorage.getItem(CONFIG.LAST_SEQ_KEY)||0); const payload = { type:'hello', ws:this.workspaceId, clientId:this.clientId, lastSeq, token:this.sessionJWT }; this.send(payload); }
    send(obj){ try{ if(this.ws && this.ws.readyState===1){ this.ws.send(JSON.stringify(obj)); return true; } }catch(e){} return false; }
    stop(){ this.shouldReconnect=false; try{ this.ws.close(); }catch{} }
  }

  class OpSender{
    constructor(sendFn, { flushMs=120, maxBatch=40, persistKey=CONFIG.PENDING_OPS_KEY }={}){
      this.sendFn = sendFn; this.flushMs = flushMs; this.maxBatch = maxBatch; this.persistKey = persistKey; this.buffer = [];
      try{ const raw = localStorage.getItem(this.persistKey); if(raw){ const arr = JSON.parse(raw); if(Array.isArray(arr)) this.buffer.push(...arr); } }catch(e){}
      this.timer = null; this.interval = setInterval(()=>this.flush(), 500);
    }
    push(op){ this.buffer.push(op); this._persist(); if(!this.timer) this.timer = setTimeout(()=>this.flush(), this.flushMs); if(this.buffer.length>=this.maxBatch) this.flush(); }
    flush(){ clearTimeout(this.timer); this.timer=null; if(!this.buffer.length) return; const chunk=this.buffer.splice(0,this.maxBatch); const packet={ type:'ops', ops:chunk, ts:Date.now() }; const ok = this.sendFn(packet); if(!ok){ this.buffer.unshift(...chunk); } else { this._persist(); } }
    _persist(){ try{ localStorage.setItem(this.persistKey, JSON.stringify(this.buffer)); }catch(e){} }
    close(){ clearInterval(this.interval); clearTimeout(this.timer); this.flush(); }
  }

  class SyncClient{
    constructor({ workspaceId, sessionJWT=null, onUpdate=null }={}){
      this.workspaceId = workspaceId; this.sessionJWT=sessionJWT; this.onUpdate = onUpdate||(()=>{});
      this.clientId = localStorage.getItem(CONFIG.CLIENT_ID_KEY) || RealtimeWs._genId(); localStorage.setItem(CONFIG.CLIENT_ID_KEY,this.clientId);
      this.lastSeq = Number(localStorage.getItem(CONFIG.LAST_SEQ_KEY)||0);
      this.realtime = null; this.opSender = null; this.wsConnected=false; this.mode='v10';
    }
    async init(){ try{ const r = await apiFetch(`state?workspace_id=${encodeURIComponent(this.workspaceId)}`); if(r.ok) this.mode='v11'; else this.mode='v10'; }catch(e){ this.mode='v10'; }
      const live = this._liveUrl(); if(live){ this.realtime = new RealtimeWs({ wsUrl: live, workspaceId: this.workspaceId, clientId: this.clientId, sessionJWT: this.sessionJWT, onMessage: msg=>this._handleMsg(msg), onOpen: ()=>this._onOpen() }); this.opSender = new OpSender(pkt=>this.realtime.send(pkt)); }
      // start presence poll/beat
      this.presenceInterval = setInterval(()=>{ apiFetch('presence/beat',{ method:'POST', body: JSON.stringify({ workspace_id:this.workspaceId }) }).catch(()=>{}); }, CONFIG.PING_INTERVAL);
      this.presencePoll = setInterval(async ()=>{ try{ const r = await apiFetch(`presence?workspace_id=${encodeURIComponent(this.workspaceId)}`); if(!r.ok) return; const j = await r.json().catch(()=>({online:[]})); this.onUpdate({ type:'presence/poll', data:j.online||[] }); }catch(e){} }, CONFIG.PRESENCE_POLL);
    }
    _liveUrl(){ try{ const u = new URL(CONFIG.API_BASE); u.pathname = (u.pathname.replace(/\/+$/,'') + '/live').replace(/\/\/{2,}/g,'/'); u.search = `?ws=${encodeURIComponent(this.workspaceId)}&token=${encodeURIComponent(this.sessionJWT||'')}`; u.protocol = u.protocol.replace('http','ws'); return u.toString(); }catch(e){ return null; } }
    _onOpen(){ this.wsConnected=true; if(this.opSender) this.opSender.flush(); }
    _handleMsg(msg){ if(!msg||!msg.type) return; if(msg.type==='ops' && msg.seq){ localStorage.setItem(CONFIG.LAST_SEQ_KEY, String(msg.seq)); this.lastSeq = Number(msg.seq); } this.onUpdate(msg); }
    sendOp(op){ op.op_id = op.op_id || ('op_'+Math.random().toString(36).slice(2,10)); op.client_id = this.clientId; op.ts = Date.now(); if(this.wsConnected && this.realtime){ try{ this.realtime.send({ type:'op:append', ws:this.workspaceId, op }); return true; }catch(e){} }
      apiFetch('ops', { method:'POST', body: JSON.stringify({ workspace_id: this.workspaceId, op }) }).catch(()=>{});
      return false;
    }
    stop(){ if(this.realtime) this.realtime.stop(); if(this.opSender) this.opSender.close(); clearInterval(this.presenceInterval); clearInterval(this.presencePoll); }
  }

  // attach to global
  window.SolaraSync = { CONFIG, apiUrl, apiFetch, safeJson, RealtimeWs, OpSender, SyncClient };
})();

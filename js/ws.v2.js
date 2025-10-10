// ws.v2.js — WebSocket live sync + awareness (using oplog.v2)
import { state } from './state.js';
import { fire, stampSync, myColor, myName, debounce } from './utils.js';
import { applySyncResponse } from './oplog.v2.js';

export function liveUrl(){ try{ const u=new URL(state.API_BASE); u.pathname=(u.pathname.replace(/\/+$/,'')+'/live').replace(/\/{2,}/g,'/'); u.search=`?ws=${encodeURIComponent(state.WORKSPACE_ID)}&token=${encodeURIComponent(state.sessionJWT)}`; u.protocol=u.protocol.replace('http','ws'); return u.toString(); }catch{ return null; } }

export function connectLive(){ const url = liveUrl(); if(!url) return; try { state.ws = new WebSocket(url); } catch { return; }
  state.ws.onopen   = ()=>{ state.wsConnected = true; fire('net:ws-open'); };
  state.ws.onclose  = ()=>{ state.wsConnected = false; fire('net:ws-close'); };
  state.ws.onerror  = ()=>{ state.wsConnected = false; fire('net:ws-error'); };
  state.ws.onmessage = (ev)=>{
    let msg={}; try{ msg=JSON.parse(ev.data||'{}'); }catch{}
    if(msg.type==='hello'){
      state.presence.clear(); (msg.online||[]).forEach(p=> state.presence.set(p.id, { name:p.name, email:p.email }));
      fire('presence:changed');
      if (Number(msg.maxseq||0) > state.lastSeq) {
        fetch(state.apiUrl(`sync?workspace_id=${encodeURIComponent(state.WORKSPACE_ID)}&since=${state.lastSeq}`), { headers:{ 'Authorization':`Bearer ${state.sessionJWT}` }})
          .then(r=>r.ok?r.json():Promise.reject()).then(applySyncResponse).catch(()=>{});
      }
      return;
    }
    if(msg.type==='presence/join'){ if(msg.by && msg.by!==state.currentUserKey){ state.presence.set(msg.by, { name:msg.name||'', email:msg.email||'' }); fire('presence:changed'); } return; }
    if(msg.type==='presence/leave'){ state.presence.delete(msg.by); fire('presence:changed'); return; }

    if(msg.type==='aware:state' && msg.ws===state.WORKSPACE_ID){ (msg.aware||[]).forEach(a=> fire('aware:paint', a)); return; }
    if(msg.type==='tabs:delta' && msg.ws===state.WORKSPACE_ID){ fire('delta:apply', msg.delta); return; }

    if(msg.type==='op' && msg.ws===state.WORKSPACE_ID){ const { seq, op } = msg; if (seq !== state.lastSeq + 1) {
        fetch(state.apiUrl(`sync?workspace_id=${encodeURIComponent(state.WORKSPACE_ID)}&since=${state.lastSeq}`), { headers:{ 'Authorization':`Bearer ${state.sessionJWT}` }})
          .then(r=>r.ok?r.json():Promise.reject()).then(applySyncResponse).catch(()=>{}); return;
      }
      if (state.sentButUnacked.has(op.op_id)) { state.sentButUnacked.delete(op.op_id); state.lastSeq = seq; stampSync(); return; }
      import('./oplog.v2.js').then(m=> m.applyOpLocal(op, true)); state.lastSeq = seq; stampSync(); return;
    }
  };
}

export function liveSend(obj){ if (state.ws && state.ws.readyState===1) { try { state.ws.send(JSON.stringify({ ...obj, ws: state.WORKSPACE_ID })); } catch {} } }

// Awareness (ephemeral)
export function sendAware(taskId, start, end){ liveSend({ type:'aware:update', taskId, caretStart:start, caretEnd:end, color: myColor(), name: myName() }); }
export function sendBlurAware(){ liveSend({ type:'aware:blur' }); }
export const sendDelta = debounce((taskId, value)=>{ if (state.wsConnected && (state.ws.bufferedAmount||0) < 1_000_000) { liveSend({ type:'delta:content', taskId, field:'content', value, upd: Date.now() }); } }, 60);

// main.v2.js — app bootstrap (wired to v2 modules)
import { state } from './state.js';
import { stampSync, bus } from './utils.js';
import { verifySessionAndHydrate } from './auth.js';
import { getState as apiGetState, sanitizeTabs, enqueueOp, applySyncResponse, scheduleContentDurable, flushContentDurable, flushOpQueue } from './oplog.v2.js';
import { connectLive } from './ws.v2.js';
import { renderTabs, renderBoard, switchTab, wireTopBar, wireFooter, renderPresence } from './ui.v2.js';
import { wireMembers } from './members.js';

function setReportsHref(){ const btn=document.getElementById('reportsLink'); if(btn){ btn.onclick=()=>{ if(!state.WORKSPACE_ID){ alert('Open a workspace first.'); return; } location.href=`reports.html?ws=${encodeURIComponent(state.WORKSPACE_ID)}`; }; } const logo=document.getElementById('workspacesLink'); if(logo){ logo.href='workspace.html'; } }

async function boot(){
  const ok = await verifySessionAndHydrate();
  if (!ok) {
    const K = 'solara_auth_redirected_once';
    if (!sessionStorage.getItem(K)) {
      sessionStorage.setItem(K, '1');
      const next = encodeURIComponent(location.href);
      location.replace(`/sign-in.html?next=${next}`);
      return;
    } else {
      const b = document.getElementById('wsBanner');
      b.classList.remove('hidden');
      b.innerHTML = '<div class="flex items-center gap-2">Authentication required. <a class="underline font-medium" href="/sign-in.html">Sign in</a></div>';
      return;
    }
  }

  const url=new URL(location.href);
  state.WORKSPACE_ID = url.searchParams.get('ws') || localStorage.getItem('solara_last_ws') || '';
  if(!state.WORKSPACE_ID){ document.getElementById('wsBanner')?.classList.remove('hidden'); } else { localStorage.setItem('solara_last_ws', state.WORKSPACE_ID); }

  try { const r=await fetch(state.apiUrl(`workspaces/${encodeURIComponent(state.WORKSPACE_ID)}/role`), { headers:{ 'Authorization':`Bearer ${state.sessionJWT}` }}); state.currentRole = r.ok ? (await r.json()).role || 'viewer' : 'viewer'; } catch { state.currentRole='viewer'; }

  try { const wlist = await fetch(state.apiUrl('workspaces'), { headers:{ 'Authorization':`Bearer ${state.sessionJWT}` }}).then(r=>r.ok?r.json():{workspaces:[]}).catch(()=>({workspaces:[]})); const wsRow=(wlist.workspaces||[]).find(w=>w.id===state.WORKSPACE_ID); state.WORKSPACE_NAME = wsRow?.name||''; document.getElementById('wsName').textContent = state.WORKSPACE_NAME || '—'; if (wsRow && wsRow.owner_id && state.currentRole !== 'owner' && wsRow.owner_id === state.currentUserKey) state.currentRole = 'owner'; } catch{}

  try { const snap = await apiGetState(); state.tabData = sanitizeTabs(snap.tabs||{}); state.lastSeq = Number(snap.base_seq||0); } catch { state.tabData = { 'Click to edit': { todo:[], inprogress:[], done:[] } }; state.lastSeq = 0; }
  state.activeTab = Object.keys(state.tabData)[0] || 'Click to edit';
  renderTabs(); switchTab(state.activeTab);

  connectLive();
  setInterval(()=>{ fetch(state.apiUrl('presence/beat'), { method:'POST', headers:{ 'Authorization':`Bearer ${state.sessionJWT}`, 'Content-Type':'application/json' }, body: JSON.stringify({ workspace_id: state.WORKSPACE_ID }) }).catch(()=>{}); }, 10000);
  setInterval(async ()=>{ try{ const r=await fetch(state.apiUrl(`presence?workspace_id=${encodeURIComponent(state.WORKSPACE_ID)}`), { headers:{ 'Authorization':`Bearer ${state.sessionJWT}` }}); if(!r.ok) return; const j=await r.json(); state.presence.clear(); (j.online||[]).forEach(p=>{ if(p.id!==state.currentUserKey) state.presence.set(p.id, { name:p.name, email:p.email }); }); renderPresence(); }catch{} }, 5000);

  wireTopBar(); wireFooter(); wireMembers(); setReportsHref();

  document.getElementById('userButton')?.addEventListener('click', ()=> document.getElementById('userMenu')?.classList.toggle('hidden'));
  document.getElementById('addUserBtn')?.addEventListener('click', ()=> alert('Open the members panel from the footer gear icon.'));
  document.getElementById('signOutBtn')?.addEventListener('click', async ()=>{ try{ if(state.sessionJWT){ await fetch(state.apiUrl('logout'), { method:'POST', headers:{ 'Authorization':`Bearer ${state.sessionJWT}` } }).catch(()=>{}); } } finally { localStorage.removeItem('stytch_session_jwt'); localStorage.removeItem('solara_session_jwt'); location.replace('/sign-in.html'); } });

  // Bus wiring for durable content + ws flush
  bus.addEventListener('content:schedule', (e)=>{ const { id, text } = e.detail||{}; scheduleContentDurable(id, text); });
  bus.addEventListener('content:flush-now', (e)=>{ const { id, text } = e.detail||{}; flushContentDurable(id, text); });
  bus.addEventListener('net:ws-open', ()=> flushOpQueue());

  stampSync();
}

document.addEventListener('DOMContentLoaded', boot);

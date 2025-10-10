// main.js — boot + wiring
import { state } from './state.js';
import { verifySessionAndHydrate } from './utils.js';
import { getState, sanitizeTabs, enqueueOp } from './oplog.v2.js';
import { connectLive } from './ws.v2.js';
import { renderTabs, switchTab, renderBoard, renderPresence, wireMembers, wireChrome } from './ui.js';
async function boot(){
  const ok = await verifySessionAndHydrate();
  if (!ok){
    const K='solara_auth_redirected_once';
    if(!sessionStorage.getItem(K)){ sessionStorage.setItem(K,'1'); const next=encodeURIComponent(location.href); location.replace(`/sign-in.html?next=${next}`); return; }
    else { const b=document.getElementById('wsBanner'); b.classList.remove('hidden'); b.innerHTML='<div class="flex items-center gap-2">Authentication required. <a class="underline font-medium" href="/sign-in.html">Sign in</a></div>'; return; }
  }
  const url=new URL(location.href);
  state.WORKSPACE_ID = url.searchParams.get('ws') || localStorage.getItem('solara_last_ws') || '';
  if(!state.WORKSPACE_ID) document.getElementById('wsBanner').classList.remove('hidden');
  else localStorage.setItem('solara_last_ws', state.WORKSPACE_ID);
  try{ const r=await fetch(state.apiUrl(`workspaces/${encodeURIComponent(state.WORKSPACE_ID)}/role`), { headers:{ 'Authorization':`Bearer ${state.sessionJWT}` }}); state.currentRole = r.ok ? (await r.json()).role || 'viewer' : 'viewer'; }catch{}
  try{ const wlist=await fetch(state.apiUrl('workspaces'), { headers:{ 'Authorization':`Bearer ${state.sessionJWT}` }}).then(r=>r.ok?r.json():{workspaces:[]}).catch(()=>({workspaces:[]})); const wsRow=(wlist.workspaces||[]).find(w=>w.id===state.WORKSPACE_ID); state.WORKSPACE_NAME=wsRow?.name||''; document.getElementById('wsName').textContent=state.WORKSPACE_NAME||'—'; if(wsRow && wsRow.owner_id && state.currentRole!=='owner' && wsRow.owner_id===state.currentUserKey) state.currentRole='owner'; }catch{}
  try{ const snap=await getState(); state.tabData=sanitizeTabs(snap.tabs||{}); state.lastSeq=Number(snap.base_seq||0); }catch{ state.tabData={'Click to edit':{ todo:[], inprogress:[], done:[] }}; state.lastSeq=0; }
  state.activeTab=Object.keys(state.tabData)[0]||'Click to edit'; renderTabs(); switchTab(state.activeTab);
  wireChrome(); wireMembers();
  document.getElementById('addTabBtn').onclick=()=>{ if(state.currentRole==='viewer') return; const name=prompt('Enter tab name:'); if(!name||!name.trim()) return; const n=name.trim(); if(state.tabData[n]) return switchTab(n); state.tabData[n]={ todo:[], inprogress:[], done:[] }; renderTabs(); switchTab(n); };
  document.getElementById('newTaskBtn').onclick=()=>{ if(state.currentRole==='viewer') return; const id=`task-${cryptoRandom()}`; const t={ id, content:'', dueDate:'', priority:'Medium', pos:(state.tabData[state.activeTab].todo.slice(-1)[0]?.pos||0)+1, upd:Date.now(), by:state.currentUserKey }; enqueueOp('create_task', { tab: state.activeTab, column:'todo', task: t }); };
  document.getElementById('clearBtn').onclick=()=>{ if(state.currentRole==='viewer') return; if(!state.activeTab) return; if(!confirm('Clear all tasks in this tab?')) return; const data=state.tabData[state.activeTab]; [...data.todo, ...data.inprogress, ...data.done].forEach(t=> enqueueOp('delete_task', { task_id: t.id })); };
  document.getElementById('exportBtn').onclick=()=>{ const board=document.getElementById('board'); html2pdf().set({ margin:.5, filename:'Solara-Board.pdf', image:{type:'jpeg',quality:.98}, html2canvas:{scale:2}, jsPDF:{unit:'in', format:'letter', orientation:'landscape'} }).from(board).save(); };
  document.getElementById('reportsLink').onclick=()=>{ if(!state.WORKSPACE_ID){ alert('Open a workspace first.'); return; } location.href=`reports.html?ws=${encodeURIComponent(state.WORKSPACE_ID)}`; };
  setInterval(()=>{ fetch(state.apiUrl('presence/beat'), { method:'POST', headers:{ 'Authorization':`Bearer ${state.sessionJWT}`,'Content-Type':'application/json' }, body: JSON.stringify({ workspace_id: state.WORKSPACE_ID }) }).catch(()=>{}); }, 10000);
  setInterval(async ()=>{ try{ const r=await fetch(state.apiUrl(`presence?workspace_id=${encodeURIComponent(state.WORKSPACE_ID)}`), { headers:{ 'Authorization':`Bearer ${state.sessionJWT}` }}); if(!r.ok) return; const j=await r.json(); state.presence.clear(); (j.online||[]).forEach(p=>{ if(p.id!==state.currentUserKey) state.presence.set(p.id,{name:p.name,email:p.email}); }); import('./ui.js').then(m=> m.renderPresence()); }catch{} }, 5000);
  connectLive();
}
function cryptoRandom(){ try{ return crypto.randomUUID(); }catch{ return Math.random().toString(36).slice(2); } }
document.addEventListener('DOMContentLoaded', boot);

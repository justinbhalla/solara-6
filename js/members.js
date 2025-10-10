// members.js
import { state } from './state.js';

export function wireMembers(){
  const open = ()=> document.getElementById('membersModal')?.classList.remove('hidden');
  const close = ()=> document.getElementById('membersModal')?.classList.add('hidden');

  document.querySelectorAll('[data-close-members]').forEach(el=> el.addEventListener('click', close));
  document.getElementById('manageBtn')?.addEventListener('click', ()=>{
    if(!state.WORKSPACE_ID){ alert('Open a workspace first.'); return; }
    open(); renderMembers();
  });

  document.getElementById('inviteBtn')?.addEventListener('click', async ()=>{
    const input=document.getElementById('inviteEmail');
    const email=(input?.value||'').trim().toLowerCase(); if(!email) return;
    const r=await fetch(state.apiUrl('shares'), { method:'POST', headers:{'Authorization':`Bearer ${state.sessionJWT}`,'Content-Type':'application/json'}, body: JSON.stringify({ workspace_id: state.WORKSPACE_ID, email }) });
    if(r.ok){ input.value=''; renderMembers(); alert('Invitation created.'); } else { alert('Invite failed.'); }
  });
}

async function listShares(){
  const r=await fetch(state.apiUrl(`shares?workspace_id=${encodeURIComponent(state.WORKSPACE_ID)}`), { headers:{ 'Authorization':`Bearer ${state.sessionJWT}` }});
  if(!r.ok) return [];
  const j=await r.json().catch(()=>({shares:[]}));
  return j.shares||[];
}

async function patchShareRole(id, role){
  return fetch(state.apiUrl(`shares/${id}`), { method:'PATCH', headers:{'Authorization':`Bearer ${state.sessionJWT}`,'Content-Type':'application/json'}, body: JSON.stringify({ role }) });
}
async function removeShare(id){
  return fetch(state.apiUrl(`shares/${id}`), { method:'DELETE', headers:{'Authorization':`Bearer ${state.sessionJWT}`}});
}

async function renderMembers(){
  const list = document.getElementById('membersList'); if(!list) return;
  list.innerHTML = '<div class="py-6 text-sm text-gray-500">Loading…</div>';
  const shares = await listShares();
  list.innerHTML = '';
  shares.forEach(s=>{
    const row=document.createElement('div'); row.className='flex items-center justify-between py-3';
    const who=document.createElement('div'); who.className='flex items-center gap-3';
    const bubble=document.createElement('div'); bubble.className='h-8 w-8 rounded-full bg-indigo-600/15 text-indigo-700 dark:text-indigo-300 flex items-center justify-center text-xs font-semibold';
    bubble.textContent = (s.email||'??').slice(0,2).toUpperCase();
    const meta=document.createElement('div'); meta.innerHTML = `<div class="text-sm font-medium">${s.email||'—'}</div>`;
    who.appendChild(bubble); who.appendChild(meta);

    const actions=document.createElement('div'); actions.className='flex items-center gap-2';
    if (s.role === 'owner') {
      const tag=document.createElement('span'); tag.className='text-xs text-gray-500'; tag.textContent='owner';
      actions.appendChild(tag);
    } else if (state.currentRole==='owner' && s.id) {
      const sel=document.createElement('select');
      sel.className='text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-800';
      ['editor','viewer'].forEach(r=>{ const o=document.createElement('option'); o.value=r; o.text=r; if(String(s.role||'editor')===r) o.selected=true; sel.appendChild(o); });
      sel.onchange = async ()=>{
        const r=await patchShareRole(s.id, sel.value); if(!r.ok) alert('Failed to update role');
      };
      const del=document.createElement('button'); del.className='px-2 py-1 text-xs rounded bg-red-50 text-red-600 hover:bg-red-100'; del.textContent='Remove';
      del.onclick = async ()=>{ if(!confirm('Remove this member?')) return; const r=await removeShare(s.id); if(r.ok) renderMembers(); else alert('Failed to remove'); };
      actions.appendChild(sel); actions.appendChild(del);
    }
    row.appendChild(who); row.appendChild(actions); list.appendChild(row);
  });
}

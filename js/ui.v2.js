// ui.v2.js
import { state, COLS } from './state.js';
import { debounce, stampSync, initials, normalizeDateString, cryptoId, bus } from './utils.js';
import { enqueueOp, findTask, scheduleContentDurable, flushContentDurable } from './oplog.v2.js';
import { sendAware, sendBlurAware, sendDelta } from './ws.v2.js';

export function renderTabs(){
  const node=document.getElementById('tabs'); if (!node) return;
  node.innerHTML='';
  const names=Object.keys(state.tabData);
  names.forEach(name=>{
    const b=document.createElement('button');
    b.className='tab-button px-4 py-1.5 rounded-full text-sm font-medium bg-transparent border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:border-indigo-500 hover:text-indigo-600 dark:hover:text-white transition-all duration-150 truncate max-w-[160px]';
    if(name===state.activeTab){ b.classList.add('border-indigo-500','text-indigo-700','dark:text-white','font-semibold','bg-indigo-50','dark:bg-indigo-600/30'); }
    b.dataset.tab=name; b.textContent=name;
    b.onclick=()=> switchTab(name);
    b.ondblclick=()=>{ if(state.currentRole==='viewer') return; const nn=prompt('Rename tab:',name); if(!nn||!nn.trim()||nn===name||state.tabData[nn])return; enqueueOp('rename_tab', { from:name, to:nn }); };
    b.oncontextmenu=(e)=>{ e.preventDefault(); if(state.currentRole==='viewer')return; if(confirm(`Delete tab "${name}"?`)){ if(state.activeTab===name) state.activeTab=Object.keys(state.tabData).find(t=>t!==name)||null; delete state.tabData[name]; renderTabs(); renderBoard(); } };
    node.appendChild(b);
  });
}

export function switchTab(tab){
  if(!state.tabData[tab]) return;
  state.activeTab=tab;
  document.querySelectorAll('.tab-button').forEach(x=>x.classList.remove('border-indigo-500','text-indigo-700','dark:text-white','font-semibold','bg-indigo-50','dark:bg-indigo-600/30'));
  const btn=[...document.querySelectorAll('.tab-button')].find(b=>b.dataset.tab===tab); if(btn) btn.classList.add('border-indigo-500','text-indigo-700','dark:text-white','font-semibold','bg-indigo-50','dark:bg-indigo-600/30');
  renderBoard();
}

function ensureAtLeastOne(){
  const cols=state.tabData[state.activeTab]; if(!cols) return;
  if((cols.todo?.length||0)+(cols.inprogress?.length||0)+(cols.done?.length||0)===0){
    const id=`task-${cryptoId()}`;
    const t={ id, content:'', dueDate:'', priority:'Medium', pos:1, upd:Date.now(), by: state.currentUserKey };
    state.tabData[state.activeTab].todo.push(t);
    renderTaskIntoDOM(state.activeTab,'todo',t);
  }
}

function createTaskElement(id, content='', dueDate='', priority='Medium', column, pos){
  const w=document.createElement('div');
  w.id=id; w.setAttribute('data-task','1'); w.draggable=state.currentRole!=='viewer';
  w.className='relative p-3 rounded bg-white dark:bg-gray-700 shadow cursor-move mb-2'; w.setAttribute('data-column',column);

  const editable=document.createElement('div'); editable.className='editable w-full font-medium mb-1'; editable.contentEditable=(state.currentRole!=='viewer'); editable.innerText=content;
  const placeholder=document.createElement('span'); placeholder.className='absolute left-3 top-3 text-sm text-gray-400 pointer-events-none'; placeholder.textContent='Click to edit...';
  function toggle(){ placeholder.style.display = editable.innerText.trim()===''?'block':'none'; }

  const row=document.createElement('div'); row.className='flex items-center gap-2';
  const dateInput=document.createElement('input'); dateInput.type='date'; dateInput.value=normalizeDateString(dueDate)||''; dateInput.disabled=(state.currentRole==='viewer'); dateInput.className='mt-1 text-xs bg-transparent text-gray-700 dark:text-gray-200 border border-transparent rounded px-1 date-badge';
  const prioritySelect=document.createElement('select'); prioritySelect.disabled=(state.currentRole==='viewer'); prioritySelect.className='mt-1 ml-2 text-xs bg-transparent text-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-600 rounded px-1';
  ['High','Medium','Low'].forEach(level=>{ const o=document.createElement('option'); o.value=level; o.text=level; if(level===priority) o.selected=true; prioritySelect.appendChild(o); });
  const del=document.createElement('button'); del.className='absolute top-2 right-2 text-gray-400 hover:text-red-500'; del.innerHTML='<svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 18L18 6M6 6l12 12"/></svg>'; del.title='Delete Task';
  del.onclick=()=>{ if(state.currentRole==='viewer')return; if(confirm('Delete this task?')) enqueueOp('delete_task', { task_id:id }); };

  // Smooth typing: awareness + deltas + durable debounce
  editable.addEventListener('focus', ()=>{ state.isEditing=true; state.editingTasks?.add?.(id); const sel=window.getSelection(); const pos=sel&&sel.anchorNode?sel.anchorOffset:0; sendAware(id,pos,pos); });
  editable.addEventListener('keyup', ()=>{ const sel=window.getSelection(); const pos=sel&&sel.anchorNode?sel.anchorOffset:editable.innerText.length; sendAware(id,pos,pos); });
  editable.addEventListener('blur', ()=>{ state.editingTasks?.delete?.(id); if((state.editingTasks?.size||0)===0){ state.isEditing=false; if(state.hasRemoteDuringEdit){ state.hasRemoteDuringEdit=false; renderTabs(); switchTab(state.activeTab); stampSync(); } } sendBlurAware(); flushContentDurable(id, editable.innerText.trim()); });
  editable.addEventListener('input', ()=>{ const text=editable.innerText.trim(); sendDelta(id, text); scheduleContentDurable(id, text); toggle(); });

  dateInput.addEventListener('change', ()=> enqueueOp('update_task_field', { task_id:id, field:'dueDate', value: normalizeDateString(dateInput.value) }));
  prioritySelect.addEventListener('change', ()=> enqueueOp('update_task_field', { task_id:id, field:'priority', value: prioritySelect.value||'Medium' }));

  w.addEventListener('dragstart',e=>{ if(state.currentRole==='viewer'){ e.preventDefault(); return; } state.isDragging=true; w.classList.add('dragging'); e.dataTransfer.setData('text/plain',id); dragContext.id=id; dragContext.fromCol=w.getAttribute('data-column'); });
  w.addEventListener('dragend',()=>{ state.isDragging=false; w.classList.remove('dragging'); if(state.hasRemoteDuringEdit){ state.hasRemoteDuringEdit=false; renderTabs(); switchTab(state.activeTab); stampSync(); } });

  row.appendChild(dateInput); row.appendChild(prioritySelect);
  w.appendChild(editable); w.appendChild(placeholder); w.appendChild(row); w.appendChild(del);
  toggle();
  return w;
}

function renderTaskIntoDOM(tab, column, t){
  const colEl=document.getElementById(column);
  const w=createTaskElement(t.id,t.content,t.dueDate,t.priority,column,t.pos);
  const siblings=[...colEl.querySelectorAll('[data-task]')];
  const where=siblings.find(el=>{
    const id=el.id; const tt=findTask(state.tabData, id);
    return (tt?.pos||0) > (t.pos||0);
  });
  if(where) colEl.insertBefore(w, where); else colEl.appendChild(w);
}

export function renderBoard(){
  COLS.forEach(col=>{
    const colEl=document.getElementById(col);
    colEl.querySelectorAll('[data-task]')?.forEach(n=>n.remove());

    colEl.ondragover = (e)=>{
      e.preventDefault();
      colEl.classList.add('drag-over','show-drop');
      const after=getAfter(colEl, e.clientY);
      const indicator=colEl.querySelector('.drop-indicator');
      if(after==null){ colEl.appendChild(indicator); } else { colEl.insertBefore(indicator, after); }
      dragContext.overCol = colEl.dataset.col;
      dragContext.insertIndex = computeInsertIndex(colEl, indicator);
    };
    colEl.ondragleave = ()=>{ colEl.classList.remove('drag-over','show-drop'); };
    colEl.ondrop = (e)=>{
      e.preventDefault();
      colEl.classList.remove('drag-over','show-drop');
      const id=dragContext.id; if(!id) return;
      commitReorder(id, dragContext.fromCol, colEl.dataset.col, dragContext.insertIndex);
      clearDrag();
    };
  });

  if(!state.activeTab || !state.tabData[state.activeTab]) return;
  ensureAtLeastOne();
  const data=state.tabData[state.activeTab];
  COLS.forEach(col=>{
    const colEl=document.getElementById(col);
    (data[col]||[]).sort((a,b)=> (a.pos||0)-(b.pos||0)).forEach(t=> colEl.appendChild(createTaskElement(t.id,t.content,t.dueDate,t.priority,col,t.pos)));
  });
}

const dragContext = { id:null, fromCol:null, overCol:null, insertIndex:null };
function clearDrag(){ dragContext.id=null; dragContext.fromCol=null; dragContext.overCol=null; dragContext.insertIndex=null; }
function getAfter(container, y){
  const els=[...container.querySelectorAll('[data-task]:not(.dragging)')];
  return els.reduce((closest,child)=>{ const box=child.getBoundingClientRect(); const off=y-box.top-box.height/2; if(off<0 && off>closest.offset){ return {offset:off, element:child}; } else return closest; },{offset:-Infinity}).element;
}
function computeInsertIndex(colEl, indicator){
  const siblings=[...colEl.querySelectorAll('[data-task]')];
  if(siblings.length===0) return 0;
  const all=[...colEl.children]; let index=0;
  for(let i=0;i<all.length;i++){ const el=all[i]; if(el===indicator){ index=[...all.slice(0,i)].filter(n=>n.hasAttribute && n.hasAttribute('data-task')).length; return index; } }
  return siblings.length;
}
function newPosBetween(prev, next){ const A=Number.isFinite(prev)?+prev:0; const B=Number.isFinite(next)?+next:A+2; if(B-A>1e-6) return A+(B-A)/2; return A+0.000001; }
function reindex(list){ list.forEach((t,i)=> t.pos=i+1); }

function commitReorder(taskId, fromCol, toCol, insertIndex){
  if(state.currentRole==='viewer') return;
  const cols=state.tabData[state.activeTab];
  let moved; const fromList=cols[fromCol]||[]; const i=fromList.findIndex(t=>t.id===taskId);
  if(i!==-1){ moved=fromList.splice(i,1)[0]; }
  if(!moved) return;
  const target=cols[toCol]=cols[toCol]||[];
  if(insertIndex==null||insertIndex<0) insertIndex=target.length;
  if(insertIndex>target.length) insertIndex=target.length;
  const prev=target[insertIndex-1]?.pos, next=target[insertIndex]?.pos;
  const pos=newPosBetween(prev,next);
  moved.pos=pos; target.splice(insertIndex,0,moved); reindex(target);
  renderBoard();
  enqueueOp('move_task', { task_id: taskId, to: toCol, pos, tab: state.activeTab });
}

/* Presence UI */
export function renderPresence(){
  const avatars=document.getElementById('presenceAvatars');
  const list=document.getElementById('presenceList');
  const count=document.getElementById('presenceCount');
  if (!avatars || !list || !count) return;
  avatars.innerHTML=''; list.innerHTML='';
  const others=[...state.presence.entries()].map(([id,v])=>({id,...v})).sort((a,b)=>(a.name||a.email).localeCompare(b.name||b.email));
  count.textContent = others.length ? '' : '0 online';
  const max=4;
  others.slice(0,max).forEach(p=>{
    const span=document.createElement('span');
    span.className='avatar inline-flex items-center justify-center h-7 w-7 rounded-full bg-indigo-600/10 text-indigo-700 dark:text-indigo-300 text-[11px] font-semibold ring-2 ring-white';
    span.title=p.name||p.email; span.textContent=(p.name||p.email||'?').slice(0,2).toUpperCase();
    const dot=document.createElement('span'); dot.className='presence-dot'; span.appendChild(dot);
    avatars.appendChild(span);

    const row=document.createElement('div');
    row.className='flex items-center gap-2';
    row.innerHTML=`<div class="relative inline-flex items-center justify-center h-6 w-6 rounded-full bg-indigo-600/10 text-indigo-700 dark:text-indigo-300 text-[10px] font-semibold">
      ${(p.name||p.email||'?').slice(0,2).toUpperCase()}<span class="presence-dot" style="right:-1px;bottom:-1px;width:8px;height:8px"></span></div>
      <div class="truncate">${p.name||p.email}</div>`;
    list.appendChild(row);
  });
  if(others.length>max){
    const extra=others.length-max;
    const more=document.createElement('span');
    more.className='avatar inline-flex items-center justify-center h-7 w-7 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-[11px] font-semibold ring-2 ring-white';
    more.textContent = `+${extra}`; avatars.appendChild(more);
  }
}

export function wireTopBar(){
  const addTabBtn = document.getElementById('addTabBtn');
  const newTaskBtn = document.getElementById('newTaskBtn');
  const clearBtn = document.getElementById('clearBtn');
  const exportBtn = document.getElementById('exportBtn');

  if (addTabBtn) addTabBtn.onclick = ()=>{
    if(state.currentRole==='viewer') return;
    const name=prompt('Enter tab name:'); if(!name||!name.trim()) return;
    const n=name.trim(); if(state.tabData[n]) return switchTab(n);
    state.tabData[n]={ todo:[], inprogress:[], done:[] }; renderTabs(); switchTab(n);
  };

  if (newTaskBtn) newTaskBtn.onclick = ()=>{
    if(state.currentRole==='viewer') return;
    if(!state.activeTab){ const def='Click to edit'; if(!state.tabData[def]) state.tabData[def]={ todo:[], inprogress:[], done:[] }; state.activeTab=def; renderTabs(); }
    const id=`task-${cryptoId()}`; const now=Date.now();
    const t={ id, content:'', dueDate:'', priority:'Medium', pos:(state.tabData[state.activeTab].todo.slice(-1)[0]?.pos||0)+1, upd:now, by:state.currentUserKey };
    enqueueOp('create_task', { tab: state.activeTab, column:'todo', task: t });
  };

  if (clearBtn) clearBtn.onclick = ()=>{
    if(state.currentRole==='viewer') return;
    if(!state.activeTab) return;
    if(!confirm('Clear all tasks in this tab?')) return;
    const data=state.tabData[state.activeTab];
    [...data.todo, ...data.inprogress, ...data.done].forEach(t=> enqueueOp('delete_task', { task_id: t.id }));
  };

  if (exportBtn) exportBtn.onclick = ()=>{
    const board=document.getElementById('board');
    // html2pdf is global (loaded in index)
    html2pdf().set({ margin:.5, filename:'Solara-Board.pdf', image:{type:'jpeg',quality:.98}, html2canvas:{scale:2}, jsPDF:{unit:'in', format:'letter', orientation:'landscape'} }).from(board).save();
  };

  const presenceBtn = document.getElementById('presenceBtn');
  if (presenceBtn) presenceBtn.onclick = ()=>{
    const t=document.getElementById('presenceTooltip');
    t?.classList.toggle('hidden');
  };

  const userButton = document.getElementById('userButton');
  if (userButton) userButton.onclick = ()=> document.getElementById('userMenu')?.classList.toggle('hidden');
}

export function wireFooter(){ /* reserved for footer specific wiring if needed */ }

// Drag helpers
function getAfter(container, y){
  const els=[...container.querySelectorAll('[data-task]:not(.dragging)')];
  return els.reduce((closest,child)=>{ const box=child.getBoundingClientRect(); const off=y-box.top-box.height/2; if(off<0 && off>closest.offset){ return {offset:off, element:child}; } else return closest; },{offset:-Infinity}).element;
}
function computeInsertIndex(colEl, indicator){
  const siblings=[...colEl.querySelectorAll('[data-task]')];
  if(siblings.length===0) return 0;
  const all=[...colEl.children]; let index=0;
  for(let i=0;i<all.length;i++){ const el=all[i]; if(el===indicator){ index=[...all.slice(0,i)].filter(n=>n.hasAttribute && n.hasAttribute('data-task')).length; return index; } }
  return siblings.length;
}

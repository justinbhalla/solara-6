// utils.js
import { state } from './state.js';

export const bus = new EventTarget();
export const fire = (type, detail)=> bus.dispatchEvent(new CustomEvent(type, { detail }));

export const debounce = (fn, ms=400)=>{
  let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); };
};

export function stampSync(){
  const el = document.getElementById('lastSynced');
  if (el) el.textContent = 'Last synced: ' + new Date().toLocaleTimeString();
}

export function initials(name='', email=''){
  const parts=(name||'').trim().split(/\s+/).filter(Boolean);
  return parts.length?parts.slice(0,2).map(s=>s[0]).join('').toUpperCase():(email||'?').slice(0,2).toUpperCase();
}

export function normalizeDateString(v){
  if(!v) return '';
  if(/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d=new Date(v);
  if(isNaN(d)) return '';
  const tz=d.getTimezoneOffset()*60000;
  return new Date(d.getTime()-tz).toISOString().slice(0,10);
}

export function cryptoId(){ try{ return crypto.randomUUID(); }catch{ return Math.random().toString(36).slice(2); } }

const colorForUser=(id)=>{
  const palette=['#ef4444','#10b981','#3b82f6','#f59e0b','#8b5cf6','#06b6d4'];
  let h=0; for(let i=0;i<id.length;i++) h=(h*31+id.charCodeAt(i))|0;
  return palette[Math.abs(h)%palette.length];
};
export const myColor = ()=> colorForUser(state.currentUserKey||'me');
export const myName  = ()=>{
  const u = state.authedUser;
  const f=u?.name?.first_name, l=u?.name?.last_name, e=u?.email_addresses?.[0]?.email_address;
  return [f,l].filter(Boolean).join(' ') || e || 'User';
};

// auth.js
import { state } from './state.js';

function displayNameFor(u){
  const f=u?.name?.first_name, l=u?.name?.last_name, e=u?.email_addresses?.[0]?.email_address;
  return [f,l].filter(Boolean).join(' ') || e || 'User';
}
function getSessionJWT(){
  const m = document.cookie.match(/(?:^|; )(?:stytch_session_jwt|solara_session_jwt)=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : (localStorage.getItem('stytch_session_jwt') || localStorage.getItem('solara_session_jwt') || null);
}
function updateAuthUI(){
  const name=displayNameFor(state.authedUser);
  const email=state.authedUser?.email_addresses?.[0]?.email_address||'';
  const avatar = document.getElementById('avatar');
  const userName = document.getElementById('userName');
  const userEmail = document.getElementById('userEmail');
  if (avatar) avatar.textContent = (name||'?').slice(0,2).toUpperCase();
  if (userName) userName.textContent = name;
  if (userEmail) userEmail.textContent = email;
}

export async function verifySessionAndHydrate(){
  state.sessionJWT = getSessionJWT();
  if (state.sessionJWT) {
    try {
      const r = await fetch(state.apiUrl('auth/check'), { headers:{ 'Authorization':`Bearer ${state.sessionJWT}` }});
      if (r.ok) {
        const data = await r.json();
        state.currentUserKey = data.user_id;
        const email = data.email ? [{ email_address: data.email }] : [];
        const parts = (data.name||'').trim().split(' ').filter(Boolean);
        state.authedUser = { name:{ first_name:parts[0]||'', last_name:parts.slice(1).join(' ')||'' }, email_addresses: email };
        if (data.session_jwt) {
          state.sessionJWT = data.session_jwt;
          localStorage.setItem('solara_session_jwt', state.sessionJWT);
          document.cookie = `solara_session_jwt=${encodeURIComponent(state.sessionJWT)}; path=/; SameSite=Lax`;
        }
        localStorage.setItem('stytch_user', JSON.stringify(state.authedUser));
        updateAuthUI();
        return true;
      }
    } catch {}
  }
  try {
    const r2 = await fetch(state.apiUrl('auth/check'), { credentials: 'include' });
    if (r2.ok) {
      const data = await r2.json();
      state.currentUserKey = data.user_id;
      const email = data.email ? [{ email_address: data.email }] : [];
      const parts = (data.name||'').trim().split(' ').filter(Boolean);
      state.authedUser = { name:{ first_name:parts[0]||'', last_name:parts.slice(1).join(' ')||'' }, email_addresses: email };
      if (data.session_jwt) {
        state.sessionJWT = data.session_jwt;
        localStorage.setItem('solara_session_jwt', state.sessionJWT);
        document.cookie = `solara_session_jwt=${encodeURIComponent(state.sessionJWT)}; path=/; SameSite=Lax`;
      }
      localStorage.setItem('stytch_user', JSON.stringify(state.authedUser));
      updateAuthUI();
      return true;
    }
  } catch {}
  return false;
}

// state.js — global state
export const COLS = ['todo','inprogress','done'];
export const state = {
  API_BASE: "https://shy-smoke-ab8e.justinbhalla28.workers.dev",
  apiUrl: (p)=>{
    const base = state.API_BASE.replace(/\/+$/,'')
    const path = String(p||'').replace(/^\/+/,'');
    return base + '/' + path;
  },
  sessionJWT: null, authedUser: null, currentUserKey: null, currentRole: 'viewer',
  WORKSPACE_ID: '', WORKSPACE_NAME: '',
  tabData: {}, activeTab: null,
  lastSeq: 0, pendingOps: [], sentButUnacked: new Map(), opCounter: 0,
  ws: null, wsConnected: false, presence: new Map(),
};

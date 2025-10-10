// state.js
export const COLS = ['todo','inprogress','done'];

export const state = {
  // Config
  API_BASE: "https://shy-smoke-ab8e.justinbhalla28.workers.dev",
  apiUrl: (p)=>{
    const base = (state.API_BASE||'').replace(/\/+$/,'')
    const path = String(p||'').replace(/^\/+/, '')
    return `${base}/${path}`
  },

  // Auth
  sessionJWT: null,
  authedUser: null,
  currentUserKey: null,
  currentRole: 'viewer',

  // Workspace
  WORKSPACE_ID: '',
  WORKSPACE_NAME: '',

  // Data
  tabData: {},
  activeTab: null,

  // Op-log
  lastSeq: 0,
  pendingOps: [],
  sentButUnacked: new Map(),
  opCounter: 0,

  // Live
  ws: null,
  wsConnected: false,
  presence: new Map(),
};

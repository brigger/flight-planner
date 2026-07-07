/* ═════════════════════════════════════════════════════════════════════
   plan_sync.js — shared Save / Load / Save-as UI, bundle sync, and
   passwordless user authentication (email magic link).
   Loaded by every HTML page. Injects CSS, nav-bar status line, floating
   disc (FAB) + popup menu, an auth modal and a load-plan modal. Pages
   communicate via `velis:before-save` and `velis:after-load`.
   Also exposes `window.velisWp` — small helpers for parsing waypoint
   names / altitudes / distances. Used by both the Route Planner and
   the NAV Plan, so the parsing rules can't drift between them.
   ═════════════════════════════════════════════════════════════════════ */

/* eslint-disable */
window.velisWp = (function(){
  // 4-letter ICAO followed by whitespace + a name.  Used to split
  // "LSPG Kägiswil" → ident "LSPG" + wp "Kägiswil".
  const ICAO_RE = /^([A-Z]{4})\s+(.+)$/;
  const dropQuote = s => String(s==null?'':s).replace(/[’'`,]/g,'');
  function joinName(ident, wp){
    const i=(ident||'').trim(), w=(wp||'').trim();
    return i&&w ? i+' '+w : (i||w);
  }
  function splitName(name){
    const m = String(name||'').match(ICAO_RE);
    return m ? {ident:m[1], wp:m[2]} : {ident:'', wp:String(name||'')};
  }
  function parseAlt(v){
    const n = parseFloat(dropQuote(v));
    return isFinite(n) ? Math.round(n) : null;
  }
  function parseDist(v){
    // Floor of 1 nm, not 2 — Sky Demon legs can be sub-2 nm. Callers that
    // need to fit the Route Planner's 2–120 nm slider clamp on top of this.
    const n = parseFloat(dropQuote(v));
    return isFinite(n) ? Math.max(1, Math.round(n)) : null;
  }
  return {ICAO_RE, dropQuote, joinName, splitName, parseAlt, parseDist};
})();

(function(){
  "use strict";

  const API_BASE       = (typeof window!=='undefined'&&typeof window.VELIS_API_BASE==='string') ? window.VELIS_API_BASE : '/velis-planner/api';
  const USER_KEY       = 'velis_user';                 // cached {id,email,first_name,last_name}
  const NAV_STATE_KEY  = 'velis_navplan_state';
  const MTIME_KEY      = 'velis_bundle_mtime';
  const STIME_KEY      = 'velis_bundle_stime';
  const VIEW_KEY       = 'velis_navplan_view';
  const AUTO_SYNC_KEY  = 'velis_auto_sync';            // 'ask' | 'always' | 'never' (per device)
  const AC_KEY         = 'velis_aircraft';             // selected aircraft id (UI pref)
  const BUNDLE_EXCLUDE = new Set([USER_KEY,VIEW_KEY,MTIME_KEY,STIME_KEY,AUTO_SYNC_KEY,AC_KEY]);

  /* ─── Aircraft + Nav definition ─── */
  // Single source of truth for the aircraft selector and per-aircraft menus.
  // Each aircraft owns a set of tabs keyed by `type` so switching aircraft can
  // stay on the same tab type when the target has it. Admin tabs have admin:true.
  const AIRCRAFT = [
    { id:'velis', name:'Velis Electro', tabs:[
      { type:'navplan', href:'velis_navplan.html',     label:'NAV Plan'          },
      { type:'route',   href:'index.html',             label:'Route Planner'     },
      { type:'takeoff', href:'velis_takeoff.html',     label:'Takeoff & Landing' },
      { type:'perf',    href:'velis_performance.html', label:'Performance'       },
    ]},
    { id:'da20', name:'Diamond DA20-C1', tabs:[
      { type:'navplan', href:'da20_navplan.html',      label:'NAV Plan'          },
      { type:'route',   href:'da20_index.html',        label:'Route Planner'     },
      { type:'takeoff', href:'da20_takeoff.html',      label:'Takeoff & Landing' },
      { type:'perf',    href:'da20_performance.html',  label:'Performance'       },
    ]},
  ];
  // Shared across all aircraft (same page regardless of selection).
  const SHARED_TABS = [
    { type:'about',     href:'velis_about.html', label:'About'                 },
    { type:'dashboard', href:'velis_admin.html', label:'Dashboard', admin:true },
  ];

  /* ─── CSS ─── */
  const CSS = `
.nav{background:var(--bg-card,#fff);border-bottom:1px solid var(--bd,#e2ddd6);position:sticky;top:0;z-index:10;backdrop-filter:blur(12px);background:rgba(255,255,255,0.92);}
.nav-inner{max-width:1180px;margin:0 auto;padding:0 16px;display:flex;align-items:stretch;}
.nav-brand{padding:11px 18px 11px 0;font-size:13px;font-weight:700;color:var(--tx,#1a1a1a);border-right:1px solid var(--bd,#e2ddd6);margin-right:4px;letter-spacing:-0.02em;display:flex;align-items:center;gap:6px;}
.nav-brand svg{opacity:0.5;}
.nav-ac{position:relative;}
.nav-ac-btn{display:flex;align-items:center;gap:5px;background:none;border:none;font:inherit;font-size:13px;font-weight:700;color:var(--tx,#1a1a1a);letter-spacing:-0.02em;cursor:pointer;padding:0;}
.nav-ac-btn:hover{color:var(--blue,#185FA5);}
.nav-ac-chev{width:10px;height:10px;opacity:0.6;flex-shrink:0;transition:transform .15s;}
.nav-ac-menu.open .nav-ac-chev{transform:rotate(180deg);}
.nav-ac-menu{position:absolute;top:calc(100% + 2px);left:-6px;background:var(--bg-card,#fff);border:1px solid var(--bd,#e2ddd6);border-radius:var(--rad-md,8px);box-shadow:0 10px 30px rgba(0,0,0,0.16),0 2px 6px rgba(0,0,0,0.08);min-width:190px;padding:4px;z-index:60;display:none;}
.nav-ac-menu.open{display:block;}
.nav-ac-menu button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:10px 12px;min-height:40px;border:none;background:none;font:inherit;font-size:12.5px;font-weight:500;color:var(--tx,#1a1a1a);border-radius:5px;cursor:pointer;white-space:nowrap;}
.nav-ac-menu button:hover{background:var(--bg-sec,#f5f4f1);}
.nav-ac-menu button.sel{color:var(--blue,#185FA5);font-weight:700;}
.nav-ac-menu button .tick{margin-left:auto;opacity:0;color:var(--blue,#185FA5);}
.nav-ac-menu button.sel .tick{opacity:1;}
.nav-tab{padding:11px 18px;font-size:12.5px;font-weight:500;color:var(--tx2,#6b6660);text-decoration:none;border-bottom:2px solid transparent;transition:all 0.15s;white-space:nowrap;}
.nav-tab:hover{color:var(--tx,#1a1a1a);}
.nav-tab.active{color:var(--blue,#185FA5);border-bottom-color:var(--blue,#185FA5);font-weight:600;}
@media print{.nav{display:none !important;}}
.plan-status-grow{flex:1 1 auto;}
.plan-status{font-size:11px;color:var(--tx2,#6b6660);padding:11px 60px 11px 10px;align-self:center;display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:400px;font-family:var(--font,inherit);}
.plan-status .dot{width:6px;height:6px;border-radius:50%;background:#D46A1D;flex-shrink:0;display:none;}
.plan-status.dirty .dot{display:inline-block;}
.plan-status .name{color:var(--tx,#1a1a1a);font-weight:500;overflow:hidden;text-overflow:ellipsis;}
.plan-status .who{color:var(--tx2,#6b6660);}
.plan-status .sep{color:var(--bd2,#ccc8c0);}
.plan-status .signin{color:var(--blue,#185FA5);cursor:pointer;text-decoration:underline;font-weight:500;background:none;border:none;padding:0;font:inherit;}

.plan-fab{position:fixed;top:14px;right:16px;width:44px;height:44px;border-radius:50%;border:1px solid var(--bd,#e2ddd6);background:var(--bg-card,#fff);color:var(--tx,#1a1a1a);cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,0.12),0 1px 3px rgba(0,0,0,0.08);display:flex;align-items:center;justify-content:center;z-index:200;padding:0;transition:transform 0.12s,box-shadow 0.12s;}
.plan-fab:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(0,0,0,0.16),0 2px 4px rgba(0,0,0,0.10);}
.plan-fab:active{transform:translateY(0);}
.plan-fab svg{width:22px;height:22px;opacity:0.85;pointer-events:none;}
.plan-fab .dot{position:absolute;top:6px;right:6px;width:10px;height:10px;border-radius:50%;background:#D46A1D;border:2px solid var(--bg-card,#fff);display:none;}
.plan-fab.dirty .dot{display:block;}

.plan-menu{position:fixed;top:66px;right:16px;background:var(--bg-card,#fff);border:1px solid var(--bd,#e2ddd6);border-radius:var(--rad-md,8px);box-shadow:0 10px 30px rgba(0,0,0,0.18),0 2px 6px rgba(0,0,0,0.08);min-width:240px;padding:4px;z-index:201;display:none;font-family:var(--font,inherit);}
.plan-menu[data-open="1"]{display:block;}
.plan-menu button{display:flex;align-items:center;width:100%;min-height:44px;padding:10px 14px;border:none;background:transparent;font-family:inherit;font-size:13px;color:var(--tx,#1a1a1a);text-align:left;cursor:pointer;border-radius:6px;gap:8px;}
.plan-menu button:hover{background:var(--bg-sec,#f5f4f1);}
.plan-menu button:disabled{opacity:0.45;cursor:not-allowed;}
.plan-menu .who{padding:10px 14px 6px;font-size:10.5px;color:var(--tx2,#6b6660);font-weight:600;text-transform:uppercase;letter-spacing:0.04em;}
.plan-menu .who .em{text-transform:none;letter-spacing:0;font-weight:500;color:var(--tx,#1a1a1a);display:block;font-size:12px;margin-top:2px;}
.plan-menu .sep{height:1px;background:var(--bd,#e2ddd6);margin:4px 6px;}
.plan-menu .kbd{margin-left:auto;font-size:10.5px;color:var(--tx2,#6b6660);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
.plan-menu .sync-pref{padding:8px 14px 10px;}
.plan-menu .sync-pref .lbl{font-weight:600;text-transform:uppercase;letter-spacing:0.04em;font-size:10.5px;color:var(--tx2,#6b6660);display:block;margin-bottom:6px;}
.plan-menu .sync-pref .opts{display:flex;gap:4px;}
.plan-menu .sync-pref label{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:5px;cursor:pointer;color:var(--tx,#1a1a1a);font-weight:500;font-size:12px;padding:6px 4px;border:1px solid var(--bd,#e2ddd6);border-radius:6px;background:#fff;}
.plan-menu .sync-pref label:hover{background:var(--bg-sec,#f5f4f1);}
.plan-menu .sync-pref label.on{background:var(--bg-sec,#f5f4f1);border-color:var(--blue,#185FA5);color:var(--blue,#185FA5);}
.plan-menu .sync-pref input{margin:0;accent-color:var(--blue,#185FA5);}

.plan-sync-body{font-size:13px;color:var(--tx,#1a1a1a);line-height:1.5;margin:0 0 18px;}
.plan-sync-body b{font-weight:600;color:var(--tx,#1a1a1a);}
.plan-sync-warn{font-size:11.5px;color:#7A5700;background:#FFF8E7;border:1px solid #F2DDA0;border-radius:6px;padding:8px 10px;margin:-8px 0 16px;line-height:1.4;display:none;}
.plan-sync-warn.show{display:block;}
.plan-modal-actions .ghost{background:transparent;border-color:transparent;color:var(--tx2,#6b6660);text-decoration:underline;padding-left:6px;padding-right:6px;}
.plan-modal-actions .ghost:hover{color:var(--tx,#1a1a1a);}

.plan-modal{position:fixed;inset:0;background:rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;z-index:300;font-family:var(--font,inherit);}
.plan-modal[hidden]{display:none;}
.plan-modal-box{background:#fff;border-radius:var(--rad-lg,14px);padding:20px 24px;min-width:340px;max-width:440px;max-height:80vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,0.2);}
.plan-modal-box h3{margin:0 0 14px;font-size:14px;font-weight:700;letter-spacing:-0.01em;}
.plan-modal-box label{display:block;font-size:10.5px;color:var(--tx2,#6b6660);font-weight:600;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:12px;}
.plan-modal-box label input{display:block;width:100%;margin-top:4px;padding:10px 12px;border:1px solid var(--bd2,#ccc8c0);border-radius:6px;font-size:14px;color:var(--tx,#1a1a1a);font-weight:400;text-transform:none;letter-spacing:0;background:#fff;box-sizing:border-box;}
.plan-modal-box label input:focus{outline:none;border-color:var(--blue,#185FA5);box-shadow:0 0 0 3px rgba(24,95,165,0.15);}
.plan-modal-box .hint{font-size:12px;color:var(--tx2,#6b6660);margin:-2px 0 16px;line-height:1.4;}
.plan-modal-box .err{font-size:12px;color:#B03030;background:#FBEAEA;border-radius:6px;padding:10px 12px;margin:0 0 14px;line-height:1.4;display:none;}
.plan-modal-box .err.show{display:block;}
.plan-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px;align-items:center;}
.plan-modal-actions button{font-family:inherit;font-size:12px;font-weight:600;padding:9px 18px;min-height:38px;border:1px solid var(--bd,#e2ddd6);border-radius:6px;background:var(--bg-sec,#f5f4f1);color:var(--tx2,#6b6660);cursor:pointer;}
.plan-modal-actions button.primary{border-color:var(--blue,#185FA5);background:var(--blue,#185FA5);color:#fff;}
.plan-modal-actions button.primary:hover{background:#124a82;}
.plan-modal-actions button:disabled{opacity:0.6;cursor:wait;}
.plan-modal-actions .spacer{flex:1;}

.auth-tabs{display:flex;gap:2px;background:var(--bg-sec,#f5f4f1);border-radius:8px;padding:3px;margin:0 0 16px;}
.auth-tabs button{flex:1;font-family:inherit;font-size:12px;font-weight:600;padding:8px 10px;border:none;border-radius:6px;background:transparent;color:var(--tx2,#6b6660);cursor:pointer;}
.auth-tabs button.active{background:#fff;color:var(--tx,#1a1a1a);box-shadow:0 1px 2px rgba(0,0,0,0.06);}
.auth-pane{display:none;}
.auth-pane.active{display:block;}
.auth-ok{display:none;text-align:center;padding:8px 4px 4px;}
.auth-ok.show{display:block;}
.auth-ok .icon{width:56px;height:56px;border-radius:50%;background:#E8F5E8;color:#2C8A2C;display:inline-flex;align-items:center;justify-content:center;margin:0 auto 14px;font-size:28px;}
.auth-ok h4{margin:0 0 8px;font-size:16px;font-weight:700;letter-spacing:-0.01em;color:var(--tx,#1a1a1a);}
.auth-ok p{margin:0 0 6px;font-size:13px;color:var(--tx2,#6b6660);line-height:1.5;}
.auth-ok .em{color:var(--tx,#1a1a1a);font-weight:600;}
.auth-ok .small{font-size:11px;color:var(--tx2,#6b6660);margin-top:14px;}
.auth-ok .link{background:none;border:none;padding:0;color:var(--blue,#185FA5);cursor:pointer;font:inherit;text-decoration:underline;}

.plan-list{display:flex;flex-direction:column;gap:2px;margin:4px 0;}
.plan-li{display:flex;align-items:center;justify-content:space-between;padding:12px 10px;border-radius:6px;cursor:pointer;font-size:13px;gap:12px;min-height:44px;}
.plan-li:hover{background:var(--bg-sec,#f5f4f1);}
.plan-li .pn{font-weight:600;color:var(--tx,#1a1a1a);}
.plan-li .pd{font-size:11px;color:var(--tx2,#6b6660);margin-left:6px;}
.plan-li .del{border:none;background:transparent;color:#B08888;cursor:pointer;font-size:18px;padding:0 10px;line-height:1;min-width:32px;min-height:32px;}
.plan-li .del:hover{color:#791F1F;}
.plan-empty{font-size:12px;color:var(--tx2,#6b6660);padding:10px;font-style:italic;text-align:center;}

@media (max-width:700px){
  .nav-inner{flex-wrap:wrap;}
  .plan-status{order:10;flex-basis:100%;padding:0 12px 8px;max-width:none;}
}
@media print{
  .plan-fab,.plan-status,.plan-status-grow,.plan-menu,.plan-modal{display:none !important;}
}
`;

  /* ─── HTML fragments ─── */
  const STATUS_HTML = `<span class="plan-status-grow"></span><span class="plan-status" id="plan-status"></span>`;

  const FAB_HTML = `
<button class="plan-fab" id="plan-fab" type="button" aria-label="Plan actions" title="Plan (Save / Load)">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M5 3h11l3 3v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M7 3v6h9V3"/><rect x="8" y="13" width="8" height="6" rx="1"/></svg>
  <span class="dot"></span>
</button>`;

  const MENU_HTML = `
<div class="plan-menu" id="plan-menu" role="menu">
  <div class="who" id="plan-menu-who" hidden>Signed in<span class="em" id="plan-menu-who-em"></span></div>
  <div class="sep" id="plan-menu-who-sep" hidden></div>
  <button type="button" data-act="save">Save<span class="kbd">⌘S</span></button>
  <button type="button" data-act="save-as">Save as…</button>
  <button type="button" data-act="load">Load…</button>
  <div class="sep" id="plan-menu-sync-sep" hidden></div>
  <button type="button" data-act="manual-sync" id="plan-menu-manual-sync" hidden></button>
  <div class="sync-pref" id="plan-menu-sync-pref" hidden>
    <span class="lbl">Sync prompt</span>
    <div class="opts">
      <label data-val="ask"><input type="radio" name="plan-sync-pref" value="ask"> Ask</label>
      <label data-val="always"><input type="radio" name="plan-sync-pref" value="always"> Always</label>
      <label data-val="never"><input type="radio" name="plan-sync-pref" value="never"> Never</label>
    </div>
  </div>
  <div class="sep"></div>
  <button type="button" data-act="signin" id="plan-menu-signin">Sign in</button>
  <button type="button" data-act="logout" id="plan-menu-logout" hidden>Sign out</button>
</div>`;

  const SYNC_HTML = `
<div class="plan-modal" id="plan-sync-modal" hidden>
  <div class="plan-modal-box">
    <h3 id="plan-sync-title">Cleared to sync?</h3>
    <p class="plan-sync-body" id="plan-sync-body"></p>
    <div class="plan-sync-warn" id="plan-sync-warn"></div>
    <div class="plan-modal-actions">
      <button type="button" id="plan-sync-not-now" class="ghost">Not now</button>
      <span class="spacer"></span>
      <button type="button" id="plan-sync-never">Never ask</button>
      <button type="button" id="plan-sync-always">Always</button>
      <button type="button" id="plan-sync-now" class="primary">Sync now</button>
    </div>
  </div>
</div>`;

  const AUTH_HTML = `
<div class="plan-modal" id="plan-auth-modal" hidden>
  <div class="plan-modal-box">
    <h3 id="plan-auth-title">Sign in</h3>
    <div class="auth-tabs" id="plan-auth-tabs">
      <button type="button" data-tab="signin" class="active">Sign in</button>
      <button type="button" data-tab="register">Create account</button>
    </div>
    <div class="err" id="plan-auth-err"></div>
    <div class="auth-pane active" data-pane="signin">
      <p class="hint">Enter the email you registered with — we'll email you a one-tap sign-in link.</p>
      <label>Email<input id="plan-auth-signin-email" type="email" autocomplete="email" placeholder="you@example.com"></label>
    </div>
    <div class="auth-pane" data-pane="register">
      <p class="hint">No password needed. Enter your details and we'll email you a verification link.</p>
      <label>First name<input id="plan-auth-first" type="text" autocomplete="given-name"></label>
      <label>Last name<input id="plan-auth-last" type="text" autocomplete="family-name"></label>
      <label>Email<input id="plan-auth-email" type="email" autocomplete="email" placeholder="you@example.com"></label>
    </div>
    <div class="auth-ok" id="plan-auth-ok">
      <div class="icon">✓</div>
      <h4>Check your inbox</h4>
      <p>We sent a magic link to <span class="em" id="plan-auth-sent-to"></span>.</p>
      <p>Click the link in the email and you'll be signed in on this device.</p>
      <p class="small">Not seeing it? Check spam, or <button type="button" class="link" id="plan-auth-resend">send again</button>.</p>
    </div>
    <div class="plan-modal-actions" id="plan-auth-actions">
      <button type="button" id="plan-auth-close">Close</button>
      <span class="spacer"></span>
      <button type="button" id="plan-auth-submit" class="primary">Send magic link</button>
    </div>
  </div>
</div>`;

  const LOAD_HTML = `
<div class="plan-modal" id="plan-load-modal" hidden>
  <div class="plan-modal-box">
    <h3>Load plan</h3>
    <div class="plan-list" id="plan-list"></div>
    <div class="plan-modal-actions">
      <button type="button" id="plan-load-cancel">Close</button>
    </div>
  </div>
</div>`;

  /* ─── Helpers ─── */
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  // Browsers throw QuotaExceededError when localStorage is full or in
  // private-browsing modes. Centralize the catch so a write failure logs once
  // instead of bringing down the next saveState() / markDirty() call.
  let _quotaWarned = false;
  function safeSetItem(key, val){
    try{ localStorage.setItem(key, val); return true; }
    catch(e){
      if(!_quotaWarned){_quotaWarned=true; console.warn('localStorage write failed (quota?):', e); }
      return false;
    }
  }
  function getCachedUser(){try{return JSON.parse(localStorage.getItem(USER_KEY))||null;}catch(e){return null;}}
  function setCachedUser(u){if(u) safeSetItem(USER_KEY,JSON.stringify(u)); else localStorage.removeItem(USER_KEY);}

  async function api(path,opts={}){
    const r=await fetch(API_BASE+path,{
      credentials:'include',
      ...opts,
      headers:{
        'Content-Type':'application/json',
        ...(opts.headers||{})
      }
    });
    if(!r.ok){
      const txt=await r.text().catch(()=>'');
      const err=new Error(r.status+' '+txt);
      err.status=r.status;
      throw err;
    }
    return r.json();
  }

  /* ─── User session tracking ─── */
  let currentUser = null;        // in-memory echo of cache
  let authPollTimer = null;

  async function refreshUser(){
    try{
      const r=await api('/auth/me');
      const before=currentUser&&currentUser.id;
      const after=r.authenticated?r.user:null;
      if((before||null)!==(after&&after.id||null)){
        if(before && !after){
          // was logged in → logged out: clear all velis_* localStorage
          wipeVelisLocal();
        } else if(before && after && before!==after.id){
          // different user: clear previous plan state
          wipeVelisLocal();
        }
      }
      currentUser=after;
      setCachedUser(after);
      repaint();
      return after;
    }catch(e){
      // Network error — keep whatever we had cached, but if it was authenticated,
      // the next action will 401 and prompt reauth.
      return currentUser;
    }
  }

  function wipeVelisLocal(){
    const keys=[];
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(k&&k.startsWith('velis_')) keys.push(k);
    }
    for(const k of keys) localStorage.removeItem(k);
  }

  /* ─── Dirty tracking ─── */
  function bundleDirty(){
    const m=parseInt(localStorage.getItem(MTIME_KEY)||'0',10);
    const s=parseInt(localStorage.getItem(STIME_KEY)||'0',10);
    return m>s;
  }
  // markBundleDirty is hammered on every keystroke (slider drags fire it once
  // per pixel). Coalesce to one write per animation frame — same UX, way fewer
  // localStorage writes and fewer 'storage' events bouncing to other tabs.
  let _dirtyScheduled=false;
  function markBundleDirty(){
    if(_dirtyScheduled) return;
    _dirtyScheduled=true;
    requestAnimationFrame(()=>{_dirtyScheduled=false;safeSetItem(MTIME_KEY,String(Date.now()));repaint();});
  }
  function markBundleSaved(){safeSetItem(STIME_KEY,String(Date.now()));repaint();}

  function currentMeta(){
    try{
      const raw=localStorage.getItem(NAV_STATE_KEY);
      if(!raw) return {id:null,name:''};
      const s=JSON.parse(raw);
      return (s&&s.meta)||{id:null,name:''};
    }catch(e){return {id:null,name:''};}
  }

  function updateStatus(){
    const el=document.getElementById('plan-status');
    if(!el) return;
    const meta=currentMeta();
    const dirty=bundleDirty();
    const parts=['<span class="dot"></span>'];
    if(!currentUser){
      parts.push('<button type="button" class="signin" data-signin-link="1">Sign in</button>');
      parts.push('<span>to save plans</span>');
    } else {
      if(meta.id){
        parts.push(`<span class="name">${esc(meta.name||('Plan #'+meta.id))}</span>`);
        parts.push(`<span>${dirty?'unsaved':'saved'}</span>`);
      } else {
        parts.push(`<span>${dirty?'Unsaved draft':'Not saved to server'}</span>`);
      }
      parts.push('<span class="sep">·</span>');
      parts.push(`<span class="who">${esc(currentUser.email)}</span>`);
    }
    el.innerHTML=parts.join('');
    el.classList.toggle('dirty',dirty);
    const link=el.querySelector('[data-signin-link]');
    if(link) link.addEventListener('click',openAuthModal);
  }

  function updateFabDirty(){
    const fab=document.getElementById('plan-fab');
    if(fab) fab.classList.toggle('dirty',bundleDirty());
  }
  function currentPage(){
    const path=location.pathname||'';
    // Directory URL (trailing slash or bare) → index.html
    if(!path||path.endsWith('/')) return 'index.html';
    const last=path.substring(path.lastIndexOf('/')+1);
    return last||'index.html';
  }
  // Which aircraft owns the current page? Null for a shared page (About/Dashboard).
  function pageAircraft(page){
    for(const ac of AIRCRAFT){ if(ac.tabs.some(t=>t.href===page)) return ac; }
    return null;
  }
  // The active aircraft: taken from the page if it belongs to one (and remembered),
  // otherwise from the last-selected id in localStorage (shared pages).
  function activeAircraft(){
    const ac=pageAircraft(currentPage());
    if(ac){ try{localStorage.setItem(AC_KEY,ac.id);}catch(e){} return ac; }
    let id='velis';
    try{ id=localStorage.getItem(AC_KEY)||'velis'; }catch(e){}
    return AIRCRAFT.find(a=>a.id===id)||AIRCRAFT[0];
  }
  // The tab type of the current page (across every aircraft + shared tabs).
  function currentTabType(page){
    for(const ac of AIRCRAFT) for(const t of ac.tabs) if(t.href===page) return t.type;
    for(const t of SHARED_TABS) if(t.href===page) return t.type;
    return null;
  }
  function switchAircraft(id){
    const target=AIRCRAFT.find(a=>a.id===id);
    if(!target) return;
    try{localStorage.setItem(AC_KEY,target.id);}catch(e){}
    const type=currentTabType(currentPage());
    // Land on the same tab type if the target has it; else its first tab.
    const dest=target.tabs.find(t=>t.type===type)||target.tabs[0];
    if(dest && dest.href!==currentPage()) location.href=dest.href;
    else updateNav();
  }
  const PLANE_SVG='<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg>';
  const CHEV_SVG='<svg class="nav-ac-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>';
  const TICK_SVG='<svg class="tick" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>';
  function updateNav(){
    const navInner=document.querySelector('.nav .nav-inner');
    if(!navInner) return;
    const isAdmin=!!(currentUser&&currentUser.is_admin);
    const page=currentPage();
    const ac=activeAircraft();
    // Remove any previously-rendered brand + tabs; leave the status span (if present) intact.
    navInner.querySelectorAll('[data-nav="1"]').forEach(el=>el.remove());
    const frag=document.createDocumentFragment();

    // Aircraft-selector brand (dropdown).
    const brand=document.createElement('div');
    brand.className='nav-brand nav-ac';
    brand.dataset.nav='1';
    brand.innerHTML=PLANE_SVG
      +'<button type="button" class="nav-ac-btn" id="nav-ac-btn" aria-haspopup="true" aria-expanded="false">'
      +  '<span class="nav-ac-name"></span>'+CHEV_SVG
      +'</button>'
      +'<div class="nav-ac-menu" id="nav-ac-menu" role="menu"></div>';
    brand.querySelector('.nav-ac-name').textContent=ac.name;
    const menu=brand.querySelector('#nav-ac-menu');
    AIRCRAFT.forEach(a=>{
      const b=document.createElement('button');
      b.type='button'; b.dataset.acId=a.id;
      b.className=(a.id===ac.id?'sel':'');
      b.innerHTML='<span></span>'+TICK_SVG;
      b.querySelector('span').textContent=a.name;
      menu.appendChild(b);
    });
    frag.appendChild(brand);

    // Tabs: the active aircraft's own tabs, then the shared tabs.
    const tabs=ac.tabs.concat(SHARED_TABS.filter(t=>!t.admin||isAdmin));
    tabs.forEach(t=>{
      const a=document.createElement('a');
      a.href=t.href;
      a.className='nav-tab'+(t.href===page?' active':'');
      a.dataset.nav='1';
      if(t.admin) a.dataset.adminTab='1';
      a.textContent=t.label;
      frag.appendChild(a);
    });
    // Insert at the start so status (if already there) stays on the right.
    navInner.insertBefore(frag,navInner.firstChild);

    // Wire the dropdown.
    const btn=brand.querySelector('#nav-ac-btn');
    btn.addEventListener('click',e=>{
      e.stopPropagation();
      const open=menu.classList.toggle('open');
      btn.setAttribute('aria-expanded',open?'true':'false');
    });
    menu.querySelectorAll('button[data-ac-id]').forEach(b=>{
      b.addEventListener('click',e=>{ e.stopPropagation(); menu.classList.remove('open'); switchAircraft(b.dataset.acId); });
    });
    if(!updateNav._docClose){
      updateNav._docClose=true;
      document.addEventListener('click',()=>{
        const m=document.getElementById('nav-ac-menu');
        if(m) m.classList.remove('open');
      });
    }
  }
  function ensureNavShell(){
    // If a page omits <nav class="nav">, create it at the very top of body.
    if(document.querySelector('.nav .nav-inner')) return;
    const nav=document.createElement('nav');
    nav.className='nav';
    nav.innerHTML='<div class="nav-inner"></div>';
    document.body.insertBefore(nav,document.body.firstChild);
  }
  function updateMenuWho(){
    const who=document.getElementById('plan-menu-who');
    const sep=document.getElementById('plan-menu-who-sep');
    const em =document.getElementById('plan-menu-who-em');
    const sig=document.getElementById('plan-menu-signin');
    const lo =document.getElementById('plan-menu-logout');
    if(!who) return;
    if(currentUser){
      who.hidden=false; sep.hidden=false;
      em.textContent=currentUser.email;
      sig.hidden=true; lo.hidden=false;
    } else {
      who.hidden=true; sep.hidden=true;
      sig.hidden=false; lo.hidden=true;
    }
  }
  function repaint(){updateNav();updateStatus();updateFabDirty();updateMenuWho();}

  /* ─── Bundle I/O ─── */
  function collectBundle(){
    document.dispatchEvent(new CustomEvent('velis:before-save'));
    let navplan={};
    try{
      const raw=localStorage.getItem(NAV_STATE_KEY);
      if(raw){const {meta:_m,...rest}=JSON.parse(raw);navplan=rest;}
    }catch(e){}
    const ls={};
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(k&&k.startsWith('velis_')&&!BUNDLE_EXCLUDE.has(k)) ls[k]=localStorage.getItem(k);
    }
    return {version:2,navplan,localStorage:ls};
  }
  function applyBundle(bundle){
    const ls=bundle&&bundle.localStorage;
    if(ls) for(const [k,v] of Object.entries(ls)) if(v!=null) safeSetItem(k,v);
    document.dispatchEvent(new CustomEvent('velis:after-load',{detail:{bundle}}));
  }

  /* ─── Actions ─── */
  function ensureAuth(){
    if(!currentUser){openAuthModal();return false;}
    return true;
  }
  async function handle401(retryFn){
    // Session expired → refresh /me, force login, optionally retry
    await refreshUser();
    if(!currentUser) openAuthModal();
  }
  async function doSave(){
    if(!ensureAuth()) return;
    const meta=currentMeta();
    if(!meta.id) return doSaveAs();
    try{
      await api(`/plans/${meta.id}`,{method:'PUT',body:JSON.stringify({plan_json:collectBundle()})});
      markBundleSaved();
      _syncDbg('doSave PUT ok → dispatching after-save');
      document.dispatchEvent(new CustomEvent('velis:after-save'));
    }catch(e){
      if(e.status===401){await handle401();return;}
      if(e.status===404){
        persistMeta({id:null,name:meta.name});
        return doSaveAs();
      }
      alert('Save failed: '+e.message);
    }
  }
  async function doSaveAs(){
    if(!ensureAuth()) return;
    const meta=currentMeta();
    const suggested=meta.name||suggestedFromNavplan()||'';
    const name=prompt('Save as — plan name:',suggested);
    if(!name||!name.trim()) return;
    const bundle=collectBundle();
    try{
      const res=await api('/plans',{method:'POST',body:JSON.stringify({name:name.trim(),plan_json:bundle})});
      persistMeta({id:res.id,name:res.name});
      markBundleSaved();
      _syncDbg('doSaveAs POST ok → dispatching after-save');
      document.dispatchEvent(new CustomEvent('velis:after-save'));
    }catch(e){
      if(e.status===401){await handle401();return;}
      if(e.status===409){
        alert(`A plan named "${name.trim()}" already exists. Pick a different name.`);
        return doSaveAs();
      }
      alert('Save As failed: '+e.message);
    }
  }
  async function doLoad(){
    if(!ensureAuth()) return;
    const listEl=document.getElementById('plan-list');
    const modal=document.getElementById('plan-load-modal');
    listEl.innerHTML='<div class="plan-empty">Loading…</div>';
    modal.hidden=false;
    try{
      const plans=await api('/plans');
      if(!plans.length){
        listEl.innerHTML='<div class="plan-empty">No saved plans yet.</div>';
        return;
      }
      listEl.innerHTML=plans.map(p=>{
        const when=new Date(p.updated_at).toLocaleString();
        return `<div class="plan-li" data-id="${p.id}">
          <span><span class="pn">${esc(p.name)}</span><span class="pd">${esc(when)}</span></span>
          <button type="button" class="del" data-del="${p.id}" title="Delete">×</button>
        </div>`;
      }).join('');
    }catch(e){
      if(e.status===401){closeLoadModal();await handle401();return;}
      listEl.innerHTML=`<div class="plan-empty">Could not list plans: ${esc(e.message)}</div>`;
    }
  }

  async function doLogout(){
    try{await api('/auth/logout',{method:'POST'});}catch(e){}
    wipeVelisLocal();
    currentUser=null;
    setCachedUser(null);
    repaint();
    openAuthModal();
  }

  function suggestedFromNavplan(){
    try{
      const raw=localStorage.getItem(NAV_STATE_KEY);
      if(!raw) return '';
      const s=JSON.parse(raw);
      return (s&&s.hdr&&s.hdr.ident)||'';
    }catch(e){return '';}
  }

  function persistMeta(meta){
    try{
      const raw=localStorage.getItem(NAV_STATE_KEY);
      const s=raw?JSON.parse(raw):{};
      s.meta={id:meta.id||null,name:meta.name||'',dirty:false};
      safeSetItem(NAV_STATE_KEY,JSON.stringify(s));
    }catch(e){}
  }

  /* ─── Auth modal ─── */
  let pendingEmail=null;          // last email sent → "resend" target
  let pendingPayload=null;        // last POST body → for resend
  let pendingEndpoint=null;       // '/auth/register' or '/auth/login'

  function openAuthModal(tab){
    const cached=getCachedUser();
    const defaultTab = tab || 'signin';
    setAuthTab(defaultTab);
    clearAuthError();
    hideAuthOk();
    if(cached && defaultTab==='signin'){
      const em=document.getElementById('plan-auth-signin-email');
      if(em) em.value=cached.email||'';
    }
    document.getElementById('plan-auth-modal').hidden=false;
    startAuthPoll();
    setTimeout(()=>{
      const focus=defaultTab==='signin'?'plan-auth-signin-email':'plan-auth-first';
      const el=document.getElementById(focus);
      if(el) el.focus();
    },50);
  }
  function closeAuthModal(){
    document.getElementById('plan-auth-modal').hidden=true;
    stopAuthPoll();
  }
  function setAuthTab(tab){
    document.querySelectorAll('#plan-auth-tabs button').forEach(b=>{
      b.classList.toggle('active',b.dataset.tab===tab);
    });
    document.querySelectorAll('#plan-auth-modal .auth-pane').forEach(p=>{
      p.classList.toggle('active',p.dataset.pane===tab);
    });
    document.getElementById('plan-auth-title').textContent=(tab==='signin')?'Sign in':'Create account';
    const sub=document.getElementById('plan-auth-submit');
    sub.textContent=(tab==='signin')?'Send sign-in link':'Create account';
    hideAuthOk();
    clearAuthError();
  }
  function currentAuthTab(){
    const active=document.querySelector('#plan-auth-tabs button.active');
    return active?active.dataset.tab:'signin';
  }
  function showAuthError(msg){
    const el=document.getElementById('plan-auth-err');
    el.textContent=msg;
    el.classList.add('show');
  }
  function clearAuthError(){
    const el=document.getElementById('plan-auth-err');
    el.textContent='';
    el.classList.remove('show');
  }
  function showAuthOk(email){
    document.getElementById('plan-auth-sent-to').textContent=email;
    document.getElementById('plan-auth-ok').classList.add('show');
    document.querySelectorAll('#plan-auth-modal .auth-pane').forEach(p=>p.classList.remove('active'));
    document.getElementById('plan-auth-tabs').style.display='none';
    document.getElementById('plan-auth-submit').hidden=true;
    document.getElementById('plan-auth-title').textContent='Magic link sent';
  }
  function hideAuthOk(){
    document.getElementById('plan-auth-ok').classList.remove('show');
    document.getElementById('plan-auth-tabs').style.display='';
    document.getElementById('plan-auth-submit').hidden=false;
    const tab=currentAuthTab();
    document.querySelectorAll('#plan-auth-modal .auth-pane').forEach(p=>{
      p.classList.toggle('active',p.dataset.pane===tab);
    });
  }
  async function submitAuth(){
    clearAuthError();
    const tab=currentAuthTab();
    const sub=document.getElementById('plan-auth-submit');
    let endpoint, payload, email;
    if(tab==='signin'){
      email=(document.getElementById('plan-auth-signin-email').value||'').trim();
      if(!email){showAuthError('Enter your email.');return;}
      endpoint='/auth/login';
      payload={email};
    } else {
      const first=(document.getElementById('plan-auth-first').value||'').trim();
      const last =(document.getElementById('plan-auth-last').value||'').trim();
      email      =(document.getElementById('plan-auth-email').value||'').trim();
      if(!first||!last||!email){showAuthError('All fields are required.');return;}
      endpoint='/auth/register';
      payload={first_name:first,last_name:last,email};
    }
    sub.disabled=true;
    try{
      const r=await api(endpoint,{method:'POST',body:JSON.stringify(payload)});
      pendingEmail=email;
      pendingPayload=payload;
      pendingEndpoint=endpoint;
      showAuthOk(r.email||email);
    }catch(e){
      let msg=e.message;
      try{const j=JSON.parse(e.message.replace(/^\d+\s*/,''));if(j&&j.error)msg=j.error;}catch(_){}
      showAuthError(msg||'Something went wrong. Try again.');
    }finally{
      sub.disabled=false;
    }
  }
  async function resendAuth(){
    if(!pendingEndpoint||!pendingPayload) return;
    try{
      const r=await api(pendingEndpoint,{method:'POST',body:JSON.stringify(pendingPayload)});
      const el=document.getElementById('plan-auth-sent-to');
      if(el) el.textContent=r.email||pendingEmail;
    }catch(e){/* silent */}
  }

  function startAuthPoll(){
    stopAuthPoll();
    authPollTimer=setInterval(async ()=>{
      if(document.getElementById('plan-auth-modal').hidden){stopAuthPoll();return;}
      const u=await refreshUser();
      if(u){closeAuthModal();}
    },3000);
  }
  function stopAuthPoll(){if(authPollTimer){clearInterval(authPollTimer);authPollTimer=null;}}

  function wireAuthModal(){
    document.getElementById('plan-auth-tabs').addEventListener('click',ev=>{
      const b=ev.target.closest('button[data-tab]');
      if(b) setAuthTab(b.dataset.tab);
    });
    document.getElementById('plan-auth-close').addEventListener('click',closeAuthModal);
    document.getElementById('plan-auth-submit').addEventListener('click',submitAuth);
    document.getElementById('plan-auth-resend').addEventListener('click',resendAuth);
    document.querySelectorAll('#plan-auth-modal input').forEach(inp=>{
      inp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();submitAuth();}});
    });
  }

  /* ─── Load modal ─── */
  function closeLoadModal(){document.getElementById('plan-load-modal').hidden=true;}
  function wireLoadModal(){
    document.getElementById('plan-load-cancel').addEventListener('click',closeLoadModal);
    document.getElementById('plan-list').addEventListener('click',async ev=>{
      const delBtn=ev.target.closest('[data-del]');
      if(delBtn){
        ev.stopPropagation();
        const pid=delBtn.dataset.del;
        if(!confirm('Delete this plan permanently?')) return;
        try{
          await api(`/plans/${pid}`,{method:'DELETE'});
          if(String(currentMeta().id)===String(pid)) persistMeta({id:null,name:''});
          doLoad();
        }catch(e){
          if(e.status===401){closeLoadModal();await handle401();return;}
          alert('Delete failed: '+e.message);
        }
        return;
      }
      const item=ev.target.closest('.plan-li');
      if(!item) return;
      const pid=item.dataset.id;
      try{
        const p=await api(`/plans/${pid}`);
        applyBundle(p.plan_json);
        persistMeta({id:p.id,name:p.name});
        markBundleSaved();
        closeLoadModal();
      }catch(e){
        if(e.status===401){closeLoadModal();await handle401();return;}
        alert('Load failed: '+e.message);
      }
    });
  }

  // Quiet console-only debug helper for the sync flow. (Earlier on-screen
  // toasts were removed once the wiring was confirmed; logs stay for support.)
  function _syncDbg(msg){ try{ console.log('[sync]', msg); }catch(e){} }
  window.velisSyncDbg = _syncDbg;

  /* ─── Cross-page sync prompt ───
     Pages register an isInSync() check + a push function via registerManualSync()
     and call runAutoSync() in their velis:after-save listener. The modal here
     handles 'ask' mode; 'always' fires the push silently; 'never' is a no-op.
     A "Sync now" item lives in the FAB menu as a manual escape hatch. */
  let manualSyncReg = null;             // { label, fn, available, warn }
  let pendingSync   = null;             // { onConfirm, warn } while modal is open

  function getAutoSyncPref(){
    const v=localStorage.getItem(AUTO_SYNC_KEY);
    return (v==='always'||v==='never') ? v : 'ask';
  }
  function setAutoSyncPref(v){
    if(v!=='always'&&v!=='never') v='ask';
    safeSetItem(AUTO_SYNC_KEY,v);
    updateSyncPrefUI();
  }

  function openSyncPrompt({title,bodyHtml,warn,onConfirm}){
    const modal=document.getElementById('plan-sync-modal');
    if(!modal){console.warn('[sync] openSyncPrompt: #plan-sync-modal missing');return;}
    console.log('[sync] openSyncPrompt: showing modal', {warn});
    pendingSync={onConfirm,warn:!!warn};
    document.getElementById('plan-sync-title').textContent=title||'Cleared to sync?';
    document.getElementById('plan-sync-body').innerHTML=bodyHtml||'';
    const w=document.getElementById('plan-sync-warn');
    if(warn){w.textContent=warn;w.classList.add('show');}
    else{w.textContent='';w.classList.remove('show');}
    // Warning is informational — Sync/Always stay clickable.
    document.getElementById('plan-sync-now').disabled=false;
    document.getElementById('plan-sync-always').disabled=false;
    modal.hidden=false;
    setTimeout(()=>{document.getElementById('plan-sync-not-now').focus();},50);
  }
  function closeSyncPrompt(){
    const modal=document.getElementById('plan-sync-modal');
    if(modal) modal.hidden=true;
    pendingSync=null;
  }
  function runAutoSync({isInSync,onConfirm,title,bodyHtml,warnOnMismatch,bodyHtmlOnMismatch}){
    let inSync=true;
    let mismatch=false;
    let isInSyncRaw;
    try{
      isInSyncRaw = isInSync&&isInSync();
      const r = isInSyncRaw;
      if(r&&typeof r==='object'){inSync=!!r.inSync;mismatch=!!r.mismatch;}
      else{inSync=!!r;}
    }catch(e){_syncDbg('runAutoSync isInSync threw: '+(e&&e.message||e)); inSync=true;}
    const pref=getAutoSyncPref();
    _syncDbg('runAutoSync inSync='+inSync+' mismatch='+mismatch+' pref='+pref+' raw='+JSON.stringify(isInSyncRaw));
    if(inSync){_syncDbg('runAutoSync: SILENT (already in sync) — nothing to do');return;}
    if(pref==='never'){_syncDbg('runAutoSync: MUTED (pref=never)');return;}
    if(pref==='always'){
      // User opted in to silent sync regardless of mismatch — trust them.
      _syncDbg('runAutoSync: pref=always → running onConfirm silently (mismatch='+mismatch+')');
      try{onConfirm&&onConfirm();}catch(e){_syncDbg('auto-sync failed: '+(e&&e.message||e));}
      _autoCommitAfterSync();
      return;
    }
    _syncDbg('runAutoSync: OPENING prompt modal');
    openSyncPrompt({
      title,
      bodyHtml: mismatch && bodyHtmlOnMismatch ? bodyHtmlOnMismatch : bodyHtml,
      warn: mismatch ? warnOnMismatch : '',
      onConfirm
    });
  }

  function registerManualSync(reg){
    manualSyncReg = reg && reg.fn ? reg : null;
    updateManualSyncButton();
  }
  function updateManualSyncButton(){
    const btn=document.getElementById('plan-menu-manual-sync');
    const sep=document.getElementById('plan-menu-sync-sep');
    const pref=document.getElementById('plan-menu-sync-pref');
    if(!btn) return;
    if(!manualSyncReg){
      btn.hidden=true; if(sep)sep.hidden=true; if(pref)pref.hidden=true;
      return;
    }
    if(sep) sep.hidden=false;
    if(pref) pref.hidden=false;
    btn.hidden=false;
    btn.textContent=manualSyncReg.label||'Sync now';
    let canRun=true;
    try{ canRun = !manualSyncReg.available || !!manualSyncReg.available(); }catch(e){canRun=false;}
    btn.disabled=!canRun;
  }
  function updateSyncPrefUI(){
    const pref=getAutoSyncPref();
    document.querySelectorAll('#plan-menu-sync-pref input[name="plan-sync-pref"]').forEach(inp=>{
      inp.checked = inp.value===pref;
    });
    document.querySelectorAll('#plan-menu-sync-pref label').forEach(lb=>{
      lb.classList.toggle('on', lb.dataset.val===pref);
    });
  }
  // Sync writes to localStorage and marks the bundle dirty. Without an
  // auto-commit the user would have to hit ⌘S a second time to flush the
  // sync to the server — and currentMeta.id is already set at this point,
  // so the second save is a quiet PUT.
  function _autoCommitAfterSync(){
    if(!currentUser) return;
    const meta=currentMeta();
    if(!meta.id) return;
    // Fire-and-forget: doSave handles its own errors via alert().
    setTimeout(()=>{ try{doSave();}catch(e){_syncDbg('auto-commit doSave threw: '+(e&&e.message||e));} },0);
  }
  function wireSyncModal(){
    document.getElementById('plan-sync-not-now').addEventListener('click',closeSyncPrompt);
    document.getElementById('plan-sync-now').addEventListener('click',()=>{
      const p=pendingSync; closeSyncPrompt();
      if(p&&p.onConfirm){
        try{p.onConfirm();}catch(e){_syncDbg('sync failed: '+(e&&e.message||e));}
        _autoCommitAfterSync();
      }
    });
    document.getElementById('plan-sync-always').addEventListener('click',()=>{
      const p=pendingSync; setAutoSyncPref('always'); closeSyncPrompt();
      if(p&&p.onConfirm){
        try{p.onConfirm();}catch(e){_syncDbg('sync failed: '+(e&&e.message||e));}
        _autoCommitAfterSync();
      }
    });
    document.getElementById('plan-sync-never').addEventListener('click',()=>{
      setAutoSyncPref('never'); closeSyncPrompt();
    });
  }
  function wireSyncPref(){
    document.querySelectorAll('#plan-menu-sync-pref input[name="plan-sync-pref"]').forEach(inp=>{
      inp.addEventListener('change',()=>{ if(inp.checked) setAutoSyncPref(inp.value); });
    });
    // Allow clicking the whole pill row (labels wrap radios already, but make
    // sure menu open/close doesn't swallow the click).
    document.getElementById('plan-menu-sync-pref').addEventListener('click',ev=>{
      ev.stopPropagation();
    });
    updateSyncPrefUI();
  }

  /* ─── FAB + menu ─── */
  function openMenu(){
    updateManualSyncButton();
    updateSyncPrefUI();
    const m=document.getElementById('plan-menu');
    m.dataset.open='1';
    setTimeout(()=>document.addEventListener('click',onDocClickOnce,{once:true}),0);
  }
  function closeMenu(){document.getElementById('plan-menu').dataset.open='0';}
  function onDocClickOnce(ev){
    const m=document.getElementById('plan-menu');
    const f=document.getElementById('plan-fab');
    if(m && m.contains(ev.target)) return;
    if(f && f.contains(ev.target)) return;
    closeMenu();
  }
  function wireFab(){
    document.getElementById('plan-fab').addEventListener('click',ev=>{
      ev.stopPropagation();
      const m=document.getElementById('plan-menu');
      if(m.dataset.open==='1') closeMenu(); else openMenu();
    });
  }
  function wireMenu(){
    document.getElementById('plan-menu').addEventListener('click',ev=>{
      const btn=ev.target.closest('button[data-act]');
      if(!btn) return;
      closeMenu();
      const act=btn.dataset.act;
      if(act==='save') doSave();
      else if(act==='save-as') doSaveAs();
      else if(act==='load') doLoad();
      else if(act==='manual-sync'){
        if(manualSyncReg&&manualSyncReg.fn){
          try{manualSyncReg.fn();}catch(e){console.warn('manual sync failed',e);}
        }
      }
      else if(act==='signin') openAuthModal();
      else if(act==='logout') doLogout();
    });
  }
  function wireKeyboard(){
    document.addEventListener('keydown',e=>{
      if((e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==='s'){
        e.preventDefault();
        doSave();
      }
      if(e.key==='Escape'){
        closeMenu();
        const a=document.getElementById('plan-auth-modal');if(a&&!a.hidden) closeAuthModal();
        const l=document.getElementById('plan-load-modal');if(l&&!l.hidden) closeLoadModal();
        const s=document.getElementById('plan-sync-modal');if(s&&!s.hidden) closeSyncPrompt();
      }
    });
  }

  /* ─── DOM injection ─── */
  function injectCSS(){
    if(document.getElementById('plan-sync-css')) return;
    const s=document.createElement('style');
    s.id='plan-sync-css';
    s.textContent=CSS;
    document.head.appendChild(s);
  }
  function injectNavStatus(){
    const navInner=document.querySelector('.nav .nav-inner');
    if(!navInner||navInner.querySelector('#plan-status')) return;
    navInner.insertAdjacentHTML('beforeend',STATUS_HTML);
  }
  function injectFabAndModals(){
    if(document.getElementById('plan-fab')) return;
    document.body.insertAdjacentHTML('beforeend',FAB_HTML+MENU_HTML+AUTH_HTML+LOAD_HTML+SYNC_HTML);
    wireFab();
    wireMenu();
    wireAuthModal();
    wireLoadModal();
    wireSyncModal();
    wireSyncPref();
  }

  function boot(){
    injectCSS();
    ensureNavShell();
    updateNav();
    injectNavStatus();
    injectFabAndModals();
    wireKeyboard();
    currentUser=getCachedUser();
    repaint();
    // Re-check /me in the background to catch cookie expiry / fresh sign-in.
    refreshUser();
    window.addEventListener('focus',()=>{ refreshUser(); });
    window.addEventListener('storage',e=>{
      if(!e.key||e.key.startsWith('velis_')) repaint();
    });
    window.addEventListener('pageshow',repaint);
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',boot);
  else boot();

  /* ─── Public API ─── */
  window.velisPlan = {
    save:doSave, saveAs:doSaveAs, load:doLoad,
    openSettings:openAuthModal,  // legacy alias
    openAuth:openAuthModal, logout:doLogout,
    markDirty:markBundleDirty, markSaved:markBundleSaved,
    bundleDirty, updateStatus:repaint,
    promptSync:openSyncPrompt,
    runAutoSync,
    registerManualSync,
    getAutoSyncPref, setAutoSyncPref,
    get user(){return currentUser;}
  };
})();

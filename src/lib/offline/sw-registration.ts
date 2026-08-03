/**
 * Service-worker registration bootstrap.
 *
 * The old one-liner was `register('/sw.js').catch(noop)` — fire and forget. It
 * never asked for an update, so an installed PWA could keep running the bundle
 * it launched with. A browser only checks `/sw.js` on its own schedule (on
 * navigation, at most every 24h), which for a standalone window that is rarely
 * cold-started means "almost never". Production feedback therefore requires
 * installed clients to check for updates more aggressively.
 *
 * So this:
 *   1. registers, then immediately calls `update()`;
 *   2. re-checks whenever the app is brought back to the foreground, and on a
 *      slow interval while it stays open;
 *   3. reloads exactly once when a NEW worker takes control.
 *
 * The reload is guarded by `controllerchange` + a one-shot flag. The worker
 * calls `skipWaiting()` on install, so a new deploy activates promptly and this
 * turns that activation into a fresh document. `controller == null` on the very
 * first registration (nothing controlled the page before), which must NOT
 * reload — that is the initial install, not an update.
 */

/** How often an open tab re-checks for a new worker. */
export const SW_UPDATE_POLL_MS = 15 * 60 * 1000;

export function swRegistrationBootstrap(): string {
  // Inlined into a <script> tag, so it must be self-contained ES5-ish source.
  return `
(function(){
  if(!('serviceWorker' in navigator))return;
  var reloading=false;
  // Captured NOW, before any change: inside the handler the controller is
  // already the new worker, so it cannot tell an update from a first install.
  var hadController=!!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange',function(){
    if(reloading||!hadController)return;
    reloading=true;
    window.location.reload();
  });
  navigator.serviceWorker.register('/sw.js').then(function(reg){
    var check=function(){ try{reg.update();}catch(e){} };
    check();
    document.addEventListener('visibilitychange',function(){
      if(document.visibilityState==='visible')check();
    });
    window.addEventListener('focus',check);
    setInterval(check,${SW_UPDATE_POLL_MS});
  }).catch(function(){});
})();
`.trim();
}

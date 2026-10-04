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

/**
 * How long to wait for a new worker to say which build it is. A page rendered by
 * the same deploy as the new worker is already current, so it is not reloaded:
 * on 3 Oct 2026 the first launch after every deploy painted, then reloaded
 * itself to a white screen, although its HTML had just come from that deploy.
 * The page's build is the `md3-build` meta tag (the full commit); the worker's
 * is its build stamp (a short commit). No answer, or no page build, keeps the
 * old behaviour and reloads.
 */
export const SW_BUILD_REPLY_MS = 1500;

export function swRegistrationBootstrap(): string {
  // Inlined into a <script> tag, so it must be self-contained ES5-ish source.
  return `
(function(){
  if(!('serviceWorker' in navigator))return;
  var reloading=false;
  // Captured NOW, before any change: inside the handler the controller is
  // already the new worker, so it cannot tell an update from a first install.
  var hadController=!!navigator.serviceWorker.controller;
  var meta=document.querySelector('meta[name="md3-build"]');
  var pageBuild=meta?(meta.getAttribute('content')||''):'';
  var reload=function(){
    if(reloading)return;
    reloading=true;
    window.location.reload();
  };
  navigator.serviceWorker.addEventListener('controllerchange',function(){
    if(reloading||!hadController)return;
    var ctl=navigator.serviceWorker.controller;
    if(!pageBuild||!ctl||typeof MessageChannel==='undefined'){reload();return;}
    var answered=false;
    var channel=new MessageChannel();
    var timer=setTimeout(function(){if(!answered){answered=true;reload();}},${SW_BUILD_REPLY_MS});
    channel.port1.onmessage=function(event){
      if(answered)return;
      answered=true;
      clearTimeout(timer);
      var build=event&&event.data&&event.data.build;
      if(typeof build==='string'&&build&&pageBuild.indexOf(build)===0)return;
      reload();
    };
    try{ctl.postMessage({type:'md3-build'},[channel.port2]);}
    catch(err){if(!answered){answered=true;clearTimeout(timer);reload();}}
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

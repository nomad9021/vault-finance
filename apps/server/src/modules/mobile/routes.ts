import { readFileSync } from "node:fs";
import { TOKENS_CSS } from "@vault/design-tokens/css";
import type { FastifyInstance } from "fastify";

// Brand icon, shipped as PNG next to this module (copied into dist by the build
// script). Read once at startup and served from same-origin routes so the HTML
// stays lean and the home-screen / manifest icons are real raster art.
const ICON_PNG = readFileSync(new URL("./app-icon.png", import.meta.url));
const ICON_MASKABLE_PNG = readFileSync(new URL("./app-icon-maskable.png", import.meta.url));
// Bump this whenever the icon art changes — it cache-busts the URL so phones
// that already added the app to their home screen pick up the new icon.
const ICON_VER = "3";
// Same idea for the stylesheet: it is cached hard, so its URL carries a
// version that changes whenever the shared design system does.
// Bump whenever the shared stylesheet changes — /vault.css is served
// `immutable` for a week, so a phone that already loaded the page will keep the
// old CSS until this URL changes.
const CSS_VER = "5";

/**
 * A tiny, dependency-free, **read-only** phone viewer served on the same origin
 * as the API. Zero-trust: you log in every time (password + 2FA), the token
 * lives only in memory, and nothing is written to device storage.
 *
 * Privacy lock: the moment the tab is hidden (app switch, screen off) a cover
 * page hides the content, and if you're away longer than a few minutes the
 * session is signed out. All data is inserted via textContent / escaped SVG so
 * a merchant or category name can't inject markup.
 *
 * Design: this page has no styles of its own. It links the *same* stylesheet
 * the desktop app compiles in (`@vault/design-tokens`), and builds its screens
 * out of the same `.panel` / `.list-row` / `.tabbar` classes. That is the only
 * reason the two platforms look like one product — there is no second palette
 * to keep in sync, because there is no second palette.
 */
export default async function mobileRoutes(app: FastifyInstance) {
  app.get("/manifest.webmanifest", async (_req, reply) => {
    reply
      .header("content-type", "application/manifest+json")
      .header("cache-control", "no-store")
      .send(
        JSON.stringify({
          name: "Vault Finance",
          short_name: "Vault Finance",
          display: "standalone",
          background_color: "#14151f",
          theme_color: "#14151f",
          start_url: "/",
          icons: [
            { src: "/app-icon.png?v=" + ICON_VER, sizes: "512x512", type: "image/png", purpose: "any" },
            {
              src: "/app-icon-maskable.png?v=" + ICON_VER,
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        }),
      );
  });

  app.get("/app-icon.png", async (_req, reply) => {
    reply
      .header("content-type", "image/png")
      .header("cache-control", "public, max-age=86400")
      .send(ICON_PNG);
  });

  app.get("/app-icon-maskable.png", async (_req, reply) => {
    reply
      .header("content-type", "image/png")
      .header("cache-control", "public, max-age=86400")
      .send(ICON_MASKABLE_PNG);
  });

  // The shared design system, served rather than inlined so the phone caches it
  // once instead of re-downloading it on every sign-in.
  app.get("/vault.css", async (_req, reply) => {
    reply
      .header("content-type", "text/css; charset=utf-8")
      .header("cache-control", "public, max-age=604800, immutable")
      .send(TOKENS_CSS);
  });

  app.get("/", async (_req, reply) => {
    reply
      .header(
        "content-security-policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      )
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header("cache-control", "no-store")
      .type("text/html")
      .send(PAGE);
  });
}

const PAGE = /* html */ `<!doctype html>
<html lang="en" data-theme="dark"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#14151f">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Vault Finance">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/app-icon.png?v=${ICON_VER}">
<link rel="stylesheet" href="/vault.css?v=${CSS_VER}">
<title>Vault Finance</title>
<style>
  /* Phone shell geometry only — every colour, size and radius below comes
     from the shared token layer. Nothing here re-defines the look. */
  body { overscroll-behavior-y: none; }
  #app { display: flex; flex-direction: column; height: 100dvh; }
  #scroll {
    flex: 1;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    padding: var(--space-4) var(--space-4) var(--space-6);
  }
  #scroll > .page { animation: fadeUp var(--dur) var(--ease-out) both; }
  .m-head {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: max(env(safe-area-inset-top), var(--space-3)) var(--space-4) var(--space-3);
    border-bottom: 1px solid var(--color-divider);
  }
  .mark {
    width: 26px; height: 26px; border-radius: 8px; flex: none;
    background: linear-gradient(135deg, var(--color-accent) 0%, var(--color-section-glow) 100%);
    box-shadow: 0 0 20px color-mix(in srgb, var(--color-accent) 45%, transparent);
  }
  .m-login { min-height: 100dvh; display: flex; flex-direction: column; justify-content: center;
    max-width: 420px; margin: 0 auto; padding: var(--space-6) var(--space-5); }
  .prof {
    display: flex; flex-direction: column; align-items: center; gap: var(--space-2);
    padding: var(--space-3) var(--space-4); border-radius: var(--radius-lg);
    background: none; border: 1px solid var(--color-divider); cursor: pointer; color: inherit;
  }
  .prof[data-on] { border-color: var(--color-accent); background: var(--color-accent-soft); }
  /* The diagram is the desktop's exact geometry, so it is wider than the
     screen and scrolls inside its panel. */
  .sankey-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 calc(var(--card-pad) * -1); padding: 0 var(--card-pad); }
  /* base.css sets a global svg max-width of 100% for every other image here.
     That silently overrode the diagram's inline width, crushing 1240px down to
     the card (~341px): captions rendered at 3.4px and the scroller had nothing
     to scroll, so the "swipe sideways" hint was false. The diagram is the one
     SVG here that must exceed its container. */
  .sankey-scroll svg { max-width: none; }
  #lock {
    position: fixed; inset: 0; z-index: var(--z-modal);
    background: var(--color-bg); display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: var(--space-4);
  }
</style></head>
<body>

<div id="login" class="m-login">
  <div style="text-align:center;margin-bottom:var(--space-6)">
    <div class="mark" style="width:44px;height:44px;border-radius:13px;margin:0 auto var(--space-3)"></div>
    <div class="page-title">Vault Finance</div>
    <div class="t-sm t-tertiary" style="margin-top:var(--space-1)">Read-only viewer</div>
  </div>
  <div id="profiles" class="row wrap" style="justify-content:center;gap:var(--space-3);margin-bottom:var(--space-4)"></div>
  <div id="pwbox" hidden class="stack">
    <input id="pw" class="input" type="password" placeholder="Password" autocomplete="current-password">
    <input id="code" class="input" inputmode="numeric" placeholder="6-digit code" hidden>
    <button id="signin" class="btn btn-primary btn-lg btn-block">Sign in</button>
    <div id="err" class="field-error" hidden style="text-align:center"></div>
  </div>
  <div class="t-xs t-tertiary" style="text-align:center;margin-top:var(--space-6)">
    Nothing is saved on this device. It locks when you leave the app and signs out after a few minutes away.
  </div>
</div>

<div id="app" hidden>
  <div class="m-head">
    <div class="mark"></div>
    <div class="brand-name grow truncate" id="viewTitle">Vault Finance</div>
    <button id="out" class="btn btn-ghost btn-sm">Sign out</button>
  </div>
  <div id="scroll"></div>
  <nav id="tabbar" class="tabbar" aria-label="Sections"></nav>
</div>

<div id="lock" hidden>
  <div class="mark" style="width:52px;height:52px;border-radius:15px"></div>
  <div class="panel-title">Locked</div>
  <div class="t-sm t-tertiary">Tap to view your finances</div>
</div>

<script>
(function(){
  "use strict";
  var token=null, sel=null, hiddenAt=0, logoutTimer=null, idleTimer=null;
  // Applies both to time spent backgrounded and to untouched time with the app open.
  var IDLE_MS=4*60*1000;
  var $=function(id){return document.getElementById(id)};
  var cache={};           // endpoint -> parsed JSON, filled once per session
  var view={tab:"home", page:null, detail:null};

  // ── tiny DOM helpers ────────────────────────────────────────────────────
  // Everything user-supplied goes in via textContent, never innerHTML.
  function el(t,cls,txt){var e=document.createElement(t);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}
  function fmt(c){var n=Math.round(c/100),s=n<0?"-":"";n=Math.abs(n);return s+"$"+n.toLocaleString()}
  function fmt2(c){var s=c<0?"-":"";return s+"$"+Math.abs(c/100).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
  function pct(n){return Math.round(n*100)+"%"}
  function esc(s){return String(s).replace(/[&<>"']/g,function(ch){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]})}
  function svgIcon(d,size){return '<svg width="'+(size||21)+'" height="'+(size||21)+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="'+d+'"/></svg>'}

  // Icon paths lifted from the shared @vault/ui set so the tab bar glyphs are
  // literally the same drawings as the desktop sidebar's.
  var ICONS={
    home:"M3 10.6 12 3.5l9 7.1M5.6 9.6V19a1.6 1.6 0 0 0 1.6 1.6h9.6A1.6 1.6 0 0 0 18.4 19V9.6",
    wallet:"M3.4 7.6A2.2 2.2 0 0 1 5.6 5.4h11.8a2.2 2.2 0 0 1 2.2 2.2v9.2a2.2 2.2 0 0 1-2.2 2.2H5.6a2.2 2.2 0 0 1-2.2-2.2V7.6ZM16 11.6h4.6v3.2H16a1.6 1.6 0 1 1 0-3.2Z",
    target:"M12 3.2a8.8 8.8 0 1 0 0 17.6 8.8 8.8 0 0 0 0-17.6ZM12 7.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8ZM12 11.4a.6.6 0 1 0 0 1.2.6.6 0 0 0 0-1.2Z",
    trendUp:"M4 16.8 9.6 11.2l3.4 3.4L20 7.6M15 7.6h5v5",
    chevronLeft:"M14.6 5.6 8.2 12l6.4 6.4"
  };

  // ── privacy lock ────────────────────────────────────────────────────────
  function lock(){ if(!token) return; $("lock").hidden=false; hiddenAt=Date.now(); clearTimeout(logoutTimer); logoutTimer=setTimeout(logout, IDLE_MS); }
  function onVisible(){ if(!token){ $("lock").hidden=true; return; } clearTimeout(logoutTimer); if(Date.now()-hiddenAt>IDLE_MS){ logout(); } idleReset(); }
  document.addEventListener("visibilitychange", function(){ document.hidden ? lock() : onVisible(); });
  window.addEventListener("pagehide", lock);
  $("lock").addEventListener("click", function(){ if(token) $("lock").hidden=true; idleReset(); });

  // ── idle sign-out while the app is open ─────────────────────────────────
  // Backgrounding the app already signs out after IDLE_MS. A phone left awake
  // on the dashboard was staying signed in indefinitely, which is the same
  // exposure with none of the protection — so untouched time counts too.
  function idleReset(){
    if(!token)return;
    clearTimeout(idleTimer);
    idleTimer=setTimeout(function(){ if(token) logout(); }, IDLE_MS);
  }
  ["touchstart","pointerdown","keydown","scroll","input"].forEach(function(ev){
    // Passive + capture: never delay a gesture, and still see events that a
    // handler below might stop propagating.
    document.addEventListener(ev, idleReset, {passive:true, capture:true});
  });

  async function api(path){
    if(cache[path]) return cache[path];
    var r=await fetch("/api/v1"+path,{headers:{authorization:"Bearer "+token},cache:"no-store"});
    if(r.status===401){logout();throw new Error("401")}
    if(!r.ok)throw new Error(String(r.status));
    cache[path]=await r.json();
    return cache[path];
  }
  async function tryApi(path,fallback){ try{ return await api(path) }catch(e){ return fallback } }

  function logout(){
    token=null;sel=null;cache={};view={tab:"home",page:null,detail:null};
    clearTimeout(logoutTimer);clearTimeout(idleTimer);
    $("lock").hidden=true;$("app").hidden=true;$("scroll").textContent="";
    $("login").hidden=false;$("pwbox").hidden=true;
    $("pw").value="";$("code").value="";$("code").hidden=true;
    loadProfiles();
  }

  // ── sign in ─────────────────────────────────────────────────────────────
  async function loadProfiles(){
    var box=$("profiles");box.textContent="";
    try{
      var d=await (await fetch("/api/v1/auth/profiles",{cache:"no-store"})).json();
      (d.profiles||[]).forEach(function(p){
        var b=el("button","prof");
        var av=el("div","avatar",(p.displayName||"?").charAt(0).toUpperCase());
        av.style.width="44px";av.style.height="44px";av.style.fontSize="17px";
        av.style.background=p.avatarColor||"var(--color-accent)";
        b.appendChild(av);
        b.appendChild(el("span","t-sm t-medium",(p.displayName||"").split(" ")[0]));
        b.onclick=function(){
          sel=p;
          var all=box.querySelectorAll(".prof");
          for(var i=0;i<all.length;i++)all[i].removeAttribute("data-on");
          b.setAttribute("data-on","1");
          $("pwbox").hidden=false;$("err").hidden=true;$("pw").focus();
        };
        box.appendChild(b);
      });
    }catch(e){box.appendChild(el("div","t-sm t-tertiary","Can't reach the server."))}
  }

  async function signin(){
    if(!sel)return;
    var pw=$("pw").value, code=$("code").value.replace(/\\D/g,"");
    if(!pw)return;
    $("err").hidden=true;
    var body={userId:sel.id,password:pw,deviceName:"Phone viewer (web)",platform:"ios"};
    if(!$("code").hidden&&code)body.totpCode=code;
    var r=await fetch("/api/v1/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    if(r.ok){var d=await r.json();token=d.accessToken;$("login").hidden=true;$("app").hidden=false;buildTabs();render();idleReset();return}
    var c2="";try{c2=(await r.json()).error.code}catch(e){}
    if(c2==="TOTP_REQUIRED"){$("code").hidden=false;$("code").focus();return}
    if(c2==="TOTP_INVALID"){$("code").hidden=false;showErr("That code isn't right — use the current one.");return}
    showErr(c2==="RATE_LIMITED"?"Too many attempts — wait a bit.":"That didn't work.");
  }
  function showErr(m){var e=$("err");e.textContent=m;e.hidden=false}

  // ── navigation model ────────────────────────────────────────────────────
  // Deliberately the same five-group shape as the desktop shell's nav.ts, so
  // the two navigate identically. The viewer is read-only, so "More" carries
  // the reports summary instead of settings.
  var TABS=[
    {id:"home", label:"Home", icon:"home", pages:[{id:"home", label:"Overview"}]},
    {id:"money",label:"Money",icon:"wallet",pages:[{id:"accounts",label:"Accounts"},{id:"transactions",label:"Transactions"}]},
    {id:"plan", label:"Plan", icon:"target",pages:[{id:"budgets",label:"Budgets"},{id:"bills",label:"Bills"}]},
    {id:"grow", label:"Grow", icon:"trendUp",pages:[{id:"goals",label:"Goals"},{id:"investments",label:"Investments"}]}
  ];
  function tabOf(id){for(var i=0;i<TABS.length;i++)if(TABS[i].id===id)return TABS[i];return TABS[0]}

  function buildTabs(){
    var bar=$("tabbar");bar.textContent="";
    TABS.forEach(function(t){
      var b=el("button","tab-item");
      var ic=el("span","tab-item-icon");ic.innerHTML=svgIcon(ICONS[t.icon]);
      b.appendChild(ic);b.appendChild(document.createTextNode(t.label));
      b.onclick=function(){ view={tab:t.id,page:t.pages[0].id,detail:null}; render() };
      b.dataset.tab=t.id;
      bar.appendChild(b);
    });
  }
  function syncTabs(){
    var kids=$("tabbar").children;
    for(var i=0;i<kids.length;i++){
      if(kids[i].dataset.tab===view.tab)kids[i].setAttribute("data-active","1");
      else kids[i].removeAttribute("data-active");
    }
  }

  // ── shared building blocks (mirrors of the desktop primitives) ──────────
  function panel(title,sub){
    var p=el("div","panel");
    if(title){
      var h=el("div","panel-head");
      var l=el("div");l.appendChild(el("div","panel-title",title));
      if(sub)l.appendChild(el("div","panel-sub",sub));
      h.appendChild(l);p.appendChild(h);
    }
    return p;
  }
  function statRow(label,value,cls){
    var s=el("div","stat");
    s.appendChild(el("div","stat-label",label));
    s.appendChild(el("div","stat-value"+(cls?" "+cls:""),value));
    return s;
  }
  function listRow(title,sub,amount,amtCls,onClick){
    var r=el(onClick?"button":"div","list-row");
    var main=el("div","list-row-main");
    main.appendChild(el("div","list-row-title",title));
    if(sub)main.appendChild(el("div","list-row-sub",sub));
    r.appendChild(main);
    if(amount!=null){
      var a=el("div","list-row-amount"+(amtCls?" "+amtCls:""),amount);
      r.appendChild(a);
    }
    if(onClick){
      var ch=el("span");ch.innerHTML=svgIcon("M9.4 5.6 15.8 12l-6.4 6.4",16);
      ch.style.color="var(--content-tertiary)";ch.style.flex="none";
      r.appendChild(ch);
      r.onclick=onClick;
    }
    return r;
  }
  function bar(fraction,color){
    var b=el("div","bar");var i=el("i");
    b.style.setProperty("--bar-pct",Math.max(0,Math.min(1,fraction))*100+"%");
    if(color)b.style.setProperty("--bar-fill",color);
    b.appendChild(i);return b;
  }
  function empty(title,body){
    var e=el("div","empty empty-sm");
    e.appendChild(el("div","empty-title",title));
    if(body)e.appendChild(el("p","empty-body",body));
    return e;
  }
  function pageTabs(tab,current,onPick){
    if(tab.pages.length<2)return null;
    var d=el("div","tabs no-scrollbar");
    tab.pages.forEach(function(p){
      var b=el("button","tab",p.label);
      if(p.id===current)b.setAttribute("data-active","1");
      b.onclick=function(){onPick(p.id)};
      d.appendChild(b);
    });
    return d;
  }

  // ── charts (SVG, same geometry as the desktop) ──────────────────────────
  function project(v,c){var n=v.length;if(!n)return new Array(c).fill(0);if(n===1)return new Array(c).fill(v[0]);
    var xm=(n-1)/2,ym=v.reduce(function(a,b){return a+b},0)/n,num=0,den=0;
    for(var i=0;i<n;i++){num+=(i-xm)*(v[i]-ym);den+=(i-xm)*(i-xm)}var sl=den?num/den:0,ic=ym-sl*xm;
    return Array.from({length:c},function(_,k){return Math.round(ic+sl*(n+k))})}
  function spark(history,projected,color){
    var all=history.concat(projected);if(all.length<2)return "";
    var W=300,H=58,pad=5,min=Math.min.apply(null,all),max=Math.max.apply(null,all),span=(max-min)||1;
    var x=function(i){return pad+(i/(all.length-1))*(W-2*pad)},y=function(v){return H-pad-((v-min)/span)*(H-2*pad)};
    var last=history.length-1;
    var hist=history.map(function(v,i){return (i?"L":"M")+x(i).toFixed(1)+","+y(v).toFixed(1)}).join(" ");
    var proj="M"+x(last).toFixed(1)+","+y(history[last]).toFixed(1)+" "+projected.map(function(v,k){return "L"+x(last+1+k).toFixed(1)+","+y(v).toFixed(1)}).join(" ");
    var area=hist+" L"+x(last).toFixed(1)+","+(H-pad)+" L"+x(0).toFixed(1)+","+(H-pad)+" Z";
    return '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" style="width:100%;height:'+H+'px;display:block;margin-top:var(--space-2)" xmlns="http://www.w3.org/2000/svg">'
      +'<path d="'+area+'" fill="'+color+'" fill-opacity="0.13"/>'
      +'<path d="'+hist+'" fill="none" stroke="'+color+'" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>'
      +(projected.length?'<path d="'+proj+'" fill="none" stroke="'+color+'" stroke-width="2" stroke-dasharray="4 4" stroke-opacity="0.55" vector-effect="non-scaling-stroke"/>':'')
      +'<circle cx="'+x(last).toFixed(1)+'" cy="'+y(history[last]).toFixed(1)+'" r="3" fill="'+color+'"/></svg>';
  }
  /**
   * A faithful port of the desktop Sankey (packages/ui/src/charts/Sankey.tsx).
   *
   * Every constant, the barycenter column ordering, the link-stacking cursors,
   * the per-flow source-to-target gradients and the label geometry are copied
   * from it deliberately — an earlier approximation used its own smaller
   * constants and flat ribbons, and the result visibly did not match the
   * desktop app.
   *
   * Because the geometry is identical it is also 1240 units wide, so on a phone
   * it lives in a horizontal scroller at native size rather than being squashed
   * to fit. Squashing is what makes the 12.5px captions illegible.
   *
   * If these ever diverge again, diff them against the desktop component.
   */
  var SK={BASE_H:600,W:1240,NW:6,PAD:40,X0:64,X1:1176,GAP:14,MIN_NODE:4,ROW_MIN:34,MIN_LINK:2};

  function rgba(hex,alpha){
    var m=/^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if(!m)return hex;
    var n=parseInt(m[1],16);
    return "rgba("+((n>>16)&255)+", "+((n>>8)&255)+", "+(n&255)+", "+alpha+")";
  }

  function sankeyLayout(nodes,links){
    var depths=Array.from(new Set(nodes.map(function(n){return n.depth}))).sort(function(a,b){return a-b});
    var maxDepth=depths[depths.length-1]||0;
    var xFor=function(d){return maxDepth===0?SK.X0:SK.X0+(d*(SK.X1-SK.X0))/maxDepth};

    var sumIn={},sumOut={};
    links.forEach(function(l){
      sumOut[l.from]=(sumOut[l.from]||0)+l.value;
      sumIn[l.to]=(sumIn[l.to]||0)+l.value;
    });
    var magnitude=function(n){return Math.max(n.value,sumIn[n.id]||0,sumOut[n.id]||0)};

    var byDepth={};
    nodes.forEach(function(n){(byDepth[n.depth]=byDepth[n.depth]||[]).push(n)});
    var maxColSum=1;
    Object.keys(byDepth).forEach(function(d){
      maxColSum=Math.max(maxColSum,byDepth[d].reduce(function(s,n){return s+magnitude(n)},0));
    });
    var scale=(SK.BASE_H-2*SK.PAD)/maxColSum;

    var barHeight=function(n){return Math.max(SK.MIN_NODE,magnitude(n)*scale)};
    var slotHeight=function(n){return Math.max(SK.ROW_MIN,barHeight(n))};
    var columnHeight=function(ns){
      return ns.reduce(function(s,n){return s+slotHeight(n)},0)+Math.max(0,ns.length-1)*SK.GAP;
    };
    var contentH=0;
    Object.keys(byDepth).forEach(function(d){contentH=Math.max(contentH,columnHeight(byDepth[d]))});
    var H=Math.max(SK.BASE_H,Math.ceil(contentH+2*SK.PAD));

    var placed={},parentsOf={};
    links.forEach(function(l){(parentsOf[l.to]=parentsOf[l.to]||[]).push(l.from)});

    depths.forEach(function(d,di){
      var ns=(byDepth[d]||[]).slice();
      if(di===0){
        ns.sort(function(a,b){return magnitude(b)-magnitude(a)});
      }else{
        var bary=function(n){
          var ps=(parentsOf[n.id]||[]).map(function(id){return placed[id]}).filter(Boolean);
          if(!ps.length)return Number.MAX_SAFE_INTEGER;
          return ps.reduce(function(s,p){return s+(p.y+p.h/2)},0)/ps.length;
        };
        ns.sort(function(a,b){return bary(a)-bary(b)});
      }
      var totalH=columnHeight(ns);
      var y=(H-totalH)/2;
      ns.forEach(function(n){
        var slot=slotHeight(n),h=barHeight(n);
        placed[n.id]={n:n,x:xFor(d),y:y+(slot-h)/2,h:h};
        y+=slot+SK.GAP;
      });
    });

    var outCursor={},inCursor={};
    var ordered=links.slice().sort(function(a,b){
      var sa=(placed[a.from]||{}).y||0, sb=(placed[b.from]||{}).y||0;
      if(sa!==sb)return sa-sb;
      return ((placed[a.to]||{}).y||0)-((placed[b.to]||{}).y||0);
    });
    var placedLinks=[];
    ordered.forEach(function(l){
      var s=placed[l.from],t=placed[l.to];
      if(!s||!t)return;
      var h=l.value>0?l.value*scale:SK.MIN_LINK;
      var sy=outCursor[l.from]!=null?outCursor[l.from]:s.y;
      var ty=inCursor[l.to]!=null?inCursor[l.to]:t.y;
      placedLinks.push({from:l.from,to:l.to,sx:s.x+SK.NW,sy:sy,tx:t.x,ty:ty,t:h});
      outCursor[l.from]=sy+h;
      inCursor[l.to]=ty+h;
    });

    return {nodes:placed,links:placedLinks,height:H};
  }

  function sankeySvg(nodes,links){
    if(!nodes.length||!links.length)return "";
    var geo=sankeyLayout(nodes,links);
    var seed=Math.random().toString(36).slice(2,8);
    var hubColor="#9397ab";

    var colorById={},depthById={};
    nodes.forEach(function(n){colorById[n.id]=n.color;depthById[n.id]=n.depth});
    var linkColor=function(id){return colorById[id]||hubColor};

    // Percentages read as each node's share of total income (hub = 100%).
    var hub=nodes.filter(function(n){return n.kind==="hub"})[0];
    var rootTotal=(hub&&hub.value>0)?hub.value
      :nodes.filter(function(n){return n.depth===0}).reduce(function(s,n){return s+n.value},0)
        ||nodes.reduce(function(m,n){return Math.max(m,n.value)},0);

    var flowKey=function(l){
      return (depthById[l.to]||0)>=(depthById[l.from]||0)?l.to:l.from;
    };
    var linkPath=function(l){
      var mx=(l.sx+l.tx)/2;
      return "M"+l.sx+","+l.sy+" C"+mx+","+l.sy+" "+mx+","+l.ty+" "+l.tx+","+l.ty
        +" L"+l.tx+","+(l.ty+l.t)+" C"+mx+","+(l.ty+l.t)+" "+mx+","+(l.sy+l.t)+" "+l.sx+","+(l.sy+l.t)+" Z";
    };

    var out=['<svg viewBox="0 0 '+SK.W+' '+geo.height+'" style="width:'+SK.W+'px;height:auto;display:block" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Cash flow diagram">'];

    // Per-flow gradient blending the source colour into the target colour —
    // the desktop's signature, and the biggest visual difference from a flat fill.
    out.push("<defs>");
    geo.links.forEach(function(l,i){
      var key=flowKey(l);
      var c1=l.from===key?linkColor(key):hubColor;
      var c2=l.to===key?linkColor(key):hubColor;
      out.push('<linearGradient id="flow-'+seed+'-'+i+'" gradientUnits="userSpaceOnUse" x1="'+l.sx+'" x2="'+l.tx+'" y1="0" y2="0">'
        +'<stop offset="0%" stop-color="'+rgba(c1,0.55)+'"/>'
        +'<stop offset="100%" stop-color="'+rgba(c2,0.55)+'"/></linearGradient>');
    });
    out.push("</defs>");

    geo.links.forEach(function(l,i){
      out.push('<path d="'+linkPath(l)+'" fill="url(#flow-'+seed+'-'+i+')" opacity="0.72"/>');
    });

    Object.keys(geo.nodes).forEach(function(id){
      var p=geo.nodes[id], n=p.n;
      // Income sources and the hub label to the RIGHT; every spending node
      // labels to the LEFT so the deepest column grows inward.
      var right=n.depth===0||n.kind==="hub";
      var anchor=right?"start":"end";
      var lx=right?p.x+SK.NW+10:p.x-10;
      var cy=p.y+p.h/2;
      var pctOf=rootTotal>0?(n.value/rootTotal)*100:0;
      var caption=rootTotal>0?fmt(n.value)+" ("+pctOf.toFixed(1)+"%)":fmt(n.value);
      out.push('<rect x="'+p.x+'" y="'+p.y.toFixed(1)+'" width="'+SK.NW+'" height="'+p.h.toFixed(1)+'" rx="1.5" fill="'+linkColor(id)+'"/>');
      out.push('<text x="'+lx+'" y="'+(cy-3).toFixed(1)+'" text-anchor="'+anchor+'" font-family="var(--font-heading)" font-weight="600" font-size="12.5" fill="var(--color-text)">'+esc(n.label)+'</text>');
      out.push('<text x="'+lx+'" y="'+(cy+12).toFixed(1)+'" text-anchor="'+anchor+'" font-family="var(--font-body)" font-size="11.5" fill="var(--color-neutral-500)">'+esc(caption)+'</text>');
    });

    out.push("</svg>");
    return out.join("");
  }

  function monthName(iso){
    var parts=String(iso).split("-");
    var d=new Date(Date.UTC(+parts[0],+parts[1]-1,1));
    return d.toLocaleDateString(undefined,{month:"long",year:"numeric",timeZone:"UTC"});
  }
  function dayLabel(iso){
    var d=new Date(iso+"T00:00:00Z"), now=new Date();
    var today=now.toISOString().slice(0,10);
    var yest=new Date(now.getTime()-86400000).toISOString().slice(0,10);
    if(iso===today)return "Today";
    if(iso===yest)return "Yesterday";
    return d.toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric",timeZone:"UTC"});
  }
  var TYPE_LABEL={checking:"Checking",savings:"Savings",credit_card:"Credit card",
    investment:"Investment",loan:"Loan",mortgage:"Mortgage",other:"Other"};

  /** Label + amount over a proportional bar — budgets, bills, goals, allocation. */
  function barBlock(name,rightText,frac,color,over){
    var wrap=el("div");wrap.style.marginBottom="var(--space-4)";
    var line=el("div","row-between t-sm");
    line.appendChild(el("div","truncate t-medium",name));
    line.appendChild(el("div","num "+(over?"neg":"t-tertiary"),rightText));
    wrap.appendChild(line);
    wrap.appendChild(bar(frac,over?"var(--color-negative)":(color||null)));
    return wrap;
  }

  /**
   * Which month Home shows — the same rule the desktop dashboard uses.
   * Month-to-date framing means that in the first days of a month there is
   * nothing to draw: income and spending both read $0 and the diagram shows a
   * $0 income node feeding 100%-of-nothing, which reads as broken. Fall back to
   * the most recent month that actually has activity.
   *
   * Derived from the trends the page already loads, so it costs no request.
   */
  function defaultMonth(points){
    var now=new Date().toISOString().slice(0,7);
    var current=points.filter(function(p){return p.month===now})[0];
    if(!current||current.incomeCents>0||current.spendingCents>0)return now;
    var active=points.filter(function(p){return p.incomeCents>0||p.spendingCents>0})
      .map(function(p){return p.month}).sort();
    return active.length?active[active.length-1]:now;
  }

  async function renderHome(root){
    var accounts=(await tryApi("/accounts",{})).accounts||[];
    var points=(await tryApi("/cashflow/trends?months=6",{})).points||[];
    var month=defaultMonth(points);
    var isCurrent=month===new Date().toISOString().slice(0,7);
    var months=(await tryApi("/cashflow/summary?months=6",{})).months||[];
    var sankey=await tryApi("/cashflow/sankey?month="+encodeURIComponent(month),{nodes:[],links:[]});

    var net=accounts.reduce(function(s,a){return s+(a.balanceCents||0)},0);
    var nw=panel();
    nw.appendChild(statRow("Net worth",fmt(net)));
    if(points.length>=2){
      var w=el("div");
      w.innerHTML=spark(points.map(function(p){return p.netWorthCents}),
        project(points.map(function(p){return p.netWorthCents}),3),"var(--viz-2)");
      nw.appendChild(w);
    }
    root.appendChild(nw);

    var m=months.filter(function(x){return x.month===month})[0]||months[months.length-1]||{};
    var head=el("div","row-between wrap");
    head.appendChild(el("div","eyebrow",monthName(month)));
    if(!isCurrent){
      // Never let a fallback month masquerade as the current one.
      head.appendChild(el("div","t-xs t-tertiary",monthName(new Date().toISOString().slice(0,7))+" has no activity yet"));
    }
    root.appendChild(head);
    var g=el("div","grid");
    [["Income",fmt(m.incomeCents||0),""],
     ["Spending",fmt(m.spendingCents||0),""],
     // A null rate rendered as a green em-dash, which reads as a broken value
     // rather than "no data". Only tint when there is a number to tint.
     ["Savings rate",(m.savingsRate!=null?pct(m.savingsRate):"—"),
       m.savingsRate==null?"t-tertiary":(m.savingsRate>=0?"pos":"neg")]
    ].forEach(function(row){
      var c=el("div","col-4");var p=el("div","panel");
      p.appendChild(statRow(row[0],row[1],row[2]));
      c.appendChild(p);g.appendChild(c);
    });
    root.appendChild(g);

    if((sankey.links||[]).length){
      var svg=sankeySvg(
        sankey.nodes.map(function(n){
          return {id:n.id,label:n.label,value:n.valueCents,color:n.color,depth:n.depth,kind:n.kind};
        }),
        sankey.links.map(function(l){return {from:l.from,to:l.to,value:l.valueCents}})
      );
      if(svg){
        var s=panel("Cash flow","Where this month's income went");
        // Rendered at the desktop's native 1240 units so the captions stay the
        // same size they are there. That is wider than any phone, so it scrolls
        // sideways rather than being squashed into illegibility.
        var sc=el("div","sankey-scroll");
        var holder=el("div");
        holder.innerHTML=svg;   // built entirely from esc()'d strings
        sc.appendChild(holder);
        s.appendChild(sc);
        s.appendChild(el("div","panel-sub","Swipe the diagram sideways to follow the flow."));
        root.appendChild(s);
      }
    }

    // Top spending categories — the detail the diagram compresses away.
    var cats=(sankey.nodes||[]).filter(function(n){return n.kind==="category"&&n.depth===2&&n.valueCents>0})
      .sort(function(a,b){return b.valueCents-a.valueCents});
    if(cats.length){
      var top=cats.slice(0,6);
      var maxV=top[0].valueCents||1;
      var tp=panel("Top spending",monthName(sankey.month||(m.month||"")));
      top.forEach(function(c){
        tp.appendChild(barBlock(c.label,fmt(c.valueCents),c.valueCents/maxV,c.color,false));
      });
      root.appendChild(tp);
    }

    if(points.length>=2){
      [["Income · 6 mo","incomeCents","var(--viz-3)",true],
       ["Spending · 6 mo","spendingCents","var(--viz-1)",false]
      ].forEach(function(t){
        var hist=points.map(function(p){return p[t[1]]});
        var cur=hist[hist.length-1]||0, first=hist[0]||0, delta=cur-first;
        var good=t[3]?delta>=0:delta<=0;
        var p=panel();
        var head=el("div","row-baseline");
        head.appendChild(el("div","stat-label",t[0]));
        if(hist.length>=2)head.appendChild(el("div","stat-delta "+(good?"pos":"neg"),
          (delta>=0?"▲ ":"▼ ")+fmt(Math.abs(delta))));
        p.appendChild(head);
        p.appendChild(el("div","stat-value",fmt(cur)));
        var w=el("div");w.innerHTML=spark(hist,project(hist,3),t[2]);p.appendChild(w);
        root.appendChild(p);
      });
    }
  }

  async function renderAccounts(root){
    var accounts=(await tryApi("/accounts",{})).accounts||[];
    var live=accounts.filter(function(a){return a.balanceCents!==0});
    if(!live.length){root.appendChild(empty("No accounts","Accounts added on the desktop app show up here."));return}

    var assets=live.filter(function(a){return !a.isLiability});
    var debts=live.filter(function(a){return a.isLiability});
    var sum=function(rows){return rows.reduce(function(s,a){return s+a.balanceCents},0)};

    var head=panel();
    var hg=el("div","grid");
    [["Assets",fmt(sum(assets)),"pos"],["Liabilities",fmt(sum(debts)),debts.length?"neg":""]]
      .forEach(function(r){
        var c=el("div","col-6");var p=el("div","panel");
        p.appendChild(statRow(r[0],r[1],r[2]));
        c.appendChild(p);hg.appendChild(c);
      });
    root.appendChild(hg);

    // Grouped by type with subtotals, mirroring the desktop Accounts page.
    var groups={};
    live.forEach(function(a){(groups[a.type]=groups[a.type]||[]).push(a)});
    Object.keys(groups).forEach(function(type){
      var rows=groups[type];
      var p=panel(TYPE_LABEL[type]||type,fmt(sum(rows)));
      var list=el("div","list list-divided");
      rows.forEach(function(a){
        list.appendChild(listRow(a.name,
          [a.institution,a.mask?"••"+a.mask:null].filter(Boolean).join(" · ")||null,
          fmt(a.balanceCents),a.balanceCents<0?"neg":"",
          function(){ view.detail={type:"account",id:a.id,name:a.name}; render() }));
      });
      p.appendChild(list);root.appendChild(p);
    });
  }

  async function renderTransactions(root){
    var res=await tryApi("/transactions?limit=200",{});
    var txns=res.transactions||[];
    if(!txns.length){root.appendChild(empty("No transactions","Nothing recorded yet."));return}
    var accounts=(await tryApi("/accounts",{})).accounts||[];
    var cats=(await tryApi("/categories",{})).categories||[];
    var acctName={};accounts.forEach(function(a){acctName[a.id]=a.name});
    var catById={};cats.forEach(function(c){catById[c.id]=c});

    var box=el("div");
    var search=el("input","input");
    search.type="search";
    search.placeholder="Search merchants…";
    search.setAttribute("aria-label","Search transactions");
    box.appendChild(search);
    root.appendChild(box);

    var listHost=el("div");
    root.appendChild(listHost);

    function draw(q){
      listHost.textContent="";
      var needle=q.trim().toLowerCase();
      var rows=needle
        ? txns.filter(function(t){return (t.merchantName||"").toLowerCase().indexOf(needle)>=0})
        : txns;
      if(!rows.length){
        listHost.appendChild(empty("Nothing matches","Try a different merchant name."));
        return;
      }
      // Grouped by day, so a long ledger stays scannable on a small screen.
      var byDay={},order=[];
      rows.forEach(function(t){
        var d=t.postedAt.slice(0,10);
        if(!byDay[d]){byDay[d]=[];order.push(d)}
        byDay[d].push(t);
      });
      order.forEach(function(d){
        var dayTotal=byDay[d].reduce(function(s,t){return s+t.amountCents},0);
        var p=panel(dayLabel(d),fmt(dayTotal));
        var list=el("div","list list-divided");
        byDay[d].forEach(function(t){
          var cat=t.categoryId?catById[t.categoryId]:null;
          list.appendChild(listRow(t.merchantName,
            [(cat&&cat.name)||"Uncategorized",acctName[t.accountId]].filter(Boolean).join(" · "),
            fmt2(t.amountCents), t.amountCents>0?"pos":""));
        });
        p.appendChild(list);listHost.appendChild(p);
      });
    }
    search.addEventListener("input",function(){draw(search.value)});
    draw("");
  }

  async function renderAccountDetail(root,detail){
    var back=el("button","back-btn");
    back.innerHTML=svgIcon(ICONS.chevronLeft,17);
    back.appendChild(document.createTextNode(" Accounts"));
    back.onclick=function(){ view.detail=null; render() };
    root.appendChild(back);

    var res=await tryApi("/transactions?limit=100&accountId="+encodeURIComponent(detail.id),{});
    var txns=res.transactions||[];
    var cats=(await tryApi("/categories",{})).categories||[];
    var catById={};cats.forEach(function(c){catById[c.id]=c});

    var p=panel(detail.name, txns.length? txns.length+" recent transactions" : null);
    if(!txns.length){p.appendChild(empty("Nothing here yet","No transactions on this account."))}
    else{
      var list=el("div","list list-divided");
      txns.forEach(function(t){
        var cat=t.categoryId?catById[t.categoryId]:null;
        list.appendChild(listRow(t.merchantName,
          t.postedAt.slice(5)+((cat&&cat.name)?" · "+cat.name:""),
          fmt2(t.amountCents),t.amountCents>0?"pos":""));
      });
      p.appendChild(list);
    }
    root.appendChild(p);
  }

  async function renderBudgets(root){
    var b=await tryApi("/budgets",{});
    var tb=b.totalBudgetedCents||0, ts=b.totalSpentCents||0;
    if(!tb){root.appendChild(empty("No budgets set","Set category budgets on the desktop app."));return}
    var cats=(await tryApi("/categories",{})).categories||[];
    var byId={};cats.forEach(function(c){byId[c.id]=c});

    var over=ts>tb, left=tb-ts;
    var p=panel("This month",pct(Math.min(1,ts/tb))+" of budget used");
    var headline=el("div","row-baseline");
    headline.appendChild(el("div","stat-value",fmt(ts)));
    headline.appendChild(el("div","t-sm t-tertiary","of "+fmt(tb)));
    p.appendChild(headline);
    p.appendChild(bar(ts/tb, over?"var(--color-negative)":null));
    p.appendChild(el("div","t-xs "+(over?"neg":"t-tertiary"),
      over? fmt(-left)+" over budget" : fmt(left)+" left"));
    root.appendChild(p);

    var rows=(b.budgets||[]).slice().sort(function(x,y){return y.spentCents-x.spentCents});
    if(rows.length){
      var d=panel("By category",rows.length+" tracked");
      rows.forEach(function(r){
        var cat=byId[r.categoryId]||{};
        var o=r.spentCents>r.amountCents;
        d.appendChild(barBlock(cat.name||"Category",
          fmt(r.spentCents)+" / "+fmt(r.amountCents),
          r.amountCents>0?r.spentCents/r.amountCents:0, cat.color, o));
      });
      root.appendChild(d);
    }
  }

  async function renderBills(root){
    var data=await tryApi("/bills",{});
    var bills=data.bills||[];
    if(!bills.length){root.appendChild(empty("No bills tracked","Recurring bills show up here."));return}

    var due=data.totalDueCents||0, saved=data.totalSavedCents||0;
    var hg=el("div","grid");
    [["Upcoming",fmt(due),""],["Set aside",fmt(saved),"pos"]].forEach(function(r){
      var c=el("div","col-6");var pp=el("div","panel");
      pp.appendChild(statRow(r[0],r[1],r[2]));
      c.appendChild(pp);hg.appendChild(c);
    });
    root.appendChild(hg);

    var p=panel("Upcoming","Soonest first");
    bills.forEach(function(b){
      var dueText=b.daysUntilDue<0?Math.abs(b.daysUntilDue)+"d overdue"
        :b.daysUntilDue===0?"Due today":b.daysUntilDue===1?"Due tomorrow":"Due in "+b.daysUntilDue+"d";
      var funded=b.savedCents>=b.amountCents;
      var wrap=el("div");wrap.style.marginBottom="var(--space-4)";
      var line=el("div","row-between t-sm");
      var left=el("div","truncate");
      left.appendChild(el("span","t-medium",b.name));
      var sub=el("div","t-xs "+(b.daysUntilDue<=2?"neg":"t-tertiary"),dueText);
      left.appendChild(sub);
      line.appendChild(left);
      line.appendChild(el("div","list-row-amount",fmt(b.amountCents)));
      wrap.appendChild(line);
      // Sinking-fund progress: how much is already put by for this bill.
      wrap.appendChild(bar(b.amountCents>0?b.savedCents/b.amountCents:0,
        funded?"var(--color-positive)":(b.color||null)));
      wrap.appendChild(el("div","t-xs t-tertiary",
        fmt(b.savedCents)+" of "+fmt(b.amountCents)+" set aside"+(funded?" · fully funded":"")));
      p.appendChild(wrap);
    });
    root.appendChild(p);
  }

  async function renderGoals(root){
    var goals=(await tryApi("/goals",{})).goals||[];
    if(!goals.length){root.appendChild(empty("No savings goals","Goals you set show up here."));return}
    var totalSaved=goals.reduce(function(s,g){return s+g.savedCents},0);
    var totalTarget=goals.reduce(function(s,g){return s+g.targetCents},0);

    var head=panel("Goals",goals.length+" tracked");
    var hl=el("div","row-baseline");
    hl.appendChild(el("div","stat-value",fmt(totalSaved)));
    hl.appendChild(el("div","t-sm t-tertiary","of "+fmt(totalTarget)));
    head.appendChild(hl);
    head.appendChild(bar(totalTarget>0?totalSaved/totalTarget:0));
    root.appendChild(head);

    var p=panel("Each goal");
    goals.forEach(function(g){
      var frac=g.targetCents>0?Math.min(1,g.savedCents/g.targetCents):0;
      var funded=g.savedCents>=g.targetCents;
      p.appendChild(barBlock(g.name,
        funded?"funded":fmt(g.savedCents)+" / "+fmt(g.targetCents),
        frac,g.color,false));
    });
    root.appendChild(p);
  }

  async function renderInvestments(root){
    var d=await tryApi("/investments",{});
    var value=d.totalValueCents||0, cost=d.totalCostBasisCents||0;
    if(!value){root.appendChild(empty("No holdings","Positions you track show up here."));return}
    var gain=value-cost, gpct=cost>0?(gain/cost)*100:0;

    var p=panel("Portfolio");
    p.appendChild(el("div","stat-value",fmt(value)));
    p.appendChild(el("div","stat-delta "+(gain>=0?"pos":"neg"),
      (gain>=0?"+":"−")+fmt(Math.abs(gain))+" ("+(gpct>=0?"+":"")+gpct.toFixed(1)+"%)"));
    root.appendChild(p);

    var alloc=d.allocation||[];
    if(alloc.length){
      var a=panel("Allocation",alloc.length+" positions");
      alloc.slice(0,12).forEach(function(s){
        a.appendChild(barBlock(s.symbol,pct(s.share),s.share,null,false));
      });
      root.appendChild(a);
    }

    // Per-account holdings — the detail the allocation ring flattens out.
    (d.accounts||[]).forEach(function(acct){
      if(!acct.holdings||!acct.holdings.length)return;
      var ap=panel(acct.name,fmt(acct.holdingsValueCents||0));
      var list=el("div","list list-divided");
      acct.holdings.forEach(function(h){
        // Gain belongs in the subtitle: tinting the market value by it would
        // read as though the position itself were negative.
        var g2=h.costBasisCents!=null?h.marketValueCents-h.costBasisCents:null;
        var sub=[h.quantity?h.quantity+" units":null,
          g2==null?null:(g2>=0?"+":"−")+fmt(Math.abs(g2))].filter(Boolean).join(" · ");
        list.appendChild(listRow(h.symbol,sub||null,fmt(h.marketValueCents),""));
      });
      ap.appendChild(list);root.appendChild(ap);
    });
  }

  var RENDERERS={
    home:renderHome, accounts:renderAccounts, transactions:renderTransactions,
    budgets:renderBudgets, bills:renderBills, goals:renderGoals, investments:renderInvestments
  };

  async function render(){
    var tab=tabOf(view.tab);
    if(!view.page||!tab.pages.some(function(p){return p.id===view.page}))view.page=tab.pages[0].id;
    syncTabs();
    $("viewTitle").textContent = view.detail ? view.detail.name : tab.label;

    var root=$("scroll");
    root.textContent="";
    var page=el("div","page");
    root.appendChild(page);
    $("scroll").scrollTop=0;

    if(view.detail){
      await renderAccountDetail(page,view.detail);
      return;
    }

    var strip=pageTabs(tab,view.page,function(id){view.page=id;render()});
    if(strip)page.appendChild(strip);

    var body=el("div","stack");
    page.appendChild(body);
    var loading=el("div","skeleton");loading.style.height="120px";
    body.appendChild(loading);

    var fn=RENDERERS[view.page];
    var fresh=el("div","stack");
    if(fn)await fn(fresh);
    body.replaceWith(fresh);

    if(view.tab==="home"){
      fresh.appendChild(el("div","t-xs t-tertiary",
        "Nothing here is stored on your phone. Locks when you leave; signs out after ~4 min away."));
    }
  }

  $("signin").onclick=signin;
  $("pw").addEventListener("keydown",function(e){if(e.key==="Enter")signin()});
  $("code").addEventListener("keydown",function(e){if(e.key==="Enter")signin()});
  $("out").onclick=logout;
  loadProfiles();
})();
</script>
</body></html>`;

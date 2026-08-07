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
const CSS_VER = "2";

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
  #lock {
    position: fixed; inset: 0; z-index: var(--z-modal);
    background: var(--color-bg); display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: var(--space-4);
  }
  /* The diagram is wider than any phone; it scrolls inside its panel. */
  .sankey-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 calc(var(--card-pad) * -1); padding: 0 var(--card-pad); }
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
  var token=null, sel=null, hiddenAt=0, logoutTimer=null;
  var IDLE_MS=4*60*1000; // sign out after ~4 min in the background
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
  function onVisible(){ if(!token){ $("lock").hidden=true; return; } clearTimeout(logoutTimer); if(Date.now()-hiddenAt>IDLE_MS){ logout(); } }
  document.addEventListener("visibilitychange", function(){ document.hidden ? lock() : onVisible(); });
  window.addEventListener("pagehide", lock);
  $("lock").addEventListener("click", function(){ if(token) $("lock").hidden=true; });

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
    clearTimeout(logoutTimer);
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
    if(r.ok){var d=await r.json();token=d.accessToken;$("login").hidden=true;$("app").hidden=false;buildTabs();render();return}
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
  function sankeySvg(nodes,links){
    var W=700,NW=6,PAD=22,X0=44,X1=636,GAP=9,MIN_NODE=3,ROW_MIN=24,MIN_LINK=2,BASE_H=360;
    var depths=Array.from(new Set(nodes.map(function(n){return n.depth}))).sort(function(a,b){return a-b});
    var maxDepth=depths[depths.length-1]||0;
    var xFor=function(d){return maxDepth===0?X0:X0+(d*(X1-X0))/maxDepth};
    var sumIn={},sumOut={};
    links.forEach(function(l){sumOut[l.from]=(sumOut[l.from]||0)+l.value;sumIn[l.to]=(sumIn[l.to]||0)+l.value});
    var mag=function(n){return Math.max(n.value,sumIn[n.id]||0,sumOut[n.id]||0)};
    var byDepth={};nodes.forEach(function(n){(byDepth[n.depth]=byDepth[n.depth]||[]).push(n)});
    var maxColSum=1;Object.keys(byDepth).forEach(function(d){maxColSum=Math.max(maxColSum,byDepth[d].reduce(function(s,n){return s+mag(n)},0))});
    var scale=(BASE_H-2*PAD)/maxColSum;
    var barH=function(n){return Math.max(MIN_NODE,mag(n)*scale)};
    var slotH=function(n){return Math.max(ROW_MIN,barH(n))};
    var colH=function(ns){return ns.reduce(function(s,n){return s+slotH(n)},0)+Math.max(0,ns.length-1)*GAP};
    var contentH=0;Object.keys(byDepth).forEach(function(d){contentH=Math.max(contentH,colH(byDepth[d]))});
    var H=Math.max(BASE_H,Math.ceil(contentH+2*PAD));
    var placed={},parentsOf={};
    links.forEach(function(l){(parentsOf[l.to]=parentsOf[l.to]||[]).push(l.from)});
    depths.forEach(function(d,di){
      var ns=(byDepth[d]||[]).slice();
      if(di===0){ns.sort(function(a,b){return mag(b)-mag(a)})}
      else{var bary=function(n){var ps=(parentsOf[n.id]||[]).map(function(id){return placed[id]}).filter(Boolean);if(!ps.length)return 9e15;return ps.reduce(function(s,p){return s+(p.y+p.h/2)},0)/ps.length};ns.sort(function(a,b){return bary(a)-bary(b)})}
      var totalH=colH(ns);var y=(H-totalH)/2;
      ns.forEach(function(n){var slot=slotH(n),h=barH(n);placed[n.id]={n:n,x:xFor(d),y:y+(slot-h)/2,h:h};y+=slot+GAP});
    });
    var outC={},inC={};
    var ordered=links.slice().sort(function(a,b){var sa=(placed[a.from]||{}).y||0,sb=(placed[b.from]||{}).y||0;if(sa!==sb)return sa-sb;return((placed[a.to]||{}).y||0)-((placed[b.to]||{}).y||0)});
    var out=['<svg viewBox="0 0 '+W+' '+H+'" style="width:'+W+'px;height:auto;display:block" xmlns="http://www.w3.org/2000/svg">'];
    ordered.forEach(function(l){var s=placed[l.from],t=placed[l.to];if(!s||!t)return;var h=l.value>0?l.value*scale:MIN_LINK;
      var sy=outC[l.from]!=null?outC[l.from]:s.y, ty=inC[l.to]!=null?inC[l.to]:t.y, sx=s.x+NW, tx=t.x, mx=(sx+tx)/2;
      var col=t.n.color||"#9397ab";
      var d="M"+sx+","+sy+" C"+mx+","+sy+" "+mx+","+ty+" "+tx+","+ty+" L"+tx+","+(ty+h)+" C"+mx+","+(ty+h)+" "+mx+","+(sy+h)+" "+sx+","+(sy+h)+" Z";
      out.push('<path d="'+d+'" fill="'+col+'" fill-opacity="0.4"/>');
      outC[l.from]=sy+h; inC[l.to]=ty+h;
    });
    Object.keys(placed).forEach(function(id){var p=placed[id];var right=p.n.depth===0||p.n.kind==="hub";var lx=right?p.x+NW+6:p.x-6;var anc=right?"start":"end";var cy=p.y+p.h/2;
      out.push('<rect x="'+p.x+'" y="'+p.y.toFixed(1)+'" width="'+NW+'" height="'+p.h.toFixed(1)+'" rx="1.5" fill="'+p.n.color+'"/>');
      out.push('<text x="'+lx+'" y="'+(cy-2).toFixed(1)+'" text-anchor="'+anc+'" font-size="10" font-weight="600" fill="#e9e9ed" font-family="system-ui">'+esc(p.n.label)+'</text>');
      out.push('<text x="'+lx+'" y="'+(cy+9).toFixed(1)+'" text-anchor="'+anc+'" font-size="9" fill="#9397ab" font-family="system-ui">'+esc(fmt(p.n.value))+'</text>');
    });
    out.push("</svg>");
    return out.join("");
  }

  // ── screens ─────────────────────────────────────────────────────────────
  async function renderHome(root){
    var accounts=(await tryApi("/accounts",{})).accounts||[];
    var months=(await tryApi("/cashflow/summary?months=2",{})).months||[];
    var points=(await tryApi("/cashflow/trends?months=6",{})).points||[];
    var sankey=await tryApi("/cashflow/sankey",{nodes:[],links:[]});

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

    var m=months[months.length-1]||{};
    var g=el("div","grid");
    [["Income",fmt(m.incomeCents||0),""],
     ["Spending",fmt(m.spendingCents||0),""],
     ["Savings rate",(m.savingsRate!=null?pct(m.savingsRate):"—"),(m.savingsRate||0)>=0?"pos":"neg"]
    ].forEach(function(row){
      var c=el("div","col-4");var p=el("div","panel");
      p.appendChild(statRow(row[0],row[1],row[2]));
      c.appendChild(p);g.appendChild(c);
    });
    root.appendChild(g);

    if((sankey.links||[]).length){
      var s=panel("Cash flow","Where the money went");
      var sc=el("div","sankey-scroll");
      var holder=el("div");
      holder.innerHTML=sankeySvg(
        sankey.nodes.map(function(n){return {id:n.id,label:n.label,value:n.valueCents,color:n.color,depth:n.depth,kind:n.kind}}),
        sankey.links.map(function(l){return {from:l.from,to:l.to,value:l.valueCents}})
      );
      sc.appendChild(holder);s.appendChild(sc);
      s.appendChild(el("div","panel-sub","Swipe the diagram sideways to follow the flow."));
      root.appendChild(s);
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
    var p=panel("Accounts",live.length+" with a balance");
    var list=el("div","list list-divided");
    live.forEach(function(a){
      list.appendChild(listRow(a.name,String(a.type||"").replace(/_/g," "),
        fmt(a.balanceCents),a.balanceCents<0?"neg":"",
        function(){ view.detail={type:"account",id:a.id,name:a.name}; render() }));
    });
    p.appendChild(list);root.appendChild(p);
  }

  async function renderTransactions(root){
    var txns=(await tryApi("/transactions?limit=50",{})).transactions||[];
    if(!txns.length){root.appendChild(empty("No transactions","Nothing recorded yet."));return}
    var accounts=(await tryApi("/accounts",{})).accounts||[];
    var byId={};accounts.forEach(function(a){byId[a.id]=a.name});
    var p=panel("Recent","Last "+txns.length);
    var list=el("div","list list-divided");
    txns.forEach(function(t){
      list.appendChild(listRow(t.merchantName,
        t.postedAt.slice(5)+" · "+(byId[t.accountId]||"—"),
        fmt2(t.amountCents), t.amountCents>0?"pos":""));
    });
    p.appendChild(list);root.appendChild(p);
  }

  async function renderAccountDetail(root,detail){
    var back=el("button","back-btn");
    back.innerHTML=svgIcon(ICONS.chevronLeft,17);
    back.appendChild(document.createTextNode(" Accounts"));
    back.onclick=function(){ view.detail=null; render() };
    root.appendChild(back);

    var res=await tryApi("/transactions?limit=50&accountId="+encodeURIComponent(detail.id),{});
    var txns=res.transactions||[];
    var p=panel(detail.name, txns.length? txns.length+" recent transactions" : null);
    if(!txns.length){p.appendChild(empty("Nothing here yet","No transactions on this account."))}
    else{
      var list=el("div","list list-divided");
      txns.forEach(function(t){
        list.appendChild(listRow(t.merchantName,t.postedAt.slice(5),fmt2(t.amountCents),t.amountCents>0?"pos":""));
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

    var p=panel("This month",pct(Math.min(1,ts/tb))+" of budget used");
    var head=el("div","row-baseline");
    head.appendChild(el("div","stat-value",fmt(ts)));
    head.appendChild(el("div","t-sm t-tertiary","of "+fmt(tb)));
    p.appendChild(head);
    p.appendChild(bar(ts/tb, ts>tb?"var(--color-negative)":null));
    root.appendChild(p);

    var rows=(b.budgets||[]).slice().sort(function(x,y){return y.spentCents-x.spentCents});
    if(rows.length){
      var d=panel("By category");
      rows.forEach(function(r){
        var cat=byId[r.categoryId]||{};
        var over=r.spentCents>r.amountCents;
        var wrap=el("div");wrap.style.marginBottom="var(--space-3)";
        var line=el("div","row-between t-sm");
        line.appendChild(el("div","truncate",cat.name||"Category"));
        var v=el("div","num"+(over?" neg":" t-tertiary"),fmt(r.spentCents)+" / "+fmt(r.amountCents));
        line.appendChild(v);
        wrap.appendChild(line);
        wrap.appendChild(bar(r.amountCents>0?r.spentCents/r.amountCents:0, over?"var(--color-negative)":(cat.color||null)));
        d.appendChild(wrap);
      });
      root.appendChild(d);
    }
  }

  async function renderBills(root){
    var bills=(await tryApi("/bills",{})).bills||[];
    if(!bills.length){root.appendChild(empty("No bills tracked","Recurring bills show up here."));return}
    var p=panel("Upcoming","Soonest first");
    var list=el("div","list list-divided");
    bills.forEach(function(b){
      var due=b.daysUntilDue<0?Math.abs(b.daysUntilDue)+"d overdue"
             :b.daysUntilDue===0?"Due today":"Due in "+b.daysUntilDue+"d";
      var r=listRow(b.name,due,fmt(b.amountCents));
      if(b.daysUntilDue<=2){var s=r.querySelector(".list-row-sub");if(s)s.className="list-row-sub neg"}
      list.appendChild(r);
    });
    p.appendChild(list);root.appendChild(p);
  }

  async function renderGoals(root){
    var goals=(await tryApi("/goals",{})).goals||[];
    if(!goals.length){root.appendChild(empty("No savings goals","Goals you set show up here."));return}
    var p=panel("Goals");
    goals.forEach(function(g){
      var frac=g.targetCents>0?Math.min(1,g.savedCents/g.targetCents):0;
      var wrap=el("div");wrap.style.marginBottom="var(--space-4)";
      var line=el("div","row-between t-sm");
      line.appendChild(el("div","t-medium truncate",g.name));
      line.appendChild(el("div","num t-tertiary",fmt(g.savedCents)+" / "+fmt(g.targetCents)));
      wrap.appendChild(line);
      wrap.appendChild(bar(frac,g.color||null));
      p.appendChild(wrap);
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
      var a=panel("Allocation");
      alloc.slice(0,10).forEach(function(s){
        var wrap=el("div");wrap.style.marginBottom="var(--space-3)";
        var line=el("div","row-between t-sm");
        line.appendChild(el("div","t-medium",s.symbol));
        line.appendChild(el("div","num t-tertiary",pct(s.share)));
        wrap.appendChild(line);
        wrap.appendChild(bar(s.share));
        a.appendChild(wrap);
      });
      root.appendChild(a);
    }
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

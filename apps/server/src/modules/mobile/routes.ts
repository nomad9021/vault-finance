import { readFileSync } from "node:fs";
import type { FastifyInstance } from "fastify";

// Brand icon, shipped as PNG next to this module (copied into dist by the build
// script). Read once at startup and served from same-origin routes so the HTML
// stays lean and the home-screen / manifest icons are real raster art.
const ICON_PNG = readFileSync(new URL("./app-icon.png", import.meta.url));
const ICON_MASKABLE_PNG = readFileSync(new URL("./app-icon-maskable.png", import.meta.url));
// Bump this whenever the icon art changes — it cache-busts the URL so phones
// that already added the app to their home screen pick up the new icon.
const ICON_VER = "3";

/**
 * A tiny, dependency-free, **read-only** phone viewer served on the same origin
 * as the API. Zero-trust: you log in every time (password + 2FA), the token
 * lives only in memory, and nothing is written to device storage.
 *
 * Privacy lock: the moment the tab is hidden (app switch, screen off) a cover
 * page hides the content, and if you're away longer than a few minutes the
 * session is signed out. All data is inserted via textContent / escaped SVG so
 * a merchant or category name can't inject markup.
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
          background_color: "#14161f",
          theme_color: "#14161f",
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
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#14161f">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Vault Finance">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/app-icon.png?v=${ICON_VER}">
<title>Vault Finance</title>
<style>
  :root{--bg:#14161f;--surface:#1b1e29;--line:#2a2e3b;--text:#e7e9ee;--muted:#9aa0ab;--pos:#3ecf8e;--neg:#e25c5c;--accent:#6f8ef2}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
    padding:max(env(safe-area-inset-top),12px) 14px calc(env(safe-area-inset-bottom) + 28px);-webkit-tap-highlight-color:transparent}
  .head{display:flex;align-items:center;gap:10px;margin:4px 2px 14px}
  .mark{width:26px;height:26px;border-radius:7px;flex:none;
    background:linear-gradient(135deg,#9184d9 0%,#353b80 100%);box-shadow:0 0 20px rgba(145,132,217,.45)}
  .brand{font-weight:700;font-size:16px;letter-spacing:-.01em}
  .sp{margin-left:auto}
  button{font:inherit;color:inherit;cursor:pointer}
  .ghost{background:none;border:0;color:var(--muted);font-size:13px;padding:6px}
  .card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:16px;margin-bottom:12px}
  .eyebrow{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600;margin-bottom:6px}
  .big{font-size:34px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .chips{display:flex;gap:10px;flex-wrap:wrap}
  .chip{flex:1;min-width:96px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:12px}
  .chip .v{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
  .row{display:flex;align-items:center;gap:10px;padding:11px 0;border-top:1px solid #22252f}
  .row:first-child{border-top:0}
  .row .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;font-size:14px}
  .row .sub{font-size:11.5px;color:var(--muted)}
  .amt{font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
  .bar{height:7px;border-radius:99px;background:#22252f;overflow:hidden;margin-top:6px}
  .bar>i{display:block;height:100%;border-radius:99px;background:var(--accent)}
  .title{font-weight:600;font-size:14px;margin:0 2px 8px}
  .hint{font-size:11px;color:var(--muted);margin:2px 2px 0}
  .pos{color:var(--pos)} .neg{color:var(--neg)} .mut{color:var(--muted)}
  .scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 -4px}
  .trend{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
  .delta{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
  .input{width:100%;background:#0f111a;border:1px solid var(--line);border-radius:11px;color:var(--text);font-size:16px;padding:12px 14px;margin-top:10px}
  .btn{width:100%;background:var(--pos);color:#08120c;border:0;border-radius:11px;font-weight:700;font-size:15px;padding:13px;margin-top:12px}
  .profiles{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin:6px 0}
  .prof{display:flex;flex-direction:column;align-items:center;gap:7px;padding:12px 16px;border-radius:14px;background:none;border:1px solid var(--line)}
  .prof[data-on]{border-color:var(--pos);background:#14231a}
  .av{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;font-weight:700;color:#08120c}
  .err{color:var(--neg);font-size:13px;margin-top:10px;text-align:center}
  .center{min-height:70vh;display:flex;flex-direction:column;justify-content:center;max-width:420px;margin:0 auto}
  .note{font-size:11.5px;color:var(--muted);text-align:center;margin-top:16px;line-height:1.5}
  #lock{position:fixed;inset:0;z-index:99;background:var(--bg);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
  #lock .l1{font-weight:700;font-size:18px}
  #lock .l2{font-size:13px;color:var(--muted)}
  [hidden]{display:none!important}
</style></head>
<body>
<div id="login" class="center">
  <div style="text-align:center;margin-bottom:18px">
    <div class="mark" style="width:40px;height:40px;border-radius:12px;margin:0 auto 10px"></div>
    <div class="brand" style="font-size:19px">Vault Finance</div>
    <div class="mut" style="font-size:12.5px;margin-top:3px">Read-only viewer</div>
  </div>
  <div id="profiles" class="profiles"></div>
  <div id="pwbox" hidden>
    <input id="pw" class="input" type="password" placeholder="Password" autocomplete="current-password">
    <input id="code" class="input" inputmode="numeric" placeholder="6-digit code" hidden>
    <button id="signin" class="btn">Sign in</button>
    <div id="err" class="err" hidden></div>
  </div>
  <div class="note">Nothing is saved on this device. It locks when you leave the app and signs out after a few minutes away.</div>
</div>

<div id="app" hidden>
  <div class="head">
    <div class="mark"></div>
    <div class="brand">Vault</div>
    <div class="sp"></div>
    <button id="out" class="ghost">Sign out</button>
  </div>
  <div id="body"></div>
</div>

<div id="lock" hidden>
  <div class="mark" style="width:52px;height:52px;border-radius:15px"></div>
  <div class="l1">Locked</div>
  <div class="l2">Tap to view your finances</div>
</div>

<script>
(function(){
  "use strict";
  var token=null, sel=null, hiddenAt=0, logoutTimer=null;
  var IDLE_MS=4*60*1000; // sign out after ~4 min in the background
  var $=function(id){return document.getElementById(id)};
  function fmt(c){var n=Math.round(c/100);var s=n<0?"-":"";n=Math.abs(n);return s+"$"+n.toLocaleString()}
  function el(t,cls,txt){var e=document.createElement(t);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}
  function amt(c,cls){var s=el("span","amt"+(cls?" "+cls:""));s.textContent=fmt(c);return s}
  function pct(n){return Math.round(n*100)+"%"}
  function esc(s){return String(s).replace(/[&<>"']/g,function(ch){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]})}

  // ---- privacy lock -------------------------------------------------------
  function lock(){ if(!token) return; $("lock").hidden=false; hiddenAt=Date.now(); clearTimeout(logoutTimer); logoutTimer=setTimeout(logout, IDLE_MS); }
  function onVisible(){ if(!token){ $("lock").hidden=true; return; } clearTimeout(logoutTimer); if(Date.now()-hiddenAt>IDLE_MS){ logout(); } }
  document.addEventListener("visibilitychange", function(){ document.hidden ? lock() : onVisible(); });
  window.addEventListener("pagehide", lock);
  $("lock").addEventListener("click", function(){ if(token) $("lock").hidden=true; });

  async function api(path){
    var r=await fetch("/api/v1"+path,{headers:{authorization:"Bearer "+token},cache:"no-store"});
    if(r.status===401){logout();throw new Error("401")}
    if(!r.ok)throw new Error(String(r.status));
    return r.json();
  }

  function logout(){token=null;sel=null;clearTimeout(logoutTimer);$("lock").hidden=true;$("app").hidden=true;$("body").textContent="";$("login").hidden=false;$("pwbox").hidden=true;$("pw").value="";$("code").value="";$("code").hidden=true;loadProfiles()}

  async function loadProfiles(){
    var box=$("profiles");box.textContent="";
    try{
      var d=await (await fetch("/api/v1/auth/profiles",{cache:"no-store"})).json();
      (d.profiles||[]).forEach(function(p){
        var b=el("button","prof");
        var av=el("div","av",(p.displayName||"?").charAt(0).toUpperCase());av.style.background=p.avatarColor||"#3ecf8e";
        b.appendChild(av);b.appendChild(el("span",null,(p.displayName||"").split(" ")[0]));
        b.onclick=function(){sel=p;var all=box.querySelectorAll(".prof");for(var i=0;i<all.length;i++)all[i].removeAttribute("data-on");b.setAttribute("data-on","1");$("pwbox").hidden=false;$("err").hidden=true;$("pw").focus()};
        box.appendChild(b);
      });
    }catch(e){box.appendChild(el("div","mut","Can't reach the server."))}
  }

  async function signin(){
    if(!sel)return;
    var pw=$("pw").value, code=$("code").value.replace(/\\D/g,"");
    if(!pw)return;
    $("err").hidden=true;
    var body={userId:sel.id,password:pw,deviceName:"Phone viewer (web)",platform:"ios"};
    if(!$("code").hidden&&code)body.totpCode=code;
    var r=await fetch("/api/v1/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    if(r.ok){var d=await r.json();token=d.accessToken;$("login").hidden=true;$("app").hidden=false;overview();return}
    var c2="";try{c2=(await r.json()).error.code}catch(e){}
    if(c2==="TOTP_REQUIRED"){$("code").hidden=false;$("code").focus();return}
    if(c2==="TOTP_INVALID"){$("code").hidden=false;showErr("That code isn't right — use the current one.");return}
    showErr(c2==="RATE_LIMITED"?"Too many attempts — wait a bit.":"That didn't work.");
  }
  function showErr(m){var e=$("err");e.textContent=m;e.hidden=false}

  function section(title){var c=el("div","card");if(title)c.appendChild(el("div","title",title));return c}
  function chip(label,valEl){var c=el("div","chip");c.appendChild(el("div","eyebrow",label));c.appendChild(valEl);return c}

  // ---- charts (SVG, desktop-styled) --------------------------------------
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
    return '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" style="width:100%;height:'+H+'px;display:block;margin-top:8px" xmlns="http://www.w3.org/2000/svg">'
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
      out.push('<text x="'+lx+'" y="'+(cy-2).toFixed(1)+'" text-anchor="'+anc+'" font-size="10" font-weight="600" fill="#e7e9ee" font-family="system-ui">'+esc(p.n.label)+'</text>');
      out.push('<text x="'+lx+'" y="'+(cy+9).toFixed(1)+'" text-anchor="'+anc+'" font-size="9" fill="#9aa0ab" font-family="system-ui">'+esc(fmt(p.n.value))+'</text>');
    });
    out.push("</svg>");
    return out.join("");
  }

  function trendCard(label,history,color,goodUp){
    var proj=project(history,3), cur=history[history.length-1]||0, first=history[0]||0, delta=cur-first;
    var good=goodUp?delta>=0:delta<=0, base=Math.abs(first)||1, p=Math.round(delta/base*100);
    var c=el("div","card");
    var head=el("div","trend");head.appendChild(el("div","eyebrow",label));
    if(history.length>=2){head.appendChild(el("div","delta "+(good?"pos":"neg"),(delta>=0?"▲ ":"▼ ")+fmt(Math.abs(delta))+" ("+(p>=0?"+":"")+p+"%)"))}
    c.appendChild(head);
    var v=el("div","big");v.style.fontSize="24px";v.textContent=fmt(cur);c.appendChild(v);
    var wrap=el("div");wrap.innerHTML=spark(history,proj,color);c.appendChild(wrap);
    return c;
  }

  async function overview(){
    var body=$("body");body.textContent="";body.appendChild(el("div","mut","Loading…"));
    var res=await Promise.allSettled([api("/accounts"),api("/cashflow/summary?months=2"),api("/budgets"),api("/goals"),api("/bills"),api("/transactions?limit=6"),api("/cashflow/trends?months=6"),api("/cashflow/sankey")]);
    var val=function(i){return res[i].status==="fulfilled"?res[i].value:null};
    var accounts=(val(0)&&val(0).accounts)||[];
    var months=(val(1)&&val(1).months)||[];
    var budgets=val(2)||{}; var goals=(val(3)&&val(3).goals)||[];
    var bills=(val(4)&&val(4).bills)||[]; var txns=(val(5)&&val(5).transactions)||[];
    var points=(val(6)&&val(6).points)||[]; var sankey=val(7)||{nodes:[],links:[]};
    body.textContent="";

    // Net worth + trend
    var net=accounts.reduce(function(s,a){return s+(a.balanceCents||0)},0);
    var nw=section();nw.appendChild(el("div","eyebrow","Net worth"));
    nw.appendChild((function(){var b=el("div","big");b.textContent=fmt(net);return b})());
    if(points.length>=2){var wrap=el("div");wrap.innerHTML=spark(points.map(function(p){return p.netWorthCents}),project(points.map(function(p){return p.netWorthCents}),3),"#3ecf8e");nw.appendChild(wrap)}
    body.appendChild(nw);

    // This month
    var m=months[months.length-1]||{};
    var chips=el("div","chips");
    chips.appendChild(chip("Income",amt(m.incomeCents||0)));
    chips.appendChild(chip("Spending",amt(m.spendingCents||0)));
    chips.appendChild(chip("Savings rate",el("div","v"+((m.savingsRate||0)>=0?" pos":" neg"),(m.savingsRate!=null)?pct(m.savingsRate):"—")));
    body.appendChild(chips);

    // Cash-flow Sankey (scrollable)
    if((sankey.links||[]).length){
      var s=section("Cash flow");
      var sc=el("div","scroll");var holder=el("div");holder.style.padding="0 4px";
      holder.innerHTML=sankeySvg(
        sankey.nodes.map(function(n){return {id:n.id,label:n.label,value:n.valueCents,color:n.color,depth:n.depth,kind:n.kind}}),
        sankey.links.map(function(l){return {from:l.from,to:l.to,value:l.valueCents}})
      );
      sc.appendChild(holder);s.appendChild(sc);
      s.appendChild(el("div","hint","Swipe the diagram sideways to follow the flow."));
      body.appendChild(s);
    }

    // Trends
    if(points.length>=2){
      body.appendChild(trendCard("Income · 6 mo",points.map(function(p){return p.incomeCents}),"#6f8ef2",true));
      body.appendChild(trendCard("Spending · 6 mo",points.map(function(p){return p.spendingCents}),"#b47ef0",false));
    }

    // Accounts
    if(accounts.length){var s=section("Accounts");accounts.filter(function(a){return a.balanceCents!==0}).slice(0,8).forEach(function(a){
      var r=el("div","row");var wrap=el("div");wrap.style.flex="1";wrap.style.minWidth="0";
      wrap.appendChild(el("div","name",a.name));wrap.appendChild(el("div","sub",a.type.replace("_"," ")));r.appendChild(wrap);
      r.appendChild(amt(a.balanceCents,(a.balanceCents<0?"neg":"")));s.appendChild(r)});body.appendChild(s)}

    // Budget
    var tb=budgets.totalBudgetedCents||0, ts=budgets.totalSpentCents||0;
    if(tb>0){var s=section("Budget this month");var p=Math.min(1,ts/tb),over=ts>tb;
      var top=el("div","row");top.style.borderTop="0";top.appendChild(el("div","name",pct(p)+" used"));top.appendChild(amt(ts));s.appendChild(top);
      var bar=el("div","bar");var i=el("i");i.style.width=(p*100)+"%";if(over)i.style.background="var(--neg)";bar.appendChild(i);s.appendChild(bar);body.appendChild(s)}

    // Goals
    if(goals.length){var s=section("Goals");goals.slice(0,4).forEach(function(g){var p=g.targetCents>0?Math.min(1,g.savedCents/g.targetCents):0;
      var head=el("div","row");head.style.borderTop="0";head.style.paddingBottom="2px";head.appendChild(el("div","name",g.name));head.appendChild(el("div","amt mut",pct(p)));s.appendChild(head);
      var bar=el("div","bar");var i=el("i");i.style.width=(p*100)+"%";i.style.background=g.color||"var(--pos)";bar.appendChild(i);s.appendChild(bar)});body.appendChild(s)}

    // Bills
    if(bills.length){var s=section("Upcoming bills");bills.slice(0,5).forEach(function(b){var r=el("div","row");
      var wrap=el("div");wrap.style.flex="1";wrap.style.minWidth="0";wrap.appendChild(el("div","name",b.name));
      var due=b.daysUntilDue<0?Math.abs(b.daysUntilDue)+"d overdue":b.daysUntilDue===0?"Due today":"Due in "+b.daysUntilDue+"d";
      var sub=el("div","sub",due);if(b.daysUntilDue<=2)sub.className="sub neg";wrap.appendChild(sub);r.appendChild(wrap);r.appendChild(amt(b.amountCents));s.appendChild(r)});body.appendChild(s)}

    // Recent
    if(txns.length){var s=section("Recent");txns.forEach(function(t){var r=el("div","row");
      var wrap=el("div");wrap.style.flex="1";wrap.style.minWidth="0";wrap.appendChild(el("div","name",t.merchantName));wrap.appendChild(el("div","sub",t.postedAt.slice(5)));r.appendChild(wrap);
      r.appendChild(amt(t.amountCents,(t.amountCents>0?"pos":"")));s.appendChild(r)});body.appendChild(s)}

    body.appendChild(el("div","note","Nothing here is stored on your phone. Locks when you leave; signs out after ~4 min away."));
  }

  $("signin").onclick=signin;
  $("pw").addEventListener("keydown",function(e){if(e.key==="Enter")signin()});
  $("code").addEventListener("keydown",function(e){if(e.key==="Enter")signin()});
  $("out").onclick=logout;
  loadProfiles();
})();
</script>
</body></html>`;

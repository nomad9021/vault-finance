import type { FastifyInstance } from "fastify";

/**
 * A tiny, dependency-free, **read-only** phone viewer served on the same origin
 * as the API (so the self-signed cert is accepted once and there's no CORS).
 *
 * Zero-trust by design:
 *  - You log in every time (password + 2FA); the access token lives only in a
 *    JS variable and is gone on reload/close. Nothing is written to storage.
 *  - Money is masked (••••) by default; a tap reveals it for a few seconds.
 *  - All data is inserted via textContent (never innerHTML), so a merchant name
 *    can't inject markup.
 *  - Strict CSP; no external resources; the page never mutates anything.
 */
export default async function mobileRoutes(app: FastifyInstance) {
  app.get("/manifest.webmanifest", async (_req, reply) => {
    reply
      .header("content-type", "application/manifest+json")
      .header("cache-control", "no-store")
      .send(
        JSON.stringify({
          name: "Vault Finance",
          short_name: "Vault",
          display: "standalone",
          background_color: "#14161f",
          theme_color: "#14161f",
          start_url: "/",
          icons: [{ src: ICON, sizes: "any", type: "image/svg+xml", purpose: "any" }],
        }),
      );
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

const ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#14161f"/><path d="M20 20l12 26 12-26" fill="none" stroke="#3ecf8e" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  );

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#14161f">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Vault">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="${ICON}">
<title>Vault Finance</title>
<style>
  :root{--bg:#14161f;--surface:#1b1e29;--line:#2a2e3b;--text:#e7e9ee;--muted:#9aa0ab;--pos:#3ecf8e;--neg:#e25c5c;--accent:#6f8ef2}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;
    padding:max(env(safe-area-inset-top),12px) 14px calc(env(safe-area-inset-bottom) + 24px);-webkit-tap-highlight-color:transparent}
  .head{display:flex;align-items:center;gap:10px;margin:4px 2px 14px}
  .mark{width:26px;height:26px;border-radius:7px;background:#0f111a;display:grid;place-items:center;flex:none}
  .brand{font-weight:700;font-size:16px;letter-spacing:-.01em}
  .sp{margin-left:auto}
  button{font:inherit;color:inherit;cursor:pointer}
  .icon-btn{background:var(--surface);border:1px solid var(--line);border-radius:10px;width:38px;height:38px;display:grid;place-items:center;font-size:16px}
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
  .m{font-variant-numeric:tabular-nums;letter-spacing:.06em}
  .bar{height:7px;border-radius:99px;background:#22252f;overflow:hidden;margin-top:6px}
  .bar>i{display:block;height:100%;border-radius:99px;background:var(--accent)}
  .title{font-weight:600;font-size:14px;margin:0 2px 8px}
  .pos{color:var(--pos)} .neg{color:var(--neg)} .mut{color:var(--muted)}
  .input{width:100%;background:#0f111a;border:1px solid var(--line);border-radius:11px;color:var(--text);font-size:16px;padding:12px 14px;margin-top:10px}
  .btn{width:100%;background:var(--pos);color:#08120c;border:0;border-radius:11px;font-weight:700;font-size:15px;padding:13px;margin-top:12px}
  .profiles{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin:6px 0}
  .prof{display:flex;flex-direction:column;align-items:center;gap:7px;padding:12px 16px;border-radius:14px;background:none;border:1px solid var(--line)}
  .prof[data-on]{border-color:var(--pos);background:#14231a}
  .av{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;font-weight:700;color:#08120c}
  .err{color:var(--neg);font-size:13px;margin-top:10px;text-align:center}
  .center{min-height:70vh;display:flex;flex-direction:column;justify-content:center;max-width:420px;margin:0 auto}
  .note{font-size:11.5px;color:var(--muted);text-align:center;margin-top:16px;line-height:1.5}
  [hidden]{display:none!important}
</style></head>
<body>
<div id="login" class="center">
  <div style="text-align:center;margin-bottom:18px">
    <div class="mark" style="width:40px;height:40px;margin:0 auto 10px">
      <svg width="24" height="24" viewBox="0 0 64 64"><path d="M20 20l12 26 12-26" fill="none" stroke="#3ecf8e" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
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
  <div class="note">Nothing is saved on this device. You'll sign in each time, and amounts stay hidden until you tap the eye.</div>
</div>

<div id="app" hidden>
  <div class="head">
    <div class="mark"><svg width="16" height="16" viewBox="0 0 64 64"><path d="M20 20l12 26 12-26" fill="none" stroke="#3ecf8e" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
    <div class="brand">Vault</div>
    <div class="sp"></div>
    <button id="eye" class="icon-btn" title="Reveal amounts">👁️</button>
    <button id="out" class="ghost">Sign out</button>
  </div>
  <div id="body"></div>
</div>

<script>
(function(){
  "use strict";
  var token=null, revealed=false, revealTimer=null, sel=null;
  var $=function(id){return document.getElementById(id)};
  function fmt(c){var n=Math.round(c/100);var s=n<0?"-":"";n=Math.abs(n);return s+"$"+n.toLocaleString()}
  function el(t,cls,txt){var e=document.createElement(t);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}
  // Masked money span: shows •••• until revealed. Value kept in a data attr.
  function money(c,cls){var s=el("span","m amt"+(cls?" "+cls:""));s.dataset.c=String(c|0);s.textContent=revealed?fmt(c):"••••";return s}
  function paintMoney(){var ns=document.querySelectorAll(".m");for(var i=0;i<ns.length;i++){ns[i].textContent=revealed?fmt(+ns[i].dataset.c):"••••"}}
  function pct(n){return Math.round(n*100)+"%"}

  function reveal(){revealed=true;paintMoney();$("eye").textContent="🙈";clearTimeout(revealTimer);revealTimer=setTimeout(function(){revealed=false;paintMoney();$("eye").textContent="👁️"},15000)}
  function hide(){revealed=false;clearTimeout(revealTimer);paintMoney();$("eye").textContent="👁️"}

  async function api(path){
    var r=await fetch("/api/v1"+path,{headers:{authorization:"Bearer "+token},cache:"no-store"});
    if(r.status===401){logout();throw new Error("401")}
    if(!r.ok)throw new Error(String(r.status));
    return r.json();
  }

  function logout(){token=null;sel=null;hide();$("app").hidden=true;$("login").hidden=false;$("pwbox").hidden=true;$("pw").value="";$("code").value="";$("code").hidden=true;loadProfiles()}

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
    var code2="";try{code2=(await r.json()).error.code}catch(e){}
    if(code2==="TOTP_REQUIRED"){$("code").hidden=false;$("code").focus();return}
    if(code2==="TOTP_INVALID"){$("code").hidden=false;showErr("That code isn't right — use the current one.");return}
    showErr(code2==="RATE_LIMITED"?"Too many attempts — wait a bit.":"That didn't work.");
  }
  function showErr(m){var e=$("err");e.textContent=m;e.hidden=false}

  function section(title){var c=el("div","card");if(title)c.appendChild(el("div","title",title));return c}

  async function overview(){
    var body=$("body");body.textContent="";body.appendChild(el("div","mut","Loading…"));
    var res=await Promise.allSettled([api("/accounts"),api("/cashflow/summary?months=2"),api("/budgets"),api("/goals"),api("/bills"),api("/transactions?limit=6")]);
    var accounts=(res[0].value&&res[0].value.accounts)||[];
    var months=(res[1].value&&res[1].value.months)||[];
    var budgets=res[2].value||{}; var goals=(res[3].value&&res[3].value.goals)||[];
    var bills=(res[4].value&&res[4].value.bills)||[]; var txns=(res[5].value&&res[5].value.transactions)||[];
    body.textContent="";

    // Net worth
    var net=accounts.reduce(function(s,a){return s+(a.balanceCents||0)},0);
    var nw=section();nw.appendChild(el("div","eyebrow","Net worth"));
    var big=money(net);big.className="m big";nw.appendChild(big);body.appendChild(nw);

    // This month health
    var m=months[months.length-1]||{};
    var sr=(m.savingsRate!=null)?pct(m.savingsRate):"—";
    var chips=el("div","chips");
    chips.appendChild(chip("Income",money(m.incomeCents||0)));
    chips.appendChild(chip("Spending",money(m.spendingCents||0)));
    var srv=el("div","v"+((m.savingsRate||0)>=0?" pos":" neg"),sr);
    chips.appendChild(chip("Savings rate",srv));
    body.appendChild(chips);

    // Accounts (names shown, balances masked)
    if(accounts.length){var s=section("Accounts");accounts.filter(function(a){return a.balanceCents!==0}).slice(0,8).forEach(function(a){
      var r=el("div","row");var d=el("div","name",a.name);var wrap=el("div");wrap.style.flex="1";wrap.style.minWidth="0";wrap.appendChild(d);
      wrap.appendChild(el("div","sub",a.type.replace("_"," ")));r.appendChild(wrap);
      r.appendChild(money(a.balanceCents,(a.balanceCents<0?"neg":"")));s.appendChild(r)});body.appendChild(s)}

    // Budgets (percent shown, amount masked)
    var tb=budgets.totalBudgetedCents||0, ts=budgets.totalSpentCents||0;
    if(tb>0){var s=section("Budget this month");var p=Math.min(1,ts/tb),over=ts>tb;
      var top=el("div","row");top.style.borderTop="0";var lab=el("div","name",pct(p)+" used");top.appendChild(lab);top.appendChild(money(ts));body.appendChild(s);
      s.appendChild(top);var bar=el("div","bar");var i=el("i");i.style.width=(p*100)+"%";if(over)i.style.background="var(--neg)";bar.appendChild(i);s.appendChild(bar)}

    // Goals (percent shown)
    if(goals.length){var s=section("Goals");goals.slice(0,4).forEach(function(g){var p=g.targetCents>0?Math.min(1,g.savedCents/g.targetCents):0;
      var head=el("div","row");head.style.borderTop="0";head.style.paddingBottom="2px";head.appendChild(el("div","name",g.name));head.appendChild(el("div","amt mut",pct(p)));s.appendChild(head);
      var bar=el("div","bar");var i=el("i");i.style.width=(p*100)+"%";i.style.background=g.color||"var(--pos)";bar.appendChild(i);s.appendChild(bar)});body.appendChild(s)}

    // Upcoming bills
    if(bills.length){var s=section("Upcoming bills");bills.slice(0,5).forEach(function(b){var r=el("div","row");
      var wrap=el("div");wrap.style.flex="1";wrap.style.minWidth="0";wrap.appendChild(el("div","name",b.name));
      var due=b.daysUntilDue<0?Math.abs(b.daysUntilDue)+"d overdue":b.daysUntilDue===0?"Due today":"Due in "+b.daysUntilDue+"d";
      var sub=el("div","sub",due);if(b.daysUntilDue<=2)sub.className="sub neg";wrap.appendChild(sub);r.appendChild(wrap);r.appendChild(money(b.amountCents));s.appendChild(r)});body.appendChild(s)}

    // Recent transactions (merchant shown, amount masked)
    if(txns.length){var s=section("Recent");txns.forEach(function(t){var r=el("div","row");
      var wrap=el("div");wrap.style.flex="1";wrap.style.minWidth="0";wrap.appendChild(el("div","name",t.merchantName));wrap.appendChild(el("div","sub",t.postedAt.slice(5)));r.appendChild(wrap);
      r.appendChild(money(t.amountCents,(t.amountCents>0?"pos":"")));s.appendChild(r)});body.appendChild(s)}

    body.appendChild(el("div","note","Amounts are hidden. Tap 👁️ to reveal for 15s. Nothing here is stored on your phone."));
    paintMoney();
  }
  function chip(label,valEl){var c=el("div","chip");c.appendChild(el("div","eyebrow",label));c.appendChild(valEl);return c}

  $("signin").onclick=signin;
  $("pw").addEventListener("keydown",function(e){if(e.key==="Enter")signin()});
  $("code").addEventListener("keydown",function(e){if(e.key==="Enter")signin()});
  $("eye").onclick=function(){revealed?hide():reveal()};
  $("out").onclick=logout;
  loadProfiles();
})();
</script>
</body></html>`;

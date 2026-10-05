// Rate limiting configuration
const FAIL_LIMIT = 10; // Max wrong codes per IP per minute
const CODE_LEN = 3;    // Match your original code length
const TTL = 1200;      // Expiration in seconds (20 minutes)

// Clean and normalize text encoding (matching python version)
function cleanText(raw) {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// Generate random uppercase string code
function generateCode(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  for (let i = 0; i < len; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Rate limiting check using KV
async function isBlocked(ip, env) {
  const attempts = await env.FLASHCARDS_KV.get(`fail:${ip}`, 'json') || [];
  const now = Date.now();
  const recent = attempts.filter(t => now - t < 60000);
  return recent.length >= FAIL_LIMIT;
}

// Record failed lookup
async function recordFail(ip, env) {
  const attempts = await env.FLASHCARDS_KV.get(`fail:${ip}`, 'json') || [];
  const now = Date.now();
  const recent = attempts.filter(t => now - t < 60000);
  recent.push(now);
  await env.FLASHCARDS_KV.put(`fail:${ip}`, JSON.stringify(recent), { expirationTtl: 60 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const clientIP = request.headers.get('CF-Connecting-IP') || '127.0.0.1';

    // CORS Headers to ensure compatibility across devices
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    // Serve HTML page
    if (path === '/' && request.method === 'GET') {
      return new Response(HTML_PAGE, {
        headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' }
      });
    }

    // Phone GET /new -> generates a session code
    if (path === '/new' && request.method === 'GET') {
      let code = '';
      let attempts = 0;
      while (attempts < 10) {
        code = generateCode(CODE_LEN);
        const existing = await env.FLASHCARDS_KV.get(`sess:${code}`);
        if (!existing) break;
        attempts++;
      }

      const session = { current: '', ready: null };
      await env.FLASHCARDS_KV.put(`sess:${code}`, JSON.stringify(session), { expirationTtl: TTL });
      return new Response(code, { headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    // Extract sync code parameter
    const code = (url.searchParams.get('code') || '').trim().toUpperCase();

    // Helper for KV session lookups with IP rate-limiting
    async function getSession() {
      if (await isBlocked(clientIP, env)) {
        return { status: 429, body: 'slow down' };
      }
      if (!code) {
        await recordFail(clientIP, env);
        return { status: 404, body: 'missing code' };
      }
      const raw = await env.FLASHCARDS_KV.get(`sess:${code}`);
      if (!raw) {
        await recordFail(clientIP, env);
        return { status: 410, body: 'expired' };
      }
      return { status: 200, session: JSON.parse(raw) };
    }

    // Phone downloads edited flashcard sets: GET /get?code=XXX
    if (path === '/get' && request.method === 'GET') {
      const res = await getSession();
      if (res.status !== 200) {
        return new Response(res.body, { status: res.status, headers });
      }
      if (res.session.ready === null) {
        return new Response('not ready', { status: 404, headers });
      }
      return new Response(res.session.ready, {
        status: 200,
        headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    // Web editor loads sets: GET /api/load?code=XXX
    if (path === '/api/load' && request.method === 'GET') {
      const res = await getSession();
      if (res.status !== 200) {
        return new Response(res.body, { status: res.status, headers });
      }
      const text = res.session.ready !== null ? res.session.ready : res.session.current;
      return new Response(text, {
        status: 200,
        headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }

    // Handle POST routes (/put and /api/save)
    if (request.method === 'POST') {
      if (path !== '/put' && path !== '/api/save') {
        return new Response('not found', { status: 404, headers });
      }

      const res = await getSession();
      if (res.status !== 200) {
        return new Response(res.body, { status: res.status, headers });
      }

      const bodyText = cleanText(await request.text());
      const session = res.session;

      if (path === '/put') {
        // Phone uploads current sets
        session.current = bodyText;
        session.ready = null;
      } else {
        // Web saves modified sets
        session.ready = bodyText;
      }

      // Re-save session into KV with refreshed TTL
      await env.FLASHCARDS_KV.put(`sess:${code}`, JSON.stringify(session), { expirationTtl: TTL });
      return new Response('ok', { status: 200, headers });
    }

    return new Response('not found', { status: 404, headers });
  }
};

const HTML_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flashcards LT-FR</title>
<style>
:root{--bg:#eef1f6;--card:#fff;--ink:#16202f;--mute:#5d6b82;--line:#d3dae6;--blue:#2349c9;--red:#c2332b}
@media (prefers-color-scheme:dark){:root{--bg:#10151f;--card:#18202e;--ink:#e8edf6;--mute:#93a1b8;--line:#2a3548;--blue:#7b9bff;--red:#ff7a70}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:20px 16px 60px}
h1{font:700 28px/1.1 Georgia,"Times New Roman",serif;margin:8px 0 4px}
p.sub{margin:0 0 20px;color:var(--mute)}
.panel{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:16px;margin-bottom:16px}
label{display:block;font-size:14px;color:var(--mute);margin-bottom:4px}
input,select,button{font:inherit;color:inherit}
input[type=text],select{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:4px;background:var(--bg)}
input:focus-visible,select:focus-visible,button:focus-visible{outline:2px solid var(--blue);outline-offset:1px}
button{padding:9px 14px;border:1px solid var(--line);border-radius:4px;background:var(--card);cursor:pointer}
button.main{background:var(--blue);border-color:var(--blue);color:#fff}
@media (prefers-color-scheme:dark){button.main{color:#0b1020}}
button.danger{color:var(--red)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end}
.row>.grow{flex:1 1 200px}
#code{font:700 22px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.2em;max-width:160px}
table{width:100%;border-collapse:collapse;margin:12px 0}
td{padding:3px 4px 3px 0}
td.x{width:1%}
.msg{min-height:1.4em;margin:8px 0 0;color:var(--mute)}
.msg.err{color:var(--red)}
.hint{font-size:14px;color:var(--mute)}
[hidden]{display:none!important}
</style></head><body><main>
<h1>Flashcards LT-FR</h1>
<p class="sub">Edit your phone's flashcard sets in the browser.</p>

<section class="panel" id="connect">
  <label for="code">Code shown on the phone</label>
  <div class="row">
    <input id="code" type="text" maxlength="8" autocomplete="off" autocapitalize="characters" spellcheck="false">
    <button class="main" id="load">Load sets</button>
  </div>
  <p class="msg" id="m1"></p>
</section>

<section id="editor" hidden>
  <div class="panel">
    <div class="row">
      <div class="grow"><label for="sets">Set</label><select id="sets"></select></div>
      <button id="newset">New set</button>
      <button id="rename">Rename</button>
      <button id="delset" class="danger">Delete set</button>
    </div>
    <table id="cards"><thead><tr><td class="hint">Lithuanian</td><td class="hint">French</td><td></td></tr></thead><tbody></tbody></table>
    <button id="addcard">Add card</button>
  </div>
  <div class="panel">
    <div class="row">
      <button class="main" id="save">Save to device</button>
      <button id="export">Export .txt</button>
      <button id="importbtn">Import .txt</button>
      <input id="file" type="file" accept=".txt,text/plain" hidden>
    </div>
    <p class="msg" id="m2"></p>
    <p class="hint">After saving, press Download on the phone. Import merges by set name: a set with the same name is replaced.</p>
  </div>
</section>

<script>
let sets = [], cur = 0, code = "";
const $ = id => document.getElementById(id);
const say = (id, t, err) => { const e = $(id); e.textContent = t; e.className = "msg" + (err ? " err" : ""); };

function parse(text) {
  const out = []; let c = null;
  for (let line of text.split(/\r?\n/)) {
    line = line.trim(); if (!line) continue;
    if (line[0] === "#") { c = { name: line.slice(1).trim() || "Set", cards: [] }; out.push(c); }
    else {
      const i = line.indexOf("|");
      if (i > 0) {
        const a = line.slice(0, i).trim(), b = line.slice(i + 1).trim();
        if (a && b) { if (!c) { c = { name: "Imported", cards: [] }; out.push(c); } c.cards.push([a, b]); }
      }
    }
  }
  return out;
}
const tidy = s => s.replace(/[|\r\n#]/g, " ").trim();
function serialize() {
  return sets.map(s => "#" + tidy(s.name) + "\n" +
    s.cards.map(c => [tidy(c[0]), tidy(c[1])]).filter(c => c[0] && c[1]).map(c => c.join("|")).join("\n")
  ).join("\n\n") + "\n";
}

function render(focusLast) {
  const sel = $("sets"); sel.innerHTML = "";
  sets.forEach((s, i) => { const o = document.createElement("option"); o.value = i; o.textContent = s.name + " (" + s.cards.length + ")"; sel.appendChild(o); });
  if (cur >= sets.length) cur = Math.max(0, sets.length - 1);
  sel.value = cur;
  const tb = document.querySelector("#cards tbody"); tb.innerHTML = "";
  const s = sets[cur];
  $("rename").disabled = $("delset").disabled = $("addcard").disabled = !s;
  if (!s) return;
  s.cards.forEach((c, i) => {
    const tr = document.createElement("tr");
    [0, 1].forEach(k => {
      const td = document.createElement("td"), inp = document.createElement("input");
      inp.type = "text"; inp.value = c[k]; inp.setAttribute("aria-label", k ? "French" : "Lithuanian");
      inp.oninput = () => { c[k] = inp.value; };
      td.appendChild(inp); tr.appendChild(td);
    });
    const td = document.createElement("td"); td.className = "x";
    const del = document.createElement("button"); del.textContent = "\u00d7"; del.setAttribute("aria-label", "Delete card");
    del.onclick = () => { s.cards.splice(i, 1); render(); };
    td.appendChild(del); tr.appendChild(td); tb.appendChild(tr);
  });
  if (focusLast) { const ins = tb.querySelectorAll("input"); if (ins.length >= 2) ins[ins.length - 2].focus(); }
}

$("load").onclick = async () => {
  code = $("code").value.trim().toUpperCase();
  if (!code) return say("m1", "Type the code first.", true);
  const r = await fetch("/api/load?code=" + encodeURIComponent(code));
  if (r.status === 429) return say("m1", "Too many wrong codes. Wait a minute.", true);
  if (!r.ok) return say("m1", "Unknown or expired code. Start a new sync on the phone.", true);
  sets = parse(await r.text()); cur = 0;
  say("m1", "Connected to the phone."); $("editor").hidden = false; render();
};
$("code").addEventListener("keydown", e => { if (e.key === "Enter") $("load").click(); });
$("sets").onchange = e => { cur = +e.target.value; render(); };
$("addcard").onclick = () => { sets[cur].cards.push(["", ""]); render(true); };
$("newset").onclick = () => { const n = prompt("Name of the new set"); if (n && tidy(n)) { sets.push({ name: tidy(n), cards: [] }); cur = sets.length - 1; render(); } };
$("rename").onclick = () => { const n = prompt("New name", sets[cur].name); if (n && tidy(n)) { sets[cur].name = tidy(n); render(); } };
$("delset").onclick = () => { if (confirm("Delete the set \"" + sets[cur].name + "\"?")) { sets.splice(cur, 1); render(); } };
$("save").onclick = async () => {
  const r = await fetch("/api/save?code=" + encodeURIComponent(code), { method: "POST", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: serialize() });
  if (r.ok) say("m2", "Saved. Now press Download on the phone.");
  else say("m2", "Could not save: the code has expired. Start a new sync.", true);
};
$("export").onclick = () => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([serialize()], { type: "text/plain;charset=utf-8" }));
  a.download = "flashcards.txt"; a.click(); URL.revokeObjectURL(a.href);
};
$("importbtn").onclick = () => $("file").click();
$("file").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const got = parse(await f.text());
  got.forEach(g => { const i = sets.findIndex(s => s.name === g.name); if (i >= 0) sets[i] = g; else sets.push(g); });
  say("m2", "Imported " + got.length + " set(s). Press Save to device to send them."); e.target.value = ""; render();
};
</script></main></body></html>`;
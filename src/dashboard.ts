/** Local web dashboard: serves a single self-contained page that polls
 * /api/state and renders presence, traffic, a flight log, and hourly volume.
 * No build step and no external assets, so it works offline. */

import { spawn } from "node:child_process";
import { buildState } from "./dashboardData.ts";

/** Open a URL in the user's default browser (best-effort, detached). */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  const child = spawn(cmd[0], cmd.slice(1), {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  child.on("error", () => {
    // No browser opener available (headless box); the URL is already printed.
  });
}

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>agent-mail dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #0d1117; color: #c9d1d9; }
  header { padding: 14px 20px; display: flex;
           align-items: baseline; gap: 18px; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .stat { color: #8b949e; } header .stat b { color: #c9d1d9; }
  header .age { margin-left: auto; color: #6e7681; font-size: 12px; }
  nav { display: flex; gap: 4px; padding: 0 20px; border-top: 1px solid #21262d;
        border-bottom: 1px solid #21262d; background: #0d1117; }
  .tab { appearance: none; border: 0; border-bottom: 2px solid transparent;
         background: transparent; color: #8b949e; font: inherit; padding: 10px 12px 8px;
         cursor: pointer; }
  .tab:hover { color: #c9d1d9; }
  .tab[aria-selected="true"] { color: #f0f6fc; border-color: #2f81f7; }
  main { padding: 16px 20px; }
  section { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 12px 14px; }
  section[hidden] { display: none; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
       color: #8b949e; margin: 0 0 10px; }
  .row { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
  .bar { height: 10px; background: #1f6feb; border-radius: 2px; min-width: 2px; }
  .muted { color: #6e7681; } .arrow { color: #6e7681; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; display: inline-block; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 3px 8px 3px 0; vertical-align: top; white-space: nowrap; }
  td.msg { white-space: normal; color: #adbac7; }
  .vol { display: flex; align-items: flex-end; gap: 2px; height: 64px; }
  .vol .b { flex: 1; background: #238636; border-radius: 1px 1px 0 0; min-height: 1px; }
  .thread { color: #d29922; }
  .client { font-size: 11px; color: #8b949e; border: 1px solid #30363d;
            border-radius: 10px; padding: 0 7px; }
  .empty { color: #6e7681; font-style: italic; }
</style>
</head>
<body>
<header>
  <h1>&#x1F4EC; agent-mail</h1>
  <span class="stat"><b id="t-msgs">&ndash;</b> messages</span>
  <span class="stat"><b id="t-projects">&ndash;</b> projects</span>
  <span class="stat"><b id="t-threads">&ndash;</b> threads</span>
  <span class="stat"><b id="t-live">&ndash;</b> live</span>
  <span class="age" id="age"></span>
</header>
<nav role="tablist" aria-label="Dashboard views">
  <button class="tab" id="tab-sessions" role="tab" aria-selected="true" aria-controls="view-sessions" data-view="sessions">Sessions</button>
  <button class="tab" id="tab-traffic" role="tab" aria-selected="false" aria-controls="view-traffic" data-view="traffic">Traffic</button>
  <button class="tab" id="tab-volume" role="tab" aria-selected="false" aria-controls="view-volume" data-view="volume">Volume</button>
  <button class="tab" id="tab-log" role="tab" aria-selected="false" aria-controls="view-log" data-view="log">Flight log</button>
</nav>
<main>
  <section id="view-sessions" role="tabpanel" aria-labelledby="tab-sessions"><h2>Live sessions</h2><div id="presence"></div></section>
  <section id="view-traffic" role="tabpanel" aria-labelledby="tab-traffic" hidden><h2>Traffic (sender &rarr; recipient)</h2><div id="routes"></div></section>
  <section id="view-volume" role="tabpanel" aria-labelledby="tab-volume" hidden><h2>Volume &middot; last 24h</h2><div class="vol" id="volume"></div></section>
  <section id="view-log" role="tabpanel" aria-labelledby="tab-log" hidden><h2>Flight log</h2><table><tbody id="log"></tbody></table></section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const tabs = [...document.querySelectorAll("[role=tab]")];

function activate(view) {
  for (const tab of tabs) {
    const selected = tab.dataset.view === view;
    tab.setAttribute("aria-selected", String(selected));
    $(tab.getAttribute("aria-controls")).hidden = !selected;
  }
}

for (const tab of tabs) {
  tab.addEventListener("click", () => activate(tab.dataset.view));
}

function render(s) {
  $("t-msgs").textContent = s.totals.messages;
  $("t-projects").textContent = s.totals.projects;
  $("t-threads").textContent = s.totals.threads;
  $("t-live").textContent = s.totals.live;
  $("age").textContent = "updated " + time(s.now);

  $("presence").innerHTML = s.presence.length
    ? s.presence.map((p) =>
        '<div class="row"><span class="dot"></span><b>' + esc(p.project) + '</b>' +
        (p.client ? ' <span class="client">' + esc(p.client) + '</span>' : '') +
        ' <span class="muted">' + esc(p.label) + '</span>' +
        (p.status ? ' <span class="muted">[' + esc(p.status) + ']</span>' : '') +
        '</div>').join("")
    : '<div class="empty">no sessions listening</div>';

  const max = Math.max(1, ...s.routes.map((r) => r.count));
  $("routes").innerHTML = s.routes.length
    ? s.routes.map((r) =>
        '<div class="row"><span>' + esc(r.from) + '</span><span class="arrow">&rarr;</span><span>' +
        esc(r.to) + '</span><span class="bar" style="width:' + (r.count / max * 120 + 6) +
        'px"></span><span class="muted">' + r.count + '</span></div>').join("")
    : '<div class="empty">no traffic yet</div>';

  const vmax = Math.max(1, ...s.volume.map((v) => v.count));
  $("volume").innerHTML = s.volume.map((v) =>
    '<div class="b" style="height:' + (v.count / vmax * 100) + '%" title="' +
    time(v.hour) + ": " + v.count + '"></div>').join("");

  $("log").innerHTML = s.log.length
    ? s.log.map((m) =>
        '<tr><td class="muted">' + time(m.ts) + '</td><td><b>' + esc(m.from) +
        '</b> <span class="arrow">&rarr;</span> ' + esc(m.to) +
        (m.thread ? ' <span class="thread">&#x21A9;</span>' : '') +
        '</td><td class="msg">' + esc(m.preview) + '</td></tr>').join("")
    : '<tr><td class="empty">inbox empty</td></tr>';
}

async function tick() {
  try {
    const r = await fetch("/api/state");
    if (r.ok) render(await r.json());
  } catch {}
}
tick();
setInterval(tick, 2000);
</script>
</body>
</html>`;

/** Start the dashboard HTTP server on 127.0.0.1. Pass port 0 for an ephemeral
 * port; the chosen port is available as `server.port`. */
export function serveDashboard(port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/" || pathname === "/index.html") {
        return new Response(PAGE, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (pathname === "/api/state") {
        return new Response(JSON.stringify(buildState()), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
}

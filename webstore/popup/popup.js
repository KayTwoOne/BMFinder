/* Popup: what am I looking at, and one click to act on it.

   Deliberately thin. It reads the active tab's URL to work out context and asks
   the worker for everything else. Anything that needs a table belongs in the
   dashboard. */

import { applyTheme, resolveMode } from "../lib/theme.js";

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

// Match whatever appearance the dashboard saved. Same storage key, so the popup
// is never a different colour or mode than the rest of the extension.
(async () => {
  let pref = { seed: "violet", mode: "system" };
  try {
    const got = await chrome.storage.local.get("bmfTheme");
    if (got && got.bmfTheme) pref = { ...pref, ...got.bmfTheme };
  } catch { /* first run */ }
  applyTheme(document.documentElement, { seed: pref.seed, mode: resolveMode(pref.mode) });
})();

function setMsg(text, kind) {
  const el = $("pop-msg");
  el.textContent = text || "";
  el.className = "message" + (kind ? " " + kind : "");
}

/** Work out what the current tab is showing without injecting anything. */
function contextFor(url) {
  if (!url || !/^https:\/\/www\.battlemetrics\.com\//.test(url)) return null;
  const player = url.match(/\/players\/(\d+)/);
  if (player) return { kind: "player", id: player[1] };
  const server = url.match(/\/servers\/(?:[a-z0-9]+\/)?(\d+)/i);
  if (server) return { kind: "server", id: server[1] };
  return { kind: "site" };
}

let ctx = null;

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  ctx = contextFor(tab && tab.url);

  const track = $("pop-track");
  if (!ctx) {
    $("pop-context").textContent = "Not on a BattleMetrics page.";
    track.disabled = true;
  } else if (ctx.kind === "player") {
    $("pop-context").textContent = "Player " + ctx.id;
    track.textContent = "Save this person";
  } else if (ctx.kind === "server") {
    $("pop-context").textContent = "Server " + ctx.id;
    track.textContent = "Follow this server";
  } else {
    $("pop-context").textContent = "BattleMetrics";
    track.disabled = true;
  }

  try {
    const state = await send({ type: "GET_STATE" });
    const s = (state && state.stats) || {};
    $("pop-status").textContent =
      `${s.watched || 0} saved, ${s.servers || 0} followed, ${s.snapshots || 0} server checks`;
    // Already saved or followed? Then offer nothing rather than a duplicate.
    if (ctx && ctx.kind === "player" && (state.watch || []).some((w) => String(w.playerId) === ctx.id)) {
      track.textContent = "Already saved";
      track.disabled = true;
    }
    if (ctx && ctx.kind === "server" && (state.servers || []).some((x) => String(x.serverId) === ctx.id)) {
      track.textContent = "Already following";
      track.disabled = true;
    }
  } catch {
    $("pop-status").textContent = "Background worker not responding.";
  }
}

$("pop-track").addEventListener("click", async () => {
  if (!ctx) return;
  $("pop-track").disabled = true;
  try {
    if (ctx.kind === "player") {
      /* No relationship and no label: the popup has one button and no room to
         ask, so it saves the person and lets the dashboard fill in the rest. */
      await send({ type: "ADD_WATCH", entry: { playerId: ctx.id } });
      setMsg("Saved. Add a label and relationship in the dashboard.", "ok");
    } else {
      await send({ type: "ADD_SERVER", entry: { serverId: ctx.id } });
      setMsg("Now following this server.", "ok");
    }
    $("pop-track").textContent = ctx.kind === "player" ? "Already saved" : "Already following";
  } catch (e) {
    setMsg("Failed: " + ((e && e.message) || e), "err");
    $("pop-track").disabled = false;
  }
});

$("pop-dashboard").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard/dashboard.html") });
  window.close();
});

$("pop-refresh").addEventListener("click", async () => {
  setMsg("Refreshing in the background. This can take a while.", "");
  try {
    const r = await send({ type: "REFRESH_WATCHLIST" });
    setMsg(r && r.error ? r.error : "Refresh started.", r && r.error ? "err" : "ok");
  } catch (e) {
    setMsg("Failed: " + ((e && e.message) || e), "err");
  }
});

init();

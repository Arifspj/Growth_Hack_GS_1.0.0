const $ = (id) => document.getElementById(id);
const DEFAULT_SHEET =
  "1QQf-c4GbdAxAWHCzUQkTLWUH85Tm-u1XN7yN0pem-H4";

let port = null;
let state = { settings: null, spreadsheetId: null };
let scrapingAll = false;

function extractSheetId(value) {
  const v = String(value || "").trim();
  const m = v.match(/\/spreadsheets\/d\/([a-zA-Z0-9\-_]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9\-_]{20,}$/.test(v)) return v;
  return null;
}

async function activeTabSheetId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab && tab.url ? extractSheetId(tab.url) : null;
  } catch {
    return null;
  }
}

function log(msg, cls = "") {
  const div = document.createElement("div");
  div.className = cls;
  div.textContent = new Date().toLocaleTimeString() + "  " + msg;
  $("log").appendChild(div);
  $("log").scrollTop = $("log").scrollHeight;
  $("log").hidden = false;
}

function renderItems() {
  const wrap = $("itemsWrap");
  const box = wrap.querySelector(".items");
  box.innerHTML = "";
  const items = state.settings.items;
  if (!items.length) {
    wrap.hidden = true;
    log("No label+URL rows found in settings (Column A label, Column B URL).");
    return;
  }
  wrap.hidden = false;
  $("scrapeAllBtn").disabled = false;
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "item";
    const labelSpan = document.createElement("span");
    labelSpan.className = "item-label";
    labelSpan.textContent = item.label;
    labelSpan.title = item.url;
    const urlSpan = document.createElement("span");
    urlSpan.className = "item-url";
    urlSpan.textContent = item.url;
    const status = document.createElement("span");
    status.className = "status";
    status.textContent = "idle";
    const btn = document.createElement("button");
    btn.className = "btn primary";
    btn.textContent = "Scrape";
    btn.addEventListener("click", () => runScrape(item, btn, status));
    row.append(labelSpan, status, btn, urlSpan);
    box.appendChild(row);
  }
}

function chosenMode() {
  return $("replaceChk").checked ? "replace" : "append";
}

function runScrape(item, btn, status) {
  btn.disabled = true;
  status.className = "status";
  status.textContent = "starting...";
  port.postMessage({
    type: "scrape",
    spreadsheetId: state.spreadsheetId,
    item,
    mode: chosenMode(),
    maxPages: parseInt($("maxPages").value || "1", 10),
  });
}

async function loadSheet(spreadsheetId) {
  if (!spreadsheetId) {
    log("No Google Sheet URL/ID detected. Paste the sheet URL above.", "error");
    return;
  }
  state.spreadsheetId = spreadsheetId;
  log(`Loading settings from sheet ${spreadsheetId}...`);
  $("sheetInfo").textContent = `Sheet: ${spreadsheetId}`;
  $("controls").hidden = true;
  $("itemsWrap").hidden = true;
  $("scrapeAllBtn").disabled = true;
  $("log").innerHTML = "";
  port.postMessage({ type: "init", spreadsheetId });
}

function setLoginState(msg) {
  const s = $("loginState");
  if (msg.ok === false || msg.error) {
    s.textContent = msg.error || "Login failed.";
    $("loginBtn").disabled = false;
    return;
  }
  if (msg.noTab) {
    s.textContent = msg.message;
    $("loginBtn").disabled = false;
    return;
  }
  s.textContent = msg.message || (msg.loggedIn ? "Logged in." : "Not logged in.");
  s.style.color = msg.loggedIn ? "#2e9353" : "#dc2626";
  $("loginBtn").disabled = false;
  $("loginBtn").textContent = msg.loggedIn ? "Logged in" : "Login to Screener";
}

function init() {
  port = chrome.runtime.connect({ name: "scrape" });
  port.onMessage.addListener((msg) => {
    if (msg.type === "ready") {
      state.settings = msg.settings;
      log(
        `Settings tab "${msg.settings.settingsSheet}" → ${msg.settings.items.length} item(s).`
      );
      renderItems();
      $("controls").hidden = false;
    } else if (msg.type === "progress") {
      if (msg.label) {
        const itemEl = [...document.querySelectorAll(".item")].find(
          (el) => el.querySelector(".item-label").textContent === msg.label
        );
        if (itemEl) {
          const st = itemEl.querySelector(".status");
          st.textContent = msg.message;
        }
      }
      log(msg.message);
    } else if (msg.type === "complete") {
      const r = msg.result;
      log(
        `Done: ${r.written} rows into "${r.tabName}"${r.created ? " (tab created)" : ""}${r.skipped ? ` — ${r.skipped} duplicates skipped` : ""}.`,
        "done"
      );
      const itemEl = [...document.querySelectorAll(".item")].find(
        (el) => el.querySelector(".item-label").textContent === r.tabName
      );
      if (itemEl) {
        const st = itemEl.querySelector(".status");
        st.className = "status done";
        st.textContent = `${r.written} rows ✓`;
        const btn = itemEl.querySelector("button");
        btn.disabled = false;
      }
      if (!scrapingAll) setTimeout(() => loadSheet(state.spreadsheetId), 1500);
    } else if (msg.type === "error") {
      log("Error: " + msg.error, "error");
      [...document.querySelectorAll(".item button")].forEach((b) => (b.disabled = false));
    } else if (msg.type === "login_result" || msg.type === "login_check") {
      setLoginState(msg);
    }
  });

  $("loginBtn").addEventListener("click", () => {
    const email = $("loginEmail").value.trim();
    const password = $("loginPass").value;
    if (!email || !password) return setLoginState({ error: "Enter email and password." });
    $("loginBtn").disabled = true;
    $("loginState").textContent = "Logging in…";
    port.postMessage({
      type: "login",
      email,
      password,
      remember: $("rememberChk").checked,
    });
  });

  $("loadBtn").addEventListener("click", () => {
    loadSheet(extractSheetId($("sheetId").value));
  });

  $("scrapeAllBtn").addEventListener("click", async () => {
    $("scrapeAllBtn").disabled = true;
    scrapingAll = true;
    for (const item of state.settings.items) {
      const itemEl = [...document.querySelectorAll(".item")].find(
        (el) => el.querySelector(".item-label").textContent === item.label
      );
      const btn = itemEl.querySelector("button");
      const status = itemEl.querySelector(".status");
      status.className = "status";
      btn.disabled = true;
      await new Promise((resolve) => {
        const doneCb = (m) => {
          if ((m.type === "complete" && m.result.tabName === item.label) || m.type === "error") {
            port.onMessage.removeListener(doneCb);
            resolve();
          }
        };
        port.onMessage.addListener(doneCb);
        runScrape(item, btn, status);
      });
    }
    scrapingAll = false;
    $("scrapeAllBtn").disabled = false;
    loadSheet(state.spreadsheetId);
  });

  $("appendChk").addEventListener("change", (e) => {
    $("replaceChk").checked = !e.target.checked;
  });
  $("replaceChk").addEventListener("change", (e) => {
    $("appendChk").checked = !e.target.checked;
  });

  (async () => {
    const saved = await chrome.storage.local.get(["screenerEmail", "screenerRemember"]);
    if (saved.screenerEmail) $("loginEmail").value = saved.screenerEmail;
    $("rememberChk").checked = !!saved.screenerRemember;
    port.postMessage({ type: "login_check" });
    const active = await activeTabSheetId();
    const initial = active || extractSheetId(DEFAULT_SHEET);
    $("sheetId").value = active ? "" : DEFAULT_SHEET;
    loadSheet(initial);
  })();
}

document.addEventListener("DOMContentLoaded", init);
const $ = (id) => document.getElementById(id);
const DEFAULT_SHEET =
  "1QQf-c4GbdAxAWHCzUQkTLWUH85Tm-u1XN7yN0pem-H4";

let port = null;
let state = { settings: null, spreadsheetId: null };
let scrapingAll = false;
const eta = { start: 0, done: 0, total: 0 };

function updateStopEta(done, total) {
  const btn = $("stopBtn");
  if (!btn || btn.disabled) return;
  if (!total || done < 1) {
    btn.textContent = "Stop";
    return;
  }
  if (!eta.start) eta.start = Date.now();
  const elapsed = Date.now() - eta.start;
  const rate = elapsed / Math.max(1, done);
  const rem = Math.max(0, (total - done) * rate) / 1000;
  let label;
  if (rem < 90) label = `${Math.max(1, Math.round(rem))}s`;
  else if (rem < 5400) label = `${Math.max(1, Math.round(rem / 60))}m`;
  else {
    const h = Math.floor(rem / 3600);
    const m = Math.round((rem % 3600) / 60);
    label = m === 60 ? `${h + 1}.00hr` : `${h}.${String(m).padStart(2, "0")}hr`;
  }
  btn.textContent = `Stop (${label})`;
}

function resetStopEta() {
  eta.start = 0;
  eta.done = 0;
  eta.total = 0;
  const btn = $("stopBtn");
  if (btn) btn.textContent = "Stop";
}

let _resend = null;
function onBgMessage(msg) {
  if (msg.type === "ready") {
    state.settings = msg.settings;
    log(
      `Settings tab "${msg.settings.settingsSheet}" → ${msg.settings.items.length} item(s).`
    );
    renderItems();
    $("controls").hidden = false;
  } else if (msg.type === "progress") {
    if (msg.done != null && msg.total) {
      eta.total = msg.total;
      eta.done = Math.max(eta.done, msg.done);
      updateStopEta(msg.done, msg.total);
    }
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
    if (r.filled != null) {
      const what = r.ai ? "rows researched" : r.intrinsic ? "rows valued" : "rows filled";
      log(
        (r.stopped ? "Stopped: " : "Done: ") +
          `${r.filled}/${r.total} ${what} in "${r.tabName}".`,
        r.stopped ? "" : "done"
      );
    } else {
      log(
        (r.stopped ? "Stopped: " : "Done: ") +
          `${r.written} rows into "${r.tabName}"${r.created ? " (tab created)" : ""}${r.skipped ? ` — ${r.skipped} duplicates skipped` : ""}.`,
        r.stopped ? "" : "done"
      );
    }
    const itemEl2 = itemEl(r.tabName);
    if (itemEl2) {
      const st = itemEl2.querySelector(".status");
      st.className = "status" + (r.stopped ? "" : " done");
      if (r.filled != null) {
        st.textContent = (r.stopped ? "stopped " : "") + `${r.filled} rows${r.ai ? " researched" : r.intrinsic ? " valued" : " filled"}`;
      } else {
        st.textContent = (r.stopped ? "stopped " : "") + `${r.written} rows`;
      }
      itemEl2.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
    $("stopBtn").disabled = true;
    resetStopEta();
    if (!scrapingAll) setTimeout(() => loadSheet(state.spreadsheetId), 1500);
  } else if (msg.type === "stopped") {
    log("Stop requested — finishing the current row then stopping.");
  } else if (msg.type === "error") {
    log("Error: " + msg.error, "error");
    [...document.querySelectorAll(".item button")].forEach((b) => (b.disabled = false));
    $("stopBtn").disabled = true;
    resetStopEta();
  } else if (msg.type === "login_result" || msg.type === "login_check") {
    setLoginState(msg);
  }
}

function send(msg) {
  if (port) {
    try {
      port.postMessage(msg);
      return;
    } catch {
      port = null;
    }
  }
  port = chrome.runtime.connect({ name: "scrape" });
  port.onDisconnect.addListener(() => {
    port = null;
  });
  port.onMessage.addListener(onBgMessage);
  if (_resend) clearTimeout(_resend);
  _resend = setTimeout(() => {
    try {
      port.postMessage(msg);
    } catch {
      /* background still waking up */
    }
  }, 500);
}

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
    const dbtn = document.createElement("button");
    dbtn.className = "btn";
    dbtn.textContent = "Details";
    dbtn.title = "Extract per-row details from each company's consolidated page";
    dbtn.addEventListener("click", () => runDetails(item, dbtn, status));
    const abtn = document.createElement("button");
    abtn.className = "btn ai";
    abtn.textContent = "AI";
    abtn.title = 'Run the first N rows through the selected AI provider (ChatGPT/DeepSeek) and write the JSON into the "AI Research (JSON)" column';
    abtn.addEventListener("click", () => runAiResearch(item, abtn, status));
    const ivBtn = document.createElement("button");
    ivBtn.className = "btn iv";
    ivBtn.textContent = "IV";
    ivBtn.title = "Compute Graham Intrinsic Value + Margin of Safety % from the EPS / Profit Growth / Current Price columns (auto-detected) and append them at the end";
    ivBtn.addEventListener("click", () => runIntrinsic(item, ivBtn, status));
    row.append(labelSpan, status, btn, dbtn, abtn, ivBtn, urlSpan);
    box.appendChild(row);
  }
  const diag = $("diag");
  if (diag) {
    diag.hidden = true;
    diag.textContent = "";
  }
}

function chosenMode() {
  return $("replaceChk").checked ? "replace" : "append";
}

function modalConfirm({ title, message, okLabel = "Replace", danger = true }) {
  return new Promise((resolve) => {
    const backdrop = $("modalBackdrop");
    const okBtn = $("modalOkBtn");
    const cancelBtn = $("modalCancelBtn");
    $("modalTitle").textContent = title;
    $("modalMsg").textContent = message;
    okBtn.textContent = okLabel;
    okBtn.classList.toggle("danger", danger);
    const done = (val) => {
      backdrop.hidden = true;
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      backdrop.removeEventListener("click", onBackdrop);
      okBtn.removeEventListener("keydown", onKeys);
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBackdrop = (e) => {
      if (e.target === backdrop) done(false);
    };
    const onKeys = (e) => {
      if (e.key === "Enter") done(true);
      if (e.key === "Escape") done(false);
    };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    backdrop.addEventListener("click", onBackdrop);
    okBtn.addEventListener("keydown", onKeys);
    cancelBtn.addEventListener("keydown", onKeys);
    backdrop.hidden = false;
    okBtn.focus();
  });
}

function limitFromInput() {
  const v = $("limitInput").value.trim();
  return v === "" ? "0" : v;
}

async function runScrape(item, btn, status) {
  const mode = chosenMode();
  if (
    mode === "replace" &&
    !(await modalConfirm({
      title: `Replace tab "${item.label}"?`,
      message: "Existing data will be cleared before writing fresh results.",
      okLabel: "Replace",
    }))
  ) {
    return;
  }
  btn.disabled = true;
  setItemBusy(item.label, true);
  $("stopBtn").disabled = false;
  resetStopEta();
  status.className = "status";
  status.textContent = "starting...";
  send({
    type: "scrape",
    spreadsheetId: state.spreadsheetId,
    item,
    mode,
    maxPages: limitFromInput(),
  });
}

async function runDetails(item, btn, status) {
  if (
    chosenMode() === "replace" &&
    !(await modalConfirm({
      title: `Replace detail columns of "${item.label}"?`,
      message: `The detail columns (Market Cap, Current Price, etc.) for "${item.label}" will be cleared and refilled. Continue?`,
      okLabel: "Replace Details",
    }))
  ) {
    return;
  }
  btn.disabled = true;
  setItemBusy(item.label, true);
  $("stopBtn").disabled = false;
  resetStopEta();
  status.className = "status";
  status.textContent = "starting...";
  send({
    type: "scrape_details",
    spreadsheetId: state.spreadsheetId,
    item,
    mode: chosenMode(),
    maxRows: limitFromInput(),
  });
}

async function runAiResearch(item, btn, status) {
  btn.disabled = true;
  setItemBusy(item.label, true);
  $("stopBtn").disabled = false;
  resetStopEta();
  status.className = "status";
  status.textContent = "starting...";
  send({
    type: "ai_research",
    spreadsheetId: state.spreadsheetId,
    item,
    mode: chosenMode(),
    maxRows: limitFromInput(),
    aiProvider: $("aiProviderSel").value,
  });
}

async function runIntrinsic(item, btn, status) {
  btn.disabled = true;
  setItemBusy(item.label, true);
  $("stopBtn").disabled = false;
  resetStopEta();
  status.className = "status";
  status.textContent = "starting...";
  send({
    type: "intrinsic",
    spreadsheetId: state.spreadsheetId,
    item,
    mode: chosenMode(),
    maxRows: limitFromInput(),
  });
}

function itemEl(label) {
  return [...document.querySelectorAll(".item")].find(
    (el) => el.querySelector(".item-label").textContent === label
  );
}

function setItemBusy(label, disabled) {
  const el = itemEl(label);
  if (el) el.querySelectorAll("button").forEach((b) => (b.disabled = disabled));
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
  send({ type: "init", spreadsheetId });
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
  port.onDisconnect.addListener(() => {
    port = null;
  });
  port.onMessage.addListener(onBgMessage);

  $("loginBtn").addEventListener("click", () => {
    const email = $("loginEmail").value.trim();
    const password = $("loginPass").value;
    if (!email || !password) return setLoginState({ error: "Enter email and password." });
    $("loginBtn").disabled = true;
    $("loginState").textContent = "Logging in…";
    send({
      type: "login",
      email,
      password,
      remember: $("rememberChk").checked,
    });
  });

  $("loadBtn").addEventListener("click", () => {
    loadSheet(extractSheetId($("sheetId").value));
  });

  $("stopBtn").addEventListener("click", () => {
    $("stopBtn").disabled = true;
    send({ type: "stop" });
  });

  $("scrapeAllBtn").addEventListener("click", async () => {
    if (
      chosenMode() === "replace" &&
      !(await modalConfirm({
        title: "Scrape All (Replace)?",
        message: `Replace mode will clear existing data in every listed tab: ${state.settings.items.map((i) => i.label).join(", ") || "none"}. Continue?`,
        okLabel: "Replace All",
      }))
    ) {
      return;
    }
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
          if (
            (m.type === "complete" && m.result.tabName === item.label) ||
            m.type === "error" ||
            m.type === "stopped"
          ) {
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
  $("aiProviderSel").addEventListener("change", (e) => {
    chrome.storage.sync.set({ aiProvider: e.target.value }).catch(() => {});
  });

  $("refreshBtn").addEventListener("click", async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id != null) {
        await chrome.tabs.reload(tab.id);
        log("Reloading current page...");
      } else {
        log("No active tab to reload.", "error");
      }
    } catch (err) {
      log("Refresh failed: " + err.message, "error");
    }
  });
  $("refreshBtn2").addEventListener("click", () => $("refreshBtn").click());

  (async () => {
    const saved = await chrome.storage.local.get(["screenerEmail", "screenerRemember"]);
    if (saved.screenerEmail) $("loginEmail").value = saved.screenerEmail;
    $("rememberChk").checked = !!saved.screenerRemember;
    const prov = await chrome.storage.sync.get("aiProvider");
    $("aiProviderSel").value = prov.aiProvider === "deepseek" ? "deepseek" : "chatgpt";
    send({ type: "login_check" });
    const active = await activeTabSheetId();
    const initial = active || extractSheetId(DEFAULT_SHEET);
    $("sheetId").value = active ? "" : DEFAULT_SHEET;
    loadSheet(initial);
  })();
}

document.addEventListener("DOMContentLoaded", init);
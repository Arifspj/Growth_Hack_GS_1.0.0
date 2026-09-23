(() => {
  if (window.__screenerSheetsContent) return;
  window.__screenerSheetsContent = true;

  const SCREENER_BASE = "https://www.screener.in";
  const DEFAULT_SHEET = "1QQf-c4GbdAxAWHCzUQkTLWUH85Tm-u1XN7yN0pem-H4";

  // ---------- request handlers (any page, incl. screener.in) ----------
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === "fetch_page") {
      fetch(msg.url, { credentials: "same-origin" })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status} for ${msg.url}`);
          return r.text();
        })
        .then((html) => sendResponse({ html }))
        .catch((e) => sendResponse({ error: e.message || String(e) }));
      return true;
    }
    if (msg.type === "goto") {
      const target = String(msg.url || "").split("#")[0];
      if (location.href.split("#")[0] !== target) location.href = target;
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "extract_page") {
      // Snapshot the fully-rendered page (includes the logged-in custom-ratio list).
      try {
        sendResponse({ html: document.documentElement.outerHTML, href: location.href });
      } catch (e) {
        sendResponse({ error: e.message || String(e), href: location.href });
      }
      return false;
    }
    if (msg.type === "ping") {
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "check_login") {
      fetch(`${SCREENER_BASE}/login/?`, { credentials: "same-origin", redirect: "manual" })
        .then(async (r) => {
          const s = r.status;
          const body = s === 302 || s === 0 ? "" : await r.text();
          const loggedIn = s === 302 || s === 0 || !/name="password"/.test(body);
          sendResponse({ loggedIn, message: loggedIn ? "Logged in." : "Not logged in." });
        })
        .catch((e) => sendResponse({ loggedIn: false, error: e.message || String(e) }));
      return true;
    }
    if (msg.type === "login") {
      loginToScreener(msg.email, msg.password)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, loggedIn: false, error: e.message || String(e) }));
      return true;
    }
    return false;
  });

  async function loginToScreener(email, password) {
    const getLogin = await fetch(`${SCREENER_BASE}/login/?`, { credentials: "same-origin" });
    const html = await getLogin.text();
    if (!/name="password"/.test(html)) {
      return { ok: true, loggedIn: true, message: "Already logged in." };
    }
    const token = (html.match(/name="csrfmiddlewaretoken" value="([^"]+)"/) || [])[1];
    if (!token) throw new Error("Could not find CSRF token on the login page.");
    await fetch(`${SCREENER_BASE}/login/`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${SCREENER_BASE}/login/?`,
      },
      body: new URLSearchParams({
        csrfmiddlewaretoken: token,
        username: email,
        password,
        next: "",
      }).toString(),
    });
    const check = await fetch(`${SCREENER_BASE}/login/?`, {
      credentials: "same-origin",
      redirect: "manual",
    });
    const s = check.status;
    const body = s === 302 || s === 0 ? "" : await check.text();
    const loggedIn = s === 302 || s === 0 || !/name="password"/.test(body);
    return { ok: true, loggedIn, message: loggedIn ? "Logged in." : "Login failed — check email/password." };
  }

  if (!location.hostname.endsWith("docs.google.com")) return;

  // Only run on the configured sheet (the "added link"); skip every other document.
  const curSheet = (location.href.match(/\/spreadsheets\/d\/([a-zA-Z0-9\-_]+)/) || [])[1];
  if (!curSheet || curSheet !== DEFAULT_SHEET) return;

  // ---------- floating widget ----------
  const st = { settings: null, spreadsheetId: null, port: null, pinned: false };

  const host = document.createElement("div");
  host.id = "screener-sheets-fab";
  const root = host.attachShadow({ mode: "open" });
  document.body.appendChild(host);

  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  root.innerHTML = `
<style>
  :host { all: initial; }
  *, *::before, *::after { box-sizing: border-box; font-family: "Google Sans", "Segoe UI", Roboto, Arial, sans-serif; }
  .wrap { position: fixed; right: 20px; bottom: 20px; z-index: 2147483647; display: flex; flex-direction: column; align-items: flex-end; gap: 12px; font-size: 12.5px; color: #1f2937; }
  .fab { width: 52px; height: 52px; border-radius: 50%; background: radial-gradient(120% 120% at 20% 15%, #34d399 0%, #10b981 40%, #059669 100%); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 800; cursor: pointer; box-shadow: 0 6px 18px rgba(5, 150, 105, .45), 0 2px 6px rgba(0, 0, 0, .12); user-select: none; border: none; transition: transform .15s ease, box-shadow .15s ease; }
  .fab:hover { transform: translateY(-2px) scale(1.04); box-shadow: 0 10px 24px rgba(5, 150, 105, .5), 0 3px 8px rgba(0, 0, 0, .15); }
  .fab:active { transform: scale(.96); }
  .panel { width: 372px; max-height: calc(100vh - 96px); overflow: auto; background: #fff; border: 1px solid rgba(15, 23, 42, .08); border-radius: 16px; box-shadow: 0 24px 60px rgba(2, 6, 23, .22), 0 8px 24px rgba(2, 6, 23, .12); display: none; color: #1f2937; }
  .panel.open { display: block; animation: panelIn .18s ease-out; }
  @keyframes panelIn { from { opacity: 0; transform: translateY(8px) scale(.98); } to { opacity: 1; transform: none; } }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px; background: linear-gradient(135deg, #0d8a5f, #067a53); color: #fff; border-radius: 16px 16px 0 0; }
  .t { font-weight: 700; font-size: 13.5px; display: flex; align-items: center; gap: 8px; letter-spacing: .2px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #6ee7b7; box-shadow: 0 0 10px rgba(110, 231, 183, .9); display: inline-block; animation: pulse 2.4s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
  .sheetMeta { opacity: .85; font-weight: 500; }
  .winbtn { display: flex; gap: 6px; }
  .winbtn button { width: 26px; height: 26px; border: none; border-radius: 8px; background: rgba(255, 255, 255, .16); color: #fff; cursor: pointer; font-size: 13px; line-height: 1; display: flex; align-items: center; justify-content: center; transition: background .12s ease, transform .12s ease; }
  .winbtn button:hover { background: rgba(255, 255, 255, .3); transform: scale(1.08); }
  .sec { padding: 12px 14px; border-bottom: 1px solid #eef1f4; }
  .acc-head { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px; background: #f6f8fa; border: none; border-bottom: 1px solid #eef1f4; cursor: pointer; text-align: left; font-family: inherit; }
  .acc-head span { font-weight: 700; font-size: 11.5px; color: #374151; text-transform: uppercase; letter-spacing: .4px; }
  .acc-head .chev { font-size: 11px; color: #6b7280; transition: transform .15s ease; }
  .acc.open .acc-head .chev { transform: rotate(90deg); }
  .acc-body { display: none; }
  .acc.open .acc-body { display: block; }
  .muted { color: #6b7280; font-size: 11px; }
  .row { display: flex; align-items: center; gap: 8px; }
  .between { justify-content: space-between; }
  .col { flex-direction: column; align-items: stretch; }
  label { font-weight: 600; font-size: 11px; color: #374151; display: block; margin: 8px 0 4px; text-transform: uppercase; letter-spacing: .5px; }
  input[type=text], input[type=email], input[type=password] { padding: 8px 10px; border: 1.5px solid #e2e8f0; border-radius: 10px; font-size: 12.5px; width: 100%; background: #fbfcfd; transition: border-color .15s, box-shadow .15s, background .15s; font-family: inherit; }
  input:focus { outline: none; border-color: #10b981; background: #fff; box-shadow: 0 0 0 3px rgba(16, 185, 129, .15); }
  input[type=number] { width: 64px; padding: 7px 8px; border: 1.5px solid #e2e8f0; border-radius: 9px; font-size: 12.5px; background: #fbfcfd; }
  .chk { display: flex; align-items: center; gap: 5px; font-weight: 500; white-space: nowrap; font-size: 12px; color: #374151; }
  .chk input { width: auto; accent-color: #10b981; }
  .chk label { text-transform: none; letter-spacing: normal; margin: 0; }
  button.btn { padding: 7px 14px; border: 1px solid #e2e8f0; border-radius: 10px; background: #fff; cursor: pointer; font-size: 12px; font-weight: 600; color: #1f2937; font-family: inherit; transition: background .12s ease, transform .12s ease, box-shadow .12s ease, border-color .12s ease; }
  button.btn:hover:not(:disabled) { background: #f1f5f9; border-color: #cbd5e1; transform: translateY(-1px); }
  button.btn:active:not(:disabled) { transform: translateY(0) scale(.97); }
  button.btn.primary { background: linear-gradient(135deg, #10b981, #059669); border: none; color: #fff; box-shadow: 0 2px 8px rgba(5, 150, 105, .35); }
  button.btn.ai { background: linear-gradient(135deg, #6366f1, #4f46e5); border: none; color: #fff; box-shadow: 0 2px 8px rgba(79, 70, 229, .35); }
  button.btn.ai:hover:not(:disabled) { filter: brightness(1.08); background: linear-gradient(135deg, #6366f1, #4f46e5); }
  button.btn.primary:hover:not(:disabled) { filter: brightness(1.06); background: linear-gradient(135deg, #10b981, #059669); }
  button.btn:disabled { opacity: .55; cursor: not-allowed; box-shadow: none; }
  .seg { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; background: #f6f8fa; border-top: 1px solid #eef1f4; border-bottom: 1px solid #eef1f4; }
  .list { max-height: 260px; overflow: auto; padding: 6px 0; }
  .item { display: flex; align-items: center; gap: 8px; padding: 8px 14px; transition: background .12s ease; }
  .item:hover { background: #f4faf7; }
  .item + .item { border-top: 1px solid #f1f3f5; }
  .item-label { font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .item button { flex: 0 0 auto; }
  .item .btn { padding: 5px 10px; font-size: 11.5px; border-radius: 8px; }
  .status { font-size: 11px; color: #6b7280; max-width: 66px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; background: #f1f3f5; border-radius: 999px; padding: 2px 8px; text-align: center; }
  .status.done { background: #e6f7ef; color: #067a53; }
  .status.err { background: #fdecec; color: #dc2626; }
  .log { max-height: 130px; overflow: auto; font-family: "Cascadia Code", Consolas, Menlo, monospace; font-size: 10.5px; line-height: 1.5; color: #475569; white-space: pre-wrap; margin: 6px 0 0; background: #fafbfc; border: 1px solid #eef1f4; border-radius: 10px; padding: 8px 10px; }
  .log div { padding: 1px 0; }
  .log .err { color: #dc2626; }
  .empty { color: #94a3b8; font-size: 12px; padding: 12px 14px; }
  .list::-webkit-scrollbar, .log::-webkit-scrollbar, .panel::-webkit-scrollbar { width: 8px; height: 8px; }
  .list::-webkit-scrollbar-thumb, .log::-webkit-scrollbar-thumb { background: #d7dce2; border-radius: 999px; }
  .list::-webkit-scrollbar-thumb:hover { background: #c3cad2; }
</style>
<div class="wrap">
  <div class="panel" id="panel">
    <div class="head">
      <span class="t"><span class="dot"></span>Growth Hack GS AI <span class="sheetMeta" id="sheetInfo"></span></span>
      <span class="winbtn">
        <button id="refreshBtn" title="Reload this sheet">&#10227;</button>
        <button id="mini" title="Minimize">&#8211;</button>
        <button id="maxi" title="Maximize">&#128470;</button>
      </span>
    </div>
    <div class="diag" id="diag" style="display:none;font-size:10px;color:#b45309;background:#fef3c7;border-bottom:1px solid #fcd34d;padding:5px 14px"></div>
    <div class="acc open" id="accSheet">
      <button class="acc-head" type="button">Google Sheet URL or ID <span class="chev">&#9654;</span></button>
      <div class="acc-body">
        <div class="sec" style="border-bottom:none">
          <label for="sheetId">Google Sheet URL or ID</label>
          <div class="row">
            <input id="sheetId" type="text" placeholder="https://docs.google.com/spreadsheets/d/...">
            <button class="btn" id="loadBtn">Load</button>
          </div>
        </div>
      </div>
    </div>
    <div class="acc" id="accLogin">
      <button class="acc-head" type="button">Screener login (for Results &amp; Full-text search) <span class="chev">&#9654;</span></button>
      <div class="acc-body">
        <div class="sec" style="border-bottom:none">
          <input id="loginEmail" type="email" placeholder="screener email" autocomplete="username">
          <input id="loginPass" type="password" placeholder="screener password" autocomplete="current-password" style="margin-top:6px">
          <div class="row between" style="margin-top:8px">
            <label class="chk" style="margin:0"><input type="checkbox" id="rememberChk"> Remember</label>
            <button class="btn primary" id="loginBtn">Login to Screener</button>
          </div>
          <div class="muted" id="loginState">Checking login…</div>
        </div>
      </div>
    </div>
    <div class="sec">
      <div class="row between">
        <span class="chk"><label style="margin:0 6px 0 0">Pages (0=all):</label><input type="number" id="maxPages" value="0" min="0" max="500"></span>
        <span class="chk"><label style="margin:0 6px 0 0">AI Rows (0=all):</label><input type="number" id="maxAiRows" value="25" min="0" max="1000"></span>
      </div>
      <div class="row" style="gap:8px;margin-top:8px">
        <button class="btn" id="stopBtn" disabled style="flex:1">Stop</button>
        <button class="btn primary" id="scrapeAllBtn" disabled style="flex:2">Scrape All</button>
      </div>
    </div>
    <div class="muted" style="margin:4px 14px 10px">AI button adds the AI columns (Summary, Linked Companies, Big Orders, Catalysts, Risks), then runs the first N rows through ChatGPT (web search ON) and fills each column per row.</div>
    <div class="seg">
      <span class="chk"><input type="checkbox" id="appendChk" checked> Append (keep rows)</span>
      <span class="chk"><input type="checkbox" id="replaceChk"> Replace tab</span>
    </div>
    <div class="list" id="items"></div>
    <div class="sec" style="border-bottom:none"><div class="log" id="log"></div></div>
  </div>
  <div class="fab" id="fab" title="Growth Hack GS">⇅</div>
</div>
`;

  const panel = root.getElementById("panel");
  const fab = root.getElementById("fab");

  function openPanel() {
    panel.classList.add("open");
  }
  function closePanel() {
    if (!st.pinned) panel.classList.remove("open");
  }

  fab.addEventListener("click", () => {
    st.pinned = !st.pinned;
    if (st.pinned) openPanel();
    else closePanel();
    fab.style.outline = st.pinned ? "2px solid #1f2328" : "";
  });
  fab.addEventListener("mouseenter", openPanel);
  const wrapEl = root.querySelector(".wrap");
  let leaveTimer = null;
  const scheduleClose = () => {
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => {
      if (!panel.contains(document.activeElement)) closePanel();
    }, 700);
  };
  wrapEl.addEventListener("mouseleave", scheduleClose);
  wrapEl.addEventListener("mouseenter", () => clearTimeout(leaveTimer));
  panel.addEventListener("mouseleave", scheduleClose);

  root.getElementById("mini").addEventListener("click", () => {
    st.pinned = false;
    fab.style.outline = "";
    closePanel();
  });
  root.getElementById("maxi").addEventListener("click", openPanel);

  root.getElementById("refreshBtn").addEventListener("click", () => {
    log("Reloading this sheet…");
    location.reload();
  });

  for (const acc of root.querySelectorAll(".acc")) {
    const head = acc.querySelector(".acc-head");
    head.addEventListener("click", () => acc.classList.toggle("open"));
  }

  function log(msg, cls = "") {
    const div = document.createElement("div");
    if (cls) div.className = cls;
    div.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
    root.getElementById("log").appendChild(div);
    root.getElementById("log").scrollTop = root.getElementById("log").scrollHeight;
  }

  function renderItems() {
    const box = root.getElementById("items");
    box.innerHTML = "";
    const items = st.settings.items;
    if (!items.length) {
      box.innerHTML = '<div class="empty">No label+URL rows in Settings (Col A = label, Col B = URL).</div>';
      return;
    }
    root.getElementById("scrapeAllBtn").disabled = false;
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "item";
      const labelSpan = document.createElement("span");
      labelSpan.className = "item-label";
      labelSpan.textContent = item.label;
      labelSpan.title = item.url;
      const status = document.createElement("span");
      status.className = "status";
      status.textContent = "idle";
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.textContent = "Scrape";
      btn.title = `Scrape ${item.url}`;
      btn.addEventListener("click", () => runScrape(item, btn, status, false));
      const dbtn = document.createElement("button");
      dbtn.className = "btn";
      dbtn.textContent = "Details";
      dbtn.title = "Extract per-row details from each company's consolidated page";
      dbtn.addEventListener("click", () => runDetails(item, dbtn, status));
      const abtn = document.createElement("button");
      abtn.className = "btn ai";
      abtn.textContent = "AI";
      abtn.title = 'Run the first N rows through ChatGPT research and fill the AI Summary / Linked Companies / Big Orders / Catalysts / Risks columns';
      abtn.addEventListener("click", () => runAiResearch(item, abtn, status));
      const vTag = document.createElement("span");
      vTag.className = "verTag";
      vTag.textContent = "v1.0.9";
      vTag.style.cssText = "display:none";
      row.append(labelSpan, status, btn, dbtn, abtn, vTag);
      box.appendChild(row);
    }
    const diag = root.getElementById("diag");
    if (diag) {
      const aiBtns = [...box.querySelectorAll(".btn.ai")].length;
      diag.style.display = "block";
      diag.textContent = `v1.0.9 JS loaded | items: ${items.length} | AI buttons: ${aiBtns} | refresh: yes`;
    }
  }

function chosenMode() {
  return root.getElementById("replaceChk").checked ? "replace" : "append";
}

function pagesFromInput() {
  const v = parseInt(root.getElementById("maxPages").value, 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function runScrape(item, btn, status, fromAll) {
  const mode = chosenMode();
  if (mode === "replace" && !window.confirm(`Replace tab "${item.label}"? Existing data will be cleared.`)) {
    return;
  }
  btn.disabled = true;
  updateItemButtons(item.label, true);
  root.getElementById("stopBtn").disabled = false;
  status.className = "status";
  status.textContent = "starting…";
  st.port.postMessage({
    type: "scrape",
    spreadsheetId: st.spreadsheetId,
    item,
    mode,
    maxPages: pagesFromInput(),
  });
  void fromAll;
}

function runDetails(item, btn, status) {
  if (chosenMode() === "replace" && !window.confirm(`Replace detail columns of "${item.label}"? Existing detail values will be cleared.`)) {
    return;
  }
  btn.disabled = true;
  updateItemButtons(item.label, true);
  root.getElementById("stopBtn").disabled = false;
  status.className = "status";
  status.textContent = "starting…";
  st.port.postMessage({
    type: "scrape_details",
    spreadsheetId: st.spreadsheetId,
    item,
    mode: chosenMode(),
  });
}

function runAiResearch(item, btn, status) {
  if (chosenMode() === "replace" && !window.confirm(`Replace the previous AI data of "${item.label}"? Existing cells will be cleared.`)) {
    return;
  }
  btn.disabled = true;
  updateItemButtons(item.label, true);
  root.getElementById("stopBtn").disabled = false;
  status.className = "status";
  status.textContent = "starting…";
  const v = parseInt(root.getElementById("maxAiRows").value, 10);
  st.port.postMessage({
    type: "ai_research",
    spreadsheetId: st.spreadsheetId,
    item,
    mode: chosenMode(),
    maxRows: Number.isFinite(v) && v > 0 ? v : 0,
  });
}

function updateItemButtons(label, disabled) {
  const el = itemElByLabel(label);
  if (el) el.querySelectorAll("button").forEach((b) => (b.disabled = disabled));
}

  function loadSheet(spreadsheetId) {
    if (!spreadsheetId) return log("No Google Sheet URL/ID detected. Paste the sheet URL above.");
    st.spreadsheetId = spreadsheetId;
    root.getElementById("sheetInfo").textContent = spreadsheetId.slice(0, 12) + "…";
    log(`Loading Settings from sheet ${spreadsheetId}…`);
    st.port.postMessage({ type: "init", spreadsheetId });
  }

  function itemElByLabel(label) {
    return [...root.getElementById("items").querySelectorAll(".item")].find(
      (el) => el.querySelector(".item-label").textContent === label
    );
  }

  function connectPort() {
    st.port = chrome.runtime.connect({ name: "scrape" });
    st.port.onMessage.addListener((msg) => {
      if (msg.type === "ready") {
        st.settings = msg.settings;
        log(`Settings tab "${msg.settings.settingsSheet}" → ${msg.settings.items.length} item(s).`);
        renderItems();
      } else if (msg.type === "progress") {
        if (msg.label) {
          const el = itemElByLabel(msg.label);
          if (el) el.querySelector(".status").textContent = msg.message || "…";
        }
        log(msg.message);
      } else if (msg.type === "complete") {
        const r = msg.result;
        if (r.filled != null) {
          const what = r.ai ? "rows researched" : "rows filled";
          log(
            r.stopped
              ? `Details stopped: ${r.filled}/${r.total} ${what} in "${r.tabName}"`
              : `Details done: ${r.filled}/${r.total} ${what} in "${r.tabName}"`
          );
        } else {
          log(
            r.stopped
              ? `Stopped: ${r.written} rows into "${r.tabName}"`
              : `Done: ${r.written} rows into "${r.tabName}"${r.created ? " (tab created)" : ""}${r.skipped ? ` — ${r.skipped} duplicates skipped` : ""}`
          );
        }
        const el = itemElByLabel(r.tabName);
        if (el) {
          const stEl = el.querySelector(".status");
          stEl.className = "status" + (r.stopped ? "" : " done");
          stEl.textContent =
            (r.stopped ? "stopped " : "") +
            (r.filled != null && r.ai ? `${r.filled} rows researched` : r.filled != null ? `${r.filled} rows filled` : `${r.written} rows`);
          el.querySelectorAll("button").forEach((b) => (b.disabled = false));
        }
        root.getElementById("stopBtn").disabled = true;
      } else if (msg.type === "stopped") {
        log("Stop requested — finishing the current row then stopping.");
      } else if (msg.type === "error") {
        log("Error: " + msg.error, "err");
        root.getElementById("items").querySelectorAll(".item button").forEach((b) => (b.disabled = false));
        root.getElementById("stopBtn").disabled = true;
        const el = itemElByLabel(msg.label);
        if (el) el.querySelector(".status").textContent = "error";
      } else if (msg.type === "login_result") {
        setLoginState(msg);
      } else if (msg.type === "login_check") {
        setLoginState(msg);
      }
    });
  }

  function setLoginState(msg) {
    const s = root.getElementById("loginState");
    if (msg.ok === false || msg.error) {
      s.textContent = msg.error || "Login failed.";
      log("Login: " + (msg.error || "failed"), "err");
      root.getElementById("loginBtn").disabled = false;
      return;
    }
    if (msg.noTab) {
      s.textContent = msg.message;
      root.getElementById("loginBtn").disabled = false;
      return;
    }
    s.textContent = msg.message || (msg.loggedIn ? "Logged in." : "Not logged in.");
    if (msg.loggedIn) {
      s.style.color = "#2e9353";
      root.getElementById("loginBtn").disabled = false;
      root.getElementById("loginBtn").textContent = "Logged in";
    } else {
      s.style.color = "#dc2626";
      root.getElementById("loginBtn").disabled = false;
      root.getElementById("loginBtn").textContent = "Login to Screener";
    }
    if (msg.created) log("Opened a Screener tab and logged in.");
  }

  root.getElementById("loadBtn").addEventListener("click", () => {
    const v = root.getElementById("sheetId").value.trim();
    const m = v.match(/\/spreadsheets\/d\/([a-zA-Z0-9\-_]+)/);
    loadSheet(m ? m[1] : /^[a-zA-Z0-9\-_]{20,}$/.test(v) ? v : null);
  });

  root.getElementById("loginBtn").addEventListener("click", () => {
    const email = root.getElementById("loginEmail").value.trim();
    const password = root.getElementById("loginPass").value;
    if (!email || !password) return setLoginState({ error: "Enter email and password." });
    root.getElementById("loginBtn").disabled = true;
    root.getElementById("loginState").textContent = "Logging in…";
    st.port.postMessage({
      type: "login",
      email,
      password,
      remember: root.getElementById("rememberChk").checked,
    });
  });

  root.getElementById("appendChk").addEventListener("change", (e) => {
    root.getElementById("replaceChk").checked = !e.target.checked;
  });
  root.getElementById("replaceChk").addEventListener("change", (e) => {
    root.getElementById("appendChk").checked = !e.target.checked;
  });

  root.getElementById("stopBtn").addEventListener("click", () => {
    root.getElementById("stopBtn").disabled = true;
    st.port.postMessage({ type: "stop" });
  });

  root.getElementById("scrapeAllBtn").addEventListener("click", async () => {
    if (
      chosenMode() === "replace" &&
      !window.confirm(
        `Scrape All with Replace will clear existing data in every listed tab (${st.settings.items.map((i) => i.label).join(", ") || "none"}). Continue?`
      )
    ) {
      return;
    }
    root.getElementById("scrapeAllBtn").disabled = true;
    for (const item of st.settings.items) {
      const el = itemElByLabel(item.label);
      const btn = el.querySelector("button");
      const status = el.querySelector(".status");
      status.className = "status";
      btn.disabled = true;
      await new Promise((resolve) => {
        const doneCb = (m) => {
          if (
            (m.type === "complete" && m.result.tabName === item.label) ||
            m.type === "error" ||
            m.type === "stopped"
          ) {
            st.port.onMessage.removeListener(doneCb);
            resolve();
          }
        };
        st.port.onMessage.addListener(doneCb);
        runScrape(item, btn, status, true);
      });
    }
    root.getElementById("scrapeAllBtn").disabled = false;
    log("Scrape All finished.");
  });

  async function widgetInit() {
    connectPort();
    const saved = await chrome.storage.local.get(["screenerEmail", "screenerRemember"]);
    if (saved.screenerEmail) root.getElementById("loginEmail").value = saved.screenerEmail;
    root.getElementById("rememberChk").checked = !!saved.screenerRemember;
    st.port.postMessage({ type: "login_check" });
    const m = location.href.match(/\/spreadsheets\/d\/([a-zA-Z0-9\-_]+)/);
    const sheet = m ? m[1] : DEFAULT_SHEET;
    root.getElementById("sheetId").value = m ? "" : DEFAULT_SHEET;
    loadSheet(sheet);
  }

  widgetInit();
})();
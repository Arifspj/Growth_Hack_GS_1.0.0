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
  * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  .wrap { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
  .fab { width: 46px; height: 46px; border-radius: 50%; background: #2e9353; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 22px; font-weight: 700; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,.35); user-select: none; }
  .fab:hover { background: #267a45; }
  .panel { width: 340px; max-height: calc(100vh - 90px); overflow: auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.28); display: none; font-size: 12px; color: #1f2328; }
  .panel.open { display: block; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #f0f1f3; background: #f7f8fa; border-radius: 10px 10px 0 0; }
  .t { font-weight: 700; font-size: 13px; display: flex; align-items: center; gap: 6px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #2e9353; display: inline-block; }
  .winbtn { display: flex; gap: 4px; }
  .winbtn button { width: 22px; height: 22px; border: 1px solid #d1d5db; border-radius: 5px; background: #fff; cursor: pointer; font-size: 12px; line-height: 1; color: #374151; }
  .winbtn button:hover { background: #f3f4f6; }
  .sec { padding: 10px 12px; border-bottom: 1px solid #f0f1f3; }
  .muted { color: #6b7280; font-size: 11px; }
  .row { display: flex; align-items: center; gap: 8px; }
  .between { justify-content: space-between; }
  .col { flex-direction: column; align-items: stretch; }
  label { font-weight: 600; font-size: 11px; color: #374151; display: block; margin: 6px 0 4px; }
  input { padding: 5px 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 12px; width: 100%; }
  input[type=number] { width: 58px; }
  .chk { display: flex; align-items: center; gap: 4px; font-weight: 400; white-space: nowrap; }
  .chk input { width: auto; }
  button.btn { padding: 6px 12px; border: 1px solid #d1d5db; border-radius: 6px; background: #fff; cursor: pointer; font-size: 12px; font-weight: 600; }
  button.btn:hover:not(:disabled) { background: #f3f4f6; }
  button.btn.primary { background: #2e9353; border-color: #2e9353; color: #fff; }
  button.btn.primary:hover:not(:disabled) { background: #267a45; }
  button.btn:disabled { opacity: .5; cursor: not-allowed; }
  .list { max-height: 240px; overflow: auto; }
  .item { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid #f0f1f3; }
  .item:last-child { border-bottom: none; }
  .item-label { font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .item button { flex: 0 0 auto; }
  .status { font-size: 11px; color: #6b7280; max-width: 70px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .status.done { color: #2e9353; }
  .status.err { color: #dc2626; }
  .log { max-height: 110px; overflow: auto; font-family: Consolas, monospace; font-size: 11px; color: #374151; white-space: pre-wrap; margin: 4px 0 0; border-top: 1px dashed #eee; padding-top: 6px; }
  .log div { padding: 1px 0; }
  .empty { color: #9ca3af; font-size: 12px; padding: 10px 12px; }
</style>
<div class="wrap">
  <div class="panel" id="panel">
    <div class="head">
      <span class="t"><span class="dot"></span>Growth Hack GS <span class="muted" id="sheetInfo"></span></span>
      <span class="winbtn">
        <button id="mini" title="Minimize">&#8211;</button>
        <button id="maxi" title="Maximize">&#128470;</button>
      </span>
    </div>
    <div class="sec">
      <label for="sheetId">Google Sheet URL or ID</label>
      <div class="row">
        <input id="sheetId" type="text" placeholder="https://docs.google.com/spreadsheets/d/...">
        <button class="btn" id="loadBtn">Load</button>
      </div>
    </div>
    <div class="sec">
      <label for="loginEmail">Screener login (needed for Results &amp; Full-text search)</label>
      <input id="loginEmail" type="email" placeholder="screener email" autocomplete="username">
      <input id="loginPass" type="password" placeholder="screener password" autocomplete="current-password" style="margin-top:6px">
      <div class="row between" style="margin-top:8px">
        <label class="chk" style="margin:0"><input type="checkbox" id="rememberChk"> Remember</label>
        <button class="btn primary" id="loginBtn">Login to Screener</button>
      </div>
      <div class="muted" id="loginState">Checking login…</div>
    </div>
    <div class="sec row between">
      <span class="chk"><label style="margin:0 6px 0 0">Pages (0=all):</label><input type="number" id="maxPages" value="0" min="0" max="500"></span>
      <button class="btn primary" id="scrapeAllBtn" disabled>Scrape All</button>
    </div>
    <div class="head" style="border-top:1px solid #f0f1f3; border-bottom:1px solid #f0f1f3; background:#f7f8fa; justify-content:flex-start; gap:12px">
      <span class="chk"><input type="checkbox" id="appendChk"> Append (keep rows)</span>
      <span class="chk"><input type="checkbox" id="replaceChk" checked> Replace tab</span>
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
      row.append(labelSpan, status, btn);
      box.appendChild(row);
    }
  }

  function chosenMode() {
    return root.getElementById("replaceChk").checked ? "replace" : "append";
  }

  function runScrape(item, btn, status, fromAll) {
    btn.disabled = true;
    status.className = "status";
    status.textContent = "starting…";
    st.port.postMessage({
      type: "scrape",
      spreadsheetId: st.spreadsheetId,
      item,
      mode: chosenMode(),
      maxPages: parseInt(root.getElementById("maxPages").value || "1", 10),
    });
    void fromAll;
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
        log(
          `Done: ${r.written} rows into "${r.tabName}"${r.created ? " (tab created)" : ""}${r.skipped ? ` — ${r.skipped} duplicates skipped` : ""}`
        );
        const el = itemElByLabel(r.tabName);
        if (el) {
          const stEl = el.querySelector(".status");
          stEl.className = "status done";
          stEl.textContent = `${r.written} rows ✓`;
          el.querySelector("button").disabled = false;
        }
      } else if (msg.type === "error") {
        log("Error: " + msg.error, "err");
        root.getElementById("items").querySelectorAll(".item button").forEach((b) => (b.disabled = false));
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

  root.getElementById("scrapeAllBtn").addEventListener("click", async () => {
    root.getElementById("scrapeAllBtn").disabled = true;
    for (const item of st.settings.items) {
      const el = itemElByLabel(item.label);
      const btn = el.querySelector("button");
      const status = el.querySelector(".status");
      status.className = "status";
      btn.disabled = true;
      await new Promise((resolve) => {
        const doneCb = (m) => {
          if ((m.type === "complete" && m.result.tabName === item.label) || m.type === "error") {
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
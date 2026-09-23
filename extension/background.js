const enc = new TextEncoder();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let credsCache = null;
let tokenCache = { token: null, expiresAt: 0 };
let stopRequested = false;
let activeAbort = null;
let gptTabId = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cancelScrape() {
  stopRequested = true;
  if (activeAbort) {
    try {
      activeAbort.abort();
    } catch {}
  }
  if (gptTabId != null) {
    try {
      chrome.tabs.sendMessage(gptTabId, { action: "__gptAbort" }).catch(() => {});
    } catch {}
  }
}

async function loadCredentials() {
  if (!credsCache) {
    const res = await fetch(chrome.runtime.getURL("service_account.json"));
    if (!res.ok) throw new Error("Cannot load service_account.json from extension");
    credsCache = await res.json();
  }
  return credsCache;
}

function b64url(bytes) {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importRsaPrivateKey(pem) {
  const raw = String(pem)
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function getAccessToken() {
  const creds = await loadCredentials();
  const scope = "https://www.googleapis.com/auth/spreadsheets";
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claim = b64url(
    enc.encode(
      JSON.stringify({
        iss: creds.client_email,
        scope,
        aud: creds.token_uri,
        iat: now,
        exp: now + 3600,
      })
    )
  );
  const signingInput = `${header}.${claim}`;
  const key = await importRsaPrivateKey(creds.private_key);
  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    enc.encode(signingInput)
  );
  const assertion = `${signingInput}.${b64url(sig)}`;

  const res = await fetch(creds.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Google auth failed (${res.status}): ${JSON.stringify(data)}`);
  }
  tokenCache = { token: data.access_token, expiresAt: Date.now() + 3600 * 1000 };
  return data.access_token;
}

async function accessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60 * 1000) {
    return tokenCache.token;
  }
  return getAccessToken();
}

async function sheetsJson(path, { method = "GET", body } = {}) {
  const token = await accessToken();
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) throw new Error(`Sheets ${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const qr = (r) => encodeURIComponent(r);

async function getValues(spreadsheetId, range) {
  const data = await sheetsJson(`${spreadsheetId}/values/${qr(range)}`);
  return data.values || [];
}

async function updateValues(spreadsheetId, range, values) {
  return sheetsJson(
    `${spreadsheetId}/values/${qr(range)}?valueInputOption=RAW`,
    { method: "PUT", body: { range, majorDimension: "ROWS", values } }
  );
}

async function clearValues(spreadsheetId, range) {
  return sheetsJson(`${spreadsheetId}/values/${qr(range)}:clear`, { method: "POST", body: { range } });
}

// Current grid size (rows x cols) of a tab, so clear/write ranges never exceed
// the sheet's actual grid (clear fails with 400 "exceeds grid limits" otherwise).
async function getSheetGridInfo(spreadsheetId, tabName) {
  const meta = await getSpreadsheetMeta(spreadsheetId);
  const sheet = (meta.sheets || []).find(
    (s) => s.properties.title.toLowerCase() === String(tabName).toLowerCase()
  );
  if (!sheet) throw new Error(`Sheet "${tabName}" not found`);
  const gp = sheet.properties.gridProperties || { rowCount: 1, columnCount: 1 };
  return {
    sheetId: sheet.properties.sheetId,
    rowCount: Math.max(1, gp.rowCount || 1),
    columnCount: Math.max(1, gp.columnCount || 1),
  };
}

// Grow a tab's grid to the needed rows/columns (if already big enough, no-op).
async function expandSheetGrid(spreadsheetId, tabName, { rows = 0, cols = 0 } = {}) {
  const g = await getSheetGridInfo(spreadsheetId, tabName);
  const rowCount = Math.max(g.rowCount, rows);
  const columnCount = Math.max(g.columnCount, cols);
  if (rowCount === g.rowCount && columnCount === g.columnCount) return g;
  await sheetsJson(`${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: {
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId: g.sheetId, gridProperties: { rowCount, columnCount } },
            fields: "gridProperties.rowCount,gridProperties.columnCount",
          },
        },
      ],
    },
  });
  return { sheetId: g.sheetId, rowCount, columnCount };
}

async function getSpreadsheetMeta(spreadsheetId) {
  return sheetsJson(`${spreadsheetId}`);
}

async function addSheet(spreadsheetId, title) {
  return sheetsJson(`${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: {
      requests: [
        {
          addSheet: {
            properties: { title, gridProperties: { rowCount: 5000, columnCount: 20 } },
          },
        },
      ],
    },
  });
}

function cellText(html, arrows = false) {
  let text = String(html || "");
  // For cells with a .change span (e.g. Net profit YoY with an inline tooltip),
  // keep only the visible value: <span class="change down">⇣ 1043%</span>
  const changeM = text.match(/<span class="change\s+[^"]*">([\s\S]*?)<\/span>/i);
  if (changeM) text = changeM[1];
  text = text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"');
  text = text.replace(/\s+/g, " ").trim();
  if (arrows) text = text.replace(/⇡/g, "+").replace(/⇣/g, "-");
  // normalize numbers: drop the ₹ symbol, a leading +, and spacing after a - sign
  text = text.replace(/₹/g, "").replace(/^\+/, "").trim().replace(/^-\s+/, "-");
  return text;
}

function firstHref(cellHtml) {
  const m = String(cellHtml || "").match(/href="([^"]+)"/i);
  return m ? m[1] : "";
}

function splitCells(rowHtml) {
  const out = [];
  const re = /<th\b[^>]*>([\s\S]*?)<\/th>|<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = re.exec(rowHtml))) out.push(m[1] || m[2] || "");
  return out;
}

function parseTables(html) {
  const tables = [];
  const tableRe = /<table\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = tableRe.exec(html))) {
    const body = m[2];
    const thead = body.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i);
    const tbody = body.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i);
    let headers = thead ? splitCells(thead[1]).map((c) => cellText(c)) : [];
    const tbodyHtml = tbody ? tbody[1] : body;
    const rows = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(tbodyHtml))) {
      const rowHtml = rm[1];
      const cellsRaw = splitCells(rowHtml);
      if (!cellsRaw.length) continue;
      const firstTd = rowHtml.match(/<td\b[^>]*>([\s\S]*?)<\/td>/i);
      const href = firstTd ? firstHref(firstTd[1]) : "";
      // Screener keeps the actual company URL on the Company cell (the 2nd column),
      // NOT on the leading S.No cell — so remember every cell's first href.
      const links = cellsRaw.map((c) => firstHref(c));
      rows.push({
        href,
        plain: cellsRaw.map((c) => cellText(c)),
        arrows: cellsRaw.map((c) => cellText(c, true)),
        links,
      });
    }
    if (!headers.length && rows.length) {
      headers = rows.shift().plain;
    }
    tables.push({ class: m[1], headers, rows });
  }
  return tables;
}

function pickMainTable(tables) {
  if (!tables.length) return null;
  return tables.reduce((a, b) => (b.rows.length > a.rows.length ? b : a), tables[0]);
}

function makeAbsolute(baseUrl, href) {
  if (!href) return "";
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith("//")) return `https:${href}`;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}

async function directFetch(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
  });
  if (!res.ok) throw new Error(`Screener fetch ${url} -> HTTP ${res.status}`);
  return res.text();
}

async function fetchWithRetry(url, { retries = 2, baseDelay = 1000, timeoutMs = 12000 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    activeAbort = controller;
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
      });
      if (res.status === 429) {
        const ra = parseInt(res.headers.get("retry-after") || "5", 10);
        const delay = Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 6000, 6000);
        clearTimeout(t);
        lastErr = new Error(`HTTP 429 (rate limited) for ${url}`);
        if (stopRequested) break;
        await sleep(delay);
        continue;
      }
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      clearTimeout(t);
      if (e && e.name === "AbortError" && !stopRequested) {
        lastErr = new Error(`Timed out after ${timeoutMs}ms (${url})`);
      } else {
        lastErr = e;
      }
      if (stopRequested) break;
      if (attempt < retries) await sleep(baseDelay * (attempt + 1));
    } finally {
      if (activeAbort === controller) activeAbort = null;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Failed to fetch: ${url}`);
}

// Fetch a page through a logged-in screener.in tab (shares the session). Returns null on failure.
async function fetchScreenerTabHtml(url) {
  const tabs = await chrome.tabs.query({ url: ["https://*.screener.in/*"] });
  if (!tabs.length) return null;
  const tab = tabs[0];
  try {
    let resp;
    try {
      resp = await withTimeout(chrome.tabs.sendMessage(tab.id, { type: "fetch_page", url }), 15000);
    } catch {}
    if (!resp) {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      resp = await withTimeout(chrome.tabs.sendMessage(tab.id, { type: "fetch_page", url }), 15000);
    }
    if (resp && resp.html) return resp.html;
    if (resp && resp.error) throw new Error(resp.error);
    throw new Error("Screener tab did not respond");
  } catch {
    return null;
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out")), ms)),
  ]);
}

async function fetchScreener(url) {
  // Prefer fetching through a logged-in screener.in tab (content script shares the session),
  // else a direct fetch (public pages).
  const html = await fetchScreenerTabHtml(url);
  if (html != null) return html;
  return directFetch(url);
}

let scraperOpts = { winId: null, tabId: null };

const SCRAPER_WIN_KEY = "scraperWindow";

async function loadScraperWin() {
  try {
    const st = await chrome.storage.session.get([SCRAPER_WIN_KEY]);
    const s = st && st[SCRAPER_WIN_KEY];
    if (s && Number.isFinite(s.winId) && Number.isFinite(s.tabId)) {
      scraperOpts = { winId: s.winId, tabId: s.tabId };
    }
  } catch {}
}

async function saveScraperWin() {
  try {
    await chrome.storage.session.set({ [SCRAPER_WIN_KEY]: { ...scraperOpts } });
  } catch {}
}

async function destroyScraperWindow() {
  if (scraperOpts.winId != null) {
    await chrome.windows.remove(scraperOpts.winId).catch(() => {});
    scraperOpts = { winId: null, tabId: null };
    try {
      await chrome.storage.session.remove(SCRAPER_WIN_KEY);
    } catch {}
  }
}

async function rebuildScraperWindow() {
  await destroyScraperWindow();
  return ensureScraperWindow();
}

// One hidden (minimized) Screener window reused for every company page.
async function ensureScraperWindow(url = `${SCREENER_BASE}/`) {
  await loadScraperWin();
  if (scraperOpts.winId != null) {
    const win = await chrome.windows.get(scraperOpts.winId, { populate: true }).catch(() => null);
    const tab = win && win.tabs && win.tabs[0];
    if (tab && tab.id != null && /^https?:\/\/(www\.)?screener\.in/i.test(tab.url || "")) {
      await ensureContentScriptInjected(tab.id);
      return tab;
    }
  }
  const win = await chrome.windows
    .create({ url: String(url), focused: false, state: "minimized" })
    .catch(() => null);
  if (!win || !win.tabs || !win.tabs[0]) return null;
  scraperOpts = { winId: win.id, tabId: win.tabs[0].id };
  await saveScraperWin();
  await ensureContentScriptInjected(win.tabs[0].id);
  const st = await chrome.storage.local.get(["screenerEmail", "screenerPassword"]);
  if (st.screenerEmail && st.screenerPassword) {
    await withTimeout(
      chrome.tabs
        .sendMessage(win.tabs[0].id, {
          type: "login",
          email: st.screenerEmail,
          password: st.screenerPassword,
        })
        .catch(() => null),
      20000
    ).catch(() => null);
  }
  return win.tabs[0];
}

// Navigate the hidden tab to the company page, give it at least ~3.5s to render,
// then snapshot its DOM (the exact logged-in view with the full custom-ratio list).
async function snapshotCompanyPage(url) {
  const want = String(url).split("#")[0];
  for (let rebuild = 0; rebuild < 2; rebuild++) {
    const tab = await ensureScraperWindow();
    if (!tab) return null;
    await chrome.tabs.sendMessage(tab.id, { type: "goto", url: want }).catch(() => {});
    const deadline = Date.now() + 16000;
    let first = true;
    while (Date.now() < deadline) {
      await sleep(first ? 3500 : 1200);
      first = false;
      if (stopRequested) return null;
      const resp = await withTimeout(
        chrome.tabs.sendMessage(tab.id, { type: "extract_page" }).catch(() => null),
        5000
      ).catch(() => null);
      if (
        resp &&
        resp.html &&
        resp.href &&
        String(resp.href).split("#")[0] === want &&
        resp.html.length > 20000
      ) {
        return resp.html;
      }
      if (stopRequested) return null;
    }
    await destroyScraperWindow();
  }
  return null;
}

// Detail pages render the user's full custom-ratio list only when the page is rendered
// with the logged-in session. Reading the live DOM via the hidden Screener window
// reliably captures exactly what the user sees; public fetch is the last-resort fallback.
async function fetchDetail(url) {
  const html = await snapshotCompanyPage(url);
  if (html) return { html, source: "tab-dom" };
  const pub = await fetchWithRetry(url);
  return { html: pub, source: "public" };
}

function resolveNextPagination(html, currentUrl, page) {
  const nav = decodeAmp(html).match(/class="pagination"[\s\S]*?<\/div>/i);
  if (!nav) return null;
  for (const m of nav[0].matchAll(/href="([^"]*?[?&](?:p|page)=(\d+))"/gi)) {
    const n = parseInt(m[2], 10);
    // Only treat it as "next" if it actually advances past the current page
    // (e.g. 2→3, 3→4); ignore "1", the current page, and Prev links so we
    // never bounce back to an earlier page.
    if (n <= page) continue;
    const next = makeAbsolute(currentUrl, m[1]);
    if (next.split("#")[0] === currentUrl.split("#")[0]) continue;
    return next;
  }
  return null;
}

// "class=\"paginator\"" layout: <span class="this-page">1</span> <a href="?p=2">2</a> … 4655 results
// "class=\"paginator\"" layout — Screener's raw screen paginates with ?page=N (some
// older screens use ?p=N). Read whichever appears so totalPages is always known.
function parsePaginator(html) {
  const pag = decodeAmp(html).match(/class="paginator"[\s\S]*?<\/p>/i);
  if (!pag) return null;
  const nums = [];
  for (const m of pag[0].matchAll(/[?&](?:p|page)=(\d+)/g)) nums.push(parseInt(m[1], 10));
  const totalResults = pag[0].match(/([\d,]+)\s*results/i);
  return {
    totalPages: nums.length ? Math.max(0, ...nums) : null,
    totalResults: totalResults ? totalResults[1].replace(/,/g, "") : null,
  };
}

// An "&" inside a page-link href is HTML-encoded as &amp;, which breaks any
// literal-/&/ regex. Decode it so ?page=N / ?p=N links are always seen.
function decodeAmp(html) {
  return html.replace(/&amp;/gi, "&");
}

function resolvePaginatorNext(html, currentUrl, page) {
  const pag = decodeAmp(html).match(/class="paginator"[\s\S]*?<\/p>/i);
  if (!pag) return null;
  let best = null;
  for (const m of pag[0].matchAll(/href="([^"]*?[?&](?:p|page)=(\d+))"/gi)) {
    const n = parseInt(m[2], 10);
    if (n > page && (!best || n < best.n)) best = { href: m[1], n };
  }
  return best ? makeAbsolute(currentUrl, best.href) : null;
}

// Some Screener raw screens (Undervalued, etc.) render a paginator whose
// numbered links sit outside class="paginator"/class="pagination", or use
// ?page=N instead of ?p=N. Scan the entire document so no next page is missed.
function listPageNumbers(html) {
  const nums = [];
  for (const m of decodeAmp(html).matchAll(/[?&](?:p|page)=(\d+)/g)) nums.push(parseInt(m[1], 10));
  return nums;
}

function listPageHrefs(html) {
  const out = [];
  for (const m of decodeAmp(html).matchAll(/href="([^"]*?[?&](?:p|page)=(\d+))"/gi)) {
    out.push({ href: m[1], n: parseInt(m[2], 10) });
  }
  return out;
}

function resolveNextFromAnyAnchor(html, currentUrl, page) {
  let best = null;
  for (const p of listPageHrefs(html)) {
    if (p.n > page && (!best || p.n < best.n)) best = p;
  }
  return best ? makeAbsolute(currentUrl, best.href) : null;
}

function buildPageUrl(currentUrl, n) {
  if (/[?&](?:p|page)=\d+/.test(currentUrl)) {
    return currentUrl.replace(/([?&])(?:p|page)=\d+/, `$1page=${n}`);
  }
  return currentUrl + (currentUrl.includes("?") ? "&" : "?") + `page=${n}`;
}

// Simple 0-100 scoring for results rows (bands on YoY growth + current margin).
function bandScore(pct) {
  if (pct == null || String(pct).trim() === "") return 0;
  const v = parseFloat(String(pct).replace(/,/g, "")) || 0;
  if (v >= 25) return 20;
  if (v >= 15) return 15;
  if (v >= 5) return 10;
  if (v >= 0) return 5;
  if (v >= -10) return 2;
  return 0;
}

function marginScore(netProfit, sales) {
  const s = parseFloat(String(sales).replace(/,/g, "")) || 0;
  const n = parseFloat(String(netProfit).replace(/,/g, "")) || 0;
  if (s <= 0) return 0;
  const margin = n / s;
  if (margin >= 0.15) return 20;
  if (margin >= 0.05) return 10;
  if (margin > 0) return 5;
  return 0;
}

// ── 100-point scoring (Undervalued / classic Screener screens) ──────────────
// Valuation 20 · Profit growth 15 · Sales growth 10 · ROCE 15 · OPM 10 ·
// Debt 10 · Promoter 5 · Promoter change 5 · QoQ profit 5 · 1Y return 5.
function toNum(v) {
  if (v == null || String(v).trim() === "") return NaN;
  const s = String(v).replace(/[,%]/g, "").trim();
  return s === "" ? NaN : parseFloat(s);
}

function scorePE(v) {
  const x = toNum(v);
  if (!isFinite(x) || x <= 0) return 2;
  if (x <= 8) return 20;
  if (x <= 12) return 18;
  if (x <= 16) return 16;
  if (x <= 20) return 14;
  if (x <= 30) return 10;
  if (x <= 50) return 6;
  return 2;
}

function scoreProfitGrowth(v, qoq) {
  const x = toNum(v);
  if (!isFinite(x)) return 0;
  let pts;
  if (x > 75) pts = 15;
  else if (x > 40) pts = 13;
  else if (x > 20) pts = 11;
  else if (x > 10) pts = 8;
  else if (x > 0) pts = 5;
  else pts = 0;
  // Anti-manipulation: huge YoY profit growth that is collapsing in the latest
  // quarter is usually one-off / base-effect, not durable momentum.
  const q = toNum(qoq);
  if (isFinite(q)) {
    if (q <= -50) pts = Math.min(pts, 5);
    else if (q <= -20) pts = Math.min(pts, 8);
  }
  return pts;
}

function scoreSalesGrowth(v) {
  const x = toNum(v);
  if (!isFinite(x)) return 0;
  if (x > 75) return 10;
  if (x > 40) return 9;
  if (x > 20) return 7;
  if (x > 10) return 5;
  if (x > 0) return 3;
  return 0;
}

function scoreROCE(v) {
  const x = toNum(v);
  if (!isFinite(x)) return 2;
  if (x < 10) return 2;
  if (x < 15) return 5;
  if (x < 20) return 8;
  if (x < 30) return 10;
  if (x < 50) return 13;
  return 15;
}

function scoreOPM(v, sales) {
  const x = toNum(v);
  if (!isFinite(x) || x <= 0) return 0;
  const s = toNum(sales);
  // Anomaly guard: OPM way above 100% on a tiny sales base is data distortion
  // (e.g. Shri Niwas: ₹1.47Cr sales, 736% OPM) → never hand it max points.
  const anomalous = x > 100 && isFinite(s) && s > 0 && s < 5;
  let pts = x <= 5 ? 3 : x <= 10 ? 5 : x <= 20 ? 7 : x <= 30 ? 9 : 10;
  if (anomalous) pts = Math.min(pts, 3);
  return pts;
}

function scoreDebt(debt, sales) {
  const d = toNum(debt);
  const s = toNum(sales);
  if (!isFinite(d) || d <= 0) return 10;
  if (!isFinite(s) || s <= 0) return 2;
  const ratio = (d / s) * 100;
  if (ratio <= 0) return 10;
  if (ratio <= 5) return 9;
  if (ratio <= 10) return 8;
  if (ratio <= 20) return 6;
  if (ratio <= 40) return 4;
  if (ratio <= 60) return 2;
  return 0;
}

function scorePromoter(v) {
  const x = toNum(v);
  if (!isFinite(x)) return 1;
  if (x < 20) return 1;
  if (x < 40) return 3;
  if (x < 60) return 4;
  return 5;
}

function scorePromoterChange(v) {
  const x = toNum(v);
  if (!isFinite(x) || x === 0) return 3;
  if (x < 0) return 0;
  if (x <= 2) return 4;
  return 5;
}

function scoreQoQ(v) {
  const x = toNum(v);
  if (!isFinite(x)) return 0;
  if (x > 60) return 5;
  if (x > 30) return 4;
  if (x > 10) return 3;
  if (x > 0) return 2;
  if (x > -20) return 1;
  return 0;
}

function score1Y(v) {
  const x = toNum(v);
  if (!isFinite(x)) return 0;
  if (x > 60) return 5;
  if (x > 30) return 4;
  if (x > 10) return 3;
  if (x > 0) return 2;
  return 0;
}

function computeScore100(headers, cells) {
  const idx = (re) => headers.findIndex((h) => re.test(normCellKey(h)));
  const get = (re) => {
    const i = idx(re);
    return i >= 0 ? cells[i] : "";
  };
  const pe = get(/^pe$/i);
  const pg = get(/profit.*growth|growth.*profit/i);
  const sg = get(/sales.*growth|growth.*sales/i);
  const roce = get(/roce/i);
  const opm = get(/opm/i);
  const debt = get(/^debt/i);
  const sales = get(/^salesrscr|sales.*(?!qtr)cr/i);
  const prom = get(/prom.*hold|hold.*prom/i);
  const promChg = get(/change.*prom/i);
  const qoq = get(/qtr.*profit|profit.*var/i);
  const yr1 = get(/1yr|return/i);

  let base =
    scorePE(pe) +
    scoreProfitGrowth(pg, qoq) +
    scoreSalesGrowth(sg) +
    scoreROCE(roce) +
    scoreOPM(opm, sales) +
    scoreDebt(debt, sales) +
    scorePromoter(prom) +
    scorePromoterChange(promChg) +
    scoreQoQ(qoq) +
    score1Y(yr1);

  // ── Red-flag penalties (max -20, avoid double-count with the base bands) ──
  let penalty = 0;
  const pv = toNum(pe);
  const pgv = toNum(pg);
  const sgv = toNum(sg);
  const qv = toNum(qoq);
  const dv = toNum(debt);
  const sv = toNum(sales);
  const opmv = toNum(opm);
  const curt = toNum(get(/eqshares/));
  const prevt = toNum(get(/sharespyr/));

  // Extreme / loss-making P/E: cheap is already rewarded inside scorePE; here we
  // only punish nonsense valuations (PE>100 or negative earnings).
  if (isFinite(pv) && pv > 100) penalty += 4;
  else if (isFinite(pv) && pv <= 0) penalty += 4;
  else if (isFinite(pv) && pv > 50) penalty += 2;

  // Severe profit collapse: QoQ falling hard while the latest quarter is red.
  if (isFinite(qv)) {
    if (qv <= -75) penalty += 5;
    else if (qv <= -50) penalty += 4;
    else if (qv <= -20) penalty += 2;
  }

  // Extreme debt relative to sales (₹1,164 Cr debt vs ₹1.47 Cr sales → flag).
  if (isFinite(dv) && isFinite(sv) && dv > 0 && sv > 0) {
    const debtSales = (dv / sv) * 100;
    if (debtSales > 1000) penalty += 5;
    else if (debtSales > 200) penalty += 4;
    else if (debtSales > 100) penalty += 2;
  }

  // Abnormal margin: OPM impossibly high on a tiny base.
  if (isFinite(opmv) && opmv > 100 && isFinite(sv) && sv > 0 && sv < 5) penalty += 4;

  // Growth-quality divergence: profit exploding while sales barely move.
  if (isFinite(pgv) && isFinite(sgv) && pgv > 60 && sgv > 0 && sgv < pgv / 2) penalty += 3;

  // Major dilution: outstanding shares up significantly vs previous year.
  if (isFinite(curt) && isFinite(prevt) && prevt > 0) {
    const growth = curt / prevt;
    if (growth > 1.5) penalty += 4;
    else if (growth > 1.1) penalty += 2;
  }

  let total = base - Math.min(penalty, 20);
  total = Math.round(total);
  return {
    score: Math.max(0, Math.min(100, total)),
    confidence: computeDataConfidence(headers, cells),
  };
}

// Data confidence: share of the fundamental fields that carry a real value.
function computeDataConfidence(headers, cells) {
  const needed = [
    /^pe$/i,
    /profit.*growth|growth.*profit/i,
    /sales.*growth|growth.*sales/i,
    /roce/i,
    /opm/i,
    /^debt/i,
    /^salesrscr|sales.*(?!qtr)cr/i,
    /prom.*hold|hold.*prom/i,
    /change.*prom/i,
    /qtr.*profit|profit.*var/i,
    /1yr|return/i,
  ];
  let present = 0;
  for (const re of needed) {
    const i = headers.findIndex((h) => re.test(normCellKey(h)));
    if (i >= 0 && String(cells[i] || "").trim() !== "") present++;
  }
  return Math.round((present / needed.length) * 100);
}

// Latest-quarter results: one row per company instead of one row per metric.
function flattenResultsBlocks(blocks, headers) {
  const rows = [];
  for (const b of blocks) {
    const map = {};
    for (const r of b.rows) {
      const cells = r.arrows;
      const key = String(cells[0] || "").toLowerCase().trim();
      if (!["sales", "ebidt", "net profit", "eps"].includes(key)) continue;
      map[key] = { jq: cells[2] || "", yoy: cells[1] || "" };
    }
    const score =
      bandScore(map.sales && map.sales.yoy) +
      bandScore(map.ebidt && map.ebidt.yoy) +
      bandScore(map["net profit"] && map["net profit"].yoy) +
      bandScore(map.eps && map.eps.yoy) +
      marginScore(map["net profit"] && map["net profit"].jq, map.sales && map.sales.jq);
    rows.push({
      url: b.href,
      values: [
        b.name,
        b.price,
        b.mcap,
        map.sales ? map.sales.jq : "",
        map.sales ? map.sales.yoy : "",
        map.ebidt ? map.ebidt.jq : "",
        map.ebidt ? map.ebidt.yoy : "",
        map["net profit"] ? map["net profit"].jq : "",
        map["net profit"] ? map["net profit"].yoy : "",
        map.eps ? map.eps.jq : "",
        map.eps ? map.eps.yoy : "",
        b.href,
        score,
      ].slice(0, headers.length),
    });
  }
  return rows;
}

function parseResultsBlocks(html) {
  const blocks = [];
  const re =
    /<div class="flex-row flex-space-between flex-align-center[^"]*">\s*<div>([\s\S]*?)<\/div>\s*<div class="font-size-14">([\s\S]*?)<\/div>\s*<\/div>\s*<div class="bg-base[^"]*"[^>]*>([\s\S]*?<\/table>)/gi;
  let m;
  while ((m = re.exec(html))) {
    const titleHtml = m[1] || "";
    const metaHtml = m[2] || "";
    const tableHtml = m[3] || "";
    const nameM = titleHtml.match(/<span class="hover-link ink-900">([\s\S]*?)<\/span>/);
    const hrefM = titleHtml.match(/<a href="\/company\/([^"]+)#quarters"/);
    const tbl = parseTables(tableHtml)[0];
    if (!nameM || !hrefM || !tbl || !tbl.rows.length) continue;
    const priceM = metaHtml.match(/Price\s*₹\s*<span class="strong">([\s\S]*?)<\/span>/);
    const mcapM = metaHtml.match(/M\.Cap\s*₹\s*<span class="strong">([\s\S]*?)<\/span>\s*Cr/);
    blocks.push({
      name: cellText(nameM[1]),
      href: makeAbsolute("https://www.screener.in/", `/company/${hrefM[1]}`),
      price: priceM ? cellText(priceM[1]) : "",
      mcap: mcapM ? cellText(mcapM[1]) : "",
      headers: tbl.headers,
      rows: tbl.rows,
    });
  }
  return blocks;
}

async function scrapePaged(url, maxPages, onPage, onBatch) {
  let headers = null;
  let allRows = [];
  let current = url;
  const m = current.match(/[?&](?:p|page)=(\d+)/);
  let page = m ? parseInt(m[1], 10) : 1;
  const wantAll = !maxPages || maxPages <= 0;
  const hardCap = 500;
  let totalPages = null;
  let totalResults = null;
  let sno = 0;

  for (let guard = 0; guard < hardCap; guard++) {
    if (stopRequested) break;
    if (!wantAll && page > maxPages) break;
    if (wantAll && totalPages && page > totalPages) break;

    const html = await fetchScreener(current);
    const pag = parsePaginator(html);
    if (pag) {
      totalPages = pag.totalPages;
      totalResults = pag.totalResults;
    }
    // Fallback for raw screens whose paginator div isn't recognised: derive the
    // page count from every numbered page anchor present in the document.
    if (!totalPages) {
      const nums = listPageNumbers(html);
      if (nums.length) {
        totalPages = Math.max(0, ...nums);
        if (totalResults == null) {
          const r = html.match(/([\d,]+)\s*results/i);
          if (r) totalResults = r[1].replace(/,/g, "");
        }
      }
    }

    const pageRows = [];
    const blocks = parseResultsBlocks(html);
    if (blocks.length) {
      // "Latest quarterly results" layout.
      if (!headers) {
        headers = [
          "S.No",
          "Company",
          "Price",
          "M.Cap (Cr)",
          "Sales (JQ)",
          "Sales YoY",
          "EBIDT (JQ)",
          "EBIDT YoY",
          "Net Profit (JQ)",
          "Net Profit YoY",
          "EPS (JQ)",
          "EPS YoY",
          "Link",
          "Score (0-100)",
        ];
      }
      const flat = flattenResultsBlocks(blocks, headers);
      for (const r of flat) r.values.unshift(++sno);
      pageRows.push(...flat);
    } else {
      const main = pickMainTable(parseTables(html));
      if (main && main.rows.length) {
        if (!headers) headers = main.headers.map((h) => h || `(col)`);
        // Screener re-prints the column header (S.No, Company, CMP Rs., …) every ~25 rows.
        // Skip any row whose (normalized) cells match that header so it never lands in the sheet.
        const normKeys = headers.map((h) => normCellKey(h)).filter(Boolean);
        let linkIdx = headers.findIndex((h) => /^link$/i.test(normCellKey(h)));
        const companyIdx = headers.findIndex((h) => /company/i.test(normCellKey(h)));
        // Classic Screener screens (Undervalued, High Growth, …) declare neither a Link
        // nor a Score column, so guarantee both are always present (Link last-free url).
        let scoreIdx = headers.findIndex((h) => /score/i.test(normCellKey(h)));
        if (linkIdx < 0) { headers.push("Link"); linkIdx = headers.length - 1; }
        if (scoreIdx < 0) { headers.push("Score (0-100)"); scoreIdx = headers.length - 1; }
        for (const r of main.rows) {
          const cells = (r.arrows || []).slice();
          const sig = cells.slice(0, Math.max(normKeys.length, 2)).map((c) => normCellKey(c)).join("|");
          if (normKeys.length && sig === normKeys.join("|")) continue;
          const values = cells.slice(0, headers.length);
          while (values.length < headers.length) values.push("");
          // Company URL lives in the Company column — grab it from that cell's own link.
          const rowHref = r.links && r.links.length ? r.links[companyIdx] || r.links.find(Boolean) || r.href : r.href;
          values[linkIdx] = makeAbsolute(current, rowHref) || values[linkIdx];
          values[scoreIdx] = computeScore100(headers, values).score;
          pageRows.push({ url: makeAbsolute(current, rowHref), values });
        }
      }
    }

    if (onPage) onPage({ page, pageUrl: current, totalPages, totalResults });
    if (onBatch) {
      await onBatch({
        headers: headers || [],
        rows: pageRows,
        page,
        pageUrl: current,
        totalPages,
        totalResults,
      });
    }
    allRows.push(...pageRows);
    if (!pageRows.length) break;
    await sleep(600); // pace page requests to respect Screener rate limits

    // Prefer the numbered paginator (results page), else the Next-link layout.
    let next = pag
      ? resolvePaginatorNext(html, current, page)
      : resolveNextPagination(html, current, page);
    // Raw screens whose paginator links aren't wrapped in the known divs: scan
    // the whole page for any numbered page anchor (?page=N / ?p=N) beyond this.
    if (!next) next = resolveNextFromAnyAnchor(html, current, page);
    // Safety net: walk to the sequentially next page. Stops automatically when a
    // page returns no rows (Screener serves an empty list past the last page).
    if (!next && page + 1 <= (totalPages || 1e6)) {
      next = buildPageUrl(current, page + 1);
    }
    if (!next) break;
    if (next.split("#")[0] === current.split("#")[0]) break;
    current = next;
    page++;
    if (wantAll && totalPages && page > totalPages) break;
  }

  return { headers: headers || [], rows: allRows, totalPages, totalResults, endPage: page };
}

function dedupeRows(rows, idx = 0) {
  const seen = new Set();
  return rows.filter((r) => {
    const k = `${r.values[idx]}|${r.url}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function columnLetter(n) {
  let s = "";
  n -= 1;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

async function ensureWorksheet(spreadsheetId, title) {
  const meta = await getSpreadsheetMeta(spreadsheetId);
  let found = meta.sheets.find(
    (s) => s.properties.title.toLowerCase() === String(title).toLowerCase()
  );
  if (found) return { sheet: found, created: false };
  await addSheet(spreadsheetId, title);
  const meta2 = await getSpreadsheetMeta(spreadsheetId);
  found = meta2.sheets.find(
    (s) => s.properties.title.toLowerCase() === String(title).toLowerCase()
  );
  return { sheet: found, created: true };
}

async function firstEmptyRow(spreadsheetId, tabName) {
  const data = await getValues(spreadsheetId, `${tabName}!A1:A10000`);
  let last = data.length;
  while (last > 0 && !String(data[last - 1][0] || "").trim()) last--;
  return last; // 0-based index where fresh data can start
}

async function readSettings(spreadsheetId) {
  const meta = await getSpreadsheetMeta(spreadsheetId);
  const settingsName =
    meta.sheets.find((s) => s.properties.title.toLowerCase() === "settings")?.properties.title ||
    meta.sheets[0]?.properties.title;
  if (!settingsName) throw new Error("Spreadsheet has no sheets");
  const data = await getValues(spreadsheetId, `${settingsName}!A1:B200`);
  const items = [];
  for (const row of data) {
    const label = String(row[0] || "").replace(/[:：\s]+$/g, "").trim();
    const url = String(row[1] || "").trim();
    if (label && url && /^https?:\/\//i.test(url)) {
      items.push({ label, url });
    }
  }
  return {
    settingsSheet: settingsName,
    sheets: meta.sheets.map((s) => s.properties.title),
    items,
  };
}

// Append rows to a sheet at the first empty slot, deduping against existing keys.
async function appendDedup(spreadsheetId, title, headers, rows, keyIdx, start) {
  const lastCol = columnLetter(Math.max(headers.length, 1));
  const keyCol = columnLetter(keyIdx + 1);
  const existing =
    start > 0 ? await getValues(spreadsheetId, `${title}!${keyCol}2:${keyCol}${start}`) : [];
  const existingKeys = new Set(existing.map((r) => r[0]).filter(Boolean));
  const fresh = dedupeRows(rows, keyIdx).filter((r) => !existingKeys.has(String(r.values[keyIdx])));
  if (fresh.length) {
    const dataStart = start === 0 ? 2 : start + 1;
    const values = fresh.map((r) => r.values);
    await updateValues(
      spreadsheetId,
      `${title}!A${dataStart}:${lastCol}${dataStart + values.length - 1}`,
      values
    );
  }
  return { written: fresh.length, skipped: rows.length - fresh.length };
}

async function scrapeToSheet(spreadsheetId, item, mode, maxPages, onProgress) {
  if (onProgress) {
    const auto = await ensureAutoLogin();
    if (auto && auto.message) {
      onProgress({
        type: "progress",
        status: "login",
        label: item.label,
        message: auto.message,
      });
    }
  }
  const pageNote = maxPages > 0 ? `max ${maxPages} page${maxPages > 1 ? "s" : ""}` : "all pages";
  onProgress({
    type: "progress",
    status: "fetch",
    label: item.label,
    message: `Fetching ${item.url} (${pageNote})`,
  });

  let title = null;
  let created = false;
  let written = 0;
  let skipped = 0;
  let hasWritten = false;

  await scrapePaged(
    item.url,
    maxPages,
    (p) =>
      onProgress({
        type: "progress",
        status: "fetch",
        label: item.label,
        page: p.page,
        message: `Page ${p.page}${p.totalPages ? `/${p.totalPages}` : ""}${p.totalResults ? ` (${p.totalResults} results)` : ""} — ${p.pageUrl}`,
      }),
    async (batch) => {
      if (!batch.rows.length) return;
      const isFirst = !hasWritten;
      const keyIdx = batch.headers && batch.headers[0] === "S.No" ? 1 : 0;
      const lastCol = columnLetter(Math.max(batch.headers.length, 1));
      const headerRow = batch.headers.map((h, i) => (h === "(col)" ? `Column ${i + 1}` : h));

      if (isFirst) {
        const w = await ensureWorksheet(spreadsheetId, item.label);
        title = w.sheet.properties.title;
        created = w.created;
        if (created || mode === "replace") {
          const gi = await getSheetGridInfo(spreadsheetId, title);
          await clearValues(spreadsheetId, `${title}!A1:${columnLetter(gi.columnCount)}${gi.rowCount}`);
        }
        if (created || mode === "replace") {
          const values = [headerRow, ...batch.rows.map((r) => r.values)];
          await updateValues(spreadsheetId, `${title}!A1:${lastCol}${values.length}`, values);
          written = batch.rows.length;
        } else {
          const start = await firstEmptyRow(spreadsheetId, title);
          if (start === 0) {
            await updateValues(spreadsheetId, `${title}!A1:${lastCol}1`, [headerRow]);
          }
          const res = await appendDedup(spreadsheetId, title, batch.headers, batch.rows, keyIdx, start);
          written = res.written;
          skipped = res.skipped;
        }
      } else {
        const start = await firstEmptyRow(spreadsheetId, title);
        const res = await appendDedup(spreadsheetId, title, batch.headers, batch.rows, keyIdx, start);
        written += res.written;
        skipped += res.skipped;
      }
      hasWritten = true;

      onProgress({
        type: "progress",
        status: "write",
        label: item.label,
        message: `Page ${batch.page}${batch.totalPages ? `/${batch.totalPages}` : ""} — wrote ${batch.rows.length} rows (running total ${written}) to "${title || item.label}"`,
      });
    }
  );

  if (!hasWritten) {
    throw new Error(
      "No rows extracted. Screener may require login — Login in the panel, then retry."
    );
  }
  const stopped = stopRequested;
  stopRequested = false;
  return { tabName: title || item.label, created, written, skipped, stopped };
}

// ---------- Scrape Details (per-company consolidated financials) ----------
const DETAIL_FIELDS = [
  ["Market Cap", "Mkt Cap (Cr)"],
  ["Current Price", "Current Price"],
  ["High / Low", "High / Low"],
  ["Stock P/E", "Stock P/E"],
  ["Book Value", "Book Value"],
  ["Dividend Yield", "Dividend Yield (%)"],
  ["ROCE", "ROCE (%)"],
  ["ROE", "ROE (%)"],
  ["Face Value", "Face Value"],
  ["Profit growth", "Profit Growth (%)"],
  ["Promoter holding", "Promoter Holding (%)"],
  ["PEG Ratio", "PEG Ratio"],
  ["Price to Sales", "Price to Sales"],
  ["Net worth", "Net Worth (Cr)"],
  ["ROE 5Yr", "ROE 5Yr (%)"],
  ["Profit after tax", "Profit After Tax (Cr)"],
  ["Sales growth", "Sales Growth (%)"],
  ["Debt to equity", "Debt to Equity"],
  ["Return over 3years", "Return 3Yrs (%)"],
  ["Return over 5years", "Return 5Yrs (%)"],
  ["Earning Power", "Earning Power (%)"],
  ["Sales growth 5Years", "Sales Growth 5Yrs (%)"],
  ["Debt", "Debt (Cr)"],
  ["Return over 1year", "Return 1Yr (%)"],
  ["Net profit", "Net Profit (Cr)"],
  ["Price to book value", "Price To Book"],
  ["EPS", "EPS"],
  ["ROE 10Yr", "ROE 10Yr (%)"],
  ["Sales Var 10Yrs", "Sales Var 10Yrs (%)"],
  ["Profit Var 10Yrs", "Profit Var 10Yrs (%)"],
  ["Industry PE", "Industry PE"],
];

const normLabel = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// Normalize a table cell / header text so we can detect repeated header rows and
// identify the company "Link" column regardless of whitespace/case/punctuation.
const normCellKey = (s) => normLabel(s).replace(/^(sno?|sn|column)\w*$/, "sno");

function parseTopRatios(html) {
  const map = {};
  const m = html.match(/<ul id="top-ratios"[\s\S]*?<\/ul>/i);
  if (!m) return map;
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let li;
  while ((li = liRe.exec(m[0]))) {
    const name = li[1].match(/<span class="name">([\s\S]*?)<\/span>/i);
    if (!name) continue;
    const key = normLabel(cellText(name[1]));
    if (!key) continue;
    // everything after the name span (up to </li>) is the value, incl. nested <span>s
    const valueHtml = li[1].replace(/^[\s\S]*?<span class="name">[\s\S]*?<\/span>/, "");
    const value = cellText(valueHtml).replace(/^\s*\?\s*/, "").trim();
    if (value !== undefined && value !== "") map[key] = cleanDetailValue(value);
  }
  return map;
}

function parseRatiosSection(html) {
  const map = {};
  const sec = html.match(/<section id="ratios"[\s\S]*?<\/section>/i);
  if (!sec) return map;
  const tbl = parseTables(sec[0])[0];
  if (!tbl) return map;
  for (const r of tbl.rows) {
    const cells = r.arrows;
    const label = normLabel(cells[0]);
    if (!label) continue;
    for (let i = cells.length - 1; i > 0; i--) {
      const v = String(cells[i] || "").trim();
      if (v === "") continue;
      const text = cellText(v, true);
      if (text === "") continue;
      map[label] = cleanDetailValue(text);
      break;
    }
  }
  return map;
}

function parsePromoterHolding(html) {
  const sec = html.match(/<section id="shareholding"[\s\S]*?<\/section>/i);
  if (!sec) return "";
  for (const tbl of parseTables(sec[0])) {
    const row = tbl.rows.find(
      (r) => normLabel(String(r.arrows[0] || "")).indexOf("promoters") === 0
    );
    if (!row) continue;
    const cells = row.arrows;
    for (let i = cells.length - 1; i > 0; i--) {
      const v = String(cells[i] || "").trim();
      if (v === "") continue;
      const text = cellText(v, true);
      if (text === "" || /^[-+]?[0-9.,]+%?$/.test(text) === false) continue;
      return cleanDetailValue(text);
    }
  }
  return "";
}

function cleanDetailValue(text) {
  let v = String(text || "")
    .replace(/[?]+/g, "")
    .replace(/₹/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\+/, "")
    .replace(/^-\s+/, "-");
  v = v.replace(/\s*(%|Cr\.?|cr\.?|Rs\.?|₹)\s*$/i, "").trim();
  if (/^[\/\\]*$/.test(v) || /^-{1,2}$/.test(v) || /^[-–—]*$/.test(v)) return "";
  return v;
}

function consolidatedUrl(link) {
  let u = String(link || "").split("#")[0].replace(/\/+$/, "");
  const m = u.match(/^(https?:\/\/[^/]+\/company\/[^/]+)/i);
  if (m) return m[1] + "/consolidated/";
  return u + "/consolidated/";
}

function parseAnnualTables(html) {
  const map = {};
  for (const id of ["profit-loss", "balance-sheet", "cash-flow"]) {
    const sec = html.match(new RegExp(`<section id="${id}"[\\s\\S]*?</section>`, "i"));
    if (!sec) continue;
    const tbl = parseTables(sec[0])[0];
    if (!tbl) continue;
    for (const r of tbl.rows) {
      const cells = r.arrows;
      const label = normLabel(cells[0]);
      if (!label) continue;
      for (let i = cells.length - 1; i > 0; i--) {
        const v = String(cells[i] || "").trim();
        if (v === "") continue;
        const text = cellText(v, true);
        if (text === "") continue;
        if (map[label] == null) map[label] = cleanDetailValue(text);
        break;
      }
    }
  }
  return map;
}

const DETAIL_ALIASES = {
  profitaftertax: ["profitaftertax", "netprofit"],
  netprofit: ["netprofit", "profitaftertax"],
  eps: ["eps", "epsinrs", "epsannual"],
};

function addAmounts(...vals) {
  let sum = 0;
  let any = false;
  for (const v of vals) {
    const n = parseFloat(String(v || "").replace(/[^\d.-]/g, ""));
    if (Number.isFinite(n)) {
      sum += n;
      any = true;
    }
  }
  return any ? String(Math.round(sum * 100) / 100) : "";
}

function extractDetails(html) {
  const top = parseTopRatios(html);
  const ratios = parseRatiosSection(html);
  const annual = parseAnnualTables(html);
  const promoter = parsePromoterHolding(html);
  // Derived fallbacks available even from public pages.
  const netWorthFallback = addAmounts(annual["reserves"], annual["equitycapital"]) || annual["network"];
  const debtFallback = annual["borrowings"] || annual["debt"];
  return DETAIL_FIELDS.map(([label]) => {
    const key = normLabel(label);
    const keys = DETAIL_ALIASES[key] ? [key, ...DETAIL_ALIASES[key]] : [key];
    let v = null;
    for (const k of keys) {
      const src = top[k];
      if (src != null && src !== "") { v = src; break; }
      const s2 = ratios[k];
      if (s2 != null && s2 !== "") { v = s2; break; }
      const s3 = annual[k];
      if (s3 != null && s3 !== "") { v = s3; break; }
    }
    if ((v == null || v === "") && key === "promoterholding") v = promoter;
    if ((v == null || v === "") && key === "networth") v = netWorthFallback;
    if ((v == null || v === "") && key === "debt") v = debtFallback;
    return v == null ? "" : String(v).trim();
  });
}

async function scrapeDetails(spreadsheetId, tabName, mode, onProgress) {
  const rateDelay = 400; // ms between fetched rows, to respect Screener rate limits
  const rawTab = tabName;
  onProgress({
    type: "progress",
    status: "read",
    label: tabName,
    message: `Reading rows from "${rawTab}"…`,
  });
  // Read the full used grid so a previous Details/append run with columns far
  // beyond N is still seen (startCol detection + append must never be off by the
  // "only read up to N" mistake).
  const [gridInfo, grid, warmOk] = await Promise.all([
    getSheetGridInfo(spreadsheetId, rawTab),
    (async () => {
      try {
        const gi_ = await getSheetGridInfo(spreadsheetId, rawTab);
        const lastCol = columnLetter(Math.max(1, gi_.columnCount));
        return await getValues(spreadsheetId, `${rawTab}!A1:${lastCol}${Math.max(0, gi_.rowCount)}`);
      } catch {
        return await getValues(spreadsheetId, `${rawTab}!A1:N20000`);
      }
    })(),
    withTimeout(
      (async () => {
        const tab = await ensureScraperWindow(`${SCREENER_BASE}/`);
        if (!tab) return false;
        await ensureContentScriptInjected(tab.id).catch(() => {});
        return true;
      })(),
      25000
    ).catch(() => null),
  ]);
  void gridInfo;
  onProgress({
    type: "progress",
    status: "details",
    label: tabName,
    message: warmOk
      ? "Screener tab ready — full 31-ratio data will be scraped from the live page."
      : "Could not open a Screener tab — detail fields may be limited to public data.",
  });
  if (!grid.length) throw new Error(`Tab "${rawTab}" is empty — run the main scrape first.`);
  const headerRow = grid[0];
  const linkIdx = headerRow.findIndex((h) => normLabel(h) === "link");
  if (linkIdx < 0) {
    throw new Error(`Tab "${rawTab}" has no "Link" column — run the main scrape first (it writes links in col M).`);
  }
  let startCol = headerRow.length;
  const probe = normLabel(DETAIL_FIELDS[0][1]);
  for (let i = 0; i < headerRow.length; i++) {
    if (normLabel(headerRow[i]) === probe) {
      startCol = i;
      break;
    }
  }
  const detailHeaders = DETAIL_FIELDS.map((f) => f[1]);
  const firstLetter = columnLetter(startCol + 1);
  const lastLetter = columnLetter(startCol + detailHeaders.length);
  // The detail columns must exist in the sheet's grid before clearing/writing,
  // otherwise clear/update on a column beyond grid limits fails with a 400.
  const gi2 = await expandSheetGrid(spreadsheetId, rawTab, {
    rows: Math.max(grid.length + 1, 2),
    cols: startCol + detailHeaders.length,
  });
  await updateValues(spreadsheetId, `${rawTab}!${firstLetter}1:${lastLetter}1`, [detailHeaders]);
  if (mode === "replace") {
    await clearValues(spreadsheetId, `${rawTab}!${firstLetter}2:${lastLetter}${gi2.rowCount}`);
  }

  let filled = 0;
  let skipped = 0;
  let failed = 0;
  const pending = new Map();

  const flush = async () => {
    if (!pending.size) return;
    // Group pending writes into contiguous row runs; each row keeps its exact
    // sheet row so skipped rows never shift the remaining data up/down.
    const runs = [];
    let curStart = null;
    let curEnd = null;
    const ordered = [...pending.keys()].sort((a, b) => a - b);
    for (const row of ordered) {
      if (curEnd != null && row === curEnd + 1) {
        curEnd = row;
      } else {
        if (curStart != null) runs.push([curStart, curEnd]);
        curStart = row;
        curEnd = row;
      }
    }
    if (curStart != null) runs.push([curStart, curEnd]);
    for (const [rs, re] of runs) {
      const values = [];
      for (let r = rs; r <= re; r++) values.push(pending.get(r));
      await updateValues(
        spreadsheetId,
        `${rawTab}!${firstLetter}${rs}:${lastLetter}${re}`,
        values
      );
    }
    pending.clear();
  };

  const total = grid.length - 1;
  let n = 0;
  for (let gi = 1; gi < grid.length; gi++) {
    if (stopRequested) break;
    const row = grid[gi];
    n++;
    const sheetRow = gi + 1;
    const link = String((row && row[linkIdx]) || "").trim();
    if (!link) {
      skipped++;
      continue;
    }
    // Append mode: skip rows whose detail cells are already fully populated so
    // re-runs only re-scrape the rows that actually need data (empty/partial).
    if (mode !== "replace" && row) {
      const detailCells = row.slice(startCol, startCol + detailHeaders.length);
      if (detailCells.length > 0 && detailCells.every((c) => String(c || "").trim() !== "")) {
        skipped++;
        continue;
      }
    }
    const url = consolidatedUrl(link);
    const name = String((row && row[1]) || link).trim();
    onProgress({
      type: "progress",
      status: "details",
      label: tabName,
      message: `Details ${n}/${total} — ${name}`,
    });
    try {
      const { html, source } = await fetchDetail(url);
      if (stopRequested) break;
      const values = extractDetails(html);
      pending.set(sheetRow, values);
      filled++;
      if (pending.size >= 20) await flush();
      if (source !== "tab-dom") {
        onProgress({
          type: "progress",
          status: "details",
          label: tabName,
          message: `Details ${n}/${total} — ${name} (network fallback — cannot open logged-in page, some ratios may be missing)`,
        });
      }
    } catch (e) {
      failed++;
      if (stopRequested) break;
      if (filled === 0 && failed >= 4) {
        await flush();
        throw new Error(
          `Cannot reach screener.in after ${failed} attempts (${e.message}). ` +
            `Screener is likely rate-limiting/blocking this IP after the fast scrape. ` +
            `Open https://screener.in in a normal tab — if it's slow or does not load, wait a while and retry.`
        );
      }
      onProgress({
        type: "progress",
        status: "details",
        label: tabName,
        message: `Details ${n}/${total} — ${name}: error ${e.message}`,
      });
    }
    await sleep(rateDelay);
  }
  await flush();
  const stopped = stopRequested;
  stopRequested = false;
  return { tabName: rawTab, filled, skipped, failed, total, stopped };
}

// ---------- AI Research (ChatGPT) ----------
// Output columns, one per field in the prompt's JSON shape. The AI button adds
// these columns to the sheet, then fills them per row on the row's own line.
const AI_HEADER = "AI Research";
const AI_COLUMNS = [
  "AI Summary",
  "AI Linked Companies",
  "AI Big Orders",
  "AI Catalysts",
  "AI Risks",
];

// One cell string per AI_COLUMNS entry, from ChatGPT's parsed JSON.
function aiRowCells(parsed) {
  if (!parsed || typeof parsed !== "object") return AI_COLUMNS.map(() => "");
  const list = (arr, fn) =>
    Array.isArray(arr) ? arr.map(fn).filter(Boolean).join("\n") : "";
  const link = (x) =>
    ["name", "relation"].filter((k) => x && x[k]).map((k) => x[k]).join(" — ");
  const order = (x) =>
    ["desc", "value", "date"].filter((k) => x && x[k]).map((k) => x[k]).join(" — ");
  const point = (x) => (x && x.point ? x.point : "");
  return [
    String(parsed.summary || ""),
    list(parsed.linkedCompanies, link),
    list(parsed.bigOrders, order),
    list(parsed.catalysts, point),
    list(parsed.risks, point),
  ];
}

// Company profile block: <div class="company-profile"> with an "About" div and
// a "Key Points" commentary block of <p> paragraphs (optional <strong> title).
function parseCompanyProfile(html) {
  const out = { about: "", keyPoints: [] };
  const aboutM = html.match(
    /<div class="sub[^"]*\babout\b[^"]*"[^>]*><p>([\s\S]*?)<\/p><\/div>/i
  );
  if (aboutM) out.about = cellText(aboutM[1]).trim();
  // Commentary ("Key Points") runs up to the "Read More" button that follows it.
  const commentM = html.match(
    /<div class="sub[^"]*\bcommentary\b[^"]*"[^>]*>([\s\S]*?)<\/button>/i
  ) || html.match(
    /<div class="sub[^"]*\bcommentary\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  );
  if (commentM) {
    const pRe = /<p>([\s\S]*?)<\/p>/gi;
    let pm;
    while ((pm = pRe.exec(commentM[1]))) {
      const p = pm[1];
      const strong = p.match(/<strong>(.*?)<\/strong>/i);
      const title = strong ? cellText(strong[1]).replace(/[:\s]+$/, "") : "";
      const bodyText = strong ? p.replace(strong[0], "") : p;
      const text = cellText(bodyText).replace(/^[\s.,;:-]+|[\s.,;:-]+$/g, "").trim();
      if (text && text.length > 5) out.keyPoints.push({ title, text });
    }
  }
  return out;
}

// Pros & Cons: <section id="analysis"> holds <div class="pros"> / <div class="cons">.
function parseProsCons(html) {
  const out = { pros: [], cons: [] };
  const sec = html.match(/<section id="analysis"[\s\S]*?<\/section>/i);
  if (!sec) return out;
  const collect = (cls, target) => {
    const block = sec[0].match(new RegExp(`<div class="${cls}"[^>]*>([\\s\\S]*?)<\\/div>`, "i"));
    if (!block) return;
    const liRe = /<li>([\s\S]*?)<\/li>/gi;
    let m;
    while ((m = liRe.exec(block[1]))) {
      const t = cellText(m[1]).trim();
      if (t) target.push(t);
    }
  };
  collect("pros", out.pros);
  collect("cons", out.cons);
  return out;
}

// Pull a numeric row (e.g. "Net Profit") from a section like #quarters or
// #profit-loss, newest period = last entry. Values that aren't numeric are dropped.
function parseNetProfitSeries(html, sectionId) {
  const sec = html.match(new RegExp(`<section id="${sectionId}"[\\s\\S]*?<\\/section>`, "i"));
  if (!sec) return [];
  for (const tbl of parseTables(sec[0])) {
    const row = tbl.rows.find((r) => /net\s*profit|profit\s*after\s*tax/i.test(String(r.arrows[0] || "")));
    if (!row) continue;
    const out = [];
    for (let i = 1; i < row.arrows.length; i++) {
      const n = parseFloat(String(row.arrows[i] || "").replace(/[^\d.-]/g, ""));
      if (Number.isFinite(n)) out.push(n);
    }
    if (out.length) return out;
  }
  return [];
}

const nullNum = (v) => {
  const n = parseFloat(String(v || "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const buildAiResearchPrompt = (d) => {
  const qNet = (d.qNet || []).filter((v) => v !== null);
  const aNet = (d.aNet || []).filter((v) => v !== null);
  const qoQ =
    qNet.length >= 2 && qNet[qNet.length - 2] !== 0
      ? ((qNet[qNet.length - 1] - qNet[qNet.length - 2]) / Math.abs(qNet[qNet.length - 2])) * 100
      : null;
  const yoY =
    aNet.length >= 2 && aNet[aNet.length - 2] !== 0
      ? ((aNet[aNet.length - 1] - aNet[aNet.length - 2]) / Math.abs(aNet[aNet.length - 2])) * 100
      : null;
  const kps = (d.keyPoints || []).map((k) => (k.title ? k.title + ": " : "") + k.text);
  const rows = [
    "Act as a senior equity research analyst. Your job: quickly find the STOCK STORY / TRIGGER in plain language for a retail investor. FOCUS ON: (1) which big company, group, customer or supplier this stock is actually LINKED to and WHY it matters (e.g. \"Azaad Engineering makes jet-engine airfoil blades and supplies Boeing\" - that is exactly the kind of linkage insight we want); (2) the BIG ORDER / major win with value & date if available; (3) the single strongest near-term TRIGGER with the logic behind it. Keep it short and punchy, like a hot tip summary.",
    "",
    "Base data from screener.in:",
    "Company: " + d.name,
    d.price != null ? "Current Price: Rs " + d.price : null,
    d.pe != null ? "Current P/E: " + Number(d.pe).toFixed(1) : null,
    d.mcap ? "Market Cap: " + d.mcap : null,
    d.about ? "About: " + d.about : null,
    kps.length ? "Key Points: " + kps.join(" | ") : null,
    d.pros.length ? "Pros: " + d.pros.join("; ") : null,
    d.cons.length ? "Cons: " + d.cons.join("; ") : null,
    qNet.length ? "Quarterly Net Profit (recent " + qNet.length + "): " + qNet.map((v) => v.toFixed(1)).join(", ") : null,
    aNet.length ? "Annual Net Profit: " + aNet.map((v) => v.toFixed(1)).join(", ") : null,
    qoQ != null ? "QoQ Net Profit growth: " + qoQ.toFixed(1) + "%" : null,
    yoY != null ? "YoY Net Profit growth: " + yoY.toFixed(1) + "%" : null,
    "",
    "WEB RESEARCH (search the whole internet: latest news, BSE/NSE announcements, company and promoter-group IR pages, Reuters, MarketScreener, BazaarWatch, screener.in, credible market coverage):",
    "- Check who the company supplies to, takes orders from, is part of which group, and who controls it (promoter / parent).",
    "- Look for major recent orders, contracts and wins (value + date when known).",
    "- Identify the single biggest near-term catalyst/trigger and the top risks. Add a real source URL where possible; if you cannot confirm a fact, say so instead of guessing.",
    "",
    "CONCISENESS RULES (VERY IMPORTANT):",
    "- summary: MAX 2 sentences, plain language.",
    "- Every bullet: ONE SHORT line, MAX 15 words. No paragraphs, no date ranges in text, no extra explanation sentences.",
    "- MAX 4 items per array. If nothing major found, keep the array short or empty.",
    "",
    "OUTPUT RULES (STRICT):",
    "- Reply with ONLY ONE valid JSON object. Nothing before and nothing after it.",
    "- Do NOT use markdown code fences (no ```) and do NOT append any footnote / link list after the JSON.",
    '- Exact shape:',
    '{"summary":"\u22642 short sentences","linkedCompanies":[{"name":"company/group","relation":"how linked, one short line","source":"url if any else blank"}],"bigOrders":[{"desc":"what won, one short line","value":"value if known else blank","date":"when if known else blank","source":"url if any else blank"}],"catalysts":[{"point":"trigger with logic, one short line","source":"url if any else blank"}],"risks":[{"point":"risk, one short line","source":"url if any else blank"}]}',
  ];
  return rows.filter((r) => r !== null && r !== "").join("\n");
};

// Pull clean JSON out of ChatGPT's reply (handles ``` fences and trailing prose).
function extractAiJson(text) {
  const clean = (s) =>
    s
      .replace(/[\r\n]+/g, " ")
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/\s+/g, " ");
  const extractJson = (s) => {
    const start = s.indexOf("{");
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (inStr) { if (ch === '"') inStr = false; continue; }
      if (ch === '"') { inStr = true; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
    return null;
  };
  const str = String(text || "");
  const candidates = [];
  const fenced = str.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1]);
  const extracted = extractJson(str);
  if (extracted) candidates.push(extracted);
  candidates.push(str);
  for (const c of candidates) {
    const variants = c.trim() ? [c.trim(), clean(c)] : [];
    for (const v of variants) {
      try {
        const obj = JSON.parse(v);
        if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
      } catch (e) {}
    }
  }
  return null;
}

async function findOrOpenChatGptTab() {
  const existing = await chrome.tabs.query({ url: ["https://chatgpt.com/*"] });
  if (existing && existing.length) return existing[0];
  return await chrome.tabs.create({ url: "https://chatgpt.com/", active: false });
}

function getActiveTab() {
  return chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((t) => (t && t[0]) || null);
}

async function ensureGptBridgeReady(tabId, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { action: "__gptGetBridge" });
      if (res && res.ready) return true;
    } catch (e) {}
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["chatgpt_bridge.js"] });
    } catch (e) {}
    await sleep(800);
  }
  return false;
}

// Drive one research pass: focus a chatgpt.com tab, inject the bridge, send the
// prompt (web search ON), wait for the answer, then restore the user's tab.
// Mirrors the working flow from the Chart Screener Chrome project.
async function handleChatGptAsk(prompt, opts) {
  const prevTab = await getActiveTab();
  const tab = await findOrOpenChatGptTab();
  gptTabId = tab.id;
  try {
    const win = await chrome.windows.get(tab.windowId);
    await chrome.windows.update(win.id, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
  } catch (e) {}
  const restoreTab = async () => {
    if (prevTab && prevTab.id !== tab.id) {
      try { await chrome.tabs.update(prevTab.id, { active: true }); } catch (e) {}
    }
  };
  const ready = await ensureGptBridgeReady(tab.id);
  if (!ready) {
    await restoreTab();
    return { success: false, error: 'ChatGPT page not ready. Please open chatgpt.com and login in Chrome, then try again.' };
  }
  const res = await chrome.tabs.sendMessage(tab.id, { action: "__gptAsk", prompt, opts }).catch(() => null);
  gptTabId = null;
  await restoreTab();
  if (res && res.ok) return { success: true, text: res.text };
  if (stopRequested) return { success: false, error: "Stopped by user." };
  return { success: false, error: (res && res.error) || "ChatGPT did not respond." };
}

// Read the tab's rows (Link + Company), run up to maxRows of them through ChatGPT,
// and write each answer field into its own column for that row (columns are added
// first, in the order defined by the prompt's JSON shape).
async function runAiResearch(spreadsheetId, tabName, mode, maxRows, onProgress) {
  const rawTab = tabName;
  onProgress({ type: "progress", status: "ai", label: tabName, message: `Reading rows from "${rawTab}"…` });
  const grid = await getValues(spreadsheetId, `${rawTab}!A1:ZZ20000`);
  if (!grid.length) throw new Error(`Tab "${rawTab}" is empty — run the main scrape first.`);
  const headerRow = grid[0];
  const linkIdx = headerRow.findIndex((h) => normLabel(h) === "link");
  if (linkIdx < 0) {
    throw new Error(`Tab "${rawTab}" has no "Link" column — run the main scrape first.`);
  }
  let nameIdx = headerRow.findIndex((h) => /company|name/i.test(normLabel(h)));
  if (nameIdx < 0) nameIdx = 0; // fall back to Col A
  let aiCol = -1;
  for (let i = 0; i < headerRow.length; i++) {
    if (AI_COLUMNS.some((c) => normLabel(headerRow[i]) === normLabel(c) || normLabel(headerRow[i]).indexOf("ai ") === 0)) {
      aiCol = i;
      break;
    }
  }
  if (aiCol < 0) aiCol = grid[0].length; // append after the last used column
  const firstLetter = columnLetter(aiCol + 1);
  const lastLetter = columnLetter(aiCol + AI_COLUMNS.length);
  // The AI columns must exist in the sheet's grid before clearing/writing,
  // otherwise clear/update on a column beyond grid limits fails with a 400.
  const gi = await expandSheetGrid(spreadsheetId, rawTab, {
    rows: Math.max(grid.length + 1, 2),
    cols: aiCol + AI_COLUMNS.length,
  });
  if (mode === "replace") {
    // Clear only within the sheet's actual grid (rows = current grid height).
    await clearValues(spreadsheetId, `${rawTab}!${firstLetter}2:${lastLetter}${gi.rowCount}`);
  }
  await updateValues(spreadsheetId, `${rawTab}!${firstLetter}1:${lastLetter}1`, [AI_COLUMNS]);

  const limit = Number.isFinite(maxRows) && maxRows > 0 ? maxRows : 0; // 0 = all rows
  const targets = [];
  const existing = grid.map((r) => r[aiCol] || "");
  for (let gi = 1; gi < grid.length; gi++) {
    if (stopRequested) break;
    if (limit && targets.length >= limit) break;
    const row = grid[gi];
    const link = String((row && row[linkIdx]) || "").trim();
    if (!link) continue;
    if (mode !== "replace" && String(existing[gi] || "").trim()) continue; // already researched
    targets.push({ gi, link, name: String((row && row[nameIdx]) || link).trim() });
  }
  const total = targets.length;
  onProgress({ type: "progress", status: "ai", label: tabName, message: `AI research queue: ${total} row(s). Each row takes ~20–90s.` });

  let filled = 0, failed = 0, skipped = 0;
  const failures = [];

  const processTarget = async (t, ordinal) => {
    if (stopRequested) return "stopped";
    onProgress({ type: "progress", status: "ai", label: tabName, message: `AI ${ordinal + 1}/${total} — ${t.name} (fetching)…` });
    let detail;
    try {
      const { html } = await fetchDetail(consolidatedUrl(t.link));
      const top = parseTopRatios(html);
      const prof = parseCompanyProfile(html);
      const pc = parseProsCons(html);
      const qNet = parseNetProfitSeries(html, "quarters");
      const aNet = parseNetProfitSeries(html, "profit-loss");
      detail = {
        name: t.name,
        price: nullNum(top["currentprice"]),
        pe: nullNum(top["stockpe"]),
        mcap: top["marketcap"] || "",
        about: prof.about,
        keyPoints: prof.keyPoints,
        pros: pc.pros,
        cons: pc.cons,
        qNet,
        aNet,
      };
    } catch (e) {
      return { failed: true, error: `fetch error: ${e.message}` };
    }
    const prompt = buildAiResearchPrompt(detail);
    onProgress({ type: "progress", status: "ai", label: tabName, message: `AI ${ordinal + 1}/${total} — ${t.name} (ChatGPT researching…)` });
    let res;
    try {
      res = await Promise.race([
        handleChatGptAsk(prompt, { webSearch: true }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("ChatGPT timeout (260s)")), 260000)),
      ]);
    } catch (e) {
      if (stopRequested) return "stopped";
      return { failed: true, error: e.message || String(e) };
    }
    if (stopRequested) return "stopped";
    if (!res.success) return { failed: true, error: res.error };
    const parsed = extractAiJson(res.text);
    const cells = aiRowCells(parsed);
    if (!parsed && res.text) cells[0] = res.text;
    try {
      await updateValues(spreadsheetId, `${rawTab}!${firstLetter}${t.gi + 1}:${lastLetter}${t.gi + 1}`, [cells]);
    } catch (e) {
      return { failed: true, error: `sheet write: ${e.message}` };
    }
    return { ok: true };
  };

  // First pass: every row exactly once, never aborting on ChatGPT hiccups.
  for (let i = 0; i < targets.length; i++) {
    if (stopRequested) break;
    const t = targets[i];
    const r = await processTarget(t, i);
    if (r === "stopped") break;
    if (r.ok) {
      filled++;
      onProgress({ type: "progress", status: "ai", label: tabName, message: `AI ${i + 1}/${total} — ${t.name}: done` });
    } else {
      failed++;
      failures.push({ t, ordinal: i, error: r.error });
      onProgress({ type: "progress", status: "ai", label: tabName, message: `AI ${i + 1}/${total} — ${t.name}: ${r.error}` });
    }
  }

  // Second pass: retry only the rows that failed, once each.
  if (failures.length && !stopRequested) {
    onProgress({ type: "progress", status: "ai", label: tabName, message: `Retrying ${failures.length} failed row(s)…` });
    for (const f of failures) {
      if (stopRequested) break;
      const r = await processTarget(f.t, f.ordinal);
      if (r === "stopped") break;
      if (r.ok) {
        failed--;
        filled++;
        onProgress({ type: "progress", status: "ai", label: tabName, message: `AI ${f.ordinal + 1}/${total} — ${f.t.name}: done (retry)` });
      } else {
        onProgress({ type: "progress", status: "ai", label: tabName, message: `AI ${f.ordinal + 1}/${total} — ${f.t.name}: still failing (${r.error})` });
      }
    }
  }
  const stopped = stopRequested;
  stopRequested = false;
  return { tabName: rawTab, filled, failed, skipped, total, stopped, ai: true };
}

// ---------- Screener login ----------
const SCREENER_BASE = "https://www.screener.in";

async function screenerTab() {
  const tabs = await chrome.tabs.query({ url: ["https://*.screener.in/*"] });
  return tabs[0] || null;
}

async function ensureContentScriptInjected(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ping" });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      return true;
    } catch {
      return false;
    }
  }
}

function awaitedTabComplete(tabId) {
  return new Promise((resolve) => {
    const h = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(h);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(h);
  });
}

async function screenerLogin(email, password) {
  let tab = await screenerTab();
  let created = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: `${SCREENER_BASE}/login/` });
    created = true;
    await awaitedTabComplete(tab.id);
  }
  await ensureContentScriptInjected(tab.id);
  const resp = await withTimeout(
    chrome.tabs.sendMessage(tab.id, {
      type: "login",
      email,
      password,
    }),
    20000
  ).catch(() => ({ ok: false, loggedIn: false, error: "Screener tab did not respond." }));
  return { created, ...resp };
}

async function screenerLoginCheck() {
  const tab = await screenerTab();
  if (!tab) {
    return { noTab: true, loggedIn: false, message: "No Screener.in tab open — use the Login button to open one." };
  }
  const injected = await ensureContentScriptInjected(tab.id);
  if (!injected) {
    return { loggedIn: false, message: "Cannot access the Screener tab. Open a normal https://screener.in page first." };
  }
  return chrome.tabs
    .sendMessage(tab.id, { type: "check_login" })
    .then((r) => r || { loggedIn: false })
    .catch(() => ({ loggedIn: false, message: "Screener tab did not respond." }));
}

async function ensureAutoLogin() {
  try {
    const st = await chrome.storage.local.get(["screenerEmail", "screenerPassword"]);
    if (!st.screenerEmail || !st.screenerPassword) return null;
    const tab = await screenerTab();
    if (!tab) {
      return { message: "Starting auto-login — opening a Screener tab…" };
    }
    await ensureContentScriptInjected(tab.id);
    const ck = await withTimeout(
      chrome.tabs.sendMessage(tab.id, { type: "check_login" }).catch(() => null),
      10000
    ).catch(() => null);
    if (ck && ck.loggedIn) return null;
    const r = await withTimeout(
      chrome.tabs.sendMessage(tab.id, {
        type: "login",
        email: st.screenerEmail,
        password: st.screenerPassword,
      }).catch(() => null),
      20000
    ).catch(() => null);
    if (!r || !r.loggedIn) {
      return { message: "Auto-login to Screener failed — check credentials in the panel." };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------- messaging ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "open_popup") {
    chrome.action.openPopup().catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.action === "chatgptAsk") {
    handleChatGptAsk(msg.prompt, msg.opts)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ success: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (msg && msg.action === "openChatgpt") {
    (async () => {
      try {
        const tab = await findOrOpenChatGptTab();
        const win = await chrome.windows.get(tab.windowId);
        await chrome.windows.update(win.id, { focused: true });
        await chrome.tabs.update(tab.id, { active: true });
        sendResponse({ success: true, url: tab.url });
      } catch (e) {
        sendResponse({ success: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }
  return false;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "scrape") return;
  port.onMessage.addListener(async (msg) => {
    try {
      if (msg.type === "init") {
        const settings = await readSettings(msg.spreadsheetId);
        port.postMessage({ type: "ready", settings });
      } else if (msg.type === "scrape") {
        stopRequested = false;
        const result = await scrapeToSheet(
          msg.spreadsheetId,
          msg.item,
          msg.mode || "replace",
          Math.max(0, parseInt(msg.maxPages, 10) || 0),
          (p) => port.postMessage(p)
        );
        port.postMessage({ type: "complete", result });
      } else if (msg.type === "scrape_details") {
        stopRequested = false;
        const result = await scrapeDetails(
          msg.spreadsheetId,
          (msg.item && msg.item.label) || "",
          msg.mode || "replace",
          (p) => port.postMessage(p)
        );
        port.postMessage({ type: "complete", result });
      } else if (msg.type === "ai_research") {
        stopRequested = false;
        const result = await runAiResearch(
          msg.spreadsheetId,
          (msg.item && msg.item.label) || "",
          msg.mode || "replace",
          Math.max(0, parseInt(msg.maxRows, 10) || 0),
          (p) => port.postMessage(p)
        );
        port.postMessage({ type: "complete", result });
      } else if (msg.type === "stop") {
        cancelScrape();
        port.postMessage({ type: "stopped" });
      } else if (msg.type === "login_check") {
        const r = await screenerLoginCheck();
        port.postMessage({ type: "login_check", ...r });
      } else if (msg.type === "login") {
        const { email, password, remember } = msg;
        if (!email || !password) throw new Error("Email and password are required.");
        const r = await Promise.race([
          screenerLogin(email, password),
          new Promise((_, rej) => setTimeout(() => rej(new Error("Login timed out.")), 30000)),
        ]);
        if (remember) {
          await chrome.storage.local.set({
            screenerEmail: email,
            screenerPassword: password,
            screenerRemember: true,
          });
        } else {
          await chrome.storage.local.set({ screenerEmail: email, screenerRemember: false });
          await chrome.storage.local.remove("screenerPassword");
        }
        port.postMessage({ type: "login_result", ...r });
      }
    } catch (e) {
      port.postMessage({ type: "error", error: e.message || String(e) });
    }
  });
});
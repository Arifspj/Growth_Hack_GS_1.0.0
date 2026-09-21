const enc = new TextEncoder();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let credsCache = null;
let tokenCache = { token: null, expiresAt: 0 };
let stopRequested = false;
let activeAbort = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cancelScrape() {
  stopRequested = true;
  if (activeAbort) {
    try {
      activeAbort.abort();
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

async function destroyScraperWindow() {
  if (scraperOpts.winId != null) {
    await chrome.windows.remove(scraperOpts.winId).catch(() => {});
    scraperOpts = { winId: null, tabId: null };
  }
}

async function rebuildScraperWindow() {
  await destroyScraperWindow();
  return ensureScraperWindow();
}

// One hidden (minimized) Screener window reused for every company page.
async function ensureScraperWindow(url = `${SCREENER_BASE}/`) {
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

function resolveNextPagination(html, currentUrl) {
  const nav = html.match(/class="pagination"[\s\S]*?<\/div>/i);
  if (!nav) return null;
  for (const m of nav[0].matchAll(/href="([^"]*?[?&](?:p|page)=(\d+))"/gi)) {
    // Only treat it as "next" if it actually advances the page (1 → 2 …); ignore
    // the paginator's own "1" link so we never loop back to the first page.
    if (parseInt(m[2], 10) <= 1) continue;
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
  const pag = html.match(/class="paginator"[\s\S]*?<\/p>/i);
  if (!pag) return null;
  const nums = [];
  for (const m of pag[0].matchAll(/[?&](?:p|page)=(\d+)/g)) nums.push(parseInt(m[1], 10));
  const totalResults = pag[0].match(/([\d,]+)\s*results/i);
  return {
    totalPages: nums.length ? Math.max(0, ...nums) : null,
    totalResults: totalResults ? totalResults[1].replace(/,/g, "") : null,
  };
}

function resolvePaginatorNext(html, currentUrl, page) {
  const pag = html.match(/class="paginator"[\s\S]*?<\/p>/i);
  if (!pag) return null;
  let best = null;
  for (const m of pag[0].matchAll(/href="([^"]*?[?&](?:p|page)=(\d+))"/gi)) {
    const n = parseInt(m[2], 10);
    if (n > page && (!best || n < best.n)) best = { href: m[1], n };
  }
  return best ? makeAbsolute(currentUrl, best.href) : null;
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
  const m = current.match(/[?&]p=(\d+)/);
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
        const metricCols = { sales: {}, ebidt: {}, netprofit: {}, eps: {} };
        for (let i = 0; i < headers.length; i++) {
          const h = normCellKey(headers[i]);
          const key = ["sales", "ebidt", "netprofit", "eps"].find(
            (k) => (k === "eps" ? /^eps$/i.test(h) : h.includes(k))
          );
          if (!key) continue;
          if (/jq$/.test(h) || /latest/.test(h)) metricCols[key].jq = i;
          else if (/yoy/.test(h) || /growth/.test(h)) metricCols[key].yoy = i;
        }
        for (const r of main.rows) {
          const cells = (r.arrows || []).slice();
          const sig = cells.slice(0, Math.max(normKeys.length, 2)).map((c) => normCellKey(c)).join("|");
          if (normKeys.length && sig === normKeys.join("|")) continue;
          const values = cells.slice(0, headers.length);
          while (values.length < headers.length) values.push("");
          // Company URL lives in the Company column — grab it from that cell's own link.
          const rowHref = r.links && r.links.length ? r.links[companyIdx] || r.links.find(Boolean) || r.href : r.href;
          values[linkIdx] = makeAbsolute(current, rowHref) || values[linkIdx];
          const score =
            bandScore(values[metricCols.sales.yoy]) +
            bandScore(values[metricCols.ebidt.yoy]) +
            bandScore(values[metricCols.netprofit.yoy]) +
            bandScore(values[metricCols.eps.yoy]) +
            marginScore(values[metricCols.netprofit.jq], values[metricCols.sales.jq]);
          values[scoreIdx] = score || "";
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
      : resolveNextPagination(html, current);
    // Safety net: when total pages are known, walk to the sequentially next page.
    if (!next && pag && pag.totalPages && page < pag.totalPages) {
      next = current.replace(/[?&]p=\d+/, `?p=${page + 1}`);
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
          await clearValues(spreadsheetId, `${title}!A1:ZZ50000`);
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
  const [grid, warmOk] = await Promise.all([
    getValues(spreadsheetId, `${rawTab}!A1:N20000`),
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
  await updateValues(spreadsheetId, `${rawTab}!${firstLetter}1:${lastLetter}1`, [detailHeaders]);
  if (mode === "replace") {
    await clearValues(spreadsheetId, `${rawTab}!${firstLetter}2:${lastLetter}20000`);
  }

  let filled = 0;
  let skipped = 0;
  let failed = 0;
  let buffer = [];
  let bufferStart = 0;

  const flush = async () => {
    if (!buffer.length) return;
    await updateValues(
      spreadsheetId,
      `${rawTab}!${firstLetter}${bufferStart}:${lastLetter}${bufferStart + buffer.length - 1}`,
      buffer
    );
    buffer = [];
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
      if (buffer.length === 0) bufferStart = sheetRow;
      buffer.push(values);
      filled++;
      if (buffer.length >= 20) await flush();
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
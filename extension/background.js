const enc = new TextEncoder();
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

let credsCache = null;
let tokenCache = { token: null, expiresAt: 0 };

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
      rows.push({
        href,
        plain: cellsRaw.map((c) => cellText(c)),
        arrows: cellsRaw.map((c) => cellText(c, true)),
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

async function fetchScreener(url) {
  // Prefer fetching through a logged-in screener.in tab (content script shares the session).
  const tabs = await chrome.tabs.query({ url: ["https://*.screener.in/*"] });
  if (tabs.length) {
    const tab = tabs[0];
    try {
      let resp = await chrome.tabs.sendMessage(tab.id, { type: "fetch_page", url }).catch(() => null);
      if (!resp) {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
        resp = await chrome.tabs.sendMessage(tab.id, { type: "fetch_page", url });
      }
      if (resp && resp.html) return resp.html;
      throw new Error(resp && resp.error ? resp.error : "Screener tab did not respond");
    } catch (e) {
      // fall through to direct fetch (public pages)
    }
  }
  return directFetch(url);
}

function resolveNextPagination(html, currentUrl) {
  const pag = html.match(/class="pagination"[\s\S]*?<\/div>/i);
  if (!pag) return null;
  const m = pag[0].match(/href="([^"]*)"[^>]*>\s*Next/i);
  if (!m) return null;
  const next = makeAbsolute(currentUrl, m[1]);
  if (next.split("#")[0] === currentUrl.split("#")[0]) return null;
  return next;
}

// "class=\"paginator\"" layout: <span class="this-page">1</span> <a href="?p=2">2</a> … 4655 results
function parsePaginator(html) {
  const pag = html.match(/class="paginator"[\s\S]*?<\/p>/i);
  if (!pag) return null;
  const nums = [...pag[0].matchAll(/[?&]p=(\d+)/g)].map((m) => parseInt(m[1], 10));
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
  for (const m of pag[0].matchAll(/href="([^"]*?[?&]p=(\d+))"/gi)) {
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

function rateLabel(score) {
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Good";
  if (score >= 40) return "Average";
  if (score >= 20) return "Weak";
  return "Poor";
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
        `${score} (${rateLabel(score)})`,
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

async function scrapePaged(url, maxPages, onPage) {
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
    if (!wantAll && page > maxPages) break;
    if (wantAll && totalPages && page > totalPages) break;

    const html = await fetchScreener(current);
    const pag = parsePaginator(html);
    if (pag) {
      totalPages = pag.totalPages;
      totalResults = pag.totalResults;
    }
    if (onPage) onPage({ page, pageUrl: current, totalPages, totalResults });

    const blocks = parseResultsBlocks(html);
    let next = null;
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
      allRows.push(...flat);
      if (!pag) break;
    } else {
      const main = pickMainTable(parseTables(html));
      if (!main || !main.rows.length) break;
      if (!headers) headers = main.headers.map((h) => h || `(col)`);
      for (const r of main.rows) {
        const values = r.arrows.slice(0, headers.length);
        while (values.length < headers.length) values.push("");
        allRows.push({ url: makeAbsolute(current, r.href), values });
      }
    }

    next = resolveNextPagination(html, current) || resolvePaginatorNext(html, current, page);
    if (!next) break;
    if (next.split("#")[0] === current.split("#")[0]) break;
    current = next;
    page++;
    if (wantAll && totalPages && page > totalPages) break;
  }

  return { headers: headers || [], rows: allRows, totalPages, totalResults, endPage: page };
}

function looksLikeLoginWall(html) {
  return /Get a free account|Already registered/i.test(html) && !/<table\b/i.test(html);
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

async function writeToSheet(spreadsheetId, tabName, headers, rows, mode) {
  const { sheet, created } = await ensureWorksheet(spreadsheetId, tabName);
  const title = sheet.properties.title;
  const headerRow = headers.map((h, i) => (h === "(col)" ? `Column ${i + 1}` : h));
  const lastCol = columnLetter(Math.max(headers.length, 1));
  const dedupeIdx = headers && headers[0] === "S.No" ? 1 : 0;
  let merged = dedupeRows(rows, dedupeIdx);
  let written = 0;
  let skipped = rows.length - merged.length;

  if (created || mode === "replace") {
    await clearValues(spreadsheetId, `${title}!A1:ZZ50000`);
    const values = [headerRow, ...merged.map((r) => r.values)];
    if (merged.length) {
      await updateValues(spreadsheetId, `${title}!A1:${lastCol}${values.length}`, values);
    } else {
      await updateValues(spreadsheetId, `${title}!A1:${lastCol}1`, [headerRow]);
    }
    written = merged.length;
  } else {
    // append mode
    const start = await firstEmptyRow(spreadsheetId, title);
    if (start === 0) {
      await updateValues(spreadsheetId, `${title}!A1:${lastCol}1`, [headerRow]);
    }
    const keyCol = columnLetter(dedupeIdx + 1);
    const existing =
      start > 0 ? await getValues(spreadsheetId, `${title}!${keyCol}1:${keyCol}${start}`) : [];
    const existingKeys = new Set(existing.map((r) => r[0]).filter(Boolean));
    const fresh = merged.filter((r) => !existingKeys.has(r.values[dedupeIdx]));
    skipped = merged.length - fresh.length;
    if (fresh.length) {
      const dataStart = start === 0 ? 2 : start + 1;
      const values = fresh.map((r) => r.values);
      await updateValues(
        spreadsheetId,
        `${title}!A${dataStart}:${lastCol}${dataStart + values.length - 1}`,
        values
      );
    }
    written = fresh.length;
  }
  return { tabName: title, created, written, skipped };
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
  onProgress({
    type: "progress",
    status: "fetch",
    label: item.label,
    message: `Fetching ${item.url}`,
  });
  let { headers, rows } = await scrapePaged(item.url, maxPages, (p) =>
    onProgress({
      type: "progress",
      status: "fetch",
      label: item.label,
      page: p.page,
      message: `Page ${p.page}${p.totalPages ? `/${p.totalPages}` : ""}${p.totalResults ? ` (${p.totalResults} results)` : ""} — ${p.pageUrl}`,
    })
  );
  if (!rows.length) {
    throw new Error(
      "No rows extracted. Screener may require login — open (or reload) a logged-in Screener.in tab, then retry."
    );
  }
  onProgress({
    type: "progress",
    status: "write",
    label: item.label,
    message: `Writing ${rows.length} rows to tab "${item.label}"...`,
  });
  return writeToSheet(spreadsheetId, item.label, headers, rows, mode);
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
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
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
  const resp = await chrome.tabs.sendMessage(tab.id, {
    type: "login",
    email,
    password,
  });
  return { created, ...resp };
}

async function screenerLoginCheck() {
  const tab = await screenerTab();
  if (!tab) {
    return { noTab: true, loggedIn: false, message: "No Screener.in tab open — use the Login button to open one." };
  }
  await ensureContentScriptInjected(tab.id);
  return chrome.tabs
    .sendMessage(tab.id, { type: "check_login" })
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
    const ck = await chrome.tabs
      .sendMessage(tab.id, { type: "check_login" })
      .catch(() => null);
    if (ck && ck.loggedIn) return null;
    const r = await chrome.tabs
      .sendMessage(tab.id, {
        type: "login",
        email: st.screenerEmail,
        password: st.screenerPassword,
      })
      .catch(() => null);
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
        const result = await scrapeToSheet(
          msg.spreadsheetId,
          msg.item,
          msg.mode || "replace",
          Math.max(1, msg.maxPages || 1),
          (p) => port.postMessage(p)
        );
        port.postMessage({ type: "complete", result });
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
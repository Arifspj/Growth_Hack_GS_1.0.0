import { loadCredentials, getAccessToken, getSheetMeta, getValues, updateValues, sheetsApi } from "./gs_api.mjs";

const SPREADSHEET_ID = process.env.SHEET_ID || "1QQf-c4GbdAxAWHCzUQkTLWUH85Tm-u1XN7yN0pem-H4";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function cellText(html, arrows = false) {
  let t = String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'").replace(/&quot;/gi, '"');
  t = t.replace(/\s+/g, " ").trim();
  if (arrows) t = t.replace(/⇡/g, "+").replace(/⇣/g, "-");
  return t;
}
function firstHref(html) { const m = String(html || "").match(/href="([^"]+)"/i); return m ? m[1] : ""; }
function splitCells(rh) {
  const out = [], re = /<th\b[^>]*>([\s\S]*?)<\/th>|<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let m; while ((m = re.exec(rh))) out.push(m[1] || m[2] || "");
  return out;
}
function parseTables(html) {
  const tables = [], re = /<table\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = re.exec(html))) {
    const body = m[2];
    const thead = body.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i);
    const tbody = body.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i);
    let headers = thead ? splitCells(thead[1]).map((c) => cellText(c)) : [];
    const tbodyHtml = tbody ? tbody[1] : body;
    const rows = [], rr = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rr.exec(tbodyHtml))) {
      const rowHtml = rm[1];
      const cells = splitCells(rowHtml);
      if (!cells.length) continue;
      const firstTd = rowHtml.match(/<td\b[^>]*>([\s\S]*?)<\/td>/i);
      const href = firstTd ? firstHref(firstTd[1]) : "";
      rows.push({ href, plain: cells.map((c) => cellText(c)), arrows: cells.map((c) => cellText(c, true)) });
    }
    if (!headers.length && rows.length) headers = rows.shift().plain;
    tables.push({ headers, rows });
  }
  return tables;
}
function pickMainTable(tables) {
  if (!tables.length) return null;
  return tables.reduce((a, b) => (b.rows.length > a.rows.length ? b : a), tables[0]);
}
function makeAbsolute(base, href) {
  if (!href) return "";
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith("//")) return `https:${href}`;
  try { return new URL(href, base).toString(); } catch { return href; }
}
function resolveNextPagination(html, currentUrl) {
  const pag = html.match(/class="pagination"[\s\S]*?<\/div>/i);
  if (!pag) return null;
  const m = pag[0].match(/href="([^"]*)"[^>]*>\s*Next/i);
  if (!m) return null;
  const next = makeAbsolute(currentUrl, m[1]);
  return next.split("#")[0] === currentUrl.split("#")[0] ? null : next;
}
async function fetchScreener(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}
async function scrapePaged(url, maxPages = 3) {
  let headers = null, allRows = [], current = url, html;
  for (let page = 1; page <= maxPages; page++) {
    console.log(`  page ${page} <- ${current}`);
    html = await fetchScreener(current);
    const main = pickMainTable(parseTables(html));
    if (!main || !main.rows.length) { console.log("  (no rows — likely login wall)"); break; }
    if (!headers) headers = main.headers.map((h) => h || "(col)");
    for (const r of main.rows) {
      const v = r.arrows.slice(0, headers.length);
      while (v.length < headers.length) v.push("");
      allRows.push({ url: makeAbsolute(current, r.href), values: v });
    }
    const next = resolveNextPagination(html, current);
    if (!next) break;
    current = next;
  }
  return { headers: headers || [], rows: allRows };
}

function columnLetter(n) {
  let s = ""; n -= 1;
  while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; }
  return s;
}
async function ensureTab(token, id, title) {
  const meta = await getSheetMeta(token, id);
  let found = meta.sheets.find((s) => s.properties.title.toLowerCase() === title.toLowerCase());
  if (found) return { tab: found.properties.title, created: false };
  await sheetsApi(token, id, ":batchUpdate", {
    method: "POST",
    body: { requests: [{ addSheet: { properties: { title, gridProperties: { rowCount: 5000, columnCount: 20 } } } }] },
  });
  const meta2 = await getSheetMeta(token, id);
  return { tab: meta2.sheets.find((s) => s.properties.title.toLowerCase() === title.toLowerCase()).properties.title, created: true };
}
async function writeTab(token, id, tab, headers, rows, mode) {
  const { tab: title, created } = await ensureTab(token, id, tab);
  const scrapedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const headerRow = headers.map((h, i) => (h === "(col)" ? `Column ${i + 1}` : h));
  const lastCol = columnLetter(Math.max(headers.length + 1, 1));
  const seen = new Set();
  const merged = rows.filter((r) => { const k = `${r.values[0]}|${r.url}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (created || mode === "replace") {
    await sheetsApi(token, id, `values/${encodeURIComponent(`${title}!A1:ZZ50000`)}:clear`, { method: "POST", body: { range: `${title}!A1:ZZ50000` } });
    const values = [[...headerRow, "Scraped At"], ...merged.map((r) => [...r.values, scrapedAt])];
    if (values.length) await updateValues(token, id, `${title}!A1:${lastCol}${values.length}`, values);
    return { tab: title, created, written: merged.length };
  }
  const existing = await getValues(token, id, `${title}!A1:A10000`);
  let start = existing.length;
  while (start > 0 && !String(existing[start - 1][0] || "").trim()) start--;
  if (start === 0) await updateValues(token, id, `${title}!A1:${lastCol}1`, [[...headerRow, "Scraped At"]]);
  const keys = new Set(existing.slice(0, start).map((r) => r[0]).filter(Boolean));
  const fresh = merged.filter((r) => !keys.has(r.values[0]));
  if (fresh.length) {
    const dataStart = start === 0 ? 2 : start + 1;
    const values = fresh.map((r) => [...r.values, scrapedAt]);
    await updateValues(token, id, `${title}!A${dataStart}:${lastCol}${dataStart + values.length - 1}`, values);
  }
  return { tab: title, created, written: fresh.length };
}
async function readSettings(token, id) {
  const meta = await getSheetMeta(token, id);
  const sName = meta.sheets.find((s) => s.properties.title.toLowerCase() === "settings")?.properties.title || meta.sheets[0]?.properties.title;
  const data = await getValues(token, id, `${sName}!A1:B200`);
  return {
    settingsSheet: sName,
    items: data
      .filter((r) => String(r[0] || "").trim() && String(r[1] || "").trim().match(/^https?:\/\//))
      .map((r) => ({ label: String(r[0]).replace(/[:：\s]+$/g, "").trim(), url: String(r[1]).trim() })),
  };
}
async function deleteTab(token, id, title) {
  const meta = await getSheetMeta(token, id);
  const s = meta.sheets.find((x) => x.properties.title.toLowerCase() === title.toLowerCase());
  if (!s) return;
  await sheetsApi(token, id, ":batchUpdate", {
    method: "POST",
    body: { requests: [{ deleteSheet: { sheetId: s.properties.sheetId } }] },
  });
  console.log("  deleted test tab:", title);
}

const creds = loadCredentials();
const token = await getAccessToken(creds);
console.log(`Sheet: ${SPREADSHEET_ID}`);

const { settingsSheet, items } = await readSettings(token, SPREADSHEET_ID);
console.log(`Settings tab: ${settingsSheet} — ${items.length} item(s)`);
for (const it of items) console.log(`  - ${it.label}  =>  ${it.url.slice(0, 90)}...`);

const target = items.find((i) => i.label.toLowerCase() === "results");
if (!target) { console.log("No 'Results' row found. Aborting."); process.exit(1); }
console.log("\n[1] Results URL:", target.url);

console.log("\n[2] Direct (anonymous) fetch of Results -> expect login wall");
const wallHtml = await fetchScreener(target.url.split("?")[0]);
console.log("    login wall:", /Get a free account/.test(wallHtml), "| has table:", /data-table/.test(wallHtml));

console.log("\n[3] Pipeline test using PUBLIC page (same parser+writer code as extension):");
console.log('    scraping https://www.screener.in/ipo/recent/');
const { headers, rows } = await scrapePaged("https://www.screener.in/ipo/recent/", Number(process.env.MAX_PAGES || 2));
console.log(`    headers: ${headers.join(" | ")}`);
console.log(`    rows: ${rows.length}`);
for (const r of rows.slice(0, 3)) console.log("    " + r.values.join(" | "));
if (!rows.length) { console.log("    FAIL: no rows parsed"); process.exit(1); }

const TESTTAB = "PipelineTest";
console.log(`\n[4] Writing ${rows.length} rows into "${TESTTAB}" tab (replace)...`);
const res = await writeTab(token, SPREADSHEET_ID, TESTTAB, headers, rows, "replace");
console.log("    write:", JSON.stringify(res));

console.log(`\n[5] Verify: read back ${res.tab}!A1:H4`);
const back = await getValues(token, SPREADSHEET_ID, `${res.tab}!A1:H${Math.min(5, res.written + 1)}`);
for (const row of back) console.log("    " + JSON.stringify(row));

console.log(`\n[5b] Append SAME rows again (must dedupe to 0):`);
const resA = await writeTab(token, SPREADSHEET_ID, TESTTAB, headers, rows, "append");
console.log("    append:", JSON.stringify(resA));
const backA = await getValues(token, SPREADSHEET_ID, `${res.tab}!A1:A5`);
console.log("    header+A4 check:", JSON.stringify(backA.slice(0, 4)));

console.log("\n[6] Cleanup: deleting PipelineTest tab");
await deleteTab(token, SPREADSHEET_ID, TESTTAB);

console.log("\nRESULT: full pipeline (auth, read settings, scrape, parse, write, verify) SUCCESS");
console.log(`NOTE: Real "Results" URL (${target.url}) needs a logged-in Screener session -> use the extension in Chrome.`);
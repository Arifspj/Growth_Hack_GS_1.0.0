import { loadCredentials, getAccessToken, getSheetMeta, getValues } from "./gs_api.mjs";

const SPREADSHEET_ID = "1QQf-c4GbdAxAWHCzUQkTLWUH85Tm-u1XN7yN0pem-H4";

const creds = loadCredentials();
const token = await getAccessToken(creds);

const meta = await getSheetMeta(token, SPREADSHEET_ID);
console.log("=== SHEETS ===");
for (const s of meta.sheets) {
  console.log(`- "${s.properties.title}" (id=${s.properties.sheetId}, rows=${s.properties.gridProperties.rowCount}, cols=${s.properties.gridProperties.columnCount})`);
}

const firstSheet = meta.sheets[0].properties.title;
const values = await getValues(token, SPREADSHEET_ID, `${firstSheet}!A1:B40`);
console.log(`\n=== SETTINGS TAB ("${firstSheet}") A1:B40 ===`);
values.forEach((row, i) => {
  console.log(`${i + 1}\t${JSON.stringify(row)}`);
});
console.log("total rows:", values.length);
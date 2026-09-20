import { readFileSync } from "node:fs";
import { createPrivateKey, createSign } from "node:crypto";

export function loadCredentials(path = "service_account.json") {
  return JSON.parse(readFileSync(path, "utf8"));
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

export async function getAccessToken(creds, scope = "https://www.googleapis.com/auth/spreadsheets") {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: creds.client_email,
    scope,
    aud: creds.token_uri,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const key = createPrivateKey(creds.private_key);
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(key);
  const assertion = `${signingInput}.${b64url(signature)}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetch(creds.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Token request failed ${res.status}: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

export async function sheetsApi(token, spreadsheetId, path, { method = "GET", body } = {}) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) {
    throw new Error(`Sheets API ${res.status} ${path}: ${JSON.stringify(data)}`);
  }
  return data;
}

export async function getSheetMeta(token, spreadsheetId) {
  return sheetsApi(token, spreadsheetId, "");
}

export async function getValues(token, spreadsheetId, range) {
  const data = await sheetsApi(token, spreadsheetId, `values/${encodeURIComponent(range)}`);
  return data.values || [];
}

export async function updateValues(token, spreadsheetId, range, values, raw = true) {
  return sheetsApi(
    token,
    spreadsheetId,
    `values/${encodeURIComponent(range)}?valueInputOption=${raw ? "RAW" : "USER_ENTERED"}`,
    {
      method: "PUT",
      body: { range, majorDimension: "ROWS", values },
    }
  );
}
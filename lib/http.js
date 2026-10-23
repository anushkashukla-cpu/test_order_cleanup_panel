export function send(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

export function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.setHeader("Cache-Control", "no-store");
  res.end();
}

export function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip bad cookie */ }
    }
  }
  return out;
}

export function setCookie(res, name, value, maxAgeSeconds) {
  const c = name + "=" + encodeURIComponent(value) +
    "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + maxAgeSeconds;
  const prev = res.getHeader("Set-Cookie");
  res.setHeader("Set-Cookie", prev ? [].concat(prev, c) : c);
}

export function query(req) {
  if (req.query) return req.query;
  return Object.fromEntries(new URL(req.url, "http://x").searchParams);
}

export async function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

// Browsers send Origin on POST; refuse requests made from other websites.
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

export function baseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  return proto + "://" + req.headers.host;
}

// Today's date in India, "YYYY-MM-DD".
export function todayIST() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

// Checks a "since" date: "YYYY-MM-DD", not in the future, within maxDays.
// Returns an error message, or "" when the date is fine.
export function checkSince(since, maxDays) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(since || ""))) return "Pick a date.";
  const today = todayIST();
  if (since > today) return "The date can't be in the future.";
  const oldest = new Date(Date.parse(today + "T00:00:00Z") - maxDays * 86400 * 1000).toISOString().slice(0, 10);
  if (since < oldest) return "Pick a date within the last " + maxDays + " days.";
  return "";
}

export function requestId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
}

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { cookies, setCookie, send, sameOrigin } from "./http.js";
import { permissions, GhError } from "./github.js";

const COOKIE = "toc_session";
const HOURS = 8;

function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new GhError(500, "The website is missing SESSION_SECRET (at least 32 characters).");
  return createHash("sha256").update(secret).digest();
}

export function seal(obj) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64url");
}

export function unseal(s) {
  try {
    const buf = Buffer.from(String(s), "base64url");
    const d = createDecipheriv("aes-256-gcm", key(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
  } catch {
    return null;
  }
}

export function startSession(res, { token, login, avatar }) {
  setCookie(res, COOKIE, seal({ token, login, avatar, exp: Date.now() + HOURS * 3600 * 1000 }), HOURS * 3600);
}

export function endSession(res) {
  setCookie(res, COOKIE, "", 0);
}

export function getSession(req) {
  const raw = cookies(req)[COOKIE];
  if (!raw) return null;
  const s = unseal(raw);
  if (!s || !s.token || !s.exp || s.exp < Date.now()) return null;
  return s;
}

// Returns the session of a signed-in repository collaborator (Write access
// or more), or sends 401/403 and returns null. POSTs must come from this site.
export async function requireAdmin(req, res) {
  const s = getSession(req);
  if (!s) { send(res, 401, { error: "Sign in with GitHub to use the admin page." }); return null; }
  if (req.method !== "GET" && !sameOrigin(req)) { send(res, 403, { error: "Request blocked: it didn't come from this website." }); return null; }
  let perms;
  try {
    perms = await permissions(s.token);
  } catch (e) {
    if (e.status === 401) { endSession(res); send(res, 401, { error: "Your GitHub sign-in expired. Sign in again." }); return null; }
    if (e.status === 404 || e.status === 403) { send(res, 403, { error: "Your GitHub account doesn't have access to the cleanup repository. Ask the owner to add you as a collaborator." }); return null; }
    throw e;
  }
  if (!perms.push && !perms.admin) {
    send(res, 403, { error: "Your GitHub account can see the repository but needs Write access. Ask the owner to change your role." });
    return null;
  }
  return { ...s, perms };
}

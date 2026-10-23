// GitHub sign-in for the admin page.
//   /api/auth/login     -> sends the person to GitHub
//   /api/auth/callback  -> GitHub sends them back here
//   /api/auth/logout    -> signs out
import { randomBytes } from "node:crypto";
import { query, redirect, cookies, setCookie, baseUrl, send } from "../lib/http.js";
import { startSession, endSession } from "../lib/session.js";

const STATE_COOKIE = "toc_oauth_state";

export default async function handler(req, res) {
  const a = query(req).a;
  try {
    if (a === "login") return login(req, res);
    if (a === "callback") return await callback(req, res);
    if (a === "logout") { endSession(res); return redirect(res, "/admin"); }
    return send(res, 404, { error: "Not found" });
  } catch (e) {
    return redirect(res, "/admin?error=" + encodeURIComponent(e.message || "Sign-in failed."));
  }
}

function login(req, res) {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) return redirect(res, "/admin?error=" + encodeURIComponent("The website is missing GITHUB_OAUTH_CLIENT_ID."));
  const state = randomBytes(16).toString("hex");
  setCookie(res, STATE_COOKIE, state, 600);
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", baseUrl(req) + "/api/auth/callback");
  // repo: start runs and change settings on the private repo; workflow: change the schedule.
  u.searchParams.set("scope", "repo workflow");
  u.searchParams.set("state", state);
  u.searchParams.set("allow_signup", "false");
  return redirect(res, u.toString());
}

async function callback(req, res) {
  const q = query(req);
  const expected = cookies(req)[STATE_COOKIE];
  setCookie(res, STATE_COOKIE, "", 0);
  if (q.error) return redirect(res, "/admin?error=" + encodeURIComponent("GitHub sign-in was cancelled."));
  if (!q.code || !q.state || !expected || q.state !== expected) {
    return redirect(res, "/admin?error=" + encodeURIComponent("Sign-in expired. Try again."));
  }
  const r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_OAUTH_CLIENT_ID,
      client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
      code: q.code,
      redirect_uri: baseUrl(req) + "/api/auth/callback",
    }),
  });
  const t = await r.json().catch(() => ({}));
  if (!t.access_token) {
    return redirect(res, "/admin?error=" + encodeURIComponent("GitHub didn't accept the sign-in (" + (t.error || r.status) + "). Check the OAuth app settings."));
  }
  const u = await fetch("https://api.github.com/user", {
    headers: { Authorization: "Bearer " + t.access_token, Accept: "application/vnd.github+json", "User-Agent": "test-order-cleanup-panel" },
  });
  const me = await u.json().catch(() => ({}));
  startSession(res, { token: t.access_token, login: me.login || "", avatar: me.avatar_url || "" });
  return redirect(res, "/admin");
}

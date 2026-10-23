// Public self-service API (no login). Uses the website's own GitHub token.
//   POST /api/public?a=delete   { name, phone, since }  -> { requestId }
//   GET  /api/public?a=status&request=<id>              -> { state, result }
//   POST /api/public?a=request  { phone, name, since }  -> { approvalId }  (number not approved yet)
//   GET  /api/public?a=approval&id=<approvalId>         -> { state: pending|approved|rejected, requestId? }
// Safety: only numbers on self_service_phone_numbers are accepted, and the
// run only ever deletes orders from the numbers typed in (never the name list).
import { randomBytes } from "node:crypto";
import { query, body, send, sameOrigin, checkSince, requestId, cleanName, baseUrl } from "../lib/http.js";
import {
  dispatch, listRuns, findRunByRequest, runState, readReport, getFile, ACCOUNTS_PATH, GhError,
  openRequests, createRequest, getRequest, requestRun,
} from "../lib/github.js";
import { normalizePhone, splitPhones, readList } from "../lib/phones.js";

const MAX_PHONES = 3;
const MAX_DAYS = 90;
const MAX_DELETIONS = 100;
const MAX_ACTIVE = 3; // self-service runs allowed at the same time
const MAX_OPEN_REQUESTS = 20;

function serverToken() {
  const t = process.env.GITHUB_SERVER_TOKEN;
  if (!t) throw new GhError(500, "The website is missing GITHUB_SERVER_TOKEN.");
  return t;
}

export default async function handler(req, res) {
  const a = query(req).a;
  try {
    if (req.method === "POST" && a === "delete") return await deleteMine(req, res);
    if (req.method === "GET" && a === "status") return await status(req, res);
    if (req.method === "POST" && a === "request") return await askApproval(req, res);
    if (req.method === "GET" && a === "approval") return await approval(req, res);
    return send(res, 404, { error: "Not found" });
  } catch (e) {
    if (e instanceof GhError && (e.status === 401 || e.status === 403 || e.status === 404)) {
      return send(res, 500, { error: "The website can't reach the cleanup on GitHub right now. Tell the admin (GitHub said: " + e.message + ")." });
    }
    return send(res, e.status && e.status >= 400 && e.status < 600 ? e.status : 500, { error: e.message || "Something went wrong." });
  }
}

async function deleteMine(req, res) {
  if (!sameOrigin(req)) return send(res, 403, { error: "Request blocked: it didn't come from this website." });
  const b = await body(req);
  const typed = splitPhones(b.phone);
  if (!typed.length) return send(res, 400, { error: "Enter your phone number." });
  if (typed.length > MAX_PHONES) return send(res, 400, { error: "Enter at most " + MAX_PHONES + " numbers at a time." });
  const phones = typed.map(normalizePhone);
  const bad = typed.filter((p, i) => !phones[i]);
  if (bad.length) return send(res, 400, { error: "Not a 10-digit phone number: " + bad.join(", ") });
  const sinceErr = checkSince(b.since, MAX_DAYS);
  if (sinceErr) return send(res, 400, { error: sinceErr });
  const name = cleanName(b.name);
  if (name.length < 2) return send(res, 400, { error: "Enter your name, so the history shows who deleted these orders." });

  const token = serverToken();
  const approved = await approvedNumbers(token);
  const notApproved = phones.filter((p) => !approved.has(p));
  if (notApproved.length) {
    return send(res, 403, {
      code: "not_approved",
      numbers: notApproved,
      error: (notApproved.length === 1 ? notApproved[0] + " isn't" : notApproved.join(", ") + " aren't") +
        " approved for test cleanup yet.",
    });
  }

  const active = (await listRuns(token, { perPage: 30, event: "workflow_dispatch" }))
    .filter((r) => r.status !== "completed" && r.title.includes("by Self-service"));
  if (active.length >= MAX_ACTIVE) {
    return send(res, 429, { error: "A few cleanups are already running. Try again in two minutes." });
  }

  const id = requestId();
  await dispatch(token, {
    dry_run: "false",
    since_date: b.since,
    max_deletions: MAX_DELETIONS,
    phone_numbers: phones.join(", "),
    self_service: "true",
    requested_by: "Self-service: " + name + " (" + phones.join(", ") + ")",
    request_id: id,
  });
  return send(res, 200, { requestId: id });
}

// Approved numbers -> the name noted next to them (or the number itself).
async function approvedNumbers(token) {
  const f = await getFile(token, ACCOUNTS_PATH);
  const m = new Map();
  for (const x of readList(f.text, "self_service_phone_numbers")) {
    const n = normalizePhone(x.value);
    if (n) m.set(n, cleanName(x.label.replace(/^added by .*/i, "")) || n);
  }
  return m;
}

async function askApproval(req, res) {
  if (!sameOrigin(req)) return send(res, 403, { error: "Request blocked: it didn't come from this website." });
  const b = await body(req);
  const phone = normalizePhone(b.phone);
  if (!phone || splitPhones(b.phone).length !== 1) return send(res, 400, { error: "Enter one 10-digit phone number to request approval." });
  const name = cleanName(b.name);
  if (name.length < 2) return send(res, 400, { error: "Enter your name so the admin knows who's asking." });
  const sinceErr = checkSince(b.since, MAX_DAYS);
  if (sinceErr) return send(res, 400, { error: sinceErr });

  const token = serverToken();
  if ((await approvedNumbers(token)).has(phone)) {
    return send(res, 409, { code: "approved", error: phone + " is already approved. Click Delete my test orders." });
  }
  const open = await openRequests(token);
  const existing = open.find((x) => x.req.phone === phone);
  if (existing) {
    return send(res, 200, { approvalId: existing.issue.number + "-" + existing.req.token, existing: true });
  }
  if (open.length >= MAX_OPEN_REQUESTS) {
    return send(res, 429, { error: "There are a lot of requests waiting. Ask the admin directly." });
  }
  const tok = randomBytes(8).toString("hex");
  const issue = await createRequest(token, { phone, name, since: b.since, token: tok, at: new Date().toISOString() }, baseUrl(req) + "/admin");
  return send(res, 200, { approvalId: issue.number + "-" + tok });
}

async function approval(req, res) {
  const m = String(query(req).id || "").match(/^(\d{1,9})-([0-9a-f]{16})$/);
  if (!m) return send(res, 400, { error: "Bad request id." });
  const token = serverToken();
  let r;
  try { r = await getRequest(token, m[1]); } catch (e) { if (e.status === 404) return send(res, 404, { error: "Request not found." }); throw e; }
  if (!r.req || r.req.token !== m[2]) return send(res, 404, { error: "Request not found." });
  if (r.issue.state === "open") return send(res, 200, { state: "pending", phone: r.req.phone, since: r.req.since });
  const run = await requestRun(token, m[1]);
  if (run && run.requestId) return send(res, 200, { state: "approved", requestId: run.requestId, phone: r.req.phone });
  return send(res, 200, { state: "rejected", phone: r.req.phone });
}

async function status(req, res) {
  const id = String(query(req).request || "");
  if (!/^[0-9a-f]{12}$/.test(id)) return send(res, 400, { error: "Bad request id." });
  const token = serverToken();
  const run = await findRunByRequest(token, id);
  if (run && !run.title.includes("by Self-service")) return send(res, 404, { error: "Not found." });
  const state = runState(run);
  let result = null;
  if (run && (state === "done" || state === "failed")) {
    const rep = await readReport(token, run.id);
    if (rep) {
      result = {
        deleted: rep.deleted, failed: rep.failed, matched: rep.matched, error: rep.error || "",
        rows: (rep.rows || []).map((r) => ({ system: r.system, order: r.order_number, action: r.action, error: r.error || "" })),
      };
    }
  }
  return send(res, 200, { state, result });
}

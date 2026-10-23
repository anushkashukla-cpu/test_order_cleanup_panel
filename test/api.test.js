// Runs the API handlers against a fake GitHub. node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { zipSync, strToU8 } from "fflate";

process.env.GITHUB_REPO_OWNER = "anushkashukla-cpu";
process.env.GITHUB_REPO_NAME = "Test_Orders_Cleanup";
process.env.GITHUB_SERVER_TOKEN = "server-token";
process.env.GITHUB_OAUTH_CLIENT_ID = "cid";
process.env.GITHUB_OAUTH_CLIENT_SECRET = "csecret";
process.env.SESSION_SECRET = "x".repeat(40);

const { default: admin } = await import("../api/admin.js");
const { default: pub } = await import("../api/public.js");
const { default: auth } = await import("../api/auth.js");
const { seal } = await import("../lib/session.js");
const { readList, writeList, normalizePhone } = await import("../lib/phones.js");
const { checkSince, todayIST } = await import("../lib/http.js");

const BASE = "/repos/anushkashukla-cpu/Test_Orders_Cleanup";
let state;
function reset() {
  state = {
    files: {
      "config/test_accounts.yaml": readFileSync("test/accounts.yaml", "utf8").replace("self_service_phone_numbers:", 'self_service_phone_numbers:\n  - "9876543210"   # Himanshu'),
      ".github/workflows/cleanup.yml": readFileSync("test/workflow.yml", "utf8"),
    },
    vars: {}, dispatches: [], puts: [], calls: [],
    perms: { "user-token": { push: true, admin: false }, "viewer-token": { push: false, pull: true } },
    runs: [], issues: [], comments: {},
    history: {
      "history/2026-10/20261020T100000Z-1.json": { time: "2026-10-20T10:00:00Z", who: "Schedule", mode: "schedule", run_url: "u1", rows: [{ system: "zoho", order_number: "HR/26/1", action: "deleted" }] },
      "history/2026-10/20261022T100000Z-2.json": { time: "2026-10-22T10:00:00Z", who: "anushka", mode: "admin", run_url: "u2", rows: [{ system: "shopify", order_number: "HR/26/2", action: "deleted" }] },
    },
    zip: zipSync({ "report.json": strToU8(JSON.stringify({ dry_run: true, matched: 1, deleted: 1, failed: 0, rows: [{ system: "shopify", order_number: "HR/26/1", customer: "Dev <9876543210@home-run.co>", matched_name: "phone 9876543210", action: "would_delete" }] })) }),
  };
}
const J = (status, data) => ({ ok: status < 300, status, json: async () => data, arrayBuffer: async () => data });
global.fetch = async (url, opts = {}) => {
  const method = opts.method || "GET";
  const auth = (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || "";
  const token = auth.replace("Bearer ", "");
  const body = opts.body ? JSON.parse(opts.body) : null;
  state.calls.push({ method, url, token, body });
  if (url === "https://github.com/login/oauth/access_token") return J(200, body.code === "good" ? { access_token: "user-token" } : { error: "bad_verification_code" });
  if (url === "https://blob.example/report.zip") return { ok: true, status: 200, arrayBuffer: async () => state.zip.buffer.slice(state.zip.byteOffset, state.zip.byteOffset + state.zip.byteLength) };
  const path = url.replace("https://api.github.com", "");
  if (path === "/user") return J(200, { login: "anushka", avatar_url: "a.png" });
  if (path === BASE) {
    if (!(token in state.perms) && token !== "server-token") return J(401, { message: "Bad credentials" });
    return J(200, { permissions: state.perms[token] || { push: true } });
  }
  if (path === BASE + "/git/trees/history?recursive=1") {
    if (state.noHistory) return J(404, { message: "Not Found" });
    return J(200, { tree: [{ type: "tree", path: "history" }, ...Object.keys(state.history).map((p) => ({ type: "blob", path: p })), { type: "blob", path: "README.md" }] });
  }
  const hf = path.match(/\/contents\/(history\/.+)\?ref=history$/);
  if (hf) return J(200, { content: Buffer.from(JSON.stringify(state.history[hf[1]])).toString("base64") });
  if (path.startsWith(BASE + "/issues")) {
    const m = path.match(/\/issues(?:\/(\d+))?(\/comments)?/);
    const n = m[1] && Number(m[1]);
    if (!n && method === "POST") { const i = { number: state.issues.length + 1, state: "open", title: body.title, body: body.body, html_url: "issue" + (state.issues.length + 1), created_at: "2026-10-23T10:00:00Z" }; state.issues.push(i); return J(201, i); }
    if (!n) return J(200, [...state.issues.filter((i) => i.state === "open"), { number: 99, state: "open", body: "x", pull_request: {} }]);
    const issue = state.issues.find((i) => i.number === n);
    if (!issue) return J(404, { message: "Not Found" });
    if (m[2] && method === "POST") { (state.comments[n] ||= []).push({ body: body.body }); return J(201, {}); }
    if (m[2]) return J(200, state.comments[n] || []);
    if (method === "PATCH") { Object.assign(issue, body); return J(200, issue); }
    return J(200, issue);
  }
  const f = path.match(/\/contents\/(.+?)(\?ref=main)?$/);
  if (f) {
    if (method === "GET") return J(200, { sha: "sha-" + f[1], content: Buffer.from(state.files[f[1]]).toString("base64") });
    state.files[f[1]] = Buffer.from(body.content, "base64").toString(); state.puts.push({ path: f[1], ...body }); return J(200, {});
  }
  if (path === BASE + "/actions/variables/DRY_RUN") {
    if (method === "GET") return "DRY_RUN" in state.vars ? J(200, { value: state.vars.DRY_RUN }) : J(404, { message: "Not Found" });
    if (!("DRY_RUN" in state.vars)) return J(404, {});
    state.vars.DRY_RUN = body.value; return J(204);
  }
  if (path === BASE + "/actions/variables" && method === "POST") { state.vars[body.name] = body.value; return J(201, {}); }
  if (path.endsWith("/dispatches")) { state.dispatches.push({ token, ...body }); return J(204); }
  if (path.includes("/actions/workflows/cleanup.yml/runs")) return J(200, { workflow_runs: state.runs });
  if (/\/actions\/runs\/\d+\/artifacts$/.test(path)) return J(200, { artifacts: [{ name: "report", expired: false, archive_download_url: "https://blob.example/report.zip" }] });
  return J(500, { message: "unexpected " + method + " " + path });
};

function req({ method = "GET", url, cookie = "", origin = "https://panel.test", body }) {
  return { method, url, headers: { host: "panel.test", cookie, origin, "x-forwarded-proto": "https" }, body };
}
function res() {
  const r = { statusCode: 200, headers: {}, body: "" };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.getHeader = (k) => r.headers[k.toLowerCase()];
  r.end = (b) => { r.body = b || ""; };
  r.json = () => JSON.parse(r.body || "{}");
  return r;
}
const sess = (token = "user-token") => "toc_session=" + encodeURIComponent(seal({ token, login: "anushka", avatar: "", exp: Date.now() + 3600e3 }));
async function call(handler, opts) { const r = res(); await handler(req(opts), r); return r; }
const since = () => new Date(Date.parse(todayIST() + "T00:00:00Z") - 5 * 86400e3).toISOString().slice(0, 10);

test("phones and yaml list editing", () => {
  assert.equal(normalizePhone("+91 98765-43210"), "9876543210");
  assert.equal(normalizePhone("9876543210@home-run.co"), "9876543210");
  assert.equal(normalizePhone("98765"), "");
  const y = 'a:\n  - "x"\nself_service_phone_numbers:\n  # note\n  - "9876543210"   # Him\n\nnext:\n  - "y"\n';
  assert.deepEqual(readList(y, "self_service_phone_numbers"), [{ value: "9876543210", label: "Him" }]);
  const w = writeList(y, "self_service_phone_numbers", [{ value: "9123456789", label: "Pri" }]);
  assert.deepEqual(readList(w, "self_service_phone_numbers"), [{ value: "9123456789", label: "Pri" }]);
  assert.deepEqual(readList(w, "next"), [{ value: "y", label: "" }]);
  assert.deepEqual(readList(w, "a"), [{ value: "x", label: "" }]);
  assert.ok(w.includes("# note"));
  const added = writeList("a:\n  - x\n", "self_service_phone_numbers", [{ value: "9", label: "" }]);
  assert.ok(added.endsWith('self_service_phone_numbers:\n  - "9"\n'));
  assert.equal(writeList(y, "self_service_phone_numbers", [{ value: 'bad"\nnum', label: "a#b" }]).includes('"badnum"   # a b'), true);
});

test("since date rules", () => {
  assert.equal(checkSince(todayIST(), 90), "");
  assert.match(checkSince("2099-01-01", 90), /future/);
  assert.match(checkSince("2020-01-01", 90), /last 90 days/);
  assert.match(checkSince("23/10/2026", 90), /Pick a date/);
});

test("admin: signed out, viewer, collaborator", async () => {
  reset();
  let r = await call(admin, { url: "/api/admin?a=me" });
  assert.deepEqual(r.json(), { signedIn: false });
  r = await call(admin, { url: "/api/admin?a=settings" });
  assert.equal(r.statusCode, 401);
  r = await call(admin, { url: "/api/admin?a=me", cookie: sess("viewer-token") });
  assert.equal(r.json().access, false);
  r = await call(admin, { url: "/api/admin?a=settings", cookie: sess("viewer-token") });
  assert.equal(r.statusCode, 403);
  r = await call(admin, { url: "/api/admin?a=me", cookie: sess("expired-token") });
  assert.deepEqual(r.json(), { signedIn: false });
  r = await call(admin, { url: "/api/admin?a=me", cookie: sess() });
  assert.equal(r.json().access, true);
  r = await call(admin, { url: "/api/admin?a=me", cookie: "toc_session=tampered" });
  assert.deepEqual(r.json(), { signedIn: false });
});

test("admin: settings toggle and schedule", async () => {
  reset();
  let r = await call(admin, { url: "/api/admin?a=settings", cookie: sess() });
  assert.deepEqual(r.json(), { autoDelete: false, everyHours: 2, allowedHours: [1, 2, 3, 4, 6, 8, 12, 24] });
  r = await call(admin, { method: "POST", url: "/api/admin?a=settings", cookie: sess(), body: { autoDelete: true }, origin: "https://evil.test" });
  assert.equal(r.statusCode, 403, "blocks other origins");
  r = await call(admin, { method: "POST", url: "/api/admin?a=settings", cookie: sess(), body: { autoDelete: true } });
  assert.equal(state.vars.DRY_RUN, "false");
  assert.equal(r.json().autoDelete, true);
  r = await call(admin, { method: "POST", url: "/api/admin?a=settings", cookie: sess(), body: { everyHours: 6 } });
  assert.equal(r.json().everyHours, 6);
  assert.match(state.files[".github/workflows/cleanup.yml"], /cron: "17 \*\/6 \* \* \*"/);
  assert.match(state.puts.at(-1).message, /every 6 hours \(by anushka\)/);
  r = await call(admin, { method: "POST", url: "/api/admin?a=settings", cookie: sess(), body: { everyHours: 5 } });
  assert.equal(r.statusCode, 400);
});

test("admin: preview run and report", async () => {
  reset();
  let r = await call(admin, { method: "POST", url: "/api/admin?a=run", cookie: sess(), body: { dryRun: true, since: since(), phones: "+91 91234 56789" } });
  assert.equal(r.statusCode, 200);
  const id = r.json().requestId;
  assert.match(id, /^[0-9a-f]{12}$/);
  const d = state.dispatches.at(-1);
  assert.equal(d.token, "user-token", "admin runs as the signed-in user");
  assert.deepEqual(d.inputs, { dry_run: "true", since_date: since(), max_deletions: "200", phone_numbers: "9123456789", self_service: "false", requested_by: "anushka", request_id: id });
  r = await call(admin, { url: "/api/admin?a=report&request=" + id, cookie: sess() });
  assert.equal(r.json().state, "queued");
  state.runs = [{ id: 77, display_title: "Preview by anushka #" + id, status: "completed", conclusion: "success", created_at: "2026-10-23T10:00:00Z", html_url: "u", event: "workflow_dispatch" }];
  r = await call(admin, { url: "/api/admin?a=report&request=" + id, cookie: sess() });
  assert.equal(r.json().state, "done");
  assert.equal(r.json().report.rows[0].order_number, "HR/26/1");
  r = await call(admin, { url: "/api/admin?a=report&run=77", cookie: sess() });
  assert.equal(r.json().report.matched, 1);
  r = await call(admin, { method: "POST", url: "/api/admin?a=run", cookie: sess(), body: { dryRun: false, since: "2099-01-01" } });
  assert.equal(r.statusCode, 400);
  r = await call(admin, { method: "POST", url: "/api/admin?a=run", cookie: sess(), body: { dryRun: false, since: since(), phones: "123" } });
  assert.equal(r.statusCode, 400);
  r = await call(admin, { method: "POST", url: "/api/admin?a=run", cookie: sess(), body: { dryRun: false, since: since() } });
  assert.equal(state.dispatches.at(-1).inputs.dry_run, "false");
  r = await call(admin, { url: "/api/admin?a=runs", cookie: sess() });
  assert.equal(r.json().runs[0].title, "Preview by anushka #" + id);
});

test("admin: approved numbers", async () => {
  reset();
  let r = await call(admin, { url: "/api/admin?a=numbers", cookie: sess() });
  assert.deepEqual(r.json().numbers, [{ number: "9876543210", label: "Himanshu" }]);
  r = await call(admin, { method: "POST", url: "/api/admin?a=numbers", cookie: sess(), body: { action: "add", number: "+91 91234 56789", label: "Priydarshi" } });
  assert.deepEqual(r.json().numbers.map((n) => n.number), ["9876543210", "9123456789"]);
  assert.match(state.puts.at(-1).message, /Allow 9123456789/);
  const yaml = state.files["config/test_accounts.yaml"];
  assert.ok(yaml.includes('test_customer_names:') && yaml.includes('"Testrik Roy"'), "other lists untouched");
  r = await call(admin, { method: "POST", url: "/api/admin?a=numbers", cookie: sess(), body: { action: "remove", number: "9876543210" } });
  assert.deepEqual(r.json().numbers.map((n) => n.number), ["9123456789"]);
  r = await call(admin, { method: "POST", url: "/api/admin?a=numbers", cookie: sess(), body: { action: "remove", number: "9876543210" } });
  assert.equal(r.statusCode, 404);
  r = await call(admin, { method: "POST", url: "/api/admin?a=numbers", cookie: sess(), body: { action: "add", number: "123" } });
  assert.equal(r.statusCode, 400);
});

test("public: approved number only, self-service run with server token", async () => {
  reset();
  let r = await call(pub, { method: "POST", url: "/api/public?a=delete", body: { name: "Himanshu Sharma", phone: "9123456789", since: since() } });
  assert.equal(r.statusCode, 403);
  assert.match(r.json().error, /isn't approved/);
  assert.equal(state.dispatches.length, 0);
  r = await call(pub, { method: "POST", url: "/api/public?a=delete", body: { name: "Himanshu Sharma", phone: "98765", since: since() } });
  assert.equal(r.statusCode, 400);
  r = await call(pub, { method: "POST", url: "/api/public?a=delete", body: { name: "Himanshu Sharma", phone: "9876543210", since: "2020-01-01" } });
  assert.equal(r.statusCode, 400);
  r = await call(pub, { method: "POST", url: "/api/public?a=delete", body: { name: "Himanshu Sharma", phone: "1,2,3,4", since: since() } });
  assert.equal(r.statusCode, 400);
  r = await call(pub, { method: "POST", url: "/api/public?a=delete", body: { name: "H", phone: "9876543210", since: since() } });
  assert.equal(r.statusCode, 400, "name required");
  assert.match(r.json().error, /name/);
  r = await call(pub, { method: "POST", url: "/api/public?a=delete", body: { name: "Himanshu Sharma", phone: "9876543210", since: since() }, origin: "https://evil.test" });
  assert.equal(r.statusCode, 403);
  r = await call(pub, { method: "POST", url: "/api/public?a=delete", body: { name: "Himanshu Sharma", phone: "+91 98765 43210", since: since() } });
  assert.equal(r.statusCode, 200);
  const id = r.json().requestId;
  const d = state.dispatches.at(-1);
  assert.equal(d.token, "server-token");
  assert.deepEqual(d.inputs, { dry_run: "false", since_date: since(), max_deletions: "100", phone_numbers: "9876543210", self_service: "true", requested_by: "Self-service: Himanshu Sharma (9876543210)", request_id: id });

  r = await call(pub, { url: "/api/public?a=status&request=" + id });
  assert.equal(r.json().state, "queued");
  state.runs = [{ id: 5, display_title: "Delete by Self-service #" + id, status: "completed", conclusion: "success", created_at: "x", html_url: "u" }];
  r = await call(pub, { url: "/api/public?a=status&request=" + id });
  const j = r.json();
  assert.equal(j.state, "done");
  assert.deepEqual(j.result.rows, [{ system: "shopify", order: "HR/26/1", action: "would_delete", error: "" }]);
  assert.ok(!JSON.stringify(j).includes("home-run.co"), "no emails on the public page");
  // admin run ids can't be read through the public endpoint
  state.runs = [{ id: 6, display_title: "Preview by anushka #" + id, status: "completed", conclusion: "success" }];
  r = await call(pub, { url: "/api/public?a=status&request=" + id });
  assert.equal(r.statusCode, 404);
  r = await call(pub, { url: "/api/public?a=status&request=../../x" });
  assert.equal(r.statusCode, 400);
});

test("public: busy limit", async () => {
  reset();
  state.runs = [1, 2, 3].map((i) => ({ id: i, display_title: "Delete by Self-service #00000000000" + i, status: "in_progress" }));
  const r = await call(pub, { method: "POST", url: "/api/public?a=delete", body: { name: "Himanshu Sharma", phone: "9876543210", since: since() } });
  assert.equal(r.statusCode, 429);
});

test("auth: login, callback with state check, logout", async () => {
  reset();
  let r = await call(auth, { url: "/api/auth?a=login" });
  assert.equal(r.statusCode, 302);
  const loc = new URL(r.headers.location);
  assert.equal(loc.host, "github.com");
  assert.equal(loc.searchParams.get("redirect_uri"), "https://panel.test/api/auth/callback");
  assert.equal(loc.searchParams.get("scope"), "repo workflow");
  const st = loc.searchParams.get("state");
  const stateCookie = [].concat(r.headers["set-cookie"])[0].split(";")[0];
  r = await call(auth, { url: "/api/auth?a=callback&code=good&state=wrong", cookie: stateCookie });
  assert.match(r.headers.location, /error=/);
  r = await call(auth, { url: "/api/auth?a=callback&code=bad&state=" + st, cookie: stateCookie });
  assert.match(r.headers.location, /error=/);
  r = await call(auth, { url: "/api/auth?a=callback&code=good&state=" + st, cookie: stateCookie });
  assert.equal(r.headers.location, "/admin");
  const sc = [].concat(r.headers["set-cookie"]).find((c) => c.startsWith("toc_session="));
  assert.ok(sc && sc.includes("HttpOnly") && sc.includes("Secure") && sc.includes("SameSite=Lax"));
  const me = await call(admin, { url: "/api/admin?a=me", cookie: sc.split(";")[0] });
  assert.equal(me.json().login, "anushka");
  r = await call(auth, { url: "/api/auth?a=logout" });
  assert.equal(r.headers.location, "/admin");
  assert.ok([].concat(r.headers["set-cookie"]).some((c) => c.startsWith("toc_session=;") && c.includes("Max-Age=0")));
});

test("approval request: ask, pending, approve -> number added + run started, requester sees it", async () => {
  reset();
  // validation
  let r = await call(pub, { method: "POST", url: "/api/public?a=request", body: { phone: "9123456789", name: "P", since: since() } });
  assert.equal(r.statusCode, 400, "name required");
  r = await call(pub, { method: "POST", url: "/api/public?a=request", body: { phone: "9123456789, 9123456780", name: "Priya", since: since() } });
  assert.equal(r.statusCode, 400, "one number");
  r = await call(pub, { method: "POST", url: "/api/public?a=request", body: { phone: "9876543210", name: "Him", since: since() } });
  assert.equal(r.statusCode, 409, "already approved");
  r = await call(pub, { method: "POST", url: "/api/public?a=request", body: { phone: "9123456789", name: "Priydarshi <script>", since: since() }, origin: "https://evil.test" });
  assert.equal(r.statusCode, 403);
  // create
  r = await call(pub, { method: "POST", url: "/api/public?a=request", body: { phone: "+91 91234 56789", name: "Priydarshi <script>", since: since() } });
  assert.equal(r.statusCode, 200);
  const aid = r.json().approvalId;
  assert.match(aid, /^1-[0-9a-f]{16}$/);
  assert.equal(state.issues[0].title, "Cleanup approval: Priydarshi script (9123456789)");
  assert.match(state.issues[0].body, /https:\/\/panel\.test\/admin/);
  // same number again -> same request
  r = await call(pub, { method: "POST", url: "/api/public?a=request", body: { phone: "9123456789", name: "Priydarshi", since: since() } });
  assert.equal(r.json().approvalId, aid);
  assert.equal(state.issues.length, 1);
  // status: pending; wrong token -> 404
  r = await call(pub, { url: "/api/public?a=approval&id=" + aid });
  assert.equal(r.json().state, "pending");
  r = await call(pub, { url: "/api/public?a=approval&id=1-0000000000000000" });
  assert.equal(r.statusCode, 404);
  r = await call(pub, { url: "/api/public?a=approval&id=../1" });
  assert.equal(r.statusCode, 400);
  // admin sees it (PRs and other issues ignored)
  r = await call(admin, { url: "/api/admin?a=requests", cookie: sess() });
  assert.deepEqual(r.json().requests.map((x) => [x.issue, x.name, x.phone]), [[1, "Priydarshi script", "9123456789"]]);
  // viewer can't approve
  r = await call(admin, { method: "POST", url: "/api/admin?a=requests", cookie: sess("viewer-token"), body: { action: "approve", issue: 1 } });
  assert.equal(r.statusCode, 403);
  // approve
  r = await call(admin, { method: "POST", url: "/api/admin?a=requests", cookie: sess(), body: { action: "approve", issue: 1 } });
  assert.equal(r.statusCode, 200);
  const runId = r.json().requestId;
  assert.deepEqual(r.json().requests, []);
  const yaml = state.files["config/test_accounts.yaml"];
  assert.deepEqual(readList(yaml, "self_service_phone_numbers").map((x) => x.value), ["9876543210", "9123456789"]);
  assert.match(state.puts.at(-1).message, /Allow 9123456789 \(Priydarshi script\).*approved by anushka/);
  const d = state.dispatches.at(-1);
  assert.equal(d.token, "user-token");
  assert.deepEqual(d.inputs, { dry_run: "false", since_date: since(), max_deletions: "100", phone_numbers: "9123456789", self_service: "true", requested_by: "Self-service: Priydarshi script (9123456789, approved by anushka)", request_id: runId });
  assert.equal(state.issues[0].state, "closed");
  assert.equal(state.issues[0].state_reason, "completed");
  // requester's page now gets the run id and can follow it
  r = await call(pub, { url: "/api/public?a=approval&id=" + aid });
  assert.deepEqual(r.json(), { state: "approved", requestId: runId, phone: "9123456789" });
  state.runs = [{ id: 8, display_title: "Delete by Self-service: Priydarshi script (9123456789, approved by anushka) #" + runId, status: "in_progress" }];
  r = await call(pub, { url: "/api/public?a=status&request=" + runId });
  assert.equal(r.json().state, "running");
  // handled twice -> 409
  r = await call(admin, { method: "POST", url: "/api/admin?a=requests", cookie: sess(), body: { action: "approve", issue: 1 } });
  assert.equal(r.statusCode, 409);
});

test("approval request: reject", async () => {
  reset();
  let r = await call(pub, { method: "POST", url: "/api/public?a=request", body: { phone: "9123456789", name: "Someone", since: since() } });
  const aid = r.json().approvalId;
  r = await call(admin, { method: "POST", url: "/api/admin?a=requests", cookie: sess(), body: { action: "reject", issue: 1 } });
  assert.deepEqual(r.json().requests, []);
  assert.equal(state.issues[0].state_reason, "not_planned");
  assert.equal(state.dispatches.length, 0);
  assert.equal(readList(state.files["config/test_accounts.yaml"], "self_service_phone_numbers").length, 1);
  r = await call(pub, { url: "/api/public?a=approval&id=" + aid });
  assert.equal(r.json().state, "rejected");
  r = await call(admin, { method: "POST", url: "/api/admin?a=requests", cookie: sess(), body: { action: "approve", issue: 42 } });
  assert.equal(r.statusCode, 404);
});

test("history: newest first, empty when no branch", async () => {
  reset();
  let r = await call(admin, { url: "/api/admin?a=history", cookie: sess() });
  assert.deepEqual(r.json().history.map((h) => h.who), ["anushka", "Schedule"]);
  state.noHistory = true;
  r = await call(admin, { url: "/api/admin?a=history", cookie: sess() });
  assert.deepEqual(r.json().history, []);
  r = await call(admin, { url: "/api/admin?a=history" });
  assert.equal(r.statusCode, 401);
});

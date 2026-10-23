// Admin API. Every action needs a signed-in GitHub user with Write access to
// the cleanup repository, and acts as that user (so runs show who started them).
import { query, body, send, checkSince, requestId } from "../lib/http.js";
import { getSession, requireAdmin, endSession } from "../lib/session.js";
import {
  permissions, dispatch, listRuns, findRunByRequest, runState, readReport,
  getFile, putFile, getVariable, setVariable, readSchedule, writeSchedule,
  ALLOWED_HOURS, WORKFLOW_PATH, ACCOUNTS_PATH, GhError,
} from "../lib/github.js";
import { normalizePhone, splitPhones, readList, writeList } from "../lib/phones.js";

const SELF_SERVICE_KEY = "self_service_phone_numbers";
const ADMIN_MAX_DELETIONS = 200;
const ADMIN_MAX_DAYS = 365;

export default async function handler(req, res) {
  const a = query(req).a;
  try {
    if (a === "me") return await me(req, res);
    const s = await requireAdmin(req, res);
    if (!s) return;
    const routes = {
      "GET settings": settingsGet,
      "POST settings": settingsPost,
      "GET runs": runs,
      "POST run": startRun,
      "GET report": report,
      "GET numbers": numbersGet,
      "POST numbers": numbersPost,
    };
    const fn = routes[req.method + " " + a];
    if (!fn) return send(res, 404, { error: "Unknown action." });
    return await fn(req, res, s);
  } catch (e) {
    return fail(res, e);
  }
}

function fail(res, e) {
  if (e instanceof GhError) {
    if (e.status === 403) return send(res, 403, { error: "GitHub didn't allow that for your account: " + e.message });
    if (e.status === 404) return send(res, 404, { error: "GitHub couldn't find that. " + e.message });
    if (e.status === 422) return send(res, 400, { error: "GitHub refused the request: " + e.message });
    return send(res, e.status >= 400 && e.status < 600 ? e.status : 500, { error: e.message });
  }
  return send(res, 500, { error: "Something went wrong: " + (e && e.message) });
}

async function me(req, res) {
  const s = getSession(req);
  if (!s) return send(res, 200, { signedIn: false });
  try {
    const p = await permissions(s.token);
    const access = !!(p.push || p.admin);
    return send(res, 200, {
      signedIn: true, login: s.login, avatar: s.avatar, access,
      message: access ? "" : "Your GitHub account needs Write access to the cleanup repository. Ask the owner to add you as a collaborator.",
    });
  } catch (e) {
    if (e.status === 401) { endSession(res); return send(res, 200, { signedIn: false }); }
    if (e.status === 404 || e.status === 403) {
      return send(res, 200, { signedIn: true, login: s.login, avatar: s.avatar, access: false,
        message: "Your GitHub account doesn't have access to the cleanup repository. Ask the owner to add you as a collaborator." });
    }
    throw e;
  }
}

async function settingsGet(req, res, s) {
  const [dry, wf] = await Promise.all([getVariable(s.token, "DRY_RUN"), getFile(s.token, WORKFLOW_PATH)]);
  return send(res, 200, {
    autoDelete: String(dry || "true").trim().toLowerCase() === "false",
    everyHours: readSchedule(wf.text),
    allowedHours: ALLOWED_HOURS,
  });
}

async function settingsPost(req, res, s) {
  const b = await body(req);
  if (typeof b.autoDelete === "boolean") {
    await setVariable(s.token, "DRY_RUN", b.autoDelete ? "false" : "true");
  }
  if (b.everyHours !== undefined) {
    const h = Number(b.everyHours);
    if (!ALLOWED_HOURS.includes(h)) return send(res, 400, { error: "Pick one of: " + ALLOWED_HOURS.join(", ") + " hours." });
    const wf = await getFile(s.token, WORKFLOW_PATH);
    await putFile(s.token, WORKFLOW_PATH, writeSchedule(wf.text, h), wf.sha,
      "Set test order cleanup to run every " + h + (h === 1 ? " hour" : " hours") + " (by " + s.login + ")");
  }
  return settingsGet(req, res, s);
}

async function runs(req, res, s) {
  return send(res, 200, { runs: await listRuns(s.token, { perPage: 15 }) });
}

async function startRun(req, res, s) {
  const b = await body(req);
  const sinceErr = checkSince(b.since, ADMIN_MAX_DAYS);
  if (sinceErr) return send(res, 400, { error: sinceErr });
  const phones = splitPhones(b.phones);
  const bad = phones.filter((p) => !normalizePhone(p));
  if (bad.length) return send(res, 400, { error: "Not a 10-digit phone number: " + bad.join(", ") });
  const id = requestId();
  await dispatch(s.token, {
    dry_run: b.dryRun === false ? "false" : "true",
    since_date: b.since,
    max_deletions: ADMIN_MAX_DELETIONS,
    phone_numbers: phones.map(normalizePhone).join(", "),
    self_service: "false",
    requested_by: s.login,
    request_id: id,
  });
  return send(res, 200, { requestId: id });
}

async function report(req, res, s) {
  const q = query(req);
  let run = null;
  if (q.request) {
    if (!/^[0-9a-f]{12}$/.test(q.request)) return send(res, 400, { error: "Bad request id." });
    run = await findRunByRequest(s.token, q.request);
  } else if (q.run && /^\d+$/.test(q.run)) {
    run = (await listRuns(s.token, { perPage: 50 })).find((r) => String(r.id) === q.run) || { id: q.run, status: "completed", conclusion: "success" };
  } else {
    return send(res, 400, { error: "Give a request or run id." });
  }
  const state = runState(run);
  let rep = null;
  if (run && (state === "done" || state === "failed")) rep = await readReport(s.token, run.id);
  return send(res, 200, { state, run, report: rep });
}

async function numbersGet(req, res, s) {
  const f = await getFile(s.token, ACCOUNTS_PATH);
  return send(res, 200, { numbers: readList(f.text, SELF_SERVICE_KEY).map((x) => ({ number: normalizePhone(x.value) || x.value, label: x.label })) });
}

async function numbersPost(req, res, s) {
  const b = await body(req);
  const number = normalizePhone(b.number);
  if (!number) return send(res, 400, { error: "Enter a 10-digit phone number." });
  const label = String(b.label || "").trim().slice(0, 60);
  const f = await getFile(s.token, ACCOUNTS_PATH);
  const items = readList(f.text, SELF_SERVICE_KEY);
  const without = items.filter((x) => normalizePhone(x.value) !== number);
  let next, message;
  if (b.action === "add") {
    next = [...without, { value: number, label: label || "added by " + s.login }];
    message = "Allow " + number + " on the self-service cleanup page (by " + s.login + ")";
  } else if (b.action === "remove") {
    if (without.length === items.length) return send(res, 404, { error: number + " isn't on the list." });
    next = without;
    message = "Remove " + number + " from the self-service cleanup page (by " + s.login + ")";
  } else {
    return send(res, 400, { error: "Unknown action." });
  }
  await putFile(s.token, ACCOUNTS_PATH, writeList(f.text, SELF_SERVICE_KEY, next), f.sha, message);
  return numbersGet(req, res, s);
}

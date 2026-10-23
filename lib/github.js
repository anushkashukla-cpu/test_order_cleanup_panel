import { unzipSync, strFromU8 } from "fflate";

export const WORKFLOW_FILE = "cleanup.yml";
export const WORKFLOW_PATH = ".github/workflows/" + WORKFLOW_FILE;
export const ACCOUNTS_PATH = "config/test_accounts.yaml";
export const BRANCH = process.env.GITHUB_BRANCH || "main";

export function repo() {
  const owner = process.env.GITHUB_REPO_OWNER;
  const name = process.env.GITHUB_REPO_NAME;
  if (!owner || !name) throw new GhError(500, "The website is missing GITHUB_REPO_OWNER or GITHUB_REPO_NAME.");
  return "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(name);
}

export class GhError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function gh(token, path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch("https://api.github.com" + path, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "test-order-cleanup-panel",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new GhError(502, "Couldn't reach GitHub. Try again in a minute.");
  }
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new GhError(res.status, (data && data.message) || "GitHub error " + res.status);
  return data;
}

// Repository permissions of the token's user: { admin, push, pull }.
export async function permissions(token) {
  const r = await gh(token, repo());
  return r.permissions || {};
}

export async function dispatch(token, inputs) {
  const clean = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, String(v ?? "")]));
  await gh(token, repo() + "/actions/workflows/" + WORKFLOW_FILE + "/dispatches", {
    method: "POST",
    body: { ref: BRANCH, inputs: clean },
  });
}

export async function listRuns(token, { perPage = 15, event } = {}) {
  const q = "?per_page=" + perPage + (event ? "&event=" + event : "");
  const data = await gh(token, repo() + "/actions/workflows/" + WORKFLOW_FILE + "/runs" + q);
  return (data.workflow_runs || []).map((r) => ({
    id: r.id,
    title: r.display_title || r.name,
    status: r.status,
    conclusion: r.conclusion,
    createdAt: r.created_at,
    url: r.html_url,
    event: r.event,
  }));
}

// Runs started by the website carry " #<requestId>" at the end of their name.
export async function findRunByRequest(token, requestId) {
  const runs = await listRuns(token, { perPage: 50, event: "workflow_dispatch" });
  return runs.find((r) => r.title.endsWith("#" + requestId)) || null;
}

export function runState(run) {
  if (!run) return "queued";
  if (run.status !== "completed") return run.status === "in_progress" ? "running" : "queued";
  if (run.conclusion === "success") return "done";
  if (run.conclusion === "cancelled") return "cancelled";
  return "failed";
}

// Downloads the run's "report" artifact and returns report.json, or null.
export async function readReport(token, runId) {
  const list = await gh(token, repo() + "/actions/runs/" + runId + "/artifacts");
  const art = (list.artifacts || []).find((a) => a.name === "report" && !a.expired);
  if (!art) return null;
  let res;
  try {
    res = await fetch(art.archive_download_url, {
      headers: { Authorization: "Bearer " + token, "User-Agent": "test-order-cleanup-panel" },
      redirect: "follow",
    });
  } catch {
    throw new GhError(502, "Couldn't download the run report from GitHub.");
  }
  if (!res.ok) throw new GhError(res.status, "Couldn't download the run report (" + res.status + ").");
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  if (!files["report.json"]) return null;
  return JSON.parse(strFromU8(files["report.json"]));
}

function b64decode(s) { return Buffer.from(String(s).replace(/\s/g, ""), "base64").toString("utf8"); }
function b64encode(s) { return Buffer.from(s, "utf8").toString("base64"); }

export async function getFile(token, path) {
  const f = await gh(token, repo() + "/contents/" + path + "?ref=" + encodeURIComponent(BRANCH));
  return { sha: f.sha, text: b64decode(f.content) };
}

export async function putFile(token, path, text, sha, message) {
  await gh(token, repo() + "/contents/" + path, {
    method: "PUT",
    body: { message, content: b64encode(text), sha, branch: BRANCH },
  });
}

export async function getVariable(token, name) {
  try {
    const v = await gh(token, repo() + "/actions/variables/" + name);
    return v.value;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function setVariable(token, name, value) {
  try {
    await gh(token, repo() + "/actions/variables/" + name, { method: "PATCH", body: { name, value } });
  } catch (e) {
    if (e.status !== 404) throw e;
    await gh(token, repo() + "/actions/variables", { method: "POST", body: { name, value } });
  }
}

// ---- schedule (cron line in the workflow file) ----
const CRON_RE = /cron:\s*["']([^"']+)["']/;

export function cronToHours(cron) {
  const p = String(cron).trim().split(/\s+/);
  if (p.length !== 5 || p[2] !== "*" || p[3] !== "*" || p[4] !== "*") return null;
  if (p[1] === "*") return 1;
  const m = p[1].match(/^\*\/(\d+)$/);
  if (m) return Number(m[1]);
  if (/^\d+$/.test(p[1])) return 24;
  return null;
}

export function hoursToCron(h) {
  if (h === 1) return "17 * * * *";
  if (h === 24) return "17 0 * * *";
  return "17 */" + h + " * * *";
}

export const ALLOWED_HOURS = [1, 2, 3, 4, 6, 8, 12, 24];

export function readSchedule(workflowText) {
  const m = workflowText.match(CRON_RE);
  return m ? cronToHours(m[1]) : null;
}

export function writeSchedule(workflowText, hours) {
  if (!CRON_RE.test(workflowText)) throw new GhError(500, "The workflow file has no schedule line to update.");
  return workflowText.replace(CRON_RE, 'cron: "' + hoursToCron(hours) + '"');
}

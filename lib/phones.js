// Phone helpers, matching the cleanup job's rules exactly:
// last 10 digits; an email like 9876543210@home-run.co counts as its number.
export function normalizePhone(s) {
  let v = String(s || "");
  const at = v.indexOf("@");
  if (at >= 0) v = v.slice(0, at);
  const d = v.replace(/\D/g, "");
  return d.length < 10 ? "" : d.slice(-10);
}

export function splitPhones(s) {
  return String(s || "")
    .split(/[,;\n]+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// Reads one list (e.g. self_service_phone_numbers) from test_accounts.yaml.
// Returns [{ value, label }] where label is the trailing "# comment".
export function readList(text, key) {
  const out = [];
  let inList = false;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (!t.startsWith("-")) { inList = t === key + ":"; continue; }
    if (!inList) continue;
    const m = t.match(/^-\s*(?:"([^"]*)"|'([^']*)'|([^#]*?))\s*(?:#\s*(.*))?$/);
    if (!m) continue;
    const value = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (value) out.push({ value, label: (m[4] || "").trim() });
  }
  return out;
}

// Replaces one list in test_accounts.yaml, keeping every other line as is.
// If the key is missing it is added at the end.
export function writeList(text, key, items) {
  const lines = text.split("\n");
  const keyIdx = lines.findIndex((l) => l.trim() === key + ":" && !/^\s/.test(l));
  const rendered = items.map((it) =>
    '  - "' + String(it.value).replace(/["\r\n]/g, "") + '"' +
    (it.label ? "   # " + String(it.label).replace(/[\r\n#]/g, " ").trim() : ""));
  if (keyIdx < 0) {
    const base = text.endsWith("\n") ? text : text + "\n";
    return base + key + ":\n" + (rendered.length ? rendered.join("\n") + "\n" : "");
  }
  // The list runs until the next top-level key (an unindented, non-comment line).
  let end = keyIdx + 1;
  while (end < lines.length) {
    const l = lines[end];
    const t = l.trim();
    if (t && !t.startsWith("#") && !t.startsWith("-") && !/^\s/.test(l)) break;
    end++;
  }
  const kept = lines.slice(keyIdx + 1, end).filter((l) => !l.trim().startsWith("-"));
  return [...lines.slice(0, keyIdx + 1), ...rendered, ...kept, ...lines.slice(end)].join("\n");
}

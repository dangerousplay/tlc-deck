import { type Plan, parsePlan } from "./plan.js";

/** Text of the `### T<n>:` block for a task (heading included), or undefined. */
export function taskBlock(tasksMd: string, id: string): string | undefined {
  let found = false;
  const buf: string[] = [];
  for (const line of tasksMd.split(/\r?\n/)) {
    const head = /^###\s+(T\d+):/.exec(line);
    if (head) {
      if (found) break;
      if (head[1] === id) {
        found = true;
        buf.push(line);
      }
    } else if (/^#{1,3}\s/.test(line) || /^---\s*$/.test(line)) {
      if (found) break;
    } else if (found) buf.push(line);
  }
  return found ? buf.join("\n").trim() : undefined;
}

function inline(block: string, name: string): string {
  const m = new RegExp(`\\*\\*${name}\\*\\*:[ \\t]*(.*)$`, "mi").exec(block);
  if (!m) return "";
  return (m[1] ?? "").split(/\s+[·|]\s+\*\*/)[0]?.trim() ?? "";
}

function gateTable(tasksMd: string): { name: string; command: string }[] {
  const rows: { name: string; command: string }[] = [];
  let inSection = false;
  for (const line of tasksMd.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) {
      inSection = /gate check commands/i.test(line);
      continue;
    }
    if (!inSection || !line.trim().startsWith("|")) continue;
    const cells = line
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
    const [name, cmd] = cells;
    if (!name || !cmd || /^-+$/.test(name) || name.toLowerCase() === "gate") continue;
    const tick = /`([^`]+)`/.exec(cmd);
    rows.push({ name, command: (tick?.[1] ?? cmd).trim() });
  }
  return rows;
}

/**
 * Gate of a task: the `**Gate**` value matched (case-insensitively, by leading
 * name) against the "Gate Check Commands" table, else its first backticked
 * command, else null.
 */
export function resolveGate(tasksMd: string, id: string): { name: string; command: string } | null {
  const block = taskBlock(tasksMd, id);
  if (!block) return null;
  const value = inline(block, "Gate");
  if (!value) return null;
  const lower = value.toLowerCase();
  const rows = gateTable(tasksMd);
  const row =
    rows.find((r) => r.name.toLowerCase() === lower) ??
    rows.find((r) =>
      new RegExp(`^${r.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower),
    );
  if (row) return row;
  const tick = /`([^`]+)`/.exec(value);
  if (tick?.[1]) return { name: tick[1], command: tick[1].trim() };
  return null;
}

const SCOPE_ROOTS = ["packages", "apps", "crates", "integrations"];

function wherePaths(block: string): string[] {
  const m = /^[ \t]*\*\*Where\*\*:[ \t]*(.*)$/im.exec(block);
  const value = m?.[1] ?? "";
  const ticks = [...value.matchAll(/`([^`]+)`/g)].map((t) => t[1] as string);
  const raw = ticks.length ? ticks : value.split(",");
  return raw.map((p) => p.trim()).filter(Boolean);
}

function scopeOf(paths: string[]): string {
  for (const p of paths) {
    const seg = p.replace(/^\.\//, "").split("/");
    if (SCOPE_ROOTS.includes(seg[0] ?? "") && seg[1]) return seg[1];
  }
  const first = (paths[0] ?? "").replace(/^\.\//, "").split("/")[0] ?? "";
  return first.replace(/\.[^.]*$/, "").toLowerCase() || "repo";
}

function isDocsPath(p: string): boolean {
  return /^docs\//.test(p) || /\.md$/i.test(p) || /^README/i.test(p);
}

/** `<type>(<scope>): <title> (<T>)` plus an optional trailer paragraph. */
export function commitMessage(
  tasksMd: string,
  id: string,
  trailer?: string,
  plan: Plan = parsePlan(tasksMd),
): string {
  const task = plan.tasks.find((t) => t.id === id);
  const title = task?.title ?? id;
  const paths = wherePaths(taskBlock(tasksMd, id) ?? "");
  let type = "feat";
  if (/^(test|e2e)/i.test(title)) type = "test";
  else if (paths.length > 0 && paths.every(isDocsPath)) type = "docs";
  const subject = `${type}(${scopeOf(paths)}): ${title} (${id})`;
  return trailer ? `${subject}\n\n${trailer}` : subject;
}

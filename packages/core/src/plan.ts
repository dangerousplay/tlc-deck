import type { PlanValue } from "@tlc-deck/protocol";

export type PlanTask = PlanValue["tasks"][number] & { done: boolean };
export type Plan = { tasks: PlanTask[]; milestones: PlanValue["milestones"] };

export class PlanError extends Error {
  constructor(
    message: string,
    readonly tasks: string[] = [],
  ) {
    super(message);
    this.name = "PlanError";
  }
}

const REQ_ID = /[A-Z][A-Za-z]*-\d+/g;

/** Expand "CLI-01..07" style ranges and plain ids into a flat id list. */
function expandIds(text: string): string[] {
  const out: string[] = [];
  const re = /([A-Z][A-Za-z]*)-(\d+)(?:\.\.(\d+))?/g;
  for (const m of text.matchAll(re)) {
    const [, prefix, a, b] = m;
    const width = a?.length ?? 2;
    const from = Number(a);
    const to = b ? Number(b) : from;
    for (let n = from; n <= to && n - from < 1000; n++) {
      out.push(`${prefix}-${String(n).padStart(width, "0")}`);
    }
  }
  return out;
}

/** requirement id -> priority ("P1".."P3") from spec.md user-story sections. */
function priorityMap(spec: string): Map<string, string> {
  const map = new Map<string, string>();
  let priority: string | null = null;
  for (const line of spec.split(/\r?\n/)) {
    const h = /^#{2,4}\s+(P\d+)\b/.exec(line);
    if (h) {
      priority = h[1] ?? null;
      continue;
    }
    if (/^#{1,4}\s/.test(line)) {
      priority = null;
      continue;
    }
    if (!priority) continue;
    let ids: string[] = [];
    if (/\*\*Requirement IDs\*\*/i.test(line)) ids = expandIds(line);
    else {
      const ac = /^\s*(?:\d+\.\s*)?([A-Z][A-Za-z]*-\d+):/.exec(line);
      if (ac?.[1]) ids = [ac[1]];
    }
    for (const id of ids) if (!map.has(id)) map.set(id, priority);
  }
  return map;
}

function field(block: string, name: string): string | undefined {
  const m = new RegExp(`^[ \\t]*\\*\\*${name}\\*\\*:[ \\t]*(.*)$`, "mi").exec(block);
  return m ? (m[1] ?? "").trim() : undefined;
}

function isDone(block: string): boolean {
  const status = field(block, "Status");
  if (status && /^done\b/i.test(status)) return true;
  const idx = block.search(/^\*\*Done when\*\*/im);
  if (idx < 0) return false;
  const boxes = [...block.slice(idx).matchAll(/^\s*[-*]\s*\[([ xX])\]/gm)];
  return boxes.length > 0 && boxes.every((b) => b[1] !== " ");
}

function splitBlocks(tasksMd: string): { head: RegExpExecArray; text: string }[] {
  const lines = tasksMd.split(/\r?\n/);
  const blocks: { head: RegExpExecArray; text: string }[] = [];
  let cur: { head: RegExpExecArray; lines: string[] } | null = null;
  const flush = () => {
    if (cur) blocks.push({ head: cur.head, text: cur.lines.join("\n") });
    cur = null;
  };
  for (const line of lines) {
    const head = /^###\s+(T\d+):\s*(.*?)\s*$/.exec(line);
    if (head) {
      flush();
      cur = { head, lines: [] };
    } else if (/^#{1,3}\s/.test(line) || /^---\s*$/.test(line)) {
      flush();
    } else if (cur) cur.lines.push(line);
  }
  flush();
  return blocks;
}

export function parsePlan(tasksMd: string, specMd?: string): Plan {
  const blocks = splitBlocks(tasksMd);
  const prio = specMd ? priorityMap(specMd) : new Map<string, string>();
  const ids = new Set(blocks.map((b) => b.head[1] as string));
  const raw = blocks.map((b) => {
    const id = b.head[1] as string;
    let title = b.head[2] as string;
    const parallel = /\[P\]/.test(title);
    title = title.replace(/\s*\[P\]\s*/g, " ").trim();
    const depField = (field(b.text, "Depends on") ?? "").replace(/\([^)]*\)/g, "");
    const dependsOn = [...new Set(depField.match(/\bT\d+\b/g) ?? [])];
    const requirement = field(b.text, "Requirement") || undefined;
    const milestoneField = field(b.text, "Milestone") || undefined;
    return { id, title, parallel, dependsOn, requirement, milestoneField, done: isDone(b.text) };
  });

  const seen = new Set<string>();
  for (const t of raw) {
    if (seen.has(t.id)) throw new PlanError(`duplicate task ${t.id}`, [t.id]);
    seen.add(t.id);
    for (const d of t.dependsOn) {
      if (!ids.has(d)) throw new PlanError(`task ${t.id} depends on missing task ${d}`, [t.id, d]);
      if (d === t.id) throw new PlanError(`dependency cycle: ${t.id} depends on itself`, [t.id]);
    }
  }

  // waves: topological layers
  const wave = new Map<string, number>();
  let remaining = raw.slice();
  let layer = 1;
  while (remaining.length) {
    const ready = remaining.filter((t) => t.dependsOn.every((d) => wave.has(d)));
    if (!ready.length) {
      const names = remaining.map((t) => t.id);
      throw new PlanError(`dependency cycle among tasks: ${names.join(", ")}`, names);
    }
    for (const t of ready) wave.set(t.id, layer);
    remaining = remaining.filter((t) => !wave.has(t.id));
    layer++;
  }

  const sources = new Map<string, "field" | "priority" | "wave">();
  const tasks: PlanTask[] = raw.map((t) => {
    let milestone: string;
    let source: "field" | "priority" | "wave";
    const first = t.requirement ? (t.requirement.match(REQ_ID) ?? [])[0] : undefined;
    const p = first ? prio.get(first) : undefined;
    if (t.milestoneField) {
      milestone = t.milestoneField;
      source = "field";
    } else if (p) {
      milestone = p;
      source = "priority";
    } else {
      milestone = `Wave ${wave.get(t.id)}`;
      source = "wave";
    }
    if (!sources.has(milestone)) sources.set(milestone, source);
    const out: PlanTask = {
      id: t.id,
      title: t.title,
      milestone,
      dependsOn: t.dependsOn,
      parallel: t.parallel,
      done: t.done,
    };
    if (t.requirement) out.requirement = t.requirement;
    return out;
  });

  const milestones = [...sources].map(([name, source]) => ({
    name,
    source,
    tasks: tasks.filter((t) => t.milestone === name).map((t) => t.id),
  }));
  return { tasks, milestones };
}

export interface TaskDetails {
  title: string;
  what: string;
  where: string;
  dependsOn: string[];
  requirements: { id: string; text: string }[];
  doneWhen: { text: string; checked: boolean }[];
  tests: string;
  gate: string;
  milestone: string;
}

/** requirement id -> acceptance-criteria text from spec.md. */
function criteriaMap(spec: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of spec.split(/\r?\n/)) {
    const m = /^\s*(?:\d+\.\s*|[-*]\s*)?([A-Z][A-Za-z]*-\d+):\s*(.+?)\s*$/.exec(line);
    if (m?.[1] && !map.has(m[1])) map.set(m[1], m[2] ?? "");
  }
  return map;
}

/** Value of an inline `**Name**: value` (value ends at the next ` · ` / `|` separator or end of line). */
function inlineField(block: string, name: string): string {
  const m = new RegExp(`\\*\\*${name}\\*\\*:[ \\t]*(.*)$`, "mi").exec(block);
  if (!m) return "";
  return (m[1] ?? "").split(/\s+[·|]\s+\*\*/)[0]?.trim() ?? "";
}

export function parseTaskDetails(tasksMd: string, specMd?: string): Record<string, TaskDetails> {
  const plan = parsePlan(tasksMd, specMd);
  const milestones = new Map(plan.tasks.map((t) => [t.id, t.milestone]));
  const criteria = specMd ? criteriaMap(specMd) : new Map<string, string>();
  const out: Record<string, TaskDetails> = {};
  for (const b of splitBlocks(tasksMd)) {
    const id = b.head[1] as string;
    const title = (b.head[2] as string).replace(/\s*\[P\]\s*/g, " ").trim();
    const dependsOn = [
      ...new Set(
        (field(b.text, "Depends on") ?? "").replace(/\([^)]*\)/g, "").match(/\bT\d+\b/g) ?? [],
      ),
    ];
    const reqField = field(b.text, "Requirement") ?? "";
    const requirements = [...new Set(expandIds(reqField))].map((rid) => ({
      id: rid,
      text: criteria.get(rid) ?? "",
    }));
    const doneWhen: { text: string; checked: boolean }[] = [];
    const idx = b.text.search(/^\*\*Done when\*\*/im);
    if (idx >= 0) {
      for (const m of b.text.slice(idx).matchAll(/^\s*[-*]\s*\[([ xX])\]\s*(.*)$/gm)) {
        doneWhen.push({ text: (m[2] ?? "").trim(), checked: m[1] !== " " });
      }
    }
    out[id] = {
      title,
      what: field(b.text, "What") ?? "",
      where: field(b.text, "Where") ?? "",
      dependsOn,
      requirements,
      doneWhen,
      tests: inlineField(b.text, "Tests"),
      gate: inlineField(b.text, "Gate"),
      milestone: milestones.get(id) ?? "",
    };
  }
  return out;
}

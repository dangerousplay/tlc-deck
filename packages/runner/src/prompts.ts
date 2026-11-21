import { readFileSync } from "node:fs";

export type PromptName =
  | "implement"
  | "fix"
  | "review"
  | "advise"
  | "solo-first"
  | "solo-task"
  | "solo-fix"
  | "solo-handoff"
  | "solo-review";

const cache = new Map<string, string>();

/** Load `prompts/<name>.md` and substitute `{{key}}` placeholders (missing keys become empty). */
export function renderPrompt(name: PromptName, vars: Record<string, string | undefined>): string {
  let tpl = cache.get(name);
  if (tpl === undefined) {
    tpl = readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), "utf8");
    cache.set(name, tpl);
  }
  return tpl.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? "");
}

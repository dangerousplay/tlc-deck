import type { ReactNode } from "react";

/** Inline `code` and **bold** only; enough for the task block fields. */
function inline(text: string): ReactNode[] {
  return text
    .split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part, i) => {
      const key = `${i}-${part}`;
      if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
        return (
          <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
            {part.slice(1, -1)}
          </code>
        );
      }
      if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
        return <strong key={key}>{part.slice(2, -2)}</strong>;
      }
      return part;
    });
}

/** Tiny markdown renderer: paragraphs, `-` lists, inline code and bold. */
export function MiniMarkdown({ text }: { text: string }) {
  const blocks = text.split(/\n\s*\n/).filter((b) => b.trim());
  if (blocks.length === 0) return <p className="text-sm text-muted-foreground">—</p>;
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {blocks.map((block) => {
        const lines = block.split("\n").filter((l) => l.trim());
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={block} className="list-disc space-y-0.5 pl-5">
              {lines.map((l) => (
                <li key={l}>{inline(l.replace(/^\s*[-*]\s+/, ""))}</li>
              ))}
            </ul>
          );
        }
        return <p key={block}>{inline(lines.join(" "))}</p>;
      })}
    </div>
  );
}

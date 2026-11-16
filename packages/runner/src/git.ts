import { execFile } from "node:child_process";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      (err, out, se) => {
        if (err) reject(new Error(`git ${args[0]} failed: ${(se || err.message).trim()}`));
        else resolve(out);
      },
    );
  });
}

export interface CommitInput {
  cwd: string;
  files: string[];
  message: string;
  trailer?: string;
}

/**
 * Stage and commit only `files` (pathspec commit, so unrelated staged work is untouched).
 * Returns the short hash, or undefined when none of the files changed.
 */
export async function commitFiles(input: CommitInput): Promise<string | undefined> {
  const { cwd, files } = input;
  if (files.length === 0) return undefined;
  const status = await git(cwd, ["status", "--porcelain", "-z", "--", ...files]);
  const changed = status
    .split("\0")
    .filter((e) => e.length > 3)
    .map((e) => e.slice(3));
  if (changed.length === 0) return undefined;
  await git(cwd, ["add", "-A", "--", ...changed]);
  const msg = ["commit", "-q", "-m", input.message];
  if (input.trailer) msg.push("-m", input.trailer);
  await git(cwd, [...msg, "--", ...changed]);
  return (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim();
}

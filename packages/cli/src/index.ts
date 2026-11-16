#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { run } from "./main.js";

export const version: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

export { run } from "./main.js";

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  run(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    version,
  }).then((code) => {
    process.exitCode = code;
  });
}

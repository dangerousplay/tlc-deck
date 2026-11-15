#!/usr/bin/env node
import { readFileSync } from "node:fs";

export const version: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

if (process.argv.includes("--version")) {
  console.log(version);
}

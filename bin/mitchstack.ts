#!/usr/bin/env node
import { runCli } from "../src/cli.js";

process.exitCode = runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  out: console.log,
  err: console.error,
});

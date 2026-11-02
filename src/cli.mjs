#!/usr/bin/env node
import { spawn } from "node:child_process";
import { nativeBinary } from "./native.mjs";

const child = spawn(nativeBinary(), process.argv.slice(2), { stdio: "inherit" });
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code;
});

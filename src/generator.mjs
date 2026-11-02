import { execFileSync } from "node:child_process";
import { nativeBinary } from "./native.mjs";

export const generateClient = (document, { runtimeImport = "oasprint" } = {}) =>
  execFileSync(nativeBinary(), ["--stdin", "--runtime-import", runtimeImport], {
    input: JSON.stringify(document),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });

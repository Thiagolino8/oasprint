import { execFileSync } from "node:child_process";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import path from "node:path";

await rm("dist", { recursive: true, force: true });
await mkdir("dist");
// tsrs does not distribute a Windows ARM binary; the installed TS6 compiler does.
const useTypeScript = process.platform === "win32" && process.arch === "arm64";
const compiler = path.join(
  path.dirname(findPackageJSON(useTypeScript ? "typescript" : "tsrs", import.meta.url)),
  useTypeScript ? "bin/tsc6" : "bin/tsrs",
);
execFileSync(
  process.execPath,
  [compiler, "--project", "tsconfig.json", ...(useTypeScript ? [] : ["--fast", "--checkers", "4"])],
  { stdio: "inherit" },
);
await Promise.all(
  (await readdir("src"))
    .filter((name) => name.endsWith(".mjs") || name.endsWith(".d.mts"))
    .map((name) => cp(`src/${name}`, `dist/${name}`)),
);

await import("./build-native.mjs");

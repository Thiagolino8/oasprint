import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const npm = process.env.npm_execpath;
assert.ok(npm?.endsWith("npm-cli.js"), "Execute com npm run test:package -- <artefatos>");
const { name, version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const directory = resolve(process.argv[2] ?? "artifacts");
const platform = `${process.platform}-${process.arch}`;
const consumer = await mkdtemp(join(tmpdir(), "oasprint-consumer-"));
try {
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execFileSync(
    process.execPath,
    [
      npm,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org/",
      join(directory, `${name}-${version}.tgz`),
      join(directory, `${name}-${platform}-${version}.tgz`),
    ],
    { cwd: consumer, stdio: "inherit" },
  );
  const cli = join(consumer, "node_modules", name, "dist/cli.mjs");
  assert.equal(
    execFileSync(process.execPath, [cli, "--version"], { encoding: "utf8" }).trim(),
    version,
  );
  const fixture = await readFile(
    new URL("../test/fixtures/package-consumer.mjs", import.meta.url),
    "utf8",
  );
  await writeFile(join(consumer, "check.mjs"), fixture);
  execFileSync(process.execPath, [join(consumer, "check.mjs")], {
    cwd: consumer,
    stdio: "inherit",
  });
  console.log(`Instalação e geração conferidas: ${platform}`);
} finally {
  await rm(consumer, { recursive: true, force: true });
}

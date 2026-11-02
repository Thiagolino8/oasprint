import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const script = fileURLToPath(new URL("scripts/release.mjs", root));
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const run = (args, env = {}) =>
  execFileSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, GITHUB_REF: "refs/heads/main", GITHUB_ACTIONS: "false", ...env },
  });

const fixture = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "oasprint-release-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifacts = join(directory, "artifacts");
  await mkdir(artifacts);
  const manifests = [manifest];
  for (const name of Object.keys(manifest.optionalDependencies)) {
    const platform = name.slice(`${manifest.name}-`.length);
    manifests.push(
      JSON.parse(await readFile(new URL(`npm/${platform}/package.json`, root), "utf8")),
    );
  }
  for (const source of manifests) {
    const tree = join(directory, source.name, "package");
    await mkdir(join(tree, "dist"), { recursive: true });
    await mkdir(join(tree, "bin"));
    await writeFile(join(tree, "package.json"), JSON.stringify(source));
    await writeFile(join(tree, "LICENSE"), await readFile(new URL("LICENSE", root)));
    for (const filename of [
      "runtime.js",
      "runtime.d.ts",
      "generator.mjs",
      "generator.d.mts",
      "generate.mjs",
      "generate.d.mts",
      "cli.mjs",
    ]) {
      await writeFile(join(tree, "dist", filename), "fixture");
    }
    await writeFile(
      join(tree, "bin", source.os?.[0] === "win32" ? "oasprint.exe" : "oasprint"),
      "fixture",
    );
    execFileSync("tar", [
      "-czf",
      join(artifacts, `${source.name}-${source.version}.tgz`),
      "-C",
      dirname(tree),
      "package",
    ]);
  }
  return { directory, artifacts };
};

void test("release exige todos os pacotes e a tag correspondente à versão", async (t) => {
  const f = await fixture(t);
  assert.match(run([f.artifacts]), /Validados 7 pacotes/);
  assert.throws(
    () => run(["--source"], { GITHUB_REF: "refs/tags/v99.0.0" }),
    /Tag e versão divergem/,
  );
  await rm(join(f.artifacts, `oasprint-linux-x64-${manifest.version}.tgz`));
  assert.throws(() => run([f.artifacts]), /São necessários o principal e todos os pacotes nativos/);
});

void test("release rejeita manifesto e executável ausente no tarball", async (t) => {
  const f = await fixture(t);
  const tree = join(f.directory, manifest.name, "package");
  const archive = join(f.artifacts, `${manifest.name}-${manifest.version}.tgz`);
  await writeFile(join(tree, "package.json"), JSON.stringify({ ...manifest, version: "99.0.0" }));
  const pack = () => execFileSync("tar", ["-czf", archive, "-C", dirname(tree), "package"]);
  pack();
  assert.throws(() => run([f.artifacts]), /Manifesto divergente/);
  await writeFile(join(tree, "package.json"), JSON.stringify(manifest));
  await rm(join(tree, "dist", "cli.mjs"));
  pack();
  assert.throws(() => run([f.artifacts]), /Entrada ausente/);
});

void test("release não publica fora do evento autorizado", async (t) => {
  const f = await fixture(t);
  assert.throws(() => run([f.artifacts, "--publish"]), /exige GitHub Actions/);
  assert.throws(
    () =>
      run([f.artifacts, "--publish"], {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "workflow_dispatch",
      }),
    /exige push de tag/,
  );
});

void test("release retoma pacotes idênticos e impede publicação parcial com conteúdo divergente", async (t) => {
  const f = await fixture(t);
  const publishedName = "oasprint-linux-x64";
  const integrity = `sha512-${createHash("sha512")
    .update(await readFile(join(f.artifacts, `${publishedName}-${manifest.version}.tgz`)))
    .digest("base64")}`;
  const trace = join(f.directory, "publish.json");
  const preload = join(f.directory, "mock.mjs");
  await writeFile(
    preload,
    `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { writeFileSync } from 'node:fs';
    const exec = childProcess.execFileSync;
    const calls = [];
    childProcess.execFileSync = (command, args, options) => {
      if (command !== 'npm') return exec(command, args, options);
      calls.push(args);
      writeFileSync(process.env.RELEASE_TRACE, JSON.stringify(calls));
    };
    syncBuiltinESMExports();
    globalThis.fetch = async (url) => new Response(
      JSON.stringify({ dist: { integrity: process.env.RELEASE_INTEGRITY } }),
      { status: url.includes('/${publishedName}/') ? 200 : 404 },
    );
  `,
  );
  const env = {
    ...process.env,
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: `refs/tags/v${manifest.version}`,
    GITHUB_REPOSITORY: "Thiagolino8/oasprint",
    RELEASE_TRACE: trace,
    RELEASE_INTEGRITY: integrity,
  };
  const publish = () =>
    execFileSync(
      process.execPath,
      ["--import", pathToFileURL(preload).href, script, f.artifacts, "--publish"],
      { env, encoding: "utf8", stdio: "pipe" },
    );
  publish();
  const calls = JSON.parse(await readFile(trace, "utf8"));
  assert.equal(calls.length, 6);
  assert.ok(calls.every((args) => args[0] === "publish" && !args[1].includes(`${publishedName}-`)));
  assert.equal(calls.at(-1)[1], join(f.artifacts, `${manifest.name}-${manifest.version}.tgz`));
  await rm(trace);
  env.RELEASE_INTEGRITY = "sha512-different";
  assert.throws(publish, /Versão já publicada com conteúdo diferente/);
  await assert.rejects(readFile(trace), { code: "ENOENT" });
});

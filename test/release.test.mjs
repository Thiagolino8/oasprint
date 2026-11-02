import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  for (const platform of await readdir(new URL("npm/", root))) {
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
  await rm(join(f.artifacts, `oasprint-win32-x64-${manifest.version}.tgz`));
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

void test("release rejeita dependência pública de nativo com publicação suspensa", async (t) => {
  const f = await fixture(t);
  const source = join(f.directory, "source");
  await mkdir(join(source, "scripts"), { recursive: true });
  await mkdir(join(source, "native"));
  await copyFile(script, join(source, "scripts/release.mjs"));
  for (const filename of ["Cargo.toml", "Cargo.lock"]) {
    await copyFile(new URL(`native/${filename}`, root), join(source, "native", filename));
  }
  for (const platform of await readdir(new URL("npm/", root))) {
    const directory = join(source, "npm", platform);
    await mkdir(directory, { recursive: true });
    await copyFile(new URL(`npm/${platform}/package.json`, root), join(directory, "package.json"));
  }
  const unsafe = structuredClone(manifest);
  unsafe.optionalDependencies["oasprint-win32-arm64"] = manifest.version;
  await writeFile(join(source, "package.json"), JSON.stringify(unsafe));
  assert.throws(
    () =>
      execFileSync(process.execPath, [join(source, "scripts/release.mjs"), "--source"], {
        stdio: "pipe",
        env: { ...process.env, GITHUB_REF: "refs/heads/main" },
      }),
    /Dependências opcionais devem incluir apenas os pacotes nativos com publicação habilitada/,
  );
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
    import { createHash } from 'node:crypto';
    import { syncBuiltinESMExports } from 'node:module';
    import { readFileSync, writeFileSync } from 'node:fs';
    import { basename } from 'node:path';
    const exec = childProcess.execFileSync;
    const calls = [];
    const available = new Map([['${publishedName}', process.env.RELEASE_INTEGRITY]]);
    childProcess.execFileSync = (command, args, options) => {
      if (command !== 'npm') return exec(command, args, options);
      calls.push(args);
      writeFileSync(process.env.RELEASE_TRACE, JSON.stringify(calls));
      if (process.env.RELEASE_STAGED !== 'true') available.set(
        basename(args[1], '-${manifest.version}.tgz'),
        process.env.RELEASE_PUBLISHED_INTEGRITY ?? 'sha512-' + createHash('sha512').update(readFileSync(args[1])).digest('base64'),
      );
    };
    syncBuiltinESMExports();
    globalThis.fetch = async (url) => {
      if (url.includes('/oasprint-win32-')) throw new Error('Consulta a pacote privado');
      const name = decodeURIComponent(new URL(url).pathname.split('/')[1]);
      return new Response(
        JSON.stringify({ dist: { integrity: available.get(name) } }),
        { status: available.has(name) ? 200 : 404 },
      );
    };
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
  assert.equal(calls.length, 4);
  assert.ok(calls.every((args) => args[0] === "publish" && !args[1].includes(`${publishedName}-`)));
  assert.ok(calls.every((args) => !args[1].includes("oasprint-win32-")));
  assert.equal(calls.at(-1)[1], join(f.artifacts, `${manifest.name}-${manifest.version}.tgz`));
  await rm(trace);
  env.RELEASE_STAGED = "true";
  assert.throws(publish, /Publicação não disponível no registro/);
  assert.equal(JSON.parse(await readFile(trace, "utf8")).length, 1);
  delete env.RELEASE_STAGED;
  env.RELEASE_PUBLISHED_INTEGRITY = "sha512-different";
  assert.throws(publish, /Conteúdo publicado difere do artifact/);
  assert.equal(JSON.parse(await readFile(trace, "utf8")).length, 1);
  delete env.RELEASE_PUBLISHED_INTEGRITY;
  await rm(trace);
  env.RELEASE_INTEGRITY = "sha512-different";
  assert.throws(publish, /Versão já publicada com conteúdo diferente/);
  await assert.rejects(readFile(trace), { code: "ENOENT" });
});

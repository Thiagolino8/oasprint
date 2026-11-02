import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const { name, version, optionalDependencies, repository } = manifest;
const expected = [manifest];
for (const directory of (await readdir(new URL("npm/", root), { withFileTypes: true })).sort(
  (a, b) => a.name.localeCompare(b.name),
)) {
  if (!directory.isDirectory()) continue;
  const platform = directory.name;
  const native = JSON.parse(await readFile(new URL(`npm/${platform}/package.json`, root), "utf8"));
  assert.equal(native.name, `${name}-${platform}`);
  assert.equal(native.version, version, `Versão divergente em ${native.name}`);
  if (native.private !== true) assert.equal(optionalDependencies[native.name], version);
  assert.equal(native.repository.url, repository.url);
  expected.push(native);
}
assert.deepEqual(
  Object.keys(optionalDependencies).sort(),
  expected
    .slice(1)
    .filter((entry) => entry.private !== true)
    .map((entry) => entry.name)
    .sort(),
  "Dependências opcionais devem incluir apenas os pacotes nativos com publicação habilitada",
);
const cargo = await readFile(new URL("native/Cargo.toml", root), "utf8");
const lock = await readFile(new URL("native/Cargo.lock", root), "utf8");
assert.equal(cargo.match(/^version = "([^"]+)"/m)?.[1], version, "Versão divergente no Cargo.toml");
assert.equal(
  lock.match(/\[\[package\]\]\nname = "oasprint"\nversion = "([^"]+)"/)?.[1],
  version,
  "Versão divergente no Cargo.lock",
);
const tag = process.env.GITHUB_REF;
if (tag?.startsWith("refs/tags/"))
  assert.equal(tag, `refs/tags/v${version}`, "Tag e versão divergem");

const [directory, mode = "--check"] = process.argv.slice(2);
if (directory === "--source") {
  console.log(`Versões conferidas: ${version}`);
} else {
  assert.ok(
    directory && ["--check", "--publish"].includes(mode),
    "Uso: node scripts/release.mjs <artefatos> [--check|--publish] ou --source",
  );
  const files = (await readdir(directory)).filter((file) => file.endsWith(".tgz"));
  assert.equal(
    files.length,
    expected.length,
    "São necessários o principal e todos os pacotes nativos",
  );
  const license = await readFile(new URL("LICENSE", root), "utf8");
  const packages = [];
  for (const source of expected) {
    const filename = `${source.name}-${version}.tgz`;
    assert.ok(files.includes(filename), `Pacote ausente: ${filename}`);
    const archive = resolve(directory, filename);
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/);
    assert.ok(
      entries.every((entry) => entry.startsWith("package/") && !entry.split("/").includes("..")),
      `Caminho inválido: ${filename}`,
    );
    const packed = JSON.parse(
      execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" }),
    );
    assert.deepEqual(packed, source, `Manifesto divergente: ${filename}`);
    assert.equal(
      execFileSync("tar", ["-xOf", archive, "package/LICENSE"], { encoding: "utf8" }),
      license,
      `Licença divergente: ${filename}`,
    );
    const required =
      source.name === name
        ? [
            ...Object.values(source.exports).flatMap((entry) =>
              typeof entry === "string" ? [entry] : Object.values(entry),
            ),
            ...Object.values(source.bin),
          ]
        : [`bin/${source.os[0] === "win32" ? "oasprint.exe" : "oasprint"}`];
    for (const entry of required)
      assert.ok(
        entries.includes(`package/${entry.replace(/^\.\//, "")}`),
        `Entrada ausente em ${filename}: ${entry}`,
      );
    if (source.name === name)
      assert.ok(
        !entries.some((entry) => entry.startsWith("package/dist/bin/")),
        "O pacote principal não deve incluir binários",
      );
    const integrity = `sha512-${createHash("sha512")
      .update(await readFile(archive))
      .digest("base64")}`;
    packages.push({ name: source.name, archive, integrity, private: source.private === true });
  }
  console.log(`Validados ${packages.length} pacotes na versão ${version}`);
  if (mode === "--publish") {
    assert.equal(
      process.env.GITHUB_ACTIONS,
      "true",
      "A publicação automática exige GitHub Actions",
    );
    assert.equal(
      process.env.GITHUB_EVENT_NAME,
      "push",
      "A publicação automática exige push de tag",
    );
    assert.equal(tag, `refs/tags/v${version}`, "A publicação automática exige a tag da versão");
    assert.equal(
      repository.url,
      `git+https://github.com/${process.env.GITHUB_REPOSITORY}.git`,
      "Repositório divergente",
    );
    // Check every existing version before publishing anything; retries only skip identical tarballs.
    const pending = [];
    for (const entry of packages) {
      if (entry.private) {
        console.log(`Publicação suspensa (private): ${entry.name}`);
        continue;
      }
      const response = await fetch(
        `https://registry.npmjs.org/${encodeURIComponent(entry.name)}/${version}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (response.status === 404) {
        await response.body?.cancel();
        pending.push(entry);
      } else {
        assert.ok(response.ok, `Falha ao consultar ${entry.name}: HTTP ${response.status}`);
        const published = await response.json();
        assert.equal(
          published.dist.integrity,
          entry.integrity,
          `Versão já publicada com conteúdo diferente: ${entry.name}@${version}`,
        );
        console.log(`Já publicado: ${entry.name}@${version}`);
      }
    }
    // Upload native packages together, then await their processing before publishing the main one.
    const delays = [0, 2_000, 4_000, 8_000, 16_000, 30_000, 60_000, 60_000, 60_000, 60_000];
    for (const batch of [
      pending.filter((entry) => entry.name !== name),
      pending.filter((entry) => entry.name === name),
    ]) {
      for (const entry of batch) {
        execFileSync(
          "npm",
          [
            "publish",
            entry.archive,
            "--access",
            "public",
            "--ignore-scripts",
            "--tag",
            version.includes("-") ? "next" : "latest",
          ],
          { stdio: "inherit" },
        );
      }
      await Promise.all(
        batch.map(async (entry) => {
          for (const [attempt, delay] of delays.entries()) {
            if (delay) await setTimeout(delay);
            const response = await fetch(
              `https://registry.npmjs.org/${encodeURIComponent(entry.name)}/${version}`,
              { cache: "no-store", signal: AbortSignal.timeout(30_000) },
            );
            if (response.status === 404 && attempt < delays.length - 1) {
              await response.body?.cancel();
              if (attempt === 0)
                console.log(`Aguardando processamento no npm: ${entry.name}@${version}`);
              continue;
            }
            assert.ok(
              response.ok,
              `Publicação não disponível no registro: ${entry.name}@${version} (HTTP ${response.status}). Confira staging ou execute novamente após a propagação.`,
            );
            assert.equal(
              (await response.json()).dist.integrity,
              entry.integrity,
              `Conteúdo publicado difere do artifact: ${entry.name}@${version}`,
            );
            console.log(`Publicado e conferido: ${entry.name}@${version}`);
            break;
          }
        }),
      );
    }
  }
}

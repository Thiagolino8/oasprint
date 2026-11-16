import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import {
  appendFile,
  chmod,
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { nativeBinary } from "../src/native.mjs";

const exec = promisify(execFile);
const document = (type = "string") =>
  JSON.stringify({
    openapi: "3.1.0",
    components: { schemas: { Item: { type } } },
    paths: {},
  });
const prepare = async () => {
  const directory = await mkdtemp(join(tmpdir(), "oasprint-cache-"));
  const config = join(directory, "oasprint.json");
  const input = join(directory, "input.json");
  const output = join(directory, "output.d.ts");
  await writeFile(input, document());
  const configure = (apis) => writeFile(config, JSON.stringify({ apis }));
  await configure({ api: { root: input, "x-openapi-ts": { output } } });
  const run = (...args) =>
    exec(nativeBinary(), ["--config", config, "--no-env", "--json", ...args], {
      cwd: directory,
      timeout: 30_000,
    });
  const cache = async () => {
    const path = join(directory, ".cache/oasprint");
    const files = await readdir(path);
    assert.equal(files.length, 1);
    return readFile(join(path, files[0]), "utf8");
  };
  return { directory, input, output, configure, run, cache };
};

void test("reutiliza contratos e recupera output alterado ou apagado", async () => {
  const { input, output, run } = await prepare();
  assert.deepEqual(JSON.parse((await run()).stdout), { apis: 1, updated: 1 });
  const original = await readFile(output, "utf8");
  const before = await stat(output);
  assert.deepEqual(JSON.parse((await run()).stdout), { apis: 1, updated: 0 });
  assert.equal((await stat(output)).mtimeMs, before.mtimeMs);
  await writeFile(output, "alterado");
  await run();
  assert.equal(await readFile(output, "utf8"), original);
  await rm(output);
  await run();
  assert.equal(await readFile(output, "utf8"), original);
  const inputBefore = await stat(input);
  await writeFile(input, document("number"));
  await utimes(input, inputBefore.atime, inputBefore.mtime);
  await run();
  assert.notEqual(await readFile(output, "utf8"), original);
  await run("--runtime-import", "custom-runtime");
  assert.match(await readFile(output, "utf8"), /custom-runtime/);
});

void test("cache corrompido ou indisponível não impede geração", async () => {
  const { directory, output, run } = await prepare();
  await run();
  const cacheDirectory = join(directory, ".cache/oasprint");
  const [name] = await readdir(cacheDirectory);
  await writeFile(join(cacheDirectory, name), "{inválido");
  await rm(output);
  await run();
  assert.ok((await stat(output)).size > 0);
  await rm(join(directory, ".cache"), { recursive: true });
  await writeFile(join(directory, ".cache"), "indisponível");
  await rm(output);
  await run();
  assert.ok((await stat(output)).size > 0);
});

void test(
  "invalida o cache quando o executável muda",
  { skip: process.platform !== "linux" },
  async () => {
    const { directory, run, cache } = await prepare();
    await run();
    const original = await cache();
    const binary = join(directory, process.platform === "win32" ? "other.exe" : "other");
    await copyFile(nativeBinary(), binary);
    await appendFile(binary, "oasprint-cache-identity-test");
    await chmod(binary, 0o755);
    await exec(binary, ["--config", join(directory, "oasprint.json"), "--no-env"]);
    assert.notEqual(await cache(), original);
  },
);

void test("não publica cache nem outputs quando uma API do lote é inválida", async () => {
  const { directory, input, output, configure, run, cache } = await prepare();
  await run();
  const original = await readFile(output, "utf8");
  const manifest = await cache();
  await writeFile(input, document("number"));
  const invalid = join(directory, "invalid.json");
  await writeFile(invalid, "{inválido");
  await configure({
    good: { root: input, "x-openapi-ts": { output } },
    bad: { root: invalid, "x-openapi-ts": { output: join(directory, "bad.d.ts") } },
  });
  await assert.rejects(run());
  assert.equal(await readFile(output, "utf8"), original);
  assert.equal(await cache(), manifest);
  await assert.rejects(stat(join(directory, "bad.d.ts")), { code: "ENOENT" });
});

void test("limita o cache aos outputs atuais e permite desativá-lo", async () => {
  const { directory, input, output, configure, run, cache } = await prepare();
  await run("--no-cache");
  await assert.rejects(stat(join(directory, ".cache")), { code: "ENOENT" });
  for (const type of ["string", "number", "boolean"]) {
    await writeFile(input, document(type));
    await run();
    assert.equal(Object.keys(JSON.parse(await cache()).entries).length, 1);
  }
  await configure({
    api: { root: input, "x-openapi-ts": { output } },
    other: { root: input, "x-openapi-ts": { output: join(directory, "other.d.ts") } },
  });
  await run();
  assert.equal(Object.keys(JSON.parse(await cache()).entries).length, 2);
  await configure({ api: { root: input, "x-openapi-ts": { output } } });
  await run();
  assert.equal(Object.keys(JSON.parse(await cache()).entries).length, 1);
});

void test("consulta HTTP em todo hit e propaga falha remota", async (t) => {
  let source = document();
  let requests = 0;
  let status = 200;
  const server = createServer((_, response) => {
    requests += 1;
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(source);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const { output, configure, run, cache } = await prepare();
  await configure({
    remote: { root: `http://127.0.0.1:${address.port}/openapi`, "x-openapi-ts": { output } },
  });
  await run();
  const original = await readFile(output, "utf8");
  await run();
  assert.equal(requests, 2);
  source = document("number");
  await run();
  assert.equal(requests, 3);
  assert.notEqual(await readFile(output, "utf8"), original);
  const manifest = await cache();
  const current = await readFile(output, "utf8");
  status = 401;
  await assert.rejects(run());
  assert.equal(requests, 4);
  assert.equal(await cache(), manifest);
  assert.equal(await readFile(output, "utf8"), current);
});

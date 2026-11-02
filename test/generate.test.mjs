import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));
const schema = {
  openapi: "3.0.3",
  info: { title: "Fixture", version: "1" },
  paths: {},
  components: {
    schemas: {
      FixtureSchema: {
        type: "object",
        properties: { fixture_name: { type: "string" } },
      },
    },
  },
};

const fixture = async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "atlas-prepared-types-"));
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(schema));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const output = path.join(root, "fixture.d.ts");
  const preparedConfig = path.join(root, "prepared.json");
  await fs.writeFile(path.join(root, "schema.json"), JSON.stringify(schema));
  await fs.writeFile(
    preparedConfig,
    JSON.stringify({
      apis: {
        fixture: {
          root: "schema.json",
          "x-openapi-ts": { output: "fixture.d.ts" },
        },
      },
    }),
  );
  await fs.writeFile(
    path.join(root, "oasprint.json"),
    JSON.stringify({
      apis: {
        fixture: {
          root: `http://127.0.0.1:${server.address().port}/openapi.json`,
          "x-openapi-ts": { output },
        },
      },
    }),
  );
  return { root, output, preparedConfig, requests: () => requests };
};

void test("gen:types usa schemas preparados pelo Hub sem buscar APIs novamente", async (t) => {
  const f = await fixture(t);
  await exec(process.execPath, [path.join(project, "src/cli.mjs")], {
    cwd: project,
    timeout: 30000,
    env: { ...process.env, HUB_PREPARED_OPENAPI_CONFIG: f.preparedConfig },
  });
  assert.match(await fs.readFile(f.output, "utf8"), /FixtureSchema/);
  assert.match(await fs.readFile(f.output, "utf8"), /fixture_name/);
  const output = await fs.readFile(f.output, "utf8");
  const runtimeImport = JSON.parse(output.match(/from ("[^"]+")/)[1]);
  assert.equal(runtimeImport, "oasprint");
  assert.equal(f.requests(), 0);
});

void test("gen:types mantém o download normal quando não há preparação do Hub", async (t) => {
  const f = await fixture(t);
  const env = { ...process.env, NO_PROXY: "127.0.0.1,localhost" };
  delete env.HUB_PREPARED_OPENAPI_CONFIG;
  await exec(process.execPath, [path.join(project, "src/cli.mjs")], {
    cwd: f.root,
    timeout: 30000,
    env,
  });
  assert.match(await fs.readFile(f.output, "utf8"), /FixtureSchema/);
  assert.ok(f.requests() > 0);
});

void test("rejeita configuração e schema YAML sem escrever outputs", async (t) => {
  const f = await fixture(t);
  const original = await fs.readFile(f.preparedConfig, "utf8");
  const run = () =>
    exec(process.execPath, [path.join(project, "src/cli.mjs")], {
      cwd: f.root,
      timeout: 30000,
      env: { ...process.env, HUB_PREPARED_OPENAPI_CONFIG: f.preparedConfig },
    });
  await fs.writeFile(f.preparedConfig, "apis: {}\n");
  await assert.rejects(run(), /JSON inválido/);
  await fs.writeFile(f.preparedConfig, original);
  await fs.writeFile(path.join(f.root, "schema.json"), "openapi: 3.1.0\npaths: {}\n");
  await assert.rejects(run(), /JSON inválido/);
  await assert.rejects(fs.stat(f.output), { code: "ENOENT" });
  assert.equal(f.requests(), 0);
});

void test("configuração preparada ausente falha sem voltar ao download das APIs", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    exec(process.execPath, [path.join(project, "src/cli.mjs")], {
      cwd: f.root,
      timeout: 30000,
      env: {
        ...process.env,
        HUB_PREPARED_OPENAPI_CONFIG: path.join(f.root, "missing.json"),
      },
    }),
  );
  assert.equal(f.requests(), 0);
});

void test("preserva mtime e recupera output apagado, alterado e contrato novo", async (t) => {
  const f = await fixture(t);
  const run = () =>
    exec(process.execPath, [path.join(project, "src/cli.mjs")], {
      cwd: f.root,
      timeout: 30000,
      env: { ...process.env, HUB_PREPARED_OPENAPI_CONFIG: f.preparedConfig },
    });
  await run();
  const original = await fs.readFile(f.output, "utf8");
  const oldTime = new Date("2020-01-01T00:00:00Z");
  await fs.utimes(f.output, oldTime, oldTime);
  assert.match((await run()).stdout, /0 arquivos atualizados/);
  assert.equal((await fs.stat(f.output)).mtimeMs, oldTime.getTime());
  await fs.writeFile(f.output, "corrompido");
  await run();
  assert.equal(await fs.readFile(f.output, "utf8"), original);
  await fs.unlink(f.output);
  await run();
  assert.equal(await fs.readFile(f.output, "utf8"), original);
  const updated = structuredClone(schema);
  updated.components.schemas.FixtureSchema.properties.other = {
    type: "number",
  };
  await fs.writeFile(path.join(f.root, "schema.json"), JSON.stringify(updated));
  await run();
  assert.match(await fs.readFile(f.output, "utf8"), /"other"\?: number/);
  assert.equal(f.requests(), 0);
});

void test("erro em uma API não publica os outros contratos", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.output, "preservar");
  const config = JSON.parse(await fs.readFile(f.preparedConfig, "utf8"));
  config.apis.invalid = {
    root: path.join(f.root, "missing.json"),
    "x-openapi-ts": { output: path.join(f.root, "invalid.d.ts") },
  };
  await fs.writeFile(f.preparedConfig, JSON.stringify(config));
  await assert.rejects(
    exec(process.execPath, [path.join(project, "src/cli.mjs")], {
      cwd: f.root,
      timeout: 30000,
      env: { ...process.env, HUB_PREPARED_OPENAPI_CONFIG: f.preparedConfig },
    }),
  );
  assert.equal(await fs.readFile(f.output, "utf8"), "preservar");
});

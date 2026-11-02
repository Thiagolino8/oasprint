import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { nativeBinary } from "../src/native.mjs";
import { generateClients } from "../src/generate.mjs";

const exec = promisify(execFile);
const schema = {
  openapi: "3.1.0",
  paths: {},
  components: { schemas: { Value: { type: "string" } } },
};
const fixture = async (t, handler) => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "oasprint-http-"));
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = async (roots, headers = []) => {
    const configPath = path.join(directory, "oasprint.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        apis: Object.fromEntries(
          roots.map((root, i) => [i, { root, "x-openapi-ts": { output: `${i}.d.ts` } }]),
        ),
        resolve: { http: { headers } },
      }),
    );
    return configPath;
  };
  const env = { ...process.env, NO_PROXY: "127.0.0.1,localhost", PATH: "" };
  delete env.HUB_PREPARED_OPENAPI_CONFIG;
  const run = (args = [], overrides = {}) =>
    exec(nativeBinary(), args, { cwd: directory, env: { ...env, ...overrides }, timeout: 30000 });
  return { directory, origin, config, run };
};

void test("executa sem Node no PATH, carrega .env literal e respeita prioridade do ambiente", async (t) => {
  const received = [];
  const f = await fixture(t, (request, response) => {
    received.push(request.headers);
    response.end(JSON.stringify(schema));
  });
  await f.config(
    [`${f.origin}/schema`],
    [
      { matches: `${f.origin}/**`, name: "Authorization", envVariable: "OASPRINT_TEST_TOKEN" },
      { matches: `${f.origin}/**`, name: "X-Default", value: "first" },
      { matches: `${f.origin}/**`, name: "x-default", value: "last" },
    ],
  );
  await fs.writeFile(
    path.join(f.directory, ".env"),
    "export OASPRINT_TEST_TOKEN='Bearer $UNCHANGED#literal'\n",
  );
  await f.run();
  assert.equal(received[0].authorization, "Bearer $UNCHANGED#literal");
  assert.equal(received[0]["x-default"], "last");
  await f.run([], { OASPRINT_TEST_TOKEN: "Bearer environment" });
  assert.equal(received[1].authorization, "Bearer environment");
  const configPath = path.join(f.directory, "oasprint.json");
  await f.run([], { HUB_PREPARED_OPENAPI_CONFIG: configPath });
  assert.equal(received[2].authorization, undefined);
});

void test("preserva auth em redirect da mesma origem e remove credenciais em outra origem", async (t) => {
  const received = [];
  const target = await fixture(t, (request, response) => {
    received.push(request.headers);
    response.end(JSON.stringify(schema));
  });
  const f = await fixture(t, (request, response) => {
    if (request.url === "/same") {
      response.writeHead(302, { location: "/schema" });
      response.end();
    } else if (request.url === "/cross") {
      response.writeHead(307, { location: `${target.origin}/schema` });
      response.end();
    } else {
      received.push(request.headers);
      response.end(JSON.stringify(schema));
    }
  });
  await f.config(
    [`${f.origin}/same`],
    [
      { matches: `${f.origin}/**`, name: "Authorization", value: "Bearer fixture" },
      { matches: `${f.origin}/**`, name: "Cookie", value: "fixture=value" },
    ],
  );
  await f.run();
  assert.equal(received[0].authorization, "Bearer fixture");
  assert.equal(received[0].cookie, "fixture=value");
  await f.config(
    [`${f.origin}/cross`],
    [
      { matches: `${f.origin}/**`, name: "Authorization", value: "Bearer fixture" },
      { matches: `${f.origin}/**`, name: "Cookie", value: "fixture=value" },
    ],
  );
  await f.run();
  assert.equal(received[1].authorization, undefined);
  assert.equal(received[1].cookie, undefined);
});

void test("downloads são paralelos e retry repete apenas a API que falhou", async (t) => {
  const counts = { slow: 0, other: 0 };
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, async (request, response) => {
    const name = request.url === "/slow" ? "slow" : "other";
    counts[name]++;
    if (name === "slow") {
      await ready;
      if (counts.slow < 3) {
        response.writeHead(counts.slow === 1 ? 429 : 503);
        response.end();
        return;
      }
    } else release();
    response.end(JSON.stringify(schema));
  });
  await f.config([`${f.origin}/slow`, `${f.origin}/other`]);
  const result = await f.run();
  assert.deepEqual(counts, { slow: 3, other: 1 });
  assert.match(result.stdout, /2 APIs; 2 arquivos atualizados/);
});

void test("falhas 4xx não repetem nem expõem path, query ou credenciais", async (t) => {
  let count = 0;
  const f = await fixture(t, (_request, response) => {
    count++;
    response.writeHead(403);
    response.end("private-body");
  });
  await f.config(
    [`${f.origin}/private-path?secret=private-query`],
    [{ matches: `${f.origin}/**`, name: "Authorization", value: "Bearer private-token" }],
  );
  await assert.rejects(f.run(), (error) => {
    assert.match(error.stderr, /HTTP 403/);
    assert.ok(error.stderr.includes(f.origin));
    assert.doesNotMatch(error.stderr, /private-path|private-query|private-token|private-body/);
    return true;
  });
  assert.equal(count, 1);
  await f.config(
    [`${f.origin}/schema`],
    [{ matches: "http://**", name: "Authorization", value: "Bearer private-token" }],
  );
  await assert.rejects(f.run(), /host exato/);
  assert.equal(count, 1);
});

void test("aceita gzip e documentos maiores que o limite padrão do cliente HTTP", async (t) => {
  const body = gzipSync(JSON.stringify({ ...schema, description: "x".repeat(11 * 1024 * 1024) }));
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200, { "content-encoding": "gzip" });
    response.end(body);
  });
  await f.config([`${f.origin}/schema`]);
  await f.run();
  assert.match(
    await fs.readFile(path.join(f.directory, "0.d.ts"), "utf8"),
    /type Schema_Value = string/,
  );
});

void test("API Node delega ao executável sem carregar .env", async (t) => {
  const f = await fixture(t, (_request, response) => response.end(JSON.stringify(schema)));
  await fs.writeFile(path.join(f.directory, "schema.json"), JSON.stringify(schema));
  const configPath = await f.config(["schema.json"]);
  assert.deepEqual(await generateClients({ configPath, runtimeImport: "./custom" }), {
    apis: 1,
    updated: 1,
  });
  assert.match(await fs.readFile(path.join(f.directory, "0.d.ts"), "utf8"), /from "\.\/custom"/);
  assert.deepEqual(await generateClients({ configPath, runtimeImport: "./custom" }), {
    apis: 1,
    updated: 0,
  });
});

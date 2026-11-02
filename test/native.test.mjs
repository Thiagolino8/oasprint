import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { generateClient } from "./fixtures/javascript-generator.mjs";

import { nativeBinary } from "../src/native.mjs";
const binary = nativeBinary();
const run = (args, cwd) => spawnSync(binary, args, { cwd, encoding: "utf8", timeout: 30_000 });
const document = (schemas = {}, paths = {}) => ({
  openapi: "3.1.0",
  components: { schemas },
  paths,
});

// Cada teste mantém seus artefatos em /tmp para investigar divergências.
const prepare = async (documents) => {
  const directory = await mkdtemp(join(tmpdir(), "oasprint-native-test-"));
  const jobs = documents.map((_, index) => ({ input: `${index}.json`, output: `${index}.d.ts` }));
  await Promise.all(
    documents.map((doc, index) =>
      writeFile(join(directory, jobs[index].input), JSON.stringify(doc)),
    ),
  );
  const manifest = join(directory, "jobs.json");
  await writeFile(
    manifest,
    JSON.stringify({
      apis: Object.fromEntries(
        jobs.map((job, i) => [i, { root: job.input, "x-openapi-ts": { output: job.output } }]),
      ),
    }),
  );
  return { directory, jobs, manifest };
};

const compare = async (documents) => {
  const { directory, jobs, manifest } = await prepare(documents);
  const result = run(["--config", manifest], tmpdir());
  assert.equal(result.status, 0, result.stderr);
  for (const [index, doc] of documents.entries()) {
    assert.equal(await readFile(join(directory, jobs[index].output), "utf8"), generateClient(doc));
  }
};

void test("coincide com o contrato sintético completo da suíte JavaScript", async () => {
  const source = await readFile(new URL("./generator.test.mjs", import.meta.url), "utf8");
  const start = source.indexOf("const ref =");
  const end = source.indexOf("void test(");
  assert.ok(start >= 0 && end > start);
  const fixture = runInNewContext(`${source.slice(start, end)}\ndocument`);
  await compare([fixture]);
});

void test("preserva números ECMAScript, nomes Unicode, colisões e ordem de chaves", async () => {
  const numbers = [
    -0,
    1.5,
    1e-7,
    1e-6,
    1e20,
    1e21,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
    9007199254740992,
  ];
  // Amostra determinística de expoentes, sem depender do relógio ou de Math.random.
  for (let exponent = -300; exponent <= 300; exponent += 7)
    numbers.push(1.2345678901234567 * 10 ** exponent);
  await compare([
    document({
      "😀/~": { const: { 10: numbers, 2: "\u2028\u2029", z: null } },
      "\ue000": { type: ["number", "null"], enum: numbers },
      "A-B": { type: "string" },
      A_B: { type: "boolean" },
      Encoded: { $ref: "#/components/schemas/%F0%9F%98%80~1~0" },
      Tuple: { type: "array", prefixItems: [{ const: -0 }, { type: "string" }], items: false },
    }),
  ]);
});

void test("coincide em media types JSON e sobrescrita de milhares de parâmetros", async () => {
  const parameters = Array.from({ length: 3000 }, (_, i) => ({
    name: `q${i}`,
    in: "query",
    schema: { type: "string" },
  }));
  await compare([
    document(
      {},
      {
        "/large": {
          parameters,
          get: {
            parameters: [
              { name: "q2999", in: "query", required: true, schema: { type: "integer" } },
            ],
            responses: {
              200: {
                content: {
                  "application/problem+json; charset=utf-8": { schema: { const: "json" } },
                  "text/plain": { schema: { type: "number" } },
                },
              },
              204: {},
              "2XX": {},
            },
          },
        },
      },
    ),
  ]);
});

void test("preserva projeções em ciclos com dependências repetidas e modos misturados", async () => {
  const schemas = Object.fromEntries(
    Array.from({ length: 32 }, (_, i) => {
      const next = { $ref: `#/components/schemas/Node${(i + 1) % 32}` };
      return [
        `Node${i}`,
        {
          type: "object",
          properties: {
            value: { type: "string", readOnly: i % 3 === 0, writeOnly: i % 5 === 0 },
            next,
            repeated: next,
          },
        },
      ];
    }),
  );
  const paths = Object.fromEntries(
    Object.keys(schemas).map((name) => {
      const content = { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } };
      return [`/${name}`, { post: { requestBody: { content }, responses: { 200: { content } } } }];
    }),
  );
  await compare([document(schemas, paths)]);
});

void test("rejeita UTF-8 inválido sem gravar tipos ou emitir stdout", async () => {
  const { directory, manifest } = await prepare([document()]);
  const invalid = Buffer.concat([
    Buffer.from('{"openapi":"3.1.0","description":"'),
    Buffer.from([0xff]),
    Buffer.from('"}'),
  ]);
  await writeFile(join(directory, "0.json"), invalid);
  await writeFile(join(directory, "0.d.ts"), "preservado");
  const result = run(["--config", manifest]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /JSON inválido/);
  assert.equal(await readFile(join(directory, "0.d.ts"), "utf8"), "preservado");
  const stdin = spawnSync(binary, ["--stdin"], { input: invalid, encoding: "utf8" });
  assert.equal(stdin.status, 1, stdin.stderr);
  assert.match(stdin.stderr, /JSON inválido/);
  assert.equal(stdin.stdout, "");
});

void test("preserva runtimeImport e ignora referências em anotações", async () => {
  const doc = document({
    Value: {
      type: "object",
      properties: { value: { type: "string", default: { $ref: "ignored.json" } } },
      example: { $ref: "ignored.json" },
      "x-custom": { $ref: "ignored.json" },
    },
  });
  const { directory, jobs, manifest } = await prepare([doc]);
  jobs[0].runtimeImport = "./custom-runtime";
  await writeFile(
    manifest,
    JSON.stringify({
      apis: Object.fromEntries(
        jobs.map((job, i) => [i, { root: job.input, "x-openapi-ts": { output: job.output } }]),
      ),
    }),
  );
  const result = run(["--config", manifest, "--runtime-import", jobs[0].runtimeImport]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readFile(join(directory, jobs[0].output), "utf8"),
    generateClient(doc, { runtimeImport: jobs[0].runtimeImport }),
  );
});

void test("falhas de contrato não gravam parcialmente os outputs", async () => {
  const failures = [
    document({ Broken: { $ref: "#/components/schemas/Missing" } }),
    document({ External: { $ref: "external.json#/Schema" } }),
    document({}, { "/circular": { $ref: "#/paths/~1circular" } }),
    document({ Unsupported: { type: "unsupported" } }),
    { openapi: "2.0" },
  ];
  for (const failure of failures) {
    const { directory, manifest } = await prepare([document(), failure]);
    const output = join(directory, "0.d.ts");
    await writeFile(output, "preservado");
    const result = run(["--config", manifest]);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(await readFile(output, "utf8"), "preservado");
  }
});

void test("resolve caminhos pelo manifesto e rejeita outputs duplicados normalizados", async () => {
  const { directory, jobs, manifest } = await prepare([document(), document()]);
  jobs[1].output = "sub/../0.d.ts";
  await writeFile(
    manifest,
    JSON.stringify({
      apis: Object.fromEntries(
        jobs.map((job, i) => [i, { root: job.input, "x-openapi-ts": { output: job.output } }]),
      ),
    }),
  );
  const result = run(["--config", manifest], tmpdir());
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Output duplicado/);
  await assert.rejects(stat(join(directory, "0.d.ts")), { code: "ENOENT" });
});

void test("preserva mtime e repara output alterado, inclusive UTF-8 inválido", async () => {
  const doc = document({ Value: { enum: ["ok", null], type: ["string", "null"] } });
  const { directory, manifest } = await prepare([doc]);
  let result = run(["--config", manifest]);
  assert.equal(result.status, 0, result.stderr);
  const output = join(directory, "0.d.ts");
  const previous = await stat(output, { bigint: true });
  result = run(["--config", manifest]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await stat(output, { bigint: true })).mtimeNs, previous.mtimeNs);
  for (const corrupted of ["alterado", Buffer.from([0xff, 0xfe, 0x00])]) {
    await writeFile(output, corrupted);
    result = run(["--config", manifest]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(output, "utf8"), generateClient(doc));
  }
});

void test(
  "sete contratos reais coincidem byte a byte",
  { skip: !process.env.OPENAPI_CORPUS },
  async () => {
    const names = ["accounts", "dashboard", "alumni", "plataforma", "brasil", "erp", "contents"];
    const documents = await Promise.all(
      names.map(async (name) =>
        JSON.parse(
          await readFile(join(process.env.OPENAPI_CORPUS, `${name}-api-docs.json`), "utf8"),
        ),
      ),
    );
    await compare(documents);
  },
);

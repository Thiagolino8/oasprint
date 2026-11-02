import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { generateClient } from "../dist/generator.mjs";

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema) => ({ "application/json": { schema } });
const document = {
  openapi: "3.1.0",
  paths: {
    "/nodes/{id}": {
      parameters: [
        { in: "path", name: "id", schema: { type: "string" } },
        {
          in: "query",
          name: "limit",
          required: true,
          schema: { type: "string" },
        },
      ],
      get: {
        parameters: [{ in: "query", name: "limit", schema: { type: "integer" } }],
        responses: { 200: { content: json(ref("Node")) } },
      },
      post: {
        requestBody: { required: true, content: json(ref("Node")) },
        responses: { 201: { content: json(ref("Node")) } },
      },
      delete: { responses: { 204: { description: "Sem corpo" } } },
    },
    "/optional": {
      post: {
        requestBody: { content: json({ type: "string" }) },
        responses: { 200: {} },
      },
    },
    "/upload": {
      post: {
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: { file: { type: "string", format: "binary" } },
              },
            },
          },
        },
        responses: { 204: {} },
      },
    },
    "/choices": {
      get: {
        responses: {
          200: {
            content: json({
              oneOf: [ref("A"), ref("B")],
              discriminator: {
                propertyName: "kind",
                mapping: {
                  a: "#/components/schemas/A",
                  b: "#/components/schemas/B",
                },
              },
            }),
          },
        },
      },
    },
    "/list": {
      get: {
        responses: {
          200: {
            content: json({
              allOf: [
                ref("Page"),
                {
                  type: "object",
                  properties: { data: { type: "array", items: ref("Node") } },
                },
              ],
            }),
          },
        },
      },
    },
    "/headers": {
      get: {
        parameters: [
          {
            in: "header",
            name: "X-Version",
            required: true,
            schema: { enum: ["v1"] },
          },
        ],
        responses: { "2XX": { content: json({ type: ["string", "null"] }) } },
      },
    },
  },
  components: {
    schemas: {
      Node: {
        type: "object",
        required: ["name", "id", "password"],
        properties: {
          name: { type: "string" },
          id: { type: "string", readOnly: true },
          password: { type: "string", writeOnly: true },
          next: { ...ref("Node"), nullable: true },
          status: { type: ["string", "null"], enum: ["active", "inactive"] },
          protocol: { type: ["string", "null"], const: "v1" },
          metadata: {
            type: "object",
            additionalProperties: { type: "number" },
          },
        },
      },
      Page: {
        type: "object",
        required: ["data", "total"],
        properties: {
          data: { type: "array", items: { type: "array" } },
          total: { type: "integer" },
        },
      },
      Node_Output: { type: "string" },
      Overlap: {
        allOf: [
          {
            type: "object",
            required: ["kind"],
            properties: { kind: { enum: ["a", "b"] } },
          },
          {
            type: "object",
            required: ["kind"],
            properties: { kind: { enum: ["b", "c"] } },
          },
        ],
      },
      A: {
        type: "object",
        required: ["value"],
        properties: { value: { type: "number" } },
      },
      B: {
        type: "object",
        required: ["label"],
        properties: { label: { type: "string" } },
      },
      Escaped: {
        type: "object",
        properties: { 'quote"\n*/': { type: "string", deprecated: true } },
      },
      Tuple: {
        type: "array",
        prefixItems: [{ type: "number" }, { type: "string" }],
        items: false,
      },
      False: false,
      LiteralNumber: { type: "integer", const: 3 },
      MixedEnum: { type: ["string", "number"], enum: ["x", 1] },
      ContradictoryConst: { type: "number", const: "wrong" },
      ContradictoryEnum: { type: "boolean", enum: ["wrong"] },
    },
  },
};

void test("contratos gerados verificam requests, responses, projeções e recursão", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "atlas-client-types-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeImport = path.resolve(import.meta.dirname, "../dist/runtime");
  await fs.writeFile(path.join(root, "schema.d.ts"), generateClient(document, { runtimeImport }));
  const source = `
 import type { client, components } from "./schema";
 import { createTypedApiClient, ApiClientError } from ${JSON.stringify(runtimeImport)};
 const api = createTypedApiClient<client>({ baseUrl: "https://example.invalid", service: "Fixture", errorClass: ApiClientError });
 // @ts-expect-error a aplicação precisa escolher sua política de erro
 createTypedApiClient<client>({ baseUrl: "https://example.invalid", service: "Fixture" });
 api.get["/nodes/{id}"]({ params: { path: { id: "n" }, query: { limit: 10 } } });
 api.get["/nodes/{id}"]({ params: { path: { id: "n" } } });
 // @ts-expect-error path obrigatório
 api.get["/nodes/{id}"]();
 // @ts-expect-error método ausente
 api.put["/nodes/{id}"]({});
 // @ts-expect-error parâmetro sobrescrito é number
 api.get["/nodes/{id}"]({ params: { path: { id: "n" }, query: { limit: "1" } } });
 const params = { path: { id: "n" }, query: { limit: "1" } };
 api.post["/nodes/{id}"]({ params, body: { name: "N", password: "p", status: null, protocol: null, next: { name: "child", password: "p" } } });
 // @ts-expect-error readOnly excluído do body
 api.post["/nodes/{id}"]({ params, body: { name: "N", password: "p", id: "server" } });
 // @ts-expect-error readOnly excluído recursivamente
 api.post["/nodes/{id}"]({ params, body: { name: "N", password: "p", next: { name: "N", password: "p", id: "server" } } });
 // @ts-expect-error body obrigatório
 api.post["/nodes/{id}"]({ params });
 // @ts-expect-error writeOnly ainda obrigatório na request
 api.post["/nodes/{id}"]({ params, body: { name: "N" } });
 // @ts-expect-error enum inválido
 api.post["/nodes/{id}"]({ params, body: { name: "N", password: "p", status: "invalid" } });
 const result = await api.get["/nodes/{id}"]({ params: { path: { id: "n" } } });
 const id: string = result.id;
 // @ts-expect-error null continua possível no enum do response
 const nonNullableStatus: Exclude<typeof result.status, null> = result.status;
 // @ts-expect-error null continua possível no const do response
 const nonNullableProtocol: Exclude<typeof result.protocol, null> = result.protocol;
 const collidingName: components["schemas"]["Node_Output"] = "ok";
 const intersection: components["schemas"]["Overlap"] = { kind: "b" };
 // @ts-expect-error allOf preserva a interseção fora do padrão de paginação
 const invalidIntersection: components["schemas"]["Overlap"] = { kind: "c" };
 // @ts-expect-error writeOnly excluído do response
 result.password;
 // @ts-expect-error writeOnly excluído recursivamente
 result.next?.password;
 const removed: void = await api.delete["/nodes/{id}"]({ params });
 const unknown: unknown = await api.post["/optional"]();
 api.post["/optional"]({ body: "ok" });
 api.post["/upload"]({ body: new FormData() });
 // @ts-expect-error upload obrigatório
 api.post["/upload"]();
 const choice = await api.get["/choices"]();
 if (choice.kind === "a") { const value: number = choice.value; }
 else { const label: string = choice.label; }
 const list = await api.get["/list"]();
 const name: string = list.data[0].name;
 const total: number = list.total;
 const version: string | null = await api.get["/headers"]({ params: { header: { "X-Version": "v1" } } });
 // @ts-expect-error header obrigatório
 api.get["/headers"]();
 const tuple: components["schemas"]["Tuple"] = [1, "x"];
 // @ts-expect-error ordem de tupla
 const wrongTuple: components["schemas"]["Tuple"] = ["x", 1];
 // @ts-expect-error schema false
 const impossible: components["schemas"]["False"] = {};
 const literalNumber: components["schemas"]["LiteralNumber"] = 3;
 const mixedEnum: components["schemas"]["MixedEnum"] = 1;
 // @ts-expect-error literal numérico preservado
 const wrongNumber: components["schemas"]["LiteralNumber"] = 4;
 // @ts-expect-error enum misto preservado
 const wrongMixedEnum: components["schemas"]["MixedEnum"] = "y";
 // @ts-expect-error const incompatível com o tipo continua impossível
 const wrongConst: components["schemas"]["ContradictoryConst"] = "wrong";
 // @ts-expect-error enum incompatível com o tipo continua impossível
 const wrongEnum: components["schemas"]["ContradictoryEnum"] = "wrong";
 `;
  const file = path.join(root, "usage.ts");
  await fs.writeFile(file, source);
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: false,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }),
  );
});

void test("saída determinística, sem runtime e preservando depreciações", () => {
  const output = generateClient(document);
  assert.equal(output, generateClient(structuredClone(document)));
  assert.match(output, /@deprecated/);
  assert.match(output, /type Schema_Node_Output =/);
  assert.doesNotMatch(output, /\b(?:any|Proxy|const|function)\b/);
});

void test("ignora referências em exemplos, valores e extensões", () => {
  const withAnnotations = structuredClone(document);
  withAnnotations.components.schemas.Node.example = { $ref: "example.json" };
  withAnnotations.components.schemas.Node.examples = [{ $ref: "examples.json" }];
  withAnnotations.components.schemas.Node["x-metadata"] = {
    $ref: "metadata.json",
  };
  withAnnotations.components.schemas.Node.properties.name.default = {
    $ref: "default.json",
  };
  assert.equal(generateClient(withAnnotations), generateClient(document));
});

void test("rejeita referências quebradas/externas e versão incompatível", () => {
  assert.throws(() => generateClient({ ...document, openapi: "2.0" }), /OpenAPI 3/);
  for (const reference of ["#/components/schemas/Missing", "other.json#/Type"]) {
    const invalid = structuredClone(document);
    invalid.components.schemas.Node = { $ref: reference };
    assert.throws(() => generateClient(invalid), /Referência/);
  }
});

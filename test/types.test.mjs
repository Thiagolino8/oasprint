import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

void test("paths provisórios preservam obrigatoriedade, projeções, nullable e respostas vazias", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "oasprint-types-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtime = path.resolve(import.meta.dirname, "../dist/runtime");
  const source = `
    import type { ApiClientFromPaths, ApiResponse } from ${JSON.stringify(runtime)};
    type Body = { id: { readonly $read: string }; password: { readonly $write: string }; name: string };
    type Tree = { readonly id?: { readonly $read: string } | null; password?: { readonly $write: string }; name: string; children?: readonly Tree[]; pair?: readonly [Tree, Tree] };
    type NullFields = { empty: null; optional?: null; absent?: undefined; forbidden?: never };
    type Paths = {
      "/items/{id}": {
        get: { parameters: { path: { id: string } }; responses: { 200: { content: { "application/json": Body | null } } } };
        put: { parameters: { path: { id: string } }; requestBody: { content: { "application/json": Body } }; responses: { 204: { content?: never } } };
        post: { requestBody?: { content: { "application/json": { name: string } } }; responses: { "2XX": { content: { "application/json": boolean } } } };
        patch?: never;
      };
      "/items": { get: { parameters: { query?: { limit?: number } }; responses: { 200: { content: { "application/json": string[] } } } } };
      "/required": { get: { parameters: { query: { page: number } }; responses: { 200: { content: { "application/json": number } } } } };
      "/tree": {
        get: { responses: { 200: { content: { "application/json": Tree } } } };
        post: { requestBody: { content: { "application/json": Tree | null } }; responses: { 208: { content: { "application/json": boolean } } } };
      };
      "/upload": { post: { requestBody: { content: { "multipart/form-data": FormData } }; responses: { 204: { content?: never } } } };
      "/null-fields": {
        get: { responses: { 200: { content: { "application/json": NullFields } } } };
        post: { requestBody: { content: { "application/json": NullFields } }; responses: { 204: { content?: never } } };
      };
    };
    declare const api: ApiClientFromPaths<Paths>;
    api.get["/items/{id}"]({ params: { path: { id: "1" } } });
    api.get["/items"]();
    api.get["/required"]({ params: { query: { page: 1 } } });
    api.get["/required"]({
      params: { query: { page: 1 } },
      querySerializer: (query: { page: number }) => "page=" + query.page.toFixed(),
    });
    api.get["/items"]({ querySerializer: (query) => "limit=" + (query.limit?.toFixed() ?? "") });
    api.post["/items/{id}"]({ body: { name: "ok" }, bodySerializer: (body: { name: string }) => body.name });
    api.put["/items/{id}"]({
      params: { path: { id: "1" } },
      body: { name: "ok", password: "secret" },
      bodySerializer: (body, headers) => {
        const password: string = body.password;
        headers.set("X-Format", "custom");
        return body.name + password;
      },
    });
    // @ts-expect-error query obrigatória
    api.get["/required"]();
    // @ts-expect-error operação sem requestBody
    api.get["/items"]({ body: {} });
    api.post["/items/{id}"]();
    api.post["/items/{id}"]({ body: { name: "ok" } });
    api.put["/items/{id}"]({ params: { path: { id: "1" } }, body: { name: "ok", password: "secret" } });
    const readOnlyBody = { id: { $read: "server" }, name: "ok", password: "secret" };
    // @ts-expect-error readOnly também é rejeitado em variáveis
    api.put["/items/{id}"]({ params: { path: { id: "1" } }, body: readOnlyBody });
    // @ts-expect-error path obrigatório
    api.get["/items/{id}"]();
    // @ts-expect-error body obrigatório
    api.put["/items/{id}"]({ params: { path: { id: "1" } } });
    // @ts-expect-error readOnly excluído da request
    api.put["/items/{id}"]({ params: { path: { id: "1" } }, body: { id: "server", name: "ok", password: "secret" } });
    // @ts-expect-error writeOnly obrigatório na request
    api.put["/items/{id}"]({ params: { path: { id: "1" } }, body: { name: "ok" } });
    // @ts-expect-error query mantém seu tipo
    api.get["/items"]({ params: { query: { limit: "1" } } });
    // @ts-expect-error método ausente
    api.patch["/items/{id}"]();
    const response: ApiResponse<typeof api, "get", "/items/{id}"> = null;
    const responseBody: ApiResponse<typeof api, "get", "/items/{id}"> = { id: "1", name: "ok" };
    // @ts-expect-error writeOnly excluído da response
    const invalid: ApiResponse<typeof api, "get", "/items/{id}"> = { id: "1", name: "ok", password: "secret" };
    const empty: Promise<undefined> = api.put["/items/{id}"]({ params: { path: { id: "1" } }, body: { name: "ok", password: "secret" } });
    const wildcard: Promise<boolean> = api.post["/items/{id}"]();
    const tree: ApiResponse<typeof api, "get", "/tree"> = { id: null, name: "root", children: [{ id: "1", name: "child" }], pair: [{ name: "left" }, { name: "right" }] };
    // @ts-expect-error mantém array readonly
    tree.children?.push({ name: "child" });
    // @ts-expect-error mantém tupla readonly
    tree.pair![0] = { name: "replacement" };
    // @ts-expect-error projeção recursiva remove writeOnly
    const invalidTree: ApiResponse<typeof api, "get", "/tree"> = { name: "root", children: [{ name: "child", password: "secret" }] };
    api.post["/tree"]({ body: { name: "root", children: [{ name: "child", password: "secret" }] } });
    // @ts-expect-error projeção recursiva proíbe readOnly opcional e nullable
    api.post["/tree"]({ body: { name: "root", children: [{ name: "child", id: null }] } });
    const nullableBody: Promise<boolean> = api.post["/tree"]({ body: null });
    type UploadBody = Parameters<typeof api.post["/upload"]>[0]["body"];
    const multipart: UploadBody = new FormData();
    multipart.append("file", new Blob(["body"]), "fixture.txt");
    const nativeMultipart: FormData = multipart;
    api.post["/upload"]({ body: multipart });
    api.post["/null-fields"]({ body: { empty: null } });
    api.post["/null-fields"]({ body: { empty: null, optional: null, absent: undefined } });
    // @ts-expect-error campo null obrigatório continua obrigatório
    api.post["/null-fields"]({ body: {} });
    // @ts-expect-error null não aceita valor escalar
    api.post["/null-fields"]({ body: { empty: "value" } });
    // @ts-expect-error never continua proibido
    api.post["/null-fields"]({ body: { empty: null, forbidden: 1 } });
    const withForbidden = { empty: null, forbidden: 1 };
    // @ts-expect-error never também é proibido em variáveis
    api.post["/null-fields"]({ body: withForbidden });
    const nullFields: ApiResponse<typeof api, "get", "/null-fields"> = { empty: null };
    const nullField: null = nullFields.empty;
    const optionalNullField: null | undefined = nullFields.optional;
    const absentField: undefined = nullFields.absent;
    // @ts-expect-error campo null obrigatório também é preservado na resposta
    const missingNullField: ApiResponse<typeof api, "get", "/null-fields"> = {};
  `;
  const file = path.join(directory, "usage.ts");
  await writeFile(file, source);
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
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => directory,
      getNewLine: () => "\n",
    }),
  );
});

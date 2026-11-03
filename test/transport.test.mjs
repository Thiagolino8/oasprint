import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { ApiClientError, createTypedApiClient } from "../dist/runtime.js";

void test("transporte nativo funciona com HTTP real", { timeout: 10_000 }, async (t) => {
  const waiting = Promise.withResolvers();
  const server = createServer(async (request, response) => {
    if (request.url === "/waiting") {
      waiting.resolve();
      return;
    }
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/target" });
      response.end();
      return;
    }
    if (request.url === "/empty") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === "/error") {
      response.writeHead(422, { "Content-Type": "application/problem+json" });
      response.end('{"message":"invalid"}');
      return;
    }
    if (request.url === "/malformed") {
      response.end("not-json");
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write(
      JSON.stringify({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      }),
    );
    response.end();
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = createTypedApiClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    service: "Teste",
    errorClass: ApiClientError,
    headers: { Authorization: "Bearer fixture", "X-Priority": "base" },
    querySerializer: { array: { style: "form", explode: false } },
    onRequest: (request) => {
      request.headers.set("X-Prepared", "true");
      return request;
    },
  });

  await t.test("preserva métodos, URL, JSON, headers e preparação", async () => {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const result = await client[method]["/inspect/{id}?fixed=1"]({
        body: method === "get" ? undefined : { name: "fixture" },
        headers: { "X-Priority": "request" },
        params: {
          path: { id: "a/b" },
          query: { tags: ["first", "second"] },
          header: { "X-Priority": "param" },
        },
      });
      assert.equal(result.method, method.toUpperCase());
      assert.equal(result.url, "/inspect/a%2Fb?fixed=1&tags=first,second");
      assert.equal(result.headers.authorization, "Bearer fixture");
      assert.equal(result.headers["x-priority"], "param");
      assert.equal(result.headers["x-prepared"], "true");
      assert.equal(result.body, method === "get" ? "" : '{"name":"fixture"}');
      if (method !== "get") assert.equal(result.headers["content-type"], "application/json");
    }
  });

  await t.test("envia URL-encoded, multipart e corpo customizado", async () => {
    const encoded = await client.post["/inspect"]({
      body: { name: "a b" },
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    assert.equal(encoded.body, "name=a+b");
    assert.equal(encoded.headers["content-type"], "application/x-www-form-urlencoded");

    const form = new FormData();
    form.append("file", new Blob(["fixture-data"]), "fixture.txt");
    const multipart = await client.post["/inspect"]({ body: form });
    assert.match(multipart.headers["content-type"], /^multipart\/form-data; boundary=/);
    assert.match(multipart.body, /name="file"; filename="fixture.txt"/);
    assert.match(multipart.body, /\r\nfixture-data\r\n/);

    const binary = await client.post["/inspect"]({
      body: {},
      bodySerializer: (_body, headers) => {
        headers.set("Content-Type", "application/octet-stream");
        return new TextEncoder().encode("opaque");
      },
    });
    assert.equal(binary.headers["content-type"], "application/octet-stream");
    assert.equal(binary.body, "opaque");
  });

  await t.test("trata respostas vazias e mantém a causa dos erros", async () => {
    assert.equal(await client.delete["/empty"](), undefined);
    await assert.rejects(client.get["/error"](), (error) => {
      assert.ok(error instanceof ApiClientError);
      assert.equal(error.response.status, 422);
      assert.deepEqual(error.body, { message: "invalid" });
      return true;
    });
    await assert.rejects(client.get["/malformed"](), SyntaxError);
  });

  await t.test("respeita redirects padrão e override manual", async () => {
    assert.equal((await client.get["/redirect"]()).url, "/target");
    await assert.rejects(client.get["/redirect"]({ redirect: "manual" }), (error) => {
      assert.ok(error instanceof ApiClientError);
      assert.equal(error.response.status, 302);
      return true;
    });
  });

  await t.test("cancela fetch em andamento sem embrulhar o AbortError", async () => {
    const controller = new AbortController();
    const pending = client.get["/waiting"]({ signal: controller.signal });
    await waiting.promise;
    controller.abort();
    await assert.rejects(pending, (error) => error === controller.signal.reason);
  });
});

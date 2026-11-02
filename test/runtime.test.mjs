import assert from "node:assert/strict";
import test from "node:test";
import createClient from "openapi-fetch";
import { createTypedApiClient, ApiClientError } from "../dist/runtime.js";

void test("mantém URL, arrays CSV, headers, fetch autenticado e signal", async () => {
  const controller = new AbortController();
  const client = createTypedApiClient({
    errorClass: ApiClientError,
    baseUrl: "https://example.invalid/api/",
    service: "Teste",
    headers: { "X-App-Client": "g4_engineering" },
    querySerializer: { array: { explode: false, style: "form" } },
    fetch: async (request) => {
      assert.equal(request.method, "GET");
      assert.equal(request.url, "https://example.invalid/api/items/a%2Fb?status=active,inactive");
      assert.equal(request.headers.get("X-App-Client"), "g4_engineering");
      assert.equal(request.headers.get("X-Version"), "v1");
      assert.equal(request.signal.aborted, false);
      controller.abort();
      assert.equal(request.signal.aborted, true);
      return Response.json({ name: "ok" });
    },
  });
  assert.deepEqual(
    await client.get["/items/{id}"]({
      params: {
        path: { id: "a/b" },
        query: { status: ["active", "inactive"] },
        header: { "X-Version": "v1" },
      },
      signal: controller.signal,
    }),
    { name: "ok" },
  );
});

void test("preserva JSON, multipart, serializer e preparação do upload", async () => {
  const requests = [];
  const client = createTypedApiClient({
    errorClass: ApiClientError,
    baseUrl: "https://example.invalid",
    service: "Teste",
    onRequest: (request, schemaPath) => {
      request.headers.set("X-Schema-Path", schemaPath);
      return request;
    },
    fetch: async (request) => {
      requests.push(request);
      return Response.json({ saved: true });
    },
  });
  await client.post["/json"]({ body: { name: "ok" } });
  assert.equal(requests[0].headers.get("Content-Type"), "application/json");
  assert.deepEqual(await requests[0].json(), { name: "ok" });
  const form = new FormData();
  form.set("file", new Blob(["example"], { type: "text/plain" }), "example.txt");
  await client.put["/upload"]({ body: form });
  assert.match(requests[1].headers.get("Content-Type"), /^multipart\/form-data; boundary=/);
  assert.equal((await requests[1].formData()).get("file").name, "example.txt");
  await client.patch["/custom"]({ body: {}, bodySerializer: () => form });
  assert.equal(requests[2].headers.get("X-Schema-Path"), "/custom");
  assert.equal((await requests[2].formData()).get("file").size, 7);
});

void test("retorna corpo direto e trata status sem depender do corpo de erro", async () => {
  for (const response of [
    Response.json({ message: "Recusado" }, { status: 422 }),
    new Response(null, { status: 403, headers: { "Content-Length": "0" } }),
    new Response("Indisponível", { status: 503 }),
  ]) {
    const client = createTypedApiClient({
      errorClass: ApiClientError,
      baseUrl: "https://example.invalid",
      service: "Teste",
      fetch: async () => response,
    });
    await assert.rejects(
      client.delete["/items/{id}"]({ params: { path: { id: "n" } } }),
      (error) =>
        error instanceof ApiClientError &&
        error.status === response.status &&
        error.path === "/items/{id}" &&
        error.method === "DELETE" &&
        error.service === "Teste",
    );
  }
  const empty = createTypedApiClient({
    errorClass: ApiClientError,
    baseUrl: "https://example.invalid",
    service: "Teste",
    fetch: async () => new Response(null, { status: 204 }),
  });
  assert.equal(await empty.post["/empty"](), undefined);
});

void test("reutiliza funções por rota sem tratar símbolos ou then como endpoints", async () => {
  const client = createTypedApiClient({
    errorClass: ApiClientError,
    baseUrl: "https://example.invalid",
    service: "Teste",
  });
  assert.equal(client.get["/items"], client.get["/items"]);
  assert.equal(Object.hasOwn(client.get, "/items"), true);
  assert.notEqual(client.get["/items"], client.post["/items"]);
  assert.equal(client.get[Symbol.iterator], undefined);
  assert.equal(client.get.then, undefined);
  assert.equal(await Promise.resolve(client.get), client.get);
});

void test("serializa requests como openapi-fetch nas opções usadas pelo client", async () => {
  const controller = new AbortController();
  const cases = [
    {
      method: "get",
      path: "/items/{id}",
      init: {
        params: {
          path: { id: "a/b?#" },
          query: {
            tags: ["a", "b"],
            filter: { active: true },
            zero: 0,
            omit: null,
          },
        },
      },
    },
    {
      method: "get",
      path: "/items?fixed=1",
      options: {
        querySerializer: {
          allowReserved: true,
          array: { explode: false, style: "form" },
        },
      },
      init: {
        querySerializer: { array: { explode: false, style: "spaceDelimited" } },
        params: { query: { tags: ["a/b", "c"] } },
      },
    },
    {
      method: "get",
      path: "/items/{id}",
      init: {
        baseUrl: "https://other.invalid/v2/",
        pathSerializer: (path, params) => path.replace("{id}", `custom-${params.id}`),
        querySerializer: () => "?custom=1",
        params: { path: { id: "n" } },
        credentials: "include",
        cache: "no-store",
        redirect: "manual",
        signal: controller.signal,
      },
    },
    {
      method: "post",
      path: "/json",
      options: {
        headers: {
          "Content-Type": "application/problem+json",
          "X-Priority": "base",
        },
      },
      init: {
        body: { name: "ok" },
        headers: { "X-Priority": "request" },
        params: { header: { "X-Priority": "param" } },
      },
    },
    {
      method: "post",
      path: "/json",
      init: {
        body: false,
        headers: { "Content-Type": null, "X-Removed": null },
      },
    },
    {
      method: "post",
      path: "/form",
      init: {
        body: { name: "a b", roles: ["a", "b"] },
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    },
    {
      method: "patch",
      path: "/custom",
      init: {
        body: { name: "ok" },
        bodySerializer: () => "custom body",
        headers: { "Content-Type": "text/plain" },
      },
    },
  ];
  for (const { method, path, options, init } of cases) {
    const requests = [];
    const fetch = async (request) => {
      requests.push({
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
        credentials: request.credentials,
        cache: request.cache,
        redirect: request.redirect,
        aborted: request.signal.aborted,
      });
      return Response.json({ saved: true });
    };
    const config = {
      baseUrl: "https://example.invalid/api/",
      headers: { "X-Removed": "base" },
      ...options,
      fetch,
    };
    const reference = createClient(config);
    const client = createTypedApiClient({
      errorClass: ApiClientError,
      ...config,
      service: "Teste",
    });
    const expected = await reference.request(method, path, init);
    assert.deepEqual(await client[method][path](init), expected.data);
    assert.deepEqual(requests[1], requests[0], `${method} ${path}`);
  }
});

void test("preserva a leitura de respostas e o corpo dos erros do openapi-fetch", async () => {
  const responses = [
    () => Response.json(null),
    () => Response.json(false),
    () => Response.json(0),
    () => Response.json({ name: "ok" }),
    ...["null", "false", "0", '{"name":"ok"}'].map(
      (body) => () =>
        new Response(body, {
          headers: { "Content-Length": String(body.length) },
        }),
    ),
    () => new Response(null, { status: 204 }),
    () => new Response(null),
    () => new Response(null, { headers: { "Content-Length": "0" } }),
    () =>
      new Response("false", {
        headers: { "Content-Length": "0", "Transfer-Encoding": "chunked" },
      }),
    () => new Response(null, { status: 403 }),
    () => new Response(null, { status: 403, headers: { "Content-Length": "0" } }),
    () => new Response("Indisponível", { status: 503 }),
    () => Response.json({ message: "Recusado" }, { status: 422 }),
  ];
  for (const response of responses) {
    const config = {
      baseUrl: "https://example.invalid",
      fetch: async () => response(),
    };
    const reference = await createClient(config).GET("/items");
    const client = createTypedApiClient({
      errorClass: ApiClientError,
      ...config,
      service: "Teste",
    });
    if (reference.response.ok) {
      assert.deepEqual(await client.get["/items"](), reference.data);
    } else {
      await assert.rejects(client.get["/items"](), (error) => {
        assert.ok(error instanceof ApiClientError);
        assert.deepEqual(error.body, reference.error);
        assert.equal(error.status, reference.response.status);
        return true;
      });
    }
  }
  for (const response of [
    () => new Response("invalid JSON"),
    () =>
      new Response("invalid JSON", {
        headers: { "Content-Length": "12" },
      }),
    () => new Response(null, { headers: { "Content-Length": "10" } }),
  ]) {
    const config = {
      baseUrl: "https://example.invalid",
      fetch: async () => response(),
    };
    await assert.rejects(createClient(config).GET("/invalid"), SyntaxError);
    await assert.rejects(
      createTypedApiClient({ errorClass: ApiClientError, ...config, service: "Teste" }).get[
        "/invalid"
      ](),
      SyntaxError,
    );
  }
});

void test("usa o Request preparado no fetch local e propaga falhas sem embrulhar", async () => {
  const failure = new Error("network unavailable");
  const controller = new AbortController();
  const client = createTypedApiClient({
    errorClass: ApiClientError,
    baseUrl: "https://example.invalid",
    service: "Teste",
    fetch: () => assert.fail("o fetch local deve prevalecer"),
    onRequest: async (request) => {
      const prepared = new Request(request);
      prepared.headers.set("X-Prepared", "true");
      return prepared;
    },
  });
  await assert.rejects(
    client.get["/items"]({
      signal: controller.signal,
      fetch: async (request) => {
        assert.equal(request.headers.get("X-Prepared"), "true");
        controller.abort();
        assert.equal(request.signal.aborted, true);
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  const preparationFailure = createTypedApiClient({
    errorClass: ApiClientError,
    baseUrl: "https://example.invalid",
    service: "Teste",
    onRequest: () => {
      throw failure;
    },
    fetch: () => assert.fail("preparação interrompida não deve enviar request"),
  });
  await assert.rejects(preparationFailure.post["/upload"](), (error) => error === failure);
});

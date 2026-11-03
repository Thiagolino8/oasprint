import assert from "node:assert/strict";
import test from "node:test";
import createClient from "openapi-fetch";
import { ApiClientError, createTypedApiClient } from "../dist/runtime.js";

const compare = async (path, init, options = {}) => {
  const config = {
    baseUrl: "https://example.invalid",
    fetch: async (request) => Response.json(request.url),
    ...options,
  };
  const expected = await createClient(config).GET(path, init);
  const client = createTypedApiClient({ ...config, service: "Teste", errorClass: ApiClientError });
  assert.equal(
    await client.get[path](init),
    expected.data,
    JSON.stringify({ path, init, options }),
  );
};

void test("preserva os estilos de arrays e objetos de query em todas as opções públicas", async () => {
  const sparse = [];
  sparse[1] = "middle";
  sparse.length = 3;
  for (const arrayStyle of ["form", "spaceDelimited", "pipeDelimited"]) {
    for (const objectStyle of ["form", "deepObject"]) {
      for (const explode of [true, false]) {
        for (const allowReserved of [true, false]) {
          for (const tags of [["a b", "c/d", "á"], [], [null, undefined, 0, false], sparse]) {
            await compare(
              "/items",
              {
                params: {
                  query: {
                    tags,
                    filter: { a: "x/y", b: 0, c: false },
                    zero: 0,
                    no: false,
                    skip: null,
                  },
                },
              },
              {
                querySerializer: {
                  array: { style: arrayStyle, explode },
                  object: { style: objectStyle, explode },
                  allowReserved,
                },
              },
            );
          }
        }
      }
    }
  }
});

void test("preserva paths simples, label, matrix, explode e parâmetros repetidos", async () => {
  for (const prefix of ["", ".", ";"]) {
    for (const explode of ["", "*"]) {
      for (const id of ["á /?#", 0, false, ["a/b", "c d"], [], { a: "x/y", b: false }, {}]) {
        await compare(`/items/{${prefix}id${explode}}/{${prefix}id${explode}}`, {
          params: { path: { id } },
        });
      }
    }
  }
});

void test("reutiliza o path compilado alternando primitivos, arrays, objetos e valores ausentes", async () => {
  const config = {
    baseUrl: "https://example.invalid",
    fetch: async (request) => Response.json(request.url),
  };
  const reference = createClient(config);
  const client = createTypedApiClient({ ...config, service: "Teste", errorClass: ApiClientError });
  const path = "/items/{id}/{.id}/{;id*}";
  const route = client.get[path];
  for (const id of [
    "first",
    ["a/b", "c d"],
    { a: "x/y", b: false },
    0,
    null,
    {},
    undefined,
    [1, 2],
  ]) {
    const init = { params: { path: { id } } };
    assert.equal(await route(init), (await reference.GET(path, init)).data);
    assert.equal(client.get[path], route);
  }
});

void test("preserva propriedades enumeráveis herdadas em objetos de query e path", async () => {
  const value = Object.assign(Object.create({ inherited: "parent value", missing: null }), {
    own: "child/value",
  });
  for (const style of ["form", "deepObject"]) {
    for (const explode of [false, true]) {
      await compare(
        "/items",
        { params: { query: { filter: value, last: 1 } } },
        { querySerializer: { object: { style, explode } } },
      );
    }
  }
  for (const prefix of ["", ".", ";"]) {
    for (const explode of ["", "*"]) {
      await compare(`/items/{${prefix}id${explode}}`, { params: { path: { id: value } } });
    }
  }
});

void test("alternar baseUrl por chamada preserva o path padrão compilado da configuração", async () => {
  const config = {
    baseUrl: "https://example.invalid/{tenant}/",
    fetch: async (request) => Response.json(request.url),
  };
  const reference = createClient(config);
  const client = createTypedApiClient({ ...config, service: "Teste", errorClass: ApiClientError });
  const path = "/items/{.id*}";
  for (const baseUrl of [
    "https://other.invalid/v2/",
    undefined,
    "https://third.invalid",
    undefined,
  ]) {
    const init = {
      baseUrl,
      params: { path: { tenant: "a/b", id: ["first", "second value"] }, query: { page: 1 } },
    };
    assert.equal(await client.get[path](init), (await reference.GET(path, init)).data);
  }
});

void test("rejeita símbolos em parâmetros e headers antes de chamar o transporte", async () => {
  const value = Symbol("invalid");
  const client = createTypedApiClient({
    baseUrl: "https://example.invalid",
    service: "Teste",
    errorClass: ApiClientError,
    fetch: () => assert.fail("valor inválido não pode enviar request"),
  });
  for (const querySerializer of [
    undefined,
    { allowReserved: true },
    {
      allowReserved: false,
      array: { style: "form", explode: false },
      object: { style: "form", explode: false },
    },
    {
      allowReserved: true,
      array: { style: "form", explode: false },
      object: { style: "form", explode: false },
    },
  ]) {
    for (const init of [
      { params: { path: { id: value } } },
      { params: { path: { id: [value] } } },
      { params: { path: { id: { key: value } } } },
      { params: { query: { filter: value } } },
      { params: { query: { filter: [value] } } },
      { params: { query: { filter: { key: value } } } },
      { headers: { "X-Invalid": value } },
      { headers: { "X-Invalid": [value] } },
      { params: { header: { "X-Invalid": value } } },
    ]) {
      await assert.rejects(client.get["/items/{id}"]({ ...init, querySerializer }), TypeError);
    }
  }
});

void test("preserva separadores vazios de query sem arrays intermediários", async () => {
  for (const query of [
    {},
    { empty: [], skip: null, missing: undefined },
    { empty: {}, page: 1 },
    { page: 1, empty: {} },
    { first: {}, second: {}, page: 1 },
    { page: 1, empty: [], filter: {}, last: false },
  ]) {
    await compare("/items", { params: { query } });
  }
});

void test("reflete alterações das opções de query entre chamadas no mesmo client", async () => {
  const options = {
    array: { style: "form", explode: false },
    object: { style: "form", explode: false },
    allowReserved: false,
  };
  const config = {
    baseUrl: "https://example.invalid",
    querySerializer: options,
    fetch: async (request) => Response.json(request.url),
  };
  const reference = createClient(config);
  const client = createTypedApiClient({ ...config, service: "Teste", errorClass: ApiClientError });
  const init = { params: { query: { tags: ["a/b", "c"], filter: { key: "x/y" } } } };
  const route = client.get["/items"];
  assert.equal(await route(init), (await reference.GET("/items", init)).data);
  options.array.explode = true;
  options.object = { style: "deepObject", explode: true };
  options.allowReserved = true;
  assert.equal(await route(init), (await reference.GET("/items", init)).data);
  options.array = { style: "pipeDelimited", explode: false };
  options.allowReserved = false;
  assert.equal(await route(init), (await reference.GET("/items", init)).data);
  const override = { ...init, querySerializer: { allowReserved: true } };
  assert.equal(await route(override), (await reference.GET("/items", override)).data);
  assert.equal(client.get["/items"], route);
});

void test("headers em tuplas, Headers e records mantêm precedência e remoção explícita", async () => {
  const client = createTypedApiClient({
    baseUrl: "https://example.invalid",
    service: "Teste",
    errorClass: ApiClientError,
    headers: [
      ["X-Base", "base"],
      ["X-Priority", "base"],
      ["X-List", "base"],
      ["X-Duplicate", "first"],
      ["x-duplicate", "second"],
    ],
    fetch: async (request) => Response.json(Object.fromEntries(request.headers)),
  });
  const headers = await client.post["/items"]({
    body: { saved: true },
    headers: new Headers({ "X-Priority": "request", "X-Request": "request" }),
    params: {
      header: { "X-Priority": "param", "X-Base": null, "X-List": [1, false], "CONTENT-TYPE": null },
    },
  });
  assert.equal(headers["x-priority"], "param");
  assert.equal(headers["x-request"], "request");
  assert.equal(headers["x-duplicate"], "first, second");
  assert.equal(headers["x-list"], "base, 1, false");
  assert.equal(headers["x-base"], undefined);
  assert.equal(headers["content-type"], "text/plain;charset=UTF-8");
});

void test("preserva headers alterados pelo bodySerializer e o boundary de FormData", async () => {
  const client = createTypedApiClient({
    baseUrl: "https://example.invalid",
    service: "Teste",
    errorClass: ApiClientError,
    fetch: async (request) =>
      Response.json({ headers: Object.fromEntries(request.headers), text: await request.text() }),
  });
  const result = await client.post["/items"]({
    body: {},
    bodySerializer: (_body, headers) => {
      headers.set("Content-Type", "text/custom");
      headers.set("X-Signature", "signed");
      return "payload";
    },
  });
  assert.equal(result.headers["content-type"], "text/custom");
  assert.equal(result.headers["x-signature"], "signed");
  assert.equal(result.text, "payload");
  const multipart = await client.post["/items"]({
    body: {},
    bodySerializer: () => new FormData(),
  });
  assert.match(multipart.headers["content-type"], /^multipart\/form-data; boundary=/);
});

void test("Content-Type explícito em array prevalece sobre o padrão JSON", async () => {
  const client = createTypedApiClient({
    baseUrl: "https://example.invalid",
    service: "Teste",
    errorClass: ApiClientError,
    fetch: async (request) =>
      Response.json({
        contentType: request.headers.get("Content-Type"),
        text: await request.text(),
      }),
  });
  assert.deepEqual(
    await client.post["/form"]({
      body: { name: "a b" },
      params: { header: { "Content-Type": ["application/x-www-form-urlencoded"] } },
    }),
    { contentType: "application/x-www-form-urlencoded", text: "name=a+b" },
  );
});

void test("bodySerializer pode remover headers configurados antes da criação do Request", async () => {
  const client = createTypedApiClient({
    baseUrl: "https://example.invalid",
    service: "Teste",
    errorClass: ApiClientError,
    headers: { "Content-Type": "application/json", "X-Original": "remove" },
    fetch: async (request) =>
      Response.json({ headers: Object.fromEntries(request.headers), text: await request.text() }),
  });
  const result = await client.post["/items"]({
    body: {},
    bodySerializer: (_body, headers) => {
      headers.delete("Content-Type");
      headers.delete("X-Original");
      return "raw";
    },
  });
  assert.equal(result.headers["content-type"], "text/plain;charset=UTF-8");
  assert.equal(result.headers["x-original"], undefined);
  assert.equal(result.text, "raw");
});

void test("parâmetros aninhados falham antes de chamar o transporte", async () => {
  const client = createTypedApiClient({
    baseUrl: "https://example.invalid",
    service: "Teste",
    errorClass: ApiClientError,
    fetch: () => assert.fail("query inválida não pode enviar request"),
  });
  await assert.rejects(
    client.get["/items"]({ params: { query: { filter: { nested: {} } } } }),
    /querySerializer/,
  );
  await assert.rejects(
    client.get["/items"]({ params: { query: { tags: [{}] } } }),
    /querySerializer/,
  );
});

void test("query pré-existente recebe novos parâmetros com ampersand", async () => {
  const client = createTypedApiClient({
    baseUrl: "https://example.invalid",
    service: "Teste",
    errorClass: ApiClientError,
    fetch: async (request) => Response.json(request.url),
  });
  assert.equal(
    await client.get["/items?fixed=1"]({ params: { query: { page: 2 } } }),
    "https://example.invalid/items?fixed=1&page=2",
  );
});

void test("formulário URL-encoded aceita records, strings, URLSearchParams e pares", async () => {
  for (const body of [
    { name: "a b", roles: ["a", "b"] },
    "name=a%20b",
    new URLSearchParams("name=a+b"),
    [
      ["name", "a b"],
      ["name", "c"],
    ],
  ]) {
    const requests = [];
    const config = {
      baseUrl: "https://example.invalid",
      fetch: async (request) => {
        requests.push(await request.text());
        return Response.json({});
      },
    };
    const init = { body, headers: { "Content-Type": "application/x-www-form-urlencoded" } };
    await createClient(config).POST("/form", init);
    await createTypedApiClient({ ...config, service: "Teste", errorClass: ApiClientError }).post[
      "/form"
    ](init);
    assert.equal(requests[1], requests[0]);
  }
});

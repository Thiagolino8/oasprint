import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createTypedApiClient, ApiClientError } from "oasprint";
import { generateClient } from "oasprint/generator";
import { generateClients } from "oasprint/generate";

assert.throws(() => import.meta.resolve("openapi-fetch"), { code: "ERR_MODULE_NOT_FOUND" });

const document = {
  openapi: "3.1.0",
  paths: {
    "/ready": {
      get: {
        responses: { 200: { content: { "application/json": { schema: { type: "string" } } } } },
      },
    },
  },
};
const expected = generateClient(document);
assert.match(expected, /"\/ready"/);
await writeFile("schema.json", JSON.stringify(document));
await writeFile(
  "oasprint.json",
  JSON.stringify({
    apis: { fixture: { root: "schema.json", "x-openapi-ts": { output: "schema.d.ts" } } },
  }),
);
assert.equal((await generateClients()).updated, 1);
assert.equal(await readFile("schema.d.ts", "utf8"), expected);
assert.equal((await generateClients()).updated, 0);
const api = createTypedApiClient({
  baseUrl: "https://example.invalid",
  service: "Fixture",
  errorClass: ApiClientError,
  fetch: async () => new Response('"ready"'),
});
assert.equal(await api.get["/ready"](), "ready");

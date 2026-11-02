import {
  type ClientOptions,
  type FetchOptions,
  type FetchResponse,
  createFinalURL,
  createQuerySerializer,
  defaultBodySerializer,
  defaultPathSerializer,
  mergeHeaders,
  removeTrailingSlash,
} from "openapi-fetch";
import type { ApiClientErrorOptions } from "./error.js";
export { ApiClientError, type ApiClientErrorOptions } from "./error.js";

// As assinaturas geradas já contêm params/body e a projeção read/write.
// Estas opções não instanciam os tipos condicionais de openapi-fetch por rota.
export type ApiRequestOptions = Omit<RequestInit, "body" | "headers" | "method"> &
  Pick<ClientOptions, "headers" | "querySerializer" | "fetch" | "baseUrl" | "pathSerializer"> & {
    bodySerializer?: (body: unknown) => BodyInit | undefined;
  };

type HttpMethod = "delete" | "get" | "patch" | "post" | "put";

type ProvisionalRequestOptions<Operation> = Omit<FetchOptions<Operation>, "parseAs" | "middleware">;

// Só contratos provisórios, ainda fora dos OpenAPI publicados, usam esta
// adaptação. Contratos gerados já exportam funções diretas em `client`.
export type ApiClientFromPaths<Paths> = {
  [Method in HttpMethod]: {
    [
      Path in keyof Paths as Paths[Path] extends Record<Method, object> ? Path : never
    ]: Paths[Path] extends Record<Method, infer Operation extends Record<string, unknown>>
      ? {} extends ProvisionalRequestOptions<Operation>
        ? (
            init?: ProvisionalRequestOptions<Operation>,
          ) => Promise<NonNullable<FetchResponse<Operation, object, `${string}/${string}`>["data"]>>
        : (
            init: ProvisionalRequestOptions<Operation>,
          ) => Promise<NonNullable<FetchResponse<Operation, object, `${string}/${string}`>["data"]>>
      : never;
  };
};

type RuntimeRequestOptions = Omit<ApiRequestOptions, "bodySerializer"> & {
  bodySerializer?: typeof serializeBody;
  params?: {
    query?: Record<string, unknown>;
    path?: Record<string, unknown>;
    header?: ClientOptions["headers"];
  };
  body?: unknown;
};

// A implementação instalada aceita headers, mas sua declaração omite o argumento.
const serializeBody: (body: unknown, headers?: Headers) => BodyInit | undefined =
  defaultBodySerializer;

export const createTypedApiClient = <Client extends object>({
  baseUrl,
  fetch: baseFetch = globalThis.fetch,
  headers: baseHeaders,
  errorClass: ErrorClass,
  onRequest,
  querySerializer,
  service,
}: Pick<ClientOptions, "fetch" | "headers" | "querySerializer"> & {
  baseUrl: string;
  errorClass: new (options: ApiClientErrorOptions) => Error;
  onRequest?: (request: Request, schemaPath: string) => Request | Promise<Request>;
  service: string;
}): Client => {
  const normalizedBaseUrl = removeTrailingSlash(baseUrl);
  const baseQuerySerializer =
    typeof querySerializer === "function"
      ? querySerializer
      : createQuerySerializer(querySerializer);
  const genMethod = (method: HttpMethod) => {
    const httpMethod = method.toUpperCase();
    const routes: Record<string, (init?: RuntimeRequestOptions) => Promise<unknown>> =
      Object.create(
        new Proxy(Object.create(null), {
          get: (_target, path: string | symbol) => {
            if (typeof path !== "string" || path[0] !== "/") return undefined;
            return (routes[path] = async ({
              baseUrl: localBaseUrl,
              fetch = baseFetch,
              headers,
              params = {},
              body,
              bodySerializer = serializeBody,
              pathSerializer = defaultPathSerializer,
              querySerializer: localQuerySerializer,
              ...init
            }: RuntimeRequestOptions = {}) => {
              const requestQuerySerializer = !localQuerySerializer
                ? baseQuerySerializer
                : typeof localQuerySerializer === "function"
                  ? localQuerySerializer
                  : createQuerySerializer({
                      ...(typeof querySerializer === "object" ? querySerializer : {}),
                      ...localQuerySerializer,
                    });
              const mergedHeaders = mergeHeaders(baseHeaders, headers, params.header);
              const serializedBody =
                body === undefined ? undefined : bodySerializer(body, mergedHeaders);
              let request = new Request(
                createFinalURL(path, {
                  baseUrl: localBaseUrl ? removeTrailingSlash(localBaseUrl) : normalizedBaseUrl,
                  params,
                  querySerializer: requestQuerySerializer,
                  pathSerializer,
                }),
                {
                  redirect: "follow",
                  ...init,
                  method: httpMethod,
                  body: serializedBody,
                  headers:
                    serializedBody === undefined || serializedBody instanceof FormData
                      ? mergedHeaders
                      : mergeHeaders(
                          { "Content-Type": "application/json" },
                          baseHeaders,
                          headers,
                          params.header,
                        ),
                },
              );
              if (onRequest) request = await onRequest(request, path);
              const response = await fetch(request);
              const contentLength = response.headers.get("Content-Length");
              const empty =
                response.status === 204 ||
                (contentLength === "0" &&
                  !response.headers.get("Transfer-Encoding")?.includes("chunked"));
              if (response.ok) {
                if (empty) return;
                if (contentLength) return response.json();
                const text = await response.text();
                return text ? (JSON.parse(text) as unknown) : undefined;
              }
              let error: unknown = empty ? undefined : await response.text();
              if (typeof error === "string" && error) {
                try {
                  error = JSON.parse(error) as unknown;
                } catch {
                  // Erros também podem ter corpo em texto.
                }
              }
              throw new ErrorClass({
                body: error,
                method,
                path,
                response,
                service,
              });
            });
          },
        }),
      );
    return routes;
  };
  // A relação Client ↔ operação existe só nos tipos gerados. O runtime recebe
  // apenas método/path, sem levar uma tabela de todos os endpoints ao browser.
  return {
    delete: genMethod("delete"),
    get: genMethod("get"),
    patch: genMethod("patch"),
    post: genMethod("post"),
    put: genMethod("put"),
  } as Client;
};

// Tipos derivados de um client criado por `createTypedApiClient`. Cada API
// fixa o próprio client em aliases no seu `*-api-client.ts`.
export type ApiRequest<
  Client,
  Method extends keyof Client,
  Path extends keyof Client[Method],
> = Client[Method][Path] extends (...params: infer Params) => unknown
  ? NonNullable<Params[0]>
  : never;

export type ApiQuery<Client, Method extends keyof Client, Path extends keyof Client[Method]> =
  ApiRequest<Client, Method, Path> extends { params?: { query?: infer Query } }
    ? NonNullable<Query>
    : never;

export type ApiPathParams<Client, Method extends keyof Client, Path extends keyof Client[Method]> =
  ApiRequest<Client, Method, Path> extends { params?: { path?: infer Params } }
    ? NonNullable<Params>
    : never;

export type ApiBody<Client, Method extends keyof Client, Path extends keyof Client[Method]> =
  ApiRequest<Client, Method, Path> extends { body?: infer Body } ? NonNullable<Body> : never;

export type ApiResponse<
  Client,
  Method extends keyof Client,
  Path extends keyof Client[Method],
> = Client[Method][Path] extends (...params: never) => Promise<infer Data> ? Data : never;

// Item de listagem paginada (`{ content: Item[] }`).
export type ApiListItem<Client extends { get: object }, Path extends keyof Client["get"]> =
  ApiResponse<Client, "get", Path> extends { content?: (infer Item)[] } ? Item : never;

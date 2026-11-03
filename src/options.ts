export type HeadersOptions =
  | HeadersInit
  | Record<string, string | number | boolean | (string | number | boolean)[] | null | undefined>;

export type QuerySerializerOptions = {
  array?: { style: "form" | "spaceDelimited" | "pipeDelimited"; explode: boolean };
  object?: { style: "form" | "deepObject"; explode: boolean };
  allowReserved?: boolean;
};

export type QuerySerializer = (query: Record<string, unknown>) => string;

export type ApiRequestOptions = Omit<RequestInit, "body" | "headers" | "method"> & {
  baseUrl?: string;
  fetch?: (request: Request) => Promise<Response>;
  headers?: HeadersOptions;
  querySerializer?: QuerySerializer | QuerySerializerOptions;
  pathSerializer?: (path: string, params: Record<string, unknown>) => string;
  bodySerializer?: (body: unknown, headers: Headers) => BodyInit | undefined;
};

export type HttpMethod = "delete" | "get" | "patch" | "post" | "put";

type Project<Value, Mode extends "$read" | "$write"> = Value extends {
  readonly $read: infer Read;
}
  ? Mode extends "$read"
    ? Project<Read, Mode>
    : never
  : Value extends { readonly $write: infer Write }
    ? Mode extends "$write"
      ? Project<Write, Mode>
      : never
    : Value extends readonly unknown[]
      ? { [Key in keyof Value]: Project<Value[Key], Mode> }
      : Value extends (...args: never[]) => unknown
        ? Value
        : Value extends object
          ? {
              [
                Key in keyof Value as Value[Key] extends null | undefined
                  ? Key
                  : NonNullable<Value[Key]> extends Record<
                        Mode extends "$read" ? "$write" : "$read",
                        unknown
                      >
                    ? never
                    : Key
              ]: Project<Value[Key], Mode>;
            } & (Mode extends "$write"
              ? {
                  [
                    Key in keyof Value as Value[Key] extends null | undefined
                      ? never
                      : NonNullable<Value[Key]> extends Record<"$read", unknown>
                        ? Key
                        : never
                  ]?: never;
                }
              : unknown)
          : Value;

type Content<Value> = Value extends { content: infer Media }
  ? Media[Extract<keyof Media, `${string}/${string}`>]
  : undefined;

type RequestBody<Operation> = Operation extends { requestBody?: infer Body }
  ? Project<Content<NonNullable<Body>>, "$write">
  : never;

type OperationOptions<Operation> = Omit<ApiRequestOptions, "querySerializer" | "bodySerializer"> & {
  querySerializer?:
    | ((
        query: Operation extends { parameters: { query?: infer Query } }
          ? NonNullable<Query>
          : Record<string, unknown>,
      ) => string)
    | QuerySerializerOptions;
  bodySerializer?: (body: RequestBody<Operation>, headers: Headers) => BodyInit | undefined;
} & (Operation extends { parameters: infer Params }
    ? {} extends Params
      ? { params?: Params }
      : { params: Params }
    : { params?: { query?: Record<string, unknown> } }) &
  ([RequestBody<Operation>] extends [never]
    ? { body?: never }
    : Operation extends { requestBody: unknown }
      ? { body: RequestBody<Operation> }
      : { body?: RequestBody<Operation> });

type OperationResponse<Operation> = Operation extends { responses: infer Responses }
  ? {
      [Status in keyof Responses]: `${Status & (string | number)}` extends `2${string}`
        ? Project<Content<Responses[Status]>, "$read">
        : never;
    }[keyof Responses]
  : unknown;

// Contratos gerados já contêm assinaturas diretas; só paths provisórios passam aqui.
export type ApiClientFromPaths<Paths> = {
  [Method in HttpMethod]: {
    [
      Path in keyof Paths as Paths[Path] extends Record<Method, object> ? Path : never
    ]: Paths[Path] extends Record<Method, infer Operation>
      ? {} extends OperationOptions<Operation>
        ? (init?: OperationOptions<Operation>) => Promise<OperationResponse<Operation>>
        : (init: OperationOptions<Operation>) => Promise<OperationResponse<Operation>>
      : never;
  };
};

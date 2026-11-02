export type ApiClientErrorOptions = {
  body: unknown;
  method: string;
  path: string;
  response: Response;
  service: string;
};

export class ApiClientError extends Error {
  readonly body: unknown;
  readonly method: string;
  readonly path: string;
  readonly response: Response;
  readonly service: string;
  readonly status: number;

  constructor({ body, method, path, response, service }: ApiClientErrorOptions) {
    super(`${service} request failed for ${path} (${response.status})`);
    this.name = "ApiClientError";
    this.body = body;
    this.method = method.toUpperCase();
    this.path = path;
    this.response = response;
    this.service = service;
    this.status = response.status;
  }
}

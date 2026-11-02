/** Emite somente declarações, com client por método/rota e components.schemas. */
export declare const generateClient: (
  document: { openapi: string; [key: string]: unknown },
  options?: { runtimeImport?: string },
) => string;

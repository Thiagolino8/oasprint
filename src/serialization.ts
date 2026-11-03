import type { HeadersOptions, QuerySerializerOptions } from "./options.js";

type Style =
  | "simple"
  | "label"
  | "matrix"
  | "form"
  | "deepObject"
  | "spaceDelimited"
  | "pipeDelimited";

// Propriedades enumeráveis herdadas fazem parte dos objetos de parâmetros.
function* parameterEntries(value: object): Iterable<readonly [string, unknown]> {
  for (const key in value) yield [key, Reflect.get(value, key)];
}

// Path e query compartilham a gramática; prefixos e delimitadores dependem do estilo.
const createParameterSerializer = (style: Style, explode: boolean, reserved = false) => {
  const prefix = style === "label" ? "." : style === "matrix" ? ";" : "";
  // Só os estilos de path têm prefixo; simple é o path sem prefixo.
  const query = prefix === "" && style !== "simple";
  const expanded = explode || style === "deepObject";
  const keyed = query || prefix === ";";
  const separator = expanded ? (query ? "&" : prefix || ",") : ",";
  const arraySeparator = expanded
    ? separator
    : style === "spaceDelimited"
      ? "%20"
      : style === "pipeDelimited"
        ? "|"
        : separator;
  return (name: string, value: object): string => {
    const array = Array.isArray(value);
    const named = expanded && (!array || keyed);
    let result = prefix + (!expanded && keyed ? `${name}=` : "");
    let delimiter = "";
    const entries: Iterable<readonly [string | number, unknown]> = array
      ? value.entries()
      : parameterEntries(value);
    for (const [key, item] of entries) {
      result += delimiter;
      delimiter = array ? arraySeparator : separator;
      if (named && (item === null || item === undefined)) continue;
      if (named && typeof item === "object")
        throw new Error("Parâmetros aninhados exigem querySerializer próprio.");
      const encoded = reserved
        ? `${item ?? ""}`
        : array && !expanded && !(key in value)
          ? ""
          : encodeURIComponent(`${item}`);
      result +=
        !array && !expanded
          ? `${key},${encoded}`
          : named
            ? `${array ? name : style === "deepObject" ? `${name}[${key}]` : key}=${encoded}`
            : encoded;
    }
    return result;
  };
};

export const createQuerySerializer =
  (options?: QuerySerializerOptions) =>
  (query: Record<string, unknown>): string => {
    const reserved = options?.allowReserved;
    let serializeArray: ReturnType<typeof createParameterSerializer> | undefined;
    let serializeObject: ReturnType<typeof createParameterSerializer> | undefined;
    let search = "";
    let separator = "";
    for (const name in query) {
      const value = query[name];
      if (value === undefined || value === null) continue;
      let serialized: string;
      if (typeof value !== "object")
        serialized = `${name}=${reserved ? `${value}` : encodeURIComponent(`${value}`)}`;
      else if (Array.isArray(value)) {
        if (!value.length) continue;
        serializeArray ??= createParameterSerializer(
          options?.array?.style ?? "form",
          options?.array?.explode ?? true,
          reserved,
        );
        serialized = serializeArray(name, value);
      } else {
        serializeObject ??= createParameterSerializer(
          options?.object?.style ?? "deepObject",
          options?.object?.explode ?? true,
          reserved,
        );
        serialized = serializeObject(name, value);
      }
      search += separator + serialized;
      separator = "&";
    }
    return search;
  };

// A rota é imutável: analisa placeholders uma vez, quando a função entra no cache.
export const createPathSerializer = (path: string) => {
  const parts = path.split(/\{([^{}]+)\}/g);
  const fields = parts
    .filter((_, index) => index % 2)
    .map((token) => {
      const prefix = token[0] === "." || token[0] === ";" ? token[0] : "";
      const explode = token.endsWith("*");
      const name = token.slice(prefix.length, explode ? -1 : undefined);
      const lead = prefix + (prefix === ";" ? `${name}=` : "");
      let serialize: ReturnType<typeof createParameterSerializer> | undefined;
      return (params: Record<string, unknown>): string => {
        const value = params[name];
        if (value === undefined || value === null) return `{${token}}`;
        if (typeof value === "object") {
          serialize ??= createParameterSerializer(
            prefix === "." ? "label" : prefix === ";" ? "matrix" : "simple",
            explode,
          );
          return serialize(name, value);
        }
        return lead + encodeURIComponent(`${value}`);
      };
    });
  return (params: Record<string, unknown>): string => {
    let result = parts[0];
    for (let index = 0; index < fields.length; index++) {
      result += fields[index](params) + parts[index * 2 + 2];
    }
    return result;
  };
};

// Retorna se algum source definiu ou removeu Content-Type: null também suprime o default.
export const applyHeaders = (
  target: Headers,
  ...sources: (HeadersOptions | undefined)[]
): boolean => {
  let contentType = false;
  for (const source of sources) {
    if (!source) continue;
    const entries =
      source instanceof Headers
        ? source.entries()
        : Array.isArray(source)
          ? new Headers(source).entries()
          : Object.entries(source);
    for (const [name, value] of entries) {
      if (value === undefined || (Array.isArray(value) && !value.length)) continue;
      if (name.toLowerCase() === "content-type") contentType = true;
      if (value === null) target.delete(name);
      else if (Array.isArray(value)) for (const item of value) target.append(name, `${item}`);
      else target.set(name, `${value}`);
    }
  }
  return contentType;
};

export const serializeBody = (body: unknown, headers: Headers): BodyInit | undefined => {
  if (body instanceof FormData) return body;
  if (headers.get("Content-Type") === "application/x-www-form-urlencoded") {
    // O construtor valida os pares e converte valores pela Web IDL; o body público é unknown.
    return new URLSearchParams(body as ConstructorParameters<typeof URLSearchParams>[0]).toString();
  }
  return JSON.stringify(body);
};

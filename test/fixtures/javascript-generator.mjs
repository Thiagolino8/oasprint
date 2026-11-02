// Emite texto TypeScript diretamente: sem AST/compilador, bundler ou código de
// rotas no browser. Projeções read/write são resolvidas uma vez na geração.
const METHODS = ["delete", "get", "patch", "post", "put"];
const quote = JSON.stringify;
const union = (values) => [...new Set(values)].join(" | ") || "never";
const object = (fields) => `{ ${fields.join(" ")} }`;
const sorted = (value) =>
  Object.entries(value ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const field = (name, type, required, deprecated = false) =>
  `${deprecated ? "/** @deprecated */ " : ""}${quote(name)}${required ? "" : "?"}: ${type};`;

export const generateClient = (document, { runtimeImport = "oasprint" } = {}) => {
  if (!/^3\.[01]\./.test(document.openapi ?? "")) {
    throw new Error("O gerador exige OpenAPI 3.0 ou 3.1.");
  }
  const resolvedReferences = new Map();
  const resolve = (reference) => {
    const cached = resolvedReferences.get(reference);
    if (cached !== undefined) return cached;
    if (!reference.startsWith("#/")) {
      throw new Error(
        `Referência externa não suportada: ${reference}. Prepare um documento com referências locais.`,
      );
    }
    let value = document;
    for (const part of decodeURIComponent(reference.slice(2)).split("/")) {
      value = value?.[part.replaceAll("~1", "/").replaceAll("~0", "~")];
    }
    if (value === undefined) throw new Error(`Referência inexistente: ${reference}.`);
    resolvedReferences.set(reference, value);
    return value;
  };
  const dereference = (value) => {
    if (!value?.$ref) return value;
    const seen = new Set();
    while (value?.$ref) {
      if (seen.has(value.$ref))
        throw new Error(`Referência circular fora de schema: ${value.$ref}.`);
      seen.add(value.$ref);
      value = resolve(value.$ref);
    }
    return value;
  };

  // Propaga a necessidade de projeção pelas referências. Componentes sem
  // readOnly/writeOnly compartilham o mesmo alias nas requests e responses.
  const projections = new WeakMap();
  const dependents = new Map();
  const nodes = [];
  const visit = (value) => {
    if (!value || typeof value !== "object" || projections.has(value)) return;
    const emptyObject =
      value.type === "object" && !value.properties && !value.additionalProperties && !value.allOf;
    projections.set(value, {
      input: value.readOnly === true || emptyObject,
      output: value.writeOnly === true || emptyObject,
    });
    nodes.push(value);
    const children = [
      ...Object.values(value.properties ?? {}),
      ...(value.allOf ?? []),
      ...(value.oneOf ?? []),
      ...(value.anyOf ?? []),
      ...(value.prefixItems ?? []),
      value.items,
      value.additionalProperties,
    ];
    for (const child of children) {
      if (!child || typeof child !== "object") continue;
      visit(child);
      const parents = dependents.get(child) ?? new Set();
      parents.add(value);
      dependents.set(child, parents);
    }
    if (value.$ref) {
      const target = resolve(value.$ref);
      visit(target);
      const parents = dependents.get(target) ?? new Set();
      parents.add(value);
      dependents.set(target, parents);
    }
  };
  const visitContent = (content) => {
    for (const media of Object.values(content ?? {})) visit(media.schema);
  };
  for (const schema of Object.values(document.components?.schemas ?? {})) visit(schema);
  const operations = [];
  for (const [path, rawItem] of sorted(document.paths)) {
    const item = dereference(rawItem);
    for (const method of METHODS) {
      if (!item[method]) continue;
      const operation = dereference(item[method]);
      const parameters = new Map();
      for (const parameter of [...(item.parameters ?? []), ...(operation.parameters ?? [])]) {
        const resolved = dereference(parameter);
        parameters.set(`${resolved.in}:${resolved.name}`, resolved);
        visit(resolved.schema);
        visitContent(resolved.content);
      }
      visitContent(dereference(operation.requestBody)?.content);
      for (const response of Object.values(operation.responses ?? {}))
        visitContent(dereference(response)?.content);
      operations.push({ path, method, operation, parameters });
    }
  }
  for (const node of nodes) {
    const flags = projections.get(node);
    for (const parent of dependents.get(node) ?? []) {
      const parentFlags = projections.get(parent);
      if ((flags.input && !parentFlags.input) || (flags.output && !parentFlags.output)) {
        parentFlags.input ||= flags.input;
        parentFlags.output ||= flags.output;
        nodes.push(parent);
      }
    }
  }
  const aliases = new Map();
  const aliasNames = new Set();
  const definitions = [];
  const referenceType = (reference, mode) => {
    const schema = resolve(reference);
    const direction = projections.get(schema)?.[mode] ? mode : "neutral";
    const key = `${reference}:${direction}`;
    if (!aliases.has(key)) {
      const schemaName = decodeURIComponent(reference)
        .split("/")
        .at(-1)
        .replaceAll("~1", "/")
        .replaceAll("~0", "~")
        .replace(/[^a-zA-Z0-9_$]/g, "_");
      const baseName = `Schema_${schemaName}${direction === "neutral" ? "" : direction === "input" ? "_Input" : "_Output"}`;
      let name = baseName;
      for (let suffix = 2; aliasNames.has(name); suffix++) name = `${baseName}_${suffix}`;
      aliasNames.add(name);
      aliases.set(key, name);
      definitions.push({ name, schema, mode: direction });
    }
    return aliases.get(key);
  };
  const schemaType = (schema, mode) => {
    if (schema === false) return "never";
    if (schema === true || !schema) return "unknown";
    // Nest documenta paginação como allOf de unknown[][] e de Item[]. O
    // Readable do client anterior inferia o último elemento dessas arrays.
    // Resolve a sobreposição aqui para não impor arrays impossíveis ao app.
    if (schema.allOf) {
      const members = schema.allOf.map(dereference);
      const properties = new Map();
      let overlaps = false;
      let paginationOnly = true;
      for (const member of members) {
        for (const [name, property] of Object.entries(member.properties ?? {})) {
          if (properties.has(name)) {
            overlaps = true;
            const inherited = dereference(properties.get(name));
            const replacement = dereference(property);
            paginationOnly &&=
              inherited?.type === "array" &&
              inherited.items?.type === "array" &&
              !inherited.items.items &&
              replacement?.type === "array";
          }
          properties.set(name, property);
        }
      }
      if (
        overlaps &&
        paginationOnly &&
        members.every((member) => member.properties && !member.allOf)
      ) {
        return schemaType(
          {
            ...schema,
            allOf: undefined,
            type: "object",
            properties: {
              ...Object.fromEntries(properties),
              ...schema.properties,
            },
            required: [
              ...new Set([
                ...members.flatMap((member) => member.required ?? []),
                ...(schema.required ?? []),
              ]),
            ],
          },
          mode,
        );
      }
    }
    const parts = [];
    if (schema.$ref) parts.push(referenceType(schema.$ref, mode));
    if (Object.hasOwn(schema, "const")) parts.push(quote(schema.const));
    if (schema.enum) parts.push(`(${union(schema.enum.map(quote))})`);
    if (schema.allOf) parts.push(...schema.allOf.map((item) => `(${schemaType(item, mode)})`));
    for (const key of ["oneOf", "anyOf"]) {
      if (schema[key]) {
        parts.push(
          `(${union(
            schema[key].map((item) => {
              const type = schemaType(item, mode);
              const discriminator = schema.discriminator;
              if (!discriminator?.mapping || !item.$ref) return type;
              const names = Object.entries(discriminator.mapping)
                .filter(([, ref]) => ref === item.$ref)
                .map(([name]) => quote(name));
              return names.length
                ? `(Omit<${type}, ${quote(discriminator.propertyName)}> & { ${quote(discriminator.propertyName)}: ${union(names)} })`
                : type;
            }),
          )})`,
        );
      }
    }
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const primitives = types
      .map((type) => {
        switch (type) {
          case "string":
          case "Date":
            return "string";
          // BrasilAPI publica `float` em vez de `number` + format.
          case "number":
          case "integer":
          case "float":
          case "decimal":
            return "number";
          case "boolean":
            return "boolean";
          case "null":
            return "null";
          case "array": {
            if (schema.prefixItems) {
              const items = schema.prefixItems.map((item) => schemaType(item, mode));
              if (schema.items !== false) items.push(`...(${schemaType(schema.items, mode)})[]`);
              return `[${items.join(", ")}]`;
            }
            return `(${schemaType(schema.items, mode)})[]`;
          }
          case "object":
          case undefined: {
            if (
              type === undefined &&
              !schema.properties &&
              !Object.hasOwn(schema, "additionalProperties")
            )
              return null;
            const fields = sorted(schema.properties).flatMap(([name, property]) => {
              const resolved = dereference(property);
              if (
                (mode === "input" && (property.readOnly || resolved.readOnly)) ||
                (mode === "output" && (property.writeOnly || resolved.writeOnly))
              )
                return [];
              return [
                field(
                  name,
                  schemaType(property, mode),
                  schema.required?.includes(name),
                  property.deprecated,
                ),
              ];
            });
            const extra = schema.additionalProperties;
            if (extra) {
              const index = `Record<string, ${extra === true ? "unknown" : schemaType(extra, mode)}>`;
              return fields.length ? `(${object(fields)} & ${index})` : index;
            }
            return fields.length
              ? object(fields)
              : parts.length
                ? null
                : mode === "neutral"
                  ? "Record<string, never>"
                  : "Record<never, never>";
          }
          default:
            throw new Error(`Tipo OpenAPI não suportado: ${type}.`);
        }
      })
      .filter(Boolean);
    const literals = schema.enum ?? (Object.hasOwn(schema, "const") ? [schema.const] : undefined);
    if (
      primitives.length &&
      !literals?.every((value) => primitives.includes(value === null ? "null" : typeof value))
    ) {
      const primitive = union(primitives);
      parts.push(primitives.length > 1 ? `(${primitive})` : primitive);
    }
    const result = parts.length ? parts.join(" & ") : "unknown";
    // Mantém o comportamento dos contratos publicados: enum com type
    // ["string", "null"] continua aceitando null mesmo sem null no enum.
    return schema.nullable || types.includes("null") ? `(${result}) | null` : result;
  };
  const contentType = (content, mode, fallback) => {
    const entries = Object.entries(content ?? {});
    const json = entries.filter(([mime]) => /^application\/(?:[^/;]+\+)?json(?:;|$)/.test(mime));
    if (!entries.length) return fallback;
    return union(
      (json.length ? json : entries).map(([mime, media]) =>
        mode === "input" && mime === "multipart/form-data"
          ? `FormData | ${schemaType(media.schema, mode)}`
          : schemaType(media.schema, mode),
      ),
    );
  };
  const methods = Object.fromEntries(METHODS.map((method) => [method, []]));
  for (const { path, method, operation, parameters } of operations) {
    const groups = [];
    let paramsRequired = false;
    for (const location of ["path", "query", "header", "cookie"]) {
      const fields = [];
      let required = false;
      for (const parameter of parameters.values()) {
        if (parameter.in !== location) continue;
        const isRequired = location === "path" || parameter.required === true;
        required ||= isRequired;
        fields.push(
          field(
            parameter.name,
            parameter.content
              ? contentType(parameter.content, "input", "unknown")
              : schemaType(parameter.schema, "input"),
            isRequired,
            parameter.deprecated,
          ),
        );
      }
      if (fields.length) groups.push(field(location, object(fields), required));
      paramsRequired ||= required;
    }
    const body = dereference(operation.requestBody);
    const init = [
      field("params", groups.length ? object(groups) : "never", paramsRequired),
      field("body", body ? contentType(body.content, "input", "unknown") : "never", body?.required),
    ];
    const responses = Object.entries(operation.responses ?? {})
      .filter(([status]) => /^2(?:\d\d|XX)$/.test(status))
      .map(([status, response]) =>
        contentType(dereference(response).content, "output", status === "204" ? "void" : "unknown"),
      );
    const result = union(responses.length ? responses : ["unknown"]);
    methods[method].push(
      field(
        path,
        `(init${paramsRequired || body?.required ? "" : "?"}: ApiRequestOptions & ${object(init)}) => Promise<${result}>`,
        true,
        operation.deprecated,
      ),
    );
  }
  const components = sorted(document.components?.schemas).map(([name]) =>
    field(
      name,
      referenceType(
        `#/components/schemas/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        "neutral",
      ),
      true,
    ),
  );
  const declarations = [];
  // A emissão de um alias pode descobrir outras referências; a fila evita
  // expansão recursiva de schemas e preserva referências circulares.
  for (const { name, schema, mode } of definitions) {
    declarations.push(`type ${name} = ${schemaType(schema, mode)};`);
  }
  return `// Gerado por scripts/gen-types.mjs. Não editar.\nimport type { ApiRequestOptions } from ${quote(runtimeImport)};\nexport interface client ${object(METHODS.map((method) => field(method, object(methods[method]), true)))}\nexport interface components { schemas: ${object(components)} }\n${declarations.join("\n")}\n`;
};

use percent_encoding::percent_decode_str;
use serde_json::{Map, Value};
use std::{
    borrow::Cow,
    cell::RefCell,
    collections::{HashMap, HashSet},
};

const METHODS: [&str; 5] = ["delete", "get", "patch", "post", "put"];
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, Hash, PartialEq, Eq)]
enum Mode {
    Neutral,
    Input,
    Output,
}

#[derive(Clone, Copy, Default)]
struct Projection {
    input: bool,
    output: bool,
}

struct Node {
    projection: Projection,
    dependents: Vec<usize>,
}

struct Definition<'a> {
    name: String,
    schema: &'a Value,
    mode: Mode,
}
struct Operation<'a> {
    path: &'a str,
    method: &'a str,
    operation: &'a Value,
    parameters: Vec<&'a Value>,
}

struct Generator<'a> {
    document: &'a Value,
    references: RefCell<HashMap<String, &'a Value>>,
    schema_nodes: HashMap<usize, usize>,
    nodes: Vec<Node>,
    aliases: HashMap<String, [Option<usize>; 3]>,
    alias_names: HashSet<String>,
    definitions: Vec<Definition<'a>>,
}

fn entries(value: &Value) -> Vec<(&str, &Value)> {
    let Some(map) = value.as_object() else {
        return Vec::new();
    };
    // Object.entries() puts array-index keys before other keys.
    let index = |key: &str| {
        if key == "0" {
            return Some(0);
        }
        if !matches!(key.as_bytes().first(), Some(b'1'..=b'9')) {
            return None;
        }
        key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
    };
    let mut result: Vec<_> = map.iter().map(|(k, v)| (k.as_str(), v)).collect();
    if result.iter().any(|(key, _)| index(key).is_some()) {
        result.sort_by_key(|(key, _)| index(key).unwrap_or(u32::MAX));
    }
    result
}

fn sorted(value: &Value) -> Vec<(&str, &Value)> {
    let mut values: Vec<_> = value
        .as_object()
        .into_iter()
        .flat_map(|map| map.iter().map(|(key, value)| (key.as_str(), value)))
        .collect();
    values.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    values
}

fn array(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.is_empty(),
        Value::Number(value) => value.as_f64() != Some(0.0),
        _ => true,
    }
}
fn quoted(value: &str) -> String {
    if value
        .bytes()
        .any(|byte| byte < 0x20 || byte == b'"' || byte == b'\\')
    {
        return serde_json::to_string(value).expect("String serializável");
    }
    let mut result = String::with_capacity(value.len() + 2);
    result.push('"');
    result.push_str(value);
    result.push('"');
    result
}
fn literal(value: &Value) -> String {
    match value {
        Value::Number(number) => ryu_js::Buffer::new()
            .format(number.as_f64().expect("Número JSON"))
            .to_owned(),
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(literal).collect::<Vec<_>>().join(",")
        ),
        Value::Object(_) => format!(
            "{{{}}}",
            entries(value)
                .into_iter()
                .map(|(key, value)| format!("{}:{}", quoted(key), literal(value)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => serde_json::to_string(value).expect("JSON serializável"),
    }
}
fn union(values: impl IntoIterator<Item = String>) -> String {
    let mut values: Vec<_> = values.into_iter().collect();
    if values.len() <= 1 {
        return values.pop().unwrap_or_else(|| "never".into());
    }
    let mut seen = HashSet::with_capacity(values.len());
    let values: Vec<_> = values
        .iter()
        .map(String::as_str)
        .filter(|value| seen.insert(*value))
        .collect();
    if values.is_empty() {
        "never".into()
    } else {
        values.join(" | ")
    }
}
fn object(fields: &[String]) -> String {
    let capacity =
        fields.iter().map(String::len).sum::<usize>() + fields.len().saturating_sub(1) + 4;
    let mut result = String::with_capacity(capacity);
    result.push_str("{ ");
    for (index, field) in fields.iter().enumerate() {
        if index != 0 {
            result.push(' ');
        }
        result.push_str(field);
    }
    result.push_str(" }");
    result
}
fn field(name: &str, ty: &str, required: bool, deprecated: bool) -> String {
    format!(
        "{}{}{}: {};",
        if deprecated {
            "/** @deprecated */ "
        } else {
            ""
        },
        quoted(name),
        if required { "" } else { "?" },
        ty
    )
}
fn id(value: &Value) -> usize {
    std::ptr::from_ref(value).addr()
}
fn decode(reference: &str) -> Result<Cow<'_, str>> {
    percent_decode_str(reference)
        .decode_utf8()
        .map_err(|e| e.to_string())
}

impl<'a> Generator<'a> {
    fn resolve(&self, reference: &str) -> Result<&'a Value> {
        if let Some(value) = self.references.borrow().get(reference) {
            return Ok(value);
        }
        let Some(path) = reference.strip_prefix("#/") else {
            return Err(format!(
                "Referência externa não suportada: {reference}. Prepare um documento com referências locais."
            ));
        };
        let mut value = self.document;
        for key in decode(path)?.split('/') {
            let key = if key.contains('~') {
                Cow::Owned(key.replace("~1", "/").replace("~0", "~"))
            } else {
                Cow::Borrowed(key)
            };
            value = if let Some(map) = value.as_object() {
                map.get(key.as_ref())
            } else if let Some(list) = value.as_array() {
                key.parse::<usize>().ok().and_then(|index| list.get(index))
            } else {
                None
            }
            .ok_or_else(|| format!("Referência inexistente: {reference}."))?;
        }
        self.references.borrow_mut().insert(reference.into(), value);
        Ok(value)
    }

    fn dereference<'b>(&self, mut value: &'b Value) -> Result<&'b Value>
    where
        'a: 'b,
    {
        let Some(reference) = lookup(value, "$ref").as_str().filter(|s| !s.is_empty()) else {
            return Ok(value);
        };
        value = self.resolve(reference)?;
        if lookup(value, "$ref").as_str().is_none_or(str::is_empty) {
            return Ok(value);
        }
        let mut seen = HashSet::from([reference]);
        while let Some(reference) = lookup(value, "$ref").as_str().filter(|s| !s.is_empty()) {
            if !seen.insert(reference) {
                return Err(format!("Referência circular fora de schema: {reference}."));
            }
            value = self.resolve(reference)?;
        }
        Ok(value)
    }

    fn visit(&mut self, value: &'a Value) -> Result<Option<usize>> {
        if !(value.is_object() || value.is_array()) {
            return Ok(None);
        }
        if let Some(index) = self.schema_nodes.get(&id(value)) {
            return Ok(Some(*index));
        }
        let empty = lookup(value, "type") == "object"
            && !truthy(lookup(value, "properties"))
            && !truthy(lookup(value, "additionalProperties"))
            && !truthy(lookup(value, "allOf"));
        let index = self.nodes.len();
        self.schema_nodes.insert(id(value), index);
        self.nodes.push(Node {
            projection: Projection {
                input: lookup(value, "readOnly") == true || empty,
                output: lookup(value, "writeOnly") == true || empty,
            },
            dependents: Vec::new(),
        });
        let mut children: Vec<_> = entries(lookup(value, "properties"))
            .into_iter()
            .map(|(_, v)| v)
            .collect();
        for name in ["allOf", "oneOf", "anyOf", "prefixItems"] {
            children.extend(array(lookup(value, name)));
        }
        children.extend([
            lookup(value, "items"),
            lookup(value, "additionalProperties"),
        ]);
        if let Some(reference) = lookup(value, "$ref").as_str() {
            children.push(self.resolve(reference)?);
        }
        for child in children {
            if let Some(child) = self.visit(child)? {
                self.nodes[child].dependents.push(index);
            }
        }
        Ok(Some(index))
    }

    fn visit_content(&mut self, content: &'a Value) -> Result<()> {
        for (_, media) in entries(content) {
            self.visit(lookup(media, "schema"))?;
        }
        Ok(())
    }

    fn reference_type(&mut self, reference: &str, mode: Mode) -> Result<String> {
        if let Some(index) = self
            .aliases
            .get(reference)
            .and_then(|aliases| aliases[mode as usize])
        {
            return Ok(self.definitions[index].name.clone());
        }
        let schema = self.resolve(reference)?;
        let flags = self
            .schema_nodes
            .get(&id(schema))
            .map(|index| self.nodes[*index].projection)
            .unwrap_or_default();
        let direction = match mode {
            Mode::Input if flags.input => Mode::Input,
            Mode::Output if flags.output => Mode::Output,
            _ => Mode::Neutral,
        };
        let decoded = decode(reference)?;
        let schema_name = decoded
            .rsplit('/')
            .next()
            .unwrap_or("")
            .replace("~1", "/")
            .replace("~0", "~");
        let schema_name: String = schema_name
            .encode_utf16()
            .map(|c| {
                char::from_u32(u32::from(c))
                    .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
                    .unwrap_or('_')
            })
            .collect();
        let suffix = match direction {
            Mode::Neutral => "",
            Mode::Input => "_Input",
            Mode::Output => "_Output",
        };
        let base = format!("Schema_{schema_name}{suffix}");
        let mut name = base.clone();
        let mut suffix = 2;
        while self.alias_names.contains(&name) {
            name = format!("{base}_{suffix}");
            suffix += 1;
        }
        self.alias_names.insert(name.clone());
        let index = Some(self.definitions.len());
        let aliases = self
            .aliases
            .entry(reference.to_owned())
            .or_insert([None; 3]);
        aliases[direction as usize] = index;
        if direction == Mode::Neutral {
            if !flags.input {
                aliases[Mode::Input as usize] = index;
            }
            if !flags.output {
                aliases[Mode::Output as usize] = index;
            }
        }
        self.definitions.push(Definition {
            name: name.clone(),
            schema,
            mode: direction,
        });
        Ok(name)
    }

    fn schema_type(&mut self, schema: &Value, mode: Mode) -> Result<String> {
        if schema == &Value::Bool(false) {
            return Ok("never".into());
        }
        if schema == &Value::Bool(true) || !truthy(schema) {
            return Ok("unknown".into());
        }
        if truthy(lookup(schema, "allOf")) {
            let members: Vec<_> = array(lookup(schema, "allOf"))
                .iter()
                .map(|m| self.dereference(m))
                .collect::<Result<_>>()?;
            let mut properties: HashMap<&str, &Value> = HashMap::new();
            let mut overlaps = false;
            let mut pagination_only = true;
            for member in &members {
                for (name, property) in entries(lookup(member, "properties")) {
                    if let Some(inherited) = properties.get(name) {
                        overlaps = true;
                        let inherited = self.dereference(inherited)?;
                        let replacement = self.dereference(property)?;
                        pagination_only &= lookup(inherited, "type") == "array"
                            && lookup(lookup(inherited, "items"), "type") == "array"
                            && !truthy(lookup(lookup(inherited, "items"), "items"))
                            && lookup(replacement, "type") == "array";
                    }
                    properties.insert(name, property);
                }
            }
            if overlaps
                && pagination_only
                && members
                    .iter()
                    .all(|m| truthy(lookup(m, "properties")) && !truthy(lookup(m, "allOf")))
            {
                let mut merged = schema.clone();
                merged
                    .as_object_mut()
                    .ok_or("Schema inválido.")?
                    .remove("allOf");
                merged["type"] = "object".into();
                let mut properties = Map::new();
                for member in &members {
                    for (name, property) in entries(lookup(member, "properties")) {
                        properties.insert(name.into(), property.clone());
                    }
                }
                for (name, property) in entries(lookup(schema, "properties")) {
                    properties.insert(name.into(), property.clone());
                }
                merged["properties"] = Value::Object(properties);
                let mut required = Vec::new();
                for member in members.iter().copied().chain(std::iter::once(schema)) {
                    for key in array(lookup(member, "required")) {
                        if !required.contains(key) {
                            required.push(key.clone());
                        }
                    }
                }
                merged["required"] = Value::Array(required);
                return self.schema_type(&merged, mode);
            }
        }
        let mut parts = Vec::new();
        if let Some(reference) = lookup(schema, "$ref").as_str() {
            parts.push(self.reference_type(reference, mode)?);
        }
        if let Some(value) = schema.get("const") {
            parts.push(literal(value));
        }
        if truthy(lookup(schema, "enum")) {
            parts.push(format!(
                "({})",
                union(array(lookup(schema, "enum")).iter().map(literal))
            ));
        }
        for member in array(lookup(schema, "allOf")) {
            parts.push(format!("({})", self.schema_type(member, mode)?));
        }
        for key in ["oneOf", "anyOf"] {
            if !truthy(lookup(schema, key)) {
                continue;
            }
            let mut types = Vec::new();
            for member in array(lookup(schema, key)) {
                let ty = self.schema_type(member, mode)?;
                let discriminator = lookup(schema, "discriminator");
                let mut names = Vec::new();
                if truthy(lookup(discriminator, "mapping")) && truthy(lookup(member, "$ref")) {
                    names = entries(lookup(discriminator, "mapping"))
                        .into_iter()
                        .filter(|(_, v)| *v == lookup(member, "$ref"))
                        .map(|(name, _)| quoted(name))
                        .collect();
                }
                types.push(if names.is_empty() {
                    ty
                } else {
                    let key = quoted(
                        lookup(discriminator, "propertyName")
                            .as_str()
                            .ok_or("Discriminador inválido.")?,
                    );
                    format!("(Omit<{ty}, {key}> & {{ {key}: {} }})", union(names))
                });
            }
            parts.push(format!("({})", union(types)));
        }
        let types: Vec<Option<&str>> = if let Some(types) = lookup(schema, "type").as_array() {
            types.iter().map(Value::as_str).collect()
        } else {
            vec![lookup(schema, "type").as_str()]
        };
        let mut primitives = Vec::new();
        for ty in &types {
            let primitive = match *ty {
                Some("string" | "Date") => Some("string".into()),
                Some("number" | "integer" | "float" | "decimal") => Some("number".into()),
                Some("boolean") => Some("boolean".into()),
                Some("null") => Some("null".into()),
                Some("array") => {
                    if truthy(lookup(schema, "prefixItems")) {
                        let mut items: Vec<_> = array(lookup(schema, "prefixItems"))
                            .iter()
                            .map(|s| self.schema_type(s, mode))
                            .collect::<Result<_>>()?;
                        if lookup(schema, "items") != false {
                            items.push(format!(
                                "...({})[]",
                                self.schema_type(lookup(schema, "items"), mode)?
                            ));
                        }
                        Some(format!("[{}]", items.join(", ")))
                    } else {
                        Some(format!(
                            "({})[]",
                            self.schema_type(lookup(schema, "items"), mode)?
                        ))
                    }
                }
                Some("object") | None => {
                    if ty.is_none()
                        && !truthy(lookup(schema, "properties"))
                        && schema.get("additionalProperties").is_none()
                    {
                        None
                    } else {
                        let mut fields = Vec::new();
                        for (name, property) in sorted(lookup(schema, "properties")) {
                            let resolved = self.dereference(property)?;
                            if (mode == Mode::Input
                                && (truthy(lookup(property, "readOnly"))
                                    || truthy(lookup(resolved, "readOnly"))))
                                || (mode == Mode::Output
                                    && (truthy(lookup(property, "writeOnly"))
                                        || truthy(lookup(resolved, "writeOnly"))))
                            {
                                continue;
                            }
                            let ty = self.schema_type(property, mode)?;
                            fields.push(field(
                                name,
                                &ty,
                                array(lookup(schema, "required"))
                                    .iter()
                                    .any(|v| v.as_str() == Some(name)),
                                truthy(lookup(property, "deprecated")),
                            ));
                        }
                        let extra = lookup(schema, "additionalProperties");
                        if truthy(extra) {
                            let ty = if extra == true {
                                "unknown".into()
                            } else {
                                self.schema_type(extra, mode)?
                            };
                            let index = format!("Record<string, {ty}>");
                            Some(if fields.is_empty() {
                                index
                            } else {
                                format!("({} & {index})", object(&fields))
                            })
                        } else if !fields.is_empty() {
                            Some(object(&fields))
                        } else if !parts.is_empty() {
                            None
                        } else {
                            Some(
                                if mode == Mode::Neutral {
                                    "Record<string, never>"
                                } else {
                                    "Record<never, never>"
                                }
                                .into(),
                            )
                        }
                    }
                }
                Some(other) => return Err(format!("Tipo OpenAPI não suportado: {other}.")),
            };
            if let Some(primitive) = primitive {
                primitives.push(primitive);
            }
        }
        let literals: Option<Vec<&Value>> = if truthy(lookup(schema, "enum")) {
            Some(array(lookup(schema, "enum")).iter().collect())
        } else {
            schema.get("const").map(|v| vec![v])
        };
        let covered = literals.is_some_and(|values| {
            values.iter().all(|value| {
                let primitive = match value {
                    Value::Null => "null",
                    Value::Bool(_) => "boolean",
                    Value::Number(_) => "number",
                    Value::String(_) => "string",
                    _ => "object",
                };
                primitives.iter().any(|p| p == primitive)
            })
        });
        if !primitives.is_empty() && !covered {
            let multiple = primitives.len() > 1;
            let primitive = union(primitives);
            parts.push(if multiple {
                format!("({primitive})")
            } else {
                primitive
            });
        }
        let result = if parts.is_empty() {
            "unknown".into()
        } else {
            parts.join(" & ")
        };
        Ok(
            if truthy(lookup(schema, "nullable")) || types.contains(&Some("null")) {
                format!("({result}) | null")
            } else {
                result
            },
        )
    }

    fn content_type(&mut self, content: &Value, mode: Mode, fallback: &str) -> Result<String> {
        let entries = entries(content);
        if entries.is_empty() {
            return Ok(fallback.into());
        }
        let is_json = |mime: &str| {
            let Some(mime) = mime.strip_prefix("application/") else {
                return false;
            };
            let base = mime.split(';').next().unwrap_or("");
            base == "json" || (base.ends_with("+json") && base.len() > 5 && !base.contains('/'))
        };
        let json: Vec<_> = entries
            .iter()
            .copied()
            .filter(|(mime, _)| is_json(mime))
            .collect();
        let selected = if json.is_empty() { entries } else { json };
        let mut types = Vec::new();
        for (mime, media) in selected {
            let ty = self.schema_type(lookup(media, "schema"), mode)?;
            types.push(if mode == Mode::Input && mime == "multipart/form-data" {
                format!("FormData | {ty}")
            } else {
                ty
            });
        }
        Ok(union(types))
    }

    fn operations(&mut self) -> Result<Vec<Operation<'a>>> {
        for (_, schema) in entries(lookup(lookup(self.document, "components"), "schemas")) {
            self.visit(schema)?;
        }
        let mut operations = Vec::new();
        for (path, raw_item) in sorted(lookup(self.document, "paths")) {
            let item = self.dereference(raw_item)?;
            for method in METHODS {
                if !truthy(lookup(item, method)) {
                    continue;
                }
                let operation = self.dereference(lookup(item, method))?;
                let mut parameters: Vec<&Value> = Vec::new();
                let mut parameter_indices = HashMap::new();
                for parameter in array(lookup(item, "parameters"))
                    .iter()
                    .chain(array(lookup(operation, "parameters")))
                {
                    let resolved = self.dereference(parameter)?;
                    let key = (
                        lookup(resolved, "in")
                            .as_str()
                            .ok_or("Local de parâmetro ausente.")?,
                        lookup(resolved, "name")
                            .as_str()
                            .ok_or("Nome de parâmetro ausente.")?,
                    );
                    if let Some(index) = parameter_indices.get(&key) {
                        parameters[*index] = resolved;
                    } else {
                        parameter_indices.insert(key, parameters.len());
                        parameters.push(resolved);
                    }
                    self.visit(lookup(resolved, "schema"))?;
                    self.visit_content(lookup(resolved, "content"))?;
                }
                self.visit_content(
                    &self.dereference(lookup(operation, "requestBody"))?["content"],
                )?;
                for (_, response) in entries(lookup(operation, "responses")) {
                    self.visit_content(&self.dereference(response)?["content"])?;
                }
                operations.push(Operation {
                    path,
                    method,
                    operation,
                    parameters,
                });
            }
        }
        let mut queue: Vec<_> = (0..self.nodes.len()).collect();
        let mut index = 0;
        while index < queue.len() {
            let node = queue[index];
            let flags = self.nodes[node].projection;
            for dependent in 0..self.nodes[node].dependents.len() {
                let parent = self.nodes[node].dependents[dependent];
                let parent_flags = &mut self.nodes[parent].projection;
                if (flags.input && !parent_flags.input) || (flags.output && !parent_flags.output) {
                    parent_flags.input |= flags.input;
                    parent_flags.output |= flags.output;
                    queue.push(parent);
                }
            }
            index += 1;
        }
        Ok(operations)
    }
}

pub fn generate(document: &Value, runtime_import: &str) -> Result<String> {
    let version = lookup(document, "openapi").as_str().unwrap_or("");
    if !(version.starts_with("3.0.") || version.starts_with("3.1.")) {
        return Err("O gerador exige OpenAPI 3.0 ou 3.1.".into());
    }
    let mut generator = Generator {
        document,
        references: RefCell::new(HashMap::new()),
        schema_nodes: HashMap::new(),
        nodes: Vec::new(),
        aliases: HashMap::new(),
        alias_names: HashSet::new(),
        definitions: Vec::new(),
    };
    let operations = generator.operations()?;
    let mut methods: HashMap<&str, Vec<String>> =
        METHODS.into_iter().map(|m| (m, Vec::new())).collect();
    for Operation {
        path,
        method,
        operation,
        parameters,
    } in operations
    {
        let mut groups = Vec::new();
        let mut params_required = false;
        for location in ["path", "query", "header", "cookie"] {
            let mut fields = Vec::new();
            let mut required = false;
            for parameter in &parameters {
                if lookup(parameter, "in") != location {
                    continue;
                }
                let is_required = location == "path" || lookup(parameter, "required") == true;
                required |= is_required;
                let ty = if truthy(lookup(parameter, "content")) {
                    generator.content_type(lookup(parameter, "content"), Mode::Input, "unknown")?
                } else {
                    generator.schema_type(lookup(parameter, "schema"), Mode::Input)?
                };
                fields.push(field(
                    lookup(parameter, "name")
                        .as_str()
                        .ok_or("Nome de parâmetro ausente.")?,
                    &ty,
                    is_required,
                    truthy(lookup(parameter, "deprecated")),
                ));
            }
            if !fields.is_empty() {
                groups.push(field(location, &object(&fields), required, false));
            }
            params_required |= required;
        }
        let body = generator.dereference(lookup(operation, "requestBody"))?;
        let params = if groups.is_empty() {
            "never".into()
        } else {
            object(&groups)
        };
        let body_type = if truthy(body) {
            generator.content_type(lookup(body, "content"), Mode::Input, "unknown")?
        } else {
            "never".into()
        };
        let init = vec![
            field("params", &params, params_required, false),
            field("body", &body_type, truthy(lookup(body, "required")), false),
        ];
        let mut responses = Vec::new();
        for (status, response) in entries(lookup(operation, "responses")) {
            if status.len() != 3
                || !status.starts_with('2')
                || !(status[1..].bytes().all(|b| b.is_ascii_digit()) || status == "2XX")
            {
                continue;
            }
            let response = generator.dereference(response)?;
            responses.push(generator.content_type(
                lookup(response, "content"),
                Mode::Output,
                if status == "204" { "void" } else { "unknown" },
            )?);
        }
        if responses.is_empty() {
            responses.push("unknown".into());
        }
        let ty = format!(
            "(init{}: ApiRequestOptions & {}) => Promise<{}>",
            if params_required || truthy(lookup(body, "required")) {
                ""
            } else {
                "?"
            },
            object(&init),
            union(responses)
        );
        methods
            .get_mut(method)
            .expect("Método conhecido")
            .push(field(
                path,
                &ty,
                true,
                truthy(lookup(operation, "deprecated")),
            ));
    }
    let mut components = Vec::new();
    for (name, _) in sorted(lookup(lookup(document, "components"), "schemas")) {
        let reference = format!(
            "#/components/schemas/{}",
            name.replace('~', "~0").replace('/', "~1")
        );
        components.push(field(
            name,
            &generator.reference_type(&reference, Mode::Neutral)?,
            true,
            false,
        ));
    }
    let mut declarations = Vec::new();
    let mut index = 0;
    while index < generator.definitions.len() {
        let Definition { name, schema, mode } = &generator.definitions[index];
        let (name, schema, mode) = (name.clone(), *schema, *mode);
        declarations.push(format!(
            "type {name} = {};",
            generator.schema_type(schema, mode)?
        ));
        index += 1;
    }
    let methods: Vec<_> = METHODS
        .into_iter()
        .map(|m| field(m, &object(&methods[m]), true, false))
        .collect();
    Ok(format!(
        "// Gerado por scripts/gen-types.mjs. Não editar.\nimport type {{ ApiRequestOptions }} from {};\nexport interface client {}\nexport interface components {{ schemas: {} }}\n{}\n",
        quoted(runtime_import),
        object(&methods),
        object(&components),
        declarations.join("\n")
    ))
}

#[inline]
fn lookup<'a>(value: &'a Value, key: &str) -> &'a Value {
    let Some(map) = value.as_object() else {
        return &Value::Null;
    };
    // Most schema nodes have only a few keys; avoid hashing each keyword.
    if map.len() <= 16 {
        map.iter()
            .find_map(|(name, value)| (name == key).then_some(value))
            .unwrap_or(&Value::Null)
    } else {
        map.get(key).unwrap_or(&Value::Null)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_matches_json_indexing_across_both_paths() {
        for size in [0, 1, 15, 16, 17, 64] {
            let map: Map<_, _> = (0..size)
                .map(|i| (format!("key{i}"), Value::from(i)))
                .chain([(String::from("😀"), Value::Bool(false))])
                .collect();
            let value = Value::Object(map);
            for key in ["key0", "key15", "key16", "key63", "😀", "missing"] {
                assert_eq!(lookup(&value, key), &value[key]);
            }
        }
        for value in [
            Value::Null,
            Value::Bool(false),
            serde_json::json!([1, 2]),
            serde_json::json!("x"),
        ] {
            assert_eq!(lookup(&value, "0"), &value["0"]);
        }
    }

    #[test]
    fn key_order_matches_javascript_indices_and_utf16() {
        let value: Value = serde_json::from_str(
            r#"{"z":0,"01":0,"4294967295":0,"4294967294":0,"2":0,"+1":0,"0":0,"-0":0,"1":0}"#,
        )
        .unwrap();
        let keys: Vec<_> = entries(&value).into_iter().map(|(key, _)| key).collect();
        assert_eq!(
            keys,
            [
                "0",
                "1",
                "2",
                "4294967294",
                "z",
                "01",
                "4294967295",
                "+1",
                "-0"
            ]
        );
        let unicode = serde_json::json!({"\u{e000}": 1, "😀": 2, "a": 3});
        let keys: Vec<_> = sorted(&unicode).into_iter().map(|(key, _)| key).collect();
        assert_eq!(keys, ["a", "😀", "\u{e000}"]);
    }

    #[test]
    fn quoted_preserves_json_escaping() {
        let controls: String = (0..32).map(char::from).collect();
        for value in [
            "",
            "ascii / route",
            "😀\u{2028}\u{2029}",
            "\"\\\n",
            &controls,
        ] {
            assert_eq!(quoted(value), serde_json::to_string(value).unwrap());
        }
    }
}

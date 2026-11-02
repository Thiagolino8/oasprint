use std::collections::HashMap;

// Node's loadEnvFile semantics needed by the CLI: literal $, comments,
// export, multiline quotes and \n expansion only inside double quotes.
pub fn parse(source: &str) -> HashMap<String, String> {
    let source = source.replace("\r\n", "\n");
    let mut remaining = source.trim_start();
    let mut values = HashMap::new();
    while !remaining.is_empty() {
        let line_end = remaining.find('\n').unwrap_or(remaining.len());
        let line = &remaining[..line_end];
        let next = &remaining[line_end..];
        let line = line.strip_prefix("export ").unwrap_or(line).trim_start();
        let Some((key, value)) = line.split_once('=') else {
            remaining = next.trim_start();
            continue;
        };
        let key = key.trim();
        if key.is_empty() || key.starts_with('#') {
            remaining = next.trim_start();
            continue;
        }
        let value = value.trim_start();
        let quote = value
            .chars()
            .next()
            .filter(|c| matches!(c, '\'' | '"' | '`'));
        let (value, rest) = if let Some(quote) = quote {
            // Rebase onto the complete input to preserve embedded newlines.
            let offset = value.as_ptr() as usize - remaining.as_ptr() as usize;
            let quoted = &remaining[offset + 1..];
            if let Some(end) = quoted.find(quote) {
                let value = &quoted[..end];
                let tail = &quoted[end + 1..];
                let rest = tail.find('\n').map_or("", |end| &tail[end + 1..]);
                let value = if quote == '"' {
                    value.replace("\\n", "\n")
                } else {
                    value.to_owned()
                };
                (value, rest)
            } else {
                (value.to_owned(), next)
            }
        } else {
            (
                value.split('#').next().unwrap_or("").trim_end().to_owned(),
                next,
            )
        };
        values.insert(key.to_owned(), value);
        remaining = rest.trim_start();
    }
    values
}

#[cfg(test)]
mod tests {
    #[test]
    fn matches_node_parse_env() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../test/fixtures/dotenv.json")).unwrap();
        for fixture in fixtures.as_array().unwrap() {
            assert_eq!(
                serde_json::to_value(super::parse(fixture["source"].as_str().unwrap())).unwrap(),
                fixture["expected"]
            );
        }
    }
}

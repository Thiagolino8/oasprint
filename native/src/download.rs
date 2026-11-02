use crate::Result;
use serde_json::Value;
use std::{
    collections::HashMap,
    io::Read,
    thread,
    time::{Duration, Instant},
};
use url::Url;

pub struct HeaderRule {
    pattern: String,
    name: String,
    value: String,
}

fn matches(pattern: &str, value: &str) -> bool {
    let mut parts = pattern.split("**");
    let first = parts.next().unwrap_or("");
    let Some(mut rest) = value.strip_prefix(first) else {
        return false;
    };
    let parts: Vec<_> = parts.collect();
    if parts.is_empty() {
        return rest.is_empty();
    }
    for (i, part) in parts.iter().enumerate() {
        if i == parts.len() - 1 {
            return rest.ends_with(part);
        }
        let Some(offset) = rest.find(part) else {
            return false;
        };
        rest = &rest[offset + part.len()..];
    }
    false
}

pub fn headers(config: &Value, environment: &HashMap<String, String>) -> Result<Vec<HeaderRule>> {
    let Some(rules) = config.pointer("/resolve/http/headers") else {
        return Ok(Vec::new());
    };
    let rules = rules
        .as_array()
        .ok_or("resolve.http.headers deve ser um array.")?;
    let mut result = Vec::new();
    for rule in rules {
        let pattern = rule["matches"].as_str().ok_or("Header sem matches.")?;
        let name = rule["name"].as_str().ok_or("Header sem name.")?;
        let value = rule["value"].as_str().or_else(|| {
            rule["envVariable"]
                .as_str()
                .and_then(|key| environment.get(key).map(String::as_str))
        });
        if let Some(value) = value.filter(|s| !s.is_empty()) {
            if ureq::http::HeaderName::from_bytes(name.as_bytes()).is_err()
                || ureq::http::HeaderValue::from_str(value).is_err()
            {
                return Err("Header HTTP inválido na configuração.".into());
            }
            if name.eq_ignore_ascii_case("authorization") {
                let authority = pattern
                    .split("://")
                    .nth(1)
                    .and_then(|s| s.split('/').next())
                    .ok_or("Authorization exige matches com host exato.")?;
                if authority.contains('*') || authority.contains('@') || authority.is_empty() {
                    return Err("Authorization exige matches com host exato.".into());
                }
            }
            result.push(HeaderRule {
                pattern: pattern.into(),
                name: name.into(),
                value: value.into(),
            });
        }
    }
    Ok(result)
}

pub fn origin(root: &str) -> String {
    Url::parse(root)
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_else(|_| "URL inválida".into())
}

fn request(
    agent: &ureq::Agent,
    root: &str,
    rules: &[HeaderRule],
) -> std::result::Result<Vec<u8>, (String, bool)> {
    let fail =
        |message: String, retry: bool| (format!("OpenAPI: {message} em {}.", origin(root)), retry);
    let mut url = Url::parse(root).map_err(|_| fail("URL inválida".into(), false))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(fail("credenciais na URL não são permitidas".into(), false));
    }
    let mut headers: HashMap<String, &str> = HashMap::new();
    for rule in rules.iter().filter(|rule| matches(&rule.pattern, root)) {
        headers.insert(rule.name.to_ascii_lowercase(), &rule.value);
    }
    let deadline = Instant::now() + Duration::from_secs(45);
    for redirect in 0..=20 {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| fail("tempo de download excedido".into(), true))?;
        let mut request = agent
            .get(url.as_str())
            .config()
            .timeout_global(Some(remaining))
            .build();
        for (name, value) in &headers {
            request = request.header(name, *value);
        }
        let mut response = request
            .call()
            .map_err(|_| fail("falha de conexão".into(), true))?;
        let status = response.status().as_u16();
        if [301, 302, 303, 307, 308].contains(&status)
            && let Some(location) = response.headers().get("location")
        {
            if redirect == 20 {
                return Err(fail("limite de redirects excedido".into(), false));
            }
            let next = location
                .to_str()
                .ok()
                .and_then(|location| url.join(location).ok())
                .ok_or_else(|| fail("redirect inválido".into(), false))?;
            if !matches!(next.scheme(), "http" | "https")
                || !next.username().is_empty()
                || next.password().is_some()
            {
                return Err(fail("redirect inválido".into(), false));
            }
            if next.origin() != url.origin() {
                for name in ["authorization", "cookie", "proxy-authorization"] {
                    headers.remove(name);
                }
            }
            url = next;
            continue;
        }
        if !(200..300).contains(&status) {
            return Err(fail(
                format!("HTTP {status}"),
                status == 429 || status >= 500,
            ));
        }
        let mut source = Vec::new();
        response
            .body_mut()
            .as_reader()
            .read_to_end(&mut source)
            .map_err(|_| fail("falha na leitura".into(), true))?;
        return Ok(source);
    }
    unreachable!()
}

pub fn read(agent: &ureq::Agent, root: &str, rules: &[HeaderRule]) -> Result<Vec<u8>> {
    for attempt in 1..=3 {
        match request(agent, root, rules) {
            Ok(source) => return Ok(source),
            Err((error, retry)) => {
                if attempt == 3 || !retry {
                    return Err(error);
                }
                eprintln!(
                    "OpenAPI: falha de download; repetindo tentativa {}/3.",
                    attempt + 1
                );
                thread::sleep(Duration::from_secs(3));
            }
        }
    }
    unreachable!()
}

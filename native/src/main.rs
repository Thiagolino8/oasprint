mod download;
mod environment;
mod generator;

// musl's allocator serializes the allocation-heavy schema workers.
#[cfg(all(target_os = "linux", target_env = "musl"))]
#[global_allocator]
static ALLOCATOR: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    process::ExitCode,
    thread,
};

type Result<T> = std::result::Result<T, String>;

fn parse_json(source: &[u8]) -> Result<Value> {
    let source = std::str::from_utf8(source).map_err(|e| e.to_string())?;
    serde_json::from_str(source).map_err(|e| e.to_string())
}

fn read_json(path: &Path) -> Result<Value> {
    let source = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    parse_json(&source).map_err(|e| format!("{}: JSON inválido: {e}", path.display()))
}

fn normalize(path: PathBuf) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => (),
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

fn generate_config(
    config_path: &Path,
    runtime_import: &str,
    environment: &HashMap<String, String>,
) -> Result<Value> {
    let config_path =
        fs::canonicalize(config_path).map_err(|e| format!("{}: {e}", config_path.display()))?;
    let directory = config_path
        .parent()
        .ok_or("Diretório da configuração ausente.")?;
    let config = read_json(&config_path)?;
    let apis = config["apis"]
        .as_object()
        .ok_or("A configuração JSON deve conter apis.")?;
    let rules = download::headers(&config, environment)?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(45)))
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .into();
    let mut outputs = HashSet::new();
    let mut jobs = Vec::new();
    for api in apis.values() {
        let root = api["root"].as_str().ok_or("Root ausente.")?;
        let output = api["x-openapi-ts"]["output"]
            .as_str()
            .ok_or("Output ausente.")?;
        let output = normalize(directory.join(output));
        if !outputs.insert(output.clone()) {
            return Err(format!("Output duplicado: {}.", output.display()));
        }
        jobs.push((root, output));
    }
    let generate = |(root, output): (&str, PathBuf)| -> Result<_> {
        let document = if root.starts_with("https://") || root.starts_with("http://") {
            let source = download::read(&agent, root, &rules)?;
            parse_json(&source)
                .map_err(|e| format!("OpenAPI: JSON inválido em {}: {e}", download::origin(root)))?
        } else {
            read_json(&directory.join(root))?
        };
        let content = generator::generate(&document, runtime_import)?;
        let changed = match fs::read(&output) {
            Ok(current) => current != content.as_bytes(),
            Err(error) if error.kind() == io::ErrorKind::NotFound => true,
            Err(error) => return Err(format!("{}: {error}", output.display())),
        };
        Ok((output, content, changed))
    };
    // All workers finish before any output is written, including on failure.
    let artifacts = if jobs.len() <= 1 {
        jobs.into_iter().map(generate).collect::<Result<Vec<_>>>()?
    } else {
        thread::scope(|scope| {
            let handles: Vec<_> = jobs
                .into_iter()
                .map(|job| {
                    let generate = &generate;
                    scope.spawn(move || generate(job))
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| {
                    handle
                        .join()
                        .map_err(|_| "Falha no worker OpenAPI.".to_owned())?
                })
                .collect::<Result<Vec<_>>>()
        })?
    };
    let mut updated = 0;
    for (output, content, changed) in &artifacts {
        if !changed {
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(output, content).map_err(|e| format!("{}: {e}", output.display()))?;
        updated += 1;
    }
    Ok(json!({"apis": artifacts.len(), "updated": updated}))
}

fn run() -> Result<()> {
    let mut config_path = None;
    let mut runtime_import = "oasprint".to_owned();
    let mut stdin = false;
    let mut json = false;
    let mut load_env = true;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                println!(
                    "oasprint [--config <oasprint.json>] [--runtime-import <module>]\n\nGera clientes tipados a partir de OpenAPI JSON.\n--stdin       Lê um schema JSON de stdin e emite os tipos em stdout\n--no-env      Não carrega .env\n--json        Emite o resumo como JSON\n--version     Exibe a versão\n\nHUB_PREPARED_OPENAPI_CONFIG seleciona uma configuração JSON preparada."
                );
                return Ok(());
            }
            "--version" | "-v" => {
                println!("{}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            "--config" | "-c" => {
                config_path = Some(args.next().ok_or("--config exige um caminho.")?)
            }
            "--runtime-import" => {
                runtime_import = args.next().ok_or("--runtime-import exige um módulo.")?
            }
            "--stdin" => stdin = true,
            "--json" => json = true,
            "--no-env" => load_env = false,
            _ => return Err(format!("Argumento desconhecido: {arg}")),
        }
    }
    if stdin {
        let mut source = Vec::new();
        io::stdin()
            .read_to_end(&mut source)
            .map_err(|e| e.to_string())?;
        let document = parse_json(&source).map_err(|e| format!("JSON inválido: {e}"))?;
        let content = generator::generate(&document, &runtime_import)?;
        io::stdout()
            .write_all(content.as_bytes())
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let mut environment: HashMap<_, _> = env::vars().collect();
    let prepared = environment
        .get("HUB_PREPARED_OPENAPI_CONFIG")
        .filter(|s| !s.is_empty())
        .cloned();
    if load_env && prepared.is_none() {
        match fs::read_to_string(".env") {
            Ok(source) => {
                for (key, value) in environment::parse(&source) {
                    environment.entry(key).or_insert(value);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(format!(".env: {error}")),
        }
    }
    let config_path = config_path
        .or(prepared)
        .unwrap_or_else(|| "oasprint.json".into());
    let summary = generate_config(Path::new(&config_path), &runtime_import, &environment)?;
    if json {
        println!("{summary}");
    } else {
        println!(
            "gen:types: {} APIs; {} arquivos atualizados.",
            summary["apis"], summary["updated"]
        );
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("oasprint: {error}");
            ExitCode::FAILURE
        }
    }
}

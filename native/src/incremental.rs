use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    env, fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Deserialize, Serialize)]
struct Entry {
    input: String,
    output: String,
}

#[derive(Deserialize, Serialize)]
struct Manifest {
    version: u8,
    entries: HashMap<String, Entry>,
}

pub struct Key {
    slot: String,
    input: String,
}

pub struct Cache {
    path: PathBuf,
    identity: Sha256,
    entries: HashMap<String, Entry>,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

impl Cache {
    // Cache failures never prevent generation; every HTTP source is still fetched.
    pub fn open(config: &Path, runtime_import: &str) -> Option<Self> {
        let executable = fs::read(env::current_exe().ok()?).ok()?;
        let mut identity = Sha256::new();
        identity.update(b"oasprint-cache-v1");
        identity.update(Sha256::digest(executable));
        identity.update((runtime_import.len() as u64).to_le_bytes());
        identity.update(runtime_import.as_bytes());
        let path = config.parent()?.join(".cache/oasprint").join(format!(
            "{}.json",
            digest(config.as_os_str().as_encoded_bytes())
        ));
        let entries = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Manifest>(&bytes).ok())
            .filter(|manifest| manifest.version == 1)
            .map(|manifest| manifest.entries)
            .unwrap_or_default();
        Some(Self {
            path,
            identity,
            entries,
        })
    }

    pub fn key(&self, source: &[u8], output: &Path) -> Key {
        let mut hash = self.identity.clone();
        hash.update((source.len() as u64).to_le_bytes());
        hash.update(source);
        let slot = digest(output.as_os_str().as_encoded_bytes());
        hash.update(slot.as_bytes());
        Key {
            slot,
            input: format!("{:x}", hash.finalize()),
        }
    }

    pub fn lookup(&self, key: &Key, output: &Path) -> Option<String> {
        let entry = self.entries.get(&key.slot)?;
        if entry.input != key.input {
            return None;
        }
        let current = fs::read(output).ok()?;
        if digest(&current) != entry.output {
            return None;
        }
        String::from_utf8(current).ok()
    }

    // Keep exactly one entry per current output, only after the entire batch succeeds.
    pub fn publish<'a>(self, artifacts: impl Iterator<Item = (&'a Key, &'a [u8])>) {
        let entries = artifacts
            .map(|(key, content)| {
                (
                    key.slot.clone(),
                    Entry {
                        input: key.input.clone(),
                        output: digest(content),
                    },
                )
            })
            .collect();
        let Ok(bytes) = serde_json::to_vec(&Manifest {
            version: 1,
            entries,
        }) else {
            return;
        };
        let Some(directory) = self.path.parent() else {
            return;
        };
        if fs::create_dir_all(directory).is_err() {
            return;
        }
        let temporary = self
            .path
            .with_extension(format!("{}.tmp", std::process::id()));
        let Ok(mut file) = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        else {
            return;
        };
        let result = file.write_all(&bytes);
        drop(file);
        if result.is_ok() {
            let _ = fs::rename(&temporary, &self.path);
        }
        let _ = fs::remove_file(temporary);
    }
}

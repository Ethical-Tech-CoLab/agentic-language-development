use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const GENESIS: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Clone, Copy)]
struct StreamSpec {
    stream: &'static str,
    file: &'static str,
    domain: &'static str,
    signer: Option<&'static str>,
    tree: Option<&'static str>,
    previous: &'static str,
}

const STREAMS: [StreamSpec; 7] = [
    StreamSpec {
        stream: "baby-a-ledger",
        file: "baby-a-ledger.jsonl",
        domain: "dtsf-baby-ledger-entry-v1",
        signer: Some("baby-a-ledger"),
        tree: Some("babyA"),
        previous: "previousEntryHash",
    },
    StreamSpec {
        stream: "baby-b-ledger",
        file: "baby-b-ledger.jsonl",
        domain: "dtsf-baby-ledger-entry-v1",
        signer: Some("baby-b-ledger"),
        tree: Some("babyB"),
        previous: "previousEntryHash",
    },
    StreamSpec {
        stream: "channel",
        file: "channel-transcript.jsonl",
        domain: "dtsf-channel-event-v1",
        signer: Some("channel"),
        tree: Some("channel"),
        previous: "previousChannelHash",
    },
    StreamSpec {
        stream: "affect",
        file: "affect-transcript.jsonl",
        domain: "dtsf-affect-event-v1",
        signer: Some("affect"),
        tree: Some("affect"),
        previous: "previousEntryHash",
    },
    StreamSpec {
        stream: "audit",
        file: "audit-ledger.jsonl",
        domain: "dtsf-audit-ledger-entry-v1",
        signer: Some("audit"),
        tree: Some("audit"),
        previous: "previousEntryHash",
    },
    StreamSpec {
        stream: "turns",
        file: "turn-records.jsonl",
        domain: "dtsf-turn-record-v1",
        signer: Some("witness"),
        tree: Some("turns"),
        previous: "previousEntryHash",
    },
    StreamSpec {
        stream: "intervention",
        file: "intervention-log.jsonl",
        domain: "dtsf-intervention-event-v1",
        signer: None,
        tree: Some("intervention"),
        previous: "previousEntryHash",
    },
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditReport {
    schema_version: u8,
    implementation: &'static str,
    bundle: String,
    integrity_pass: bool,
    anchored: bool,
    stream_count: usize,
    event_count: usize,
    checkpoint_count: usize,
    attachment_count: usize,
    issues: Vec<String>,
}

struct Auditor {
    root: PathBuf,
    issues: Vec<String>,
    signers: BTreeMap<String, VerifyingKey>,
    streams: BTreeMap<String, Vec<Value>>,
    checkpoints: BTreeMap<u64, Value>,
    event_count: usize,
    attachment_count: usize,
}

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

fn encoded_hash(bytes: [u8; 32]) -> String {
    format!("sha256:{}", hex::encode(bytes))
}

fn domain_hash(domain: &str, separator: u8, parts: &[&[u8]]) -> String {
    let separator = [separator];
    let mut all = vec![domain.as_bytes(), &separator];
    all.extend_from_slice(parts);
    encoded_hash(sha256(&all))
}

fn decode_hash(value: &str) -> Result<[u8; 32], String> {
    let hex_value = value
        .strip_prefix("sha256:")
        .ok_or_else(|| "missing sha256 prefix".to_string())?;
    let decoded = hex::decode(hex_value).map_err(|error| error.to_string())?;
    decoded
        .try_into()
        .map_err(|_| "SHA-256 value is not 32 bytes".to_string())
}

fn canonical(value: &Value) -> Result<Vec<u8>, String> {
    serde_jcs::to_vec(value).map_err(|error| error.to_string())
}

fn object_without(value: &Value, removed: &[&str]) -> Result<Value, String> {
    let mut object = value
        .as_object()
        .cloned()
        .ok_or_else(|| "expected JSON object".to_string())?;
    for field in removed {
        object.remove(*field);
    }
    Ok(Value::Object(object))
}

fn hash_canonical(domain: &str, value: &Value) -> Result<String, String> {
    let bytes = canonical(value)?;
    Ok(domain_hash(domain, 0, &[&bytes]))
}

fn merkle_leaf(sequence: u64, entry_hash: &str) -> Result<String, String> {
    let sequence = sequence.to_be_bytes();
    let entry_hash = decode_hash(entry_hash)?;
    Ok(domain_hash(
        "dtsf-merkle-leaf-v1",
        0,
        &[&sequence, &entry_hash],
    ))
}

fn merkle_node(left: &str, right: &str) -> Result<String, String> {
    let left = decode_hash(left)?;
    let right = decode_hash(right)?;
    Ok(domain_hash("dtsf-merkle-node-v1", 1, &[&left, &right]))
}

fn merkle_root(leaves: &[String]) -> Result<String, String> {
    if leaves.is_empty() {
        return Ok(domain_hash("dtsf-merkle-node-v1", 1, &[]));
    }
    if leaves.len() == 1 {
        return Ok(leaves[0].clone());
    }
    let split = leaves.len().next_power_of_two() / 2;
    merkle_node(
        &merkle_root(&leaves[..split])?,
        &merkle_root(&leaves[split..])?,
    )
}

fn verify_inclusion(
    leaf_hash: &str,
    leaf_index: u64,
    tree_size: u64,
    path: &[Value],
    root: &str,
) -> Result<bool, String> {
    if leaf_index >= tree_size || tree_size == 0 {
        return Ok(false);
    }
    let mut fn_index = leaf_index;
    let mut sn = tree_size - 1;
    let mut computed = leaf_hash.to_string();
    for sibling in path {
        if sn == 0 {
            return Ok(false);
        }
        let sibling = sibling
            .as_str()
            .ok_or_else(|| "inclusion sibling is not a hash string".to_string())?;
        decode_hash(sibling)?;
        if fn_index & 1 == 1 || fn_index == sn {
            computed = merkle_node(sibling, &computed)?;
            if fn_index & 1 == 0 {
                while fn_index & 1 == 0 && fn_index != 0 {
                    fn_index >>= 1;
                    sn >>= 1;
                }
            }
        } else {
            computed = merkle_node(&computed, sibling)?;
        }
        fn_index >>= 1;
        sn >>= 1;
    }
    Ok(sn == 0 && computed == root)
}

fn string_field<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing string field {field}"))
}

fn normalized_initial_policy_refs(config: &Value) -> Result<Option<Value>, String> {
    let baby_a = config.pointer("/babyA/initialPolicyRef");
    let baby_b = config.pointer("/babyB/initialPolicyRef");
    match (baby_a, baby_b) {
        (None, None) => Ok(None),
        (Some(a), Some(b)) => {
            let a = a
                .as_str()
                .ok_or_else(|| "babyA.initialPolicyRef is not a string".to_string())?;
            let b = b
                .as_str()
                .ok_or_else(|| "babyB.initialPolicyRef is not a string".to_string())?;
            Ok(Some(json!({ "babyA": a, "babyB": b })))
        }
        _ => Err("derived run has an incomplete initial-policy reference pair".to_string()),
    }
}

fn u64_field(value: &Value, field: &str) -> Result<u64, String> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("missing unsigned integer field {field}"))
}

fn verify_signature(key: &VerifyingKey, digest: &str, encoded: &str) -> Result<(), String> {
    let digest = decode_hash(digest)?;
    let encoded = encoded
        .strip_prefix("ed25519:")
        .ok_or_else(|| "missing ed25519 signature prefix".to_string())?;
    let bytes = BASE64.decode(encoded).map_err(|error| error.to_string())?;
    let signature = Signature::from_slice(&bytes).map_err(|error| error.to_string())?;
    key.verify(&digest, &signature)
        .map_err(|error| error.to_string())
}

fn read_json(path: &Path) -> Result<(Value, Vec<u8>), String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    Ok((value, bytes))
}

fn canonical_file(path: &Path) -> Result<Value, String> {
    let (value, bytes) = read_json(path)?;
    let mut expected = canonical(&value)?;
    expected.push(b'\n');
    if bytes != expected {
        return Err("file is not canonical JSON plus one newline".to_string());
    }
    Ok(value)
}

impl Auditor {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            issues: Vec::new(),
            signers: BTreeMap::new(),
            streams: BTreeMap::new(),
            checkpoints: BTreeMap::new(),
            event_count: 0,
            attachment_count: 0,
        }
    }

    fn issue(&mut self, location: &str, detail: impl AsRef<str>) {
        self.issues.push(format!("{location}: {}", detail.as_ref()));
    }

    fn load_manifest(&mut self) -> Option<Value> {
        let path = self.root.join("run-manifest.json");
        let manifest = match canonical_file(&path) {
            Ok(value) => value,
            Err(error) => {
                self.issue("run-manifest.json", error);
                return None;
            }
        };

        if let Some(signers) = manifest.get("signers").and_then(Value::as_array) {
            for signer in signers {
                let parsed = (|| {
                    let domain = string_field(signer, "domain")?;
                    let public_key = string_field(signer, "publicKey")?
                        .strip_prefix("ed25519-pub:")
                        .ok_or_else(|| "missing ed25519-pub prefix".to_string())?;
                    let bytes = BASE64
                        .decode(public_key)
                        .map_err(|error| error.to_string())?;
                    let bytes: [u8; 32] = bytes
                        .try_into()
                        .map_err(|_| "public key is not 32 bytes".to_string())?;
                    let key =
                        VerifyingKey::from_bytes(&bytes).map_err(|error| error.to_string())?;
                    Ok::<_, String>((domain.to_string(), key))
                })();
                match parsed {
                    Ok((domain, key)) => {
                        self.signers.insert(domain, key);
                    }
                    Err(error) => self.issue("run-manifest.json signers", error),
                }
            }
        } else {
            self.issue("run-manifest.json", "missing signers array");
        }
        Some(manifest)
    }

    fn verify_configuration(&mut self, manifest: &Value) {
        let path = self.root.join("configuration/run-config.json");
        let config = match canonical_file(&path) {
            Ok(value) => value,
            Err(error) => {
                self.issue("configuration/run-config.json", error);
                return;
            }
        };
        match hash_canonical("dtsf-run-config-v1", &config) {
            Ok(actual) if manifest.get("configurationHash") == Some(&json!(actual)) => {}
            Ok(actual) => self.issue(
                "configuration/run-config.json",
                format!("configuration hash mismatch: rebuilt {actual}"),
            ),
            Err(error) => self.issue("configuration/run-config.json", error),
        }
        if manifest.get("runId") != config.get("runId") {
            self.issue(
                "configuration/run-config.json",
                "runId differs from manifest",
            );
        }
        for field in ["parentRunId", "derivedFromCheckpointHash"] {
            if manifest.get(field) != config.get(field) {
                self.issue(
                    "configuration/run-config.json",
                    format!("lineage field {field} differs from manifest"),
                );
            }
        }
        match normalized_initial_policy_refs(&config) {
            Ok(expected) if manifest.get("initialPolicyRefs") == expected.as_ref() => {}
            Ok(_) => self.issue(
                "configuration/run-config.json",
                "lineage field initialPolicyRefs differs from manifest",
            ),
            Err(error) => self.issue("configuration/run-config.json", error),
        }
        if let Some(run_id) = manifest.get("runId").and_then(Value::as_str) {
            let rebuilt = domain_hash("dtsf-run-id-v1", 0, &[run_id.as_bytes()]);
            if manifest.get("runIdHash") != Some(&json!(rebuilt)) {
                self.issue("run-manifest.json", "runIdHash mismatch");
            }
        }
    }

    fn declared_streams(&mut self, manifest: &Value) -> BTreeSet<String> {
        let mut declared = BTreeSet::new();
        let Some(entries) = manifest.get("streams").and_then(Value::as_array) else {
            self.issue("run-manifest.json", "missing streams array");
            return declared;
        };
        for declaration in entries {
            let Some(name) = declaration.get("stream").and_then(Value::as_str) else {
                self.issue("run-manifest.json streams", "missing stream name");
                continue;
            };
            if !declared.insert(name.to_string()) {
                self.issue(
                    "run-manifest.json streams",
                    format!("duplicate stream {name}"),
                );
                continue;
            }
            let Some(spec) = STREAMS.iter().find(|spec| spec.stream == name) else {
                self.issue(
                    "run-manifest.json streams",
                    format!("unknown stream {name}"),
                );
                continue;
            };
            for (field, expected) in [
                ("file", Some(spec.file)),
                ("hashDomain", Some(spec.domain)),
                ("signerDomain", spec.signer),
                ("treeName", spec.tree),
            ] {
                let actual = declaration.get(field).and_then(Value::as_str);
                if actual != expected {
                    self.issue(
                        "run-manifest.json streams",
                        format!("{name} {field} is {actual:?}, expected {expected:?}"),
                    );
                }
            }
        }
        declared
    }

    fn verify_stream(&mut self, spec: StreamSpec, run_id: Option<&str>) {
        let path = self.root.join(spec.file);
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) => {
                self.issue(spec.file, error.to_string());
                return;
            }
        };
        if !text.is_empty() && !text.ends_with('\n') {
            self.issue(spec.file, "JSONL lacks final newline");
        }
        let mut events = Vec::new();
        let mut previous = GENESIS.to_string();
        for (index, line) in text.lines().enumerate() {
            let location = format!("{}#{}", spec.file, index + 1);
            let mut event: Value = match serde_json::from_str(line) {
                Ok(value) => value,
                Err(error) => {
                    self.issue(&location, error.to_string());
                    continue;
                }
            };
            match canonical(&event) {
                Ok(bytes) if bytes == line.as_bytes() => {}
                Ok(_) => self.issue(&location, "line is not RFC 8785 canonical JSON"),
                Err(error) => self.issue(&location, error),
            }
            let expected_sequence = u64::try_from(index + 1).unwrap_or(u64::MAX);
            if u64_field(&event, "sequence") != Ok(expected_sequence) {
                self.issue(&location, format!("sequence is not {expected_sequence}"));
            }
            if event.get(spec.previous) != Some(&json!(previous)) {
                self.issue(
                    &location,
                    format!("{} does not link previous event", spec.previous),
                );
            }
            if let Some(expected_run_id) = run_id
                && event.get("runId") != Some(&json!(expected_run_id))
            {
                self.issue(&location, "runId differs from manifest");
            }
            let recorded_hash = string_field(&event, "entryHash").map(str::to_string);
            match object_without(&event, &["entryHash", "writerSignature"])
                .and_then(|unsigned| hash_canonical(spec.domain, &unsigned))
            {
                Ok(rebuilt) => {
                    if recorded_hash.as_ref().ok().map(String::as_str) != Some(rebuilt.as_str()) {
                        self.issue(&location, format!("entry hash mismatch: rebuilt {rebuilt}"));
                    }
                }
                Err(error) => self.issue(&location, error),
            }
            if let (Some(domain), Ok(hash)) = (spec.signer, recorded_hash.as_deref()) {
                let signature = string_field(&event, "writerSignature");
                match (self.signers.get(domain), signature) {
                    (Some(key), Ok(signature)) => {
                        if let Err(error) = verify_signature(key, hash, signature) {
                            self.issue(&location, format!("signature invalid: {error}"));
                        }
                    }
                    (None, _) => self.issue(&location, format!("missing signer {domain}")),
                    (_, Err(error)) => self.issue(&location, error),
                }
            }
            if let Ok(hash) = recorded_hash {
                previous = hash;
            }
            events.push(std::mem::take(&mut event));
        }
        self.event_count += events.len();
        self.streams.insert(spec.stream.to_string(), events);
    }

    fn reference_for<'a>(checkpoint: &'a Value, tree: &str) -> Option<&'a Value> {
        match tree {
            "babyA" | "babyB" | "channel" => checkpoint.get(tree),
            other => checkpoint.get("auxiliaryTrees")?.get(other),
        }
    }

    fn expected_tree(
        &mut self,
        spec: StreamSpec,
        size: usize,
        location: &str,
    ) -> Option<(String, String)> {
        let events = self.streams.get(spec.stream)?;
        if size > events.len() {
            self.issue(
                location,
                format!(
                    "{} tree size {size} exceeds {} events",
                    spec.stream,
                    events.len()
                ),
            );
            return None;
        }
        let mut leaves = Vec::with_capacity(size);
        let mut last = GENESIS.to_string();
        for event in &events[..size] {
            let Ok(sequence) = u64_field(event, "sequence") else {
                return None;
            };
            let Ok(hash) = string_field(event, "entryHash") else {
                return None;
            };
            match merkle_leaf(sequence, hash) {
                Ok(leaf) => leaves.push(leaf),
                Err(error) => {
                    self.issue(location, error);
                    return None;
                }
            }
            last = hash.to_string();
        }
        match merkle_root(&leaves) {
            Ok(root) => Some((root, last)),
            Err(error) => {
                self.issue(location, error);
                None
            }
        }
    }

    fn verify_checkpoints(&mut self, manifest: &Value) {
        let directory = self.root.join("checkpoints");
        let mut paths = match fs::read_dir(&directory) {
            Ok(entries) => entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.extension()
                        .is_some_and(|extension| extension == "json")
                })
                .collect::<Vec<_>>(),
            Err(error) => {
                self.issue("checkpoints", error.to_string());
                return;
            }
        };
        paths.sort();
        let mut previous = GENESIS.to_string();
        for (index, path) in paths.iter().enumerate() {
            let file = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("checkpoint");
            let location = format!("checkpoints/{file}");
            let checkpoint = match canonical_file(path) {
                Ok(value) => value,
                Err(error) => {
                    self.issue(&location, error);
                    continue;
                }
            };
            let expected_sequence = u64::try_from(index).unwrap_or(u64::MAX);
            if u64_field(&checkpoint, "checkpointSequence") != Ok(expected_sequence) {
                self.issue(
                    &location,
                    format!("checkpointSequence is not {expected_sequence}"),
                );
            }
            if checkpoint.get("previousCheckpointHash") != Some(&json!(previous)) {
                self.issue(&location, "previousCheckpointHash mismatch");
            }
            for (field, manifest_field) in [
                ("runIdHash", "runIdHash"),
                ("runConfigurationHash", "configurationHash"),
                ("promptBundleHash", "promptBundleHash"),
            ] {
                if checkpoint.get(field) != manifest.get(manifest_field) {
                    self.issue(&location, format!("{field} differs from manifest"));
                }
            }
            let recorded_hash = string_field(&checkpoint, "checkpointHash").map(str::to_string);
            match object_without(&checkpoint, &["checkpointHash", "witnessSignature"])
                .and_then(|unsigned| hash_canonical("dtsf-ledger-checkpoint-v1", &unsigned))
            {
                Ok(rebuilt)
                    if recorded_hash.as_ref().ok().map(String::as_str)
                        == Some(rebuilt.as_str()) => {}
                Ok(rebuilt) => self.issue(
                    &location,
                    format!("checkpoint hash mismatch: rebuilt {rebuilt}"),
                ),
                Err(error) => self.issue(&location, error),
            }
            if let (Some(key), Ok(hash), Ok(signature)) = (
                self.signers.get("witness"),
                recorded_hash.as_deref(),
                string_field(&checkpoint, "witnessSignature"),
            ) && let Err(error) = verify_signature(key, hash, signature)
            {
                self.issue(&location, format!("witness signature invalid: {error}"));
            }
            for spec in STREAMS {
                let Some(tree) = spec.tree else { continue };
                let reference = Self::reference_for(&checkpoint, tree);
                let size = reference
                    .and_then(|value| value.get("treeSize"))
                    .and_then(Value::as_u64)
                    .and_then(|value| usize::try_from(value).ok())
                    .unwrap_or(0);
                if let Some((root, last)) = self.expected_tree(spec, size, &location) {
                    if let Some(reference) = reference {
                        if reference.get("merkleRoot") != Some(&json!(root)) {
                            self.issue(&location, format!("{tree} Merkle root mismatch"));
                        }
                        if reference.get("lastEntryHash") != Some(&json!(last)) {
                            self.issue(&location, format!("{tree} last-entry hash mismatch"));
                        }
                    } else if size != 0 {
                        self.issue(&location, format!("missing {tree} tree reference"));
                    }
                }
            }
            if let Ok(hash) = recorded_hash {
                previous = hash;
            }
            if let Ok(sequence) = u64_field(&checkpoint, "checkpointSequence") {
                self.checkpoints.insert(sequence, checkpoint);
            }
        }
    }

    fn verify_inclusion_proofs(&mut self) {
        let directory = self.root.join("proofs/inclusion");
        if !directory.exists() {
            return;
        }
        let mut paths = match fs::read_dir(&directory) {
            Ok(entries) => entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| {
                    path.extension()
                        .is_some_and(|extension| extension == "json")
                })
                .collect::<Vec<_>>(),
            Err(error) => {
                self.issue("proofs/inclusion", error.to_string());
                return;
            }
        };
        paths.sort();
        for path in paths {
            let file = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("inclusion-proof");
            let location = format!("proofs/inclusion/{file}");
            let proof = match canonical_file(&path) {
                Ok(value) => value,
                Err(error) => {
                    self.issue(&location, error);
                    continue;
                }
            };
            let checked = (|| {
                let stream = string_field(&proof, "stream")?;
                let tree = string_field(&proof, "treeName")?;
                let checkpoint_sequence = u64_field(&proof, "checkpointSequence")?;
                let tree_size = u64_field(&proof, "treeSize")?;
                let leaf_index = u64_field(&proof, "leafIndex")?;
                let sequence = u64_field(&proof, "sequence")?;
                let entry_hash = string_field(&proof, "entryHash")?;
                let leaf_hash = string_field(&proof, "leafHash")?;
                let root = string_field(&proof, "root")?;
                let path = proof
                    .get("path")
                    .and_then(Value::as_array)
                    .ok_or_else(|| "missing inclusion path".to_string())?;
                if sequence != leaf_index + 1 {
                    return Err("sequence and leafIndex disagree".to_string());
                }
                let event_index = usize::try_from(leaf_index)
                    .map_err(|_| "leafIndex exceeds host range".to_string())?;
                let event = self
                    .streams
                    .get(stream)
                    .and_then(|events| events.get(event_index))
                    .ok_or_else(|| "proof references an unknown stream event".to_string())?;
                if event.get("entryHash") != Some(&json!(entry_hash)) {
                    return Err("entryHash differs from stream event".to_string());
                }
                if merkle_leaf(sequence, entry_hash)? != leaf_hash {
                    return Err("leafHash does not reproduce".to_string());
                }
                let checkpoint = self
                    .checkpoints
                    .get(&checkpoint_sequence)
                    .ok_or_else(|| "proof references an unknown checkpoint".to_string())?;
                let reference = Self::reference_for(checkpoint, tree)
                    .ok_or_else(|| "proof references an unknown checkpoint tree".to_string())?;
                if reference.get("treeSize") != Some(&json!(tree_size))
                    || reference.get("merkleRoot") != Some(&json!(root))
                {
                    return Err("proof root or size differs from checkpoint".to_string());
                }
                if !verify_inclusion(leaf_hash, leaf_index, tree_size, path, root)? {
                    return Err("inclusion path does not reproduce root".to_string());
                }
                Ok::<(), String>(())
            })();
            if let Err(error) = checked {
                self.issue(&location, error);
            }
        }
    }

    fn verify_anchors(&mut self) -> bool {
        let path = self.root.join("anchors/base-receipts.json");
        let receipts = match canonical_file(&path) {
            Ok(value) => value,
            Err(error) => {
                self.issue("anchors/base-receipts.json", error);
                return false;
            }
        };
        let Some(receipts) = receipts.as_array() else {
            self.issue("anchors/base-receipts.json", "receipt file is not an array");
            return false;
        };
        let mut anchored = false;
        let mut latest_confirmed = None;
        for (index, receipt) in receipts.iter().enumerate() {
            let location = format!("anchors/base-receipts.json[{index}]");
            let Ok(sequence) = u64_field(receipt, "checkpointSequence") else {
                self.issue(&location, "missing checkpointSequence");
                continue;
            };
            let Some(checkpoint) = self.checkpoints.get(&sequence) else {
                self.issue(&location, "references unknown checkpoint");
                continue;
            };
            let checkpoint_hash = checkpoint
                .get("checkpointHash")
                .and_then(Value::as_str)
                .map(str::to_string);
            if receipt.get("checkpointHash").and_then(Value::as_str) != checkpoint_hash.as_deref() {
                self.issue(&location, "checkpointHash differs from checkpoint file");
            }
            if let Some(hash) = checkpoint_hash.as_deref() {
                let expected = format!("0x{}", hash.trim_start_matches("sha256:"));
                if receipt.get("inputData") != Some(&json!(expected)) {
                    self.issue(&location, "inputData does not encode checkpointHash");
                }
            }
            let expected_chain = match receipt.get("network").and_then(Value::as_str) {
                Some("base-sepolia") => Some(84_532),
                Some("base-mainnet" | "base") => Some(8_453),
                _ => None,
            };
            if expected_chain.is_some()
                && receipt.get("chainId").and_then(Value::as_u64) != expected_chain
            {
                self.issue(&location, "network and chainId disagree");
            }
            if receipt.get("status") == Some(&json!("confirmed")) {
                anchored = true;
                latest_confirmed =
                    Some(latest_confirmed.map_or(sequence, |latest: u64| latest.max(sequence)));
            } else {
                self.issue(&location, "receipt is not confirmed");
            }
        }
        if let Some(sequence) = latest_confirmed
            && let Some(checkpoint) = self.checkpoints.get(&sequence).cloned()
        {
            for spec in STREAMS {
                let Some(tree) = spec.tree else { continue };
                let anchored_size = Self::reference_for(&checkpoint, tree)
                    .and_then(|reference| reference.get("treeSize"))
                    .and_then(Value::as_u64)
                    .and_then(|size| usize::try_from(size).ok())
                    .unwrap_or(0);
                let actual_size = self.streams.get(spec.stream).map_or(0, Vec::len);
                if actual_size > anchored_size {
                    self.issue(
                        "anchors/base-receipts.json",
                        format!(
                            "unanchored tail in {}: {actual_size} events but confirmed checkpoint covers {anchored_size}",
                            spec.stream
                        ),
                    );
                }
            }
        }
        anchored
    }

    fn files_under(path: &Path, base: &Path, output: &mut Vec<String>) -> Result<(), String> {
        for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let entry_path = entry.path();
            if entry_path.is_dir() {
                Self::files_under(&entry_path, base, output)?;
            } else {
                output.push(
                    entry_path
                        .strip_prefix(base)
                        .map_err(|error| error.to_string())?
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
        Ok(())
    }

    fn verify_attachments(&mut self) {
        let directory = self.root.join("analysis");
        if !directory.exists() {
            return;
        }
        let index_path = directory.join("index.json");
        let index = match canonical_file(&index_path) {
            Ok(value) => value,
            Err(error) => {
                self.issue("analysis/index.json", error);
                return;
            }
        };
        let Some(attachments) = index.get("attachments").and_then(Value::as_array) else {
            self.issue("analysis/index.json", "missing attachments array");
            return;
        };
        let mut listed = BTreeSet::new();
        for (entry_index, attachment) in attachments.iter().enumerate() {
            let location = format!("analysis/index.json attachments[{entry_index}]");
            let Ok(relative) = string_field(attachment, "path") else {
                self.issue(&location, "missing path");
                continue;
            };
            let relative_path = Path::new(relative);
            if relative_path.is_absolute()
                || relative_path
                    .components()
                    .any(|part| matches!(part, std::path::Component::ParentDir))
                || !relative.starts_with("analysis/")
            {
                self.issue(&location, "attachment path is outside analysis/");
                continue;
            }
            listed.insert(relative.replace('\\', "/"));
            match fs::read(self.root.join(relative_path)) {
                Ok(bytes) => {
                    let actual = encoded_hash(sha256(&[&bytes]));
                    if attachment.get("sha256") != Some(&json!(actual)) {
                        self.issue(&location, "attachment byte hash mismatch");
                    }
                }
                Err(error) => self.issue(&location, error.to_string()),
            }
        }
        self.attachment_count = attachments.len();
        let mut actual = Vec::new();
        if let Err(error) = Self::files_under(&directory, &directory, &mut actual) {
            self.issue("analysis", error);
            return;
        }
        actual.retain(|path| path != "index.json");
        let actual: BTreeSet<_> = actual
            .into_iter()
            .map(|path| format!("analysis/{path}"))
            .collect();
        for unlisted in actual.difference(&listed) {
            self.issue("analysis", format!("unlisted attachment {unlisted}"));
        }
        for missing in listed.difference(&actual) {
            self.issue("analysis", format!("listed attachment missing {missing}"));
        }
    }

    fn run(mut self) -> AuditReport {
        let manifest = self.load_manifest();
        if let Some(manifest) = manifest.as_ref() {
            self.verify_configuration(manifest);
            let declared = self.declared_streams(manifest);
            let run_id = manifest.get("runId").and_then(Value::as_str);
            for spec in STREAMS {
                if declared.contains(spec.stream) {
                    self.verify_stream(spec, run_id);
                }
            }
            self.verify_checkpoints(manifest);
            self.verify_inclusion_proofs();
        }
        let anchored = self.verify_anchors();
        self.verify_attachments();
        AuditReport {
            schema_version: 1,
            implementation: "ald-integrity-auditor-rust-v1",
            bundle: self.root.to_string_lossy().to_string(),
            integrity_pass: self.issues.is_empty(),
            anchored,
            stream_count: self.streams.len(),
            event_count: self.event_count,
            checkpoint_count: self.checkpoints.len(),
            attachment_count: self.attachment_count,
            issues: self.issues,
        }
    }
}

fn main() {
    let mut arguments = env::args_os();
    let program = arguments.next().unwrap_or_default();
    let Some(bundle) = arguments.next() else {
        eprintln!(
            "usage: {} <bundle-directory>",
            Path::new(&program).display()
        );
        std::process::exit(2);
    };
    if arguments.next().is_some() {
        eprintln!("exactly one bundle directory is required");
        std::process::exit(2);
    }
    let report = Auditor::new(PathBuf::from(bundle)).run();
    println!(
        "{}",
        serde_json::to_string_pretty(&report).expect("audit report serialization must succeed")
    );
    if !report.integrity_pass {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn independent_empty_root_matches_documented_vector() {
        assert_eq!(
            merkle_root(&[]).unwrap(),
            "sha256:d894f4d5b98467ac3c3683d92f363fd4fe1effe4179fe34ae68d3d2e491a6606"
        );
    }

    #[test]
    fn independent_domain_hash_matches_documented_construction() {
        assert_eq!(
            domain_hash("dtsf-run-id-v1", 0, &[b"run-test"]),
            "sha256:d6ad6a2b93facebcbd9ab7a49b2d3711c81ec1a96a57bee7946925c1e66d9fdd"
        );
    }

    #[test]
    fn nested_run_config_policy_refs_normalize_to_manifest_shape() {
        let config = json!({
            "babyA": { "initialPolicyRef": "policies/baby-a-latest.json" },
            "babyB": { "initialPolicyRef": "policies/baby-b-latest.json" }
        });
        assert_eq!(
            normalized_initial_policy_refs(&config).unwrap(),
            Some(json!({
                "babyA": "policies/baby-a-latest.json",
                "babyB": "policies/baby-b-latest.json"
            }))
        );
        assert_eq!(
            normalized_initial_policy_refs(&json!({ "babyA": {}, "babyB": {} })).unwrap(),
            None
        );
    }

    #[test]
    fn independent_inclusion_verifier_rejects_a_mutated_path() {
        let leaves = [
            merkle_leaf(1, &encoded_hash(sha256(&[b"event-1"]))).unwrap(),
            merkle_leaf(2, &encoded_hash(sha256(&[b"event-2"]))).unwrap(),
            merkle_leaf(3, &encoded_hash(sha256(&[b"event-3"]))).unwrap(),
        ];
        let root = merkle_root(&leaves).unwrap();
        let valid_path = vec![json!(leaves[1]), json!(leaves[2])];
        assert!(verify_inclusion(&leaves[0], 0, 3, &valid_path, &root).unwrap());
        let mutated_path = vec![json!(encoded_hash(sha256(&[b"mutated"]))), json!(leaves[2])];
        assert!(!verify_inclusion(&leaves[0], 0, 3, &mutated_path, &root).unwrap());
    }
}

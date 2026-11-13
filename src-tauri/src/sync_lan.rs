use crate::{sync_merge, vault, VaultRuntime, Workspace};
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use socket2::{Domain, Protocol, Socket, Type};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream, UdpSocket},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

const DISCOVERY_PORT: u16 = 42099;
const MULTICAST_ADDR: Ipv4Addr = Ipv4Addr::new(239, 255, 42, 99);
const PROTO_VERSION: &str = "onebyone-lan-v1";
const PAIR_TTL_MS: i64 = 120_000;
const MAX_PAIR_ATTEMPTS: u8 = 5;
const PEER_STALE_MS: i64 = 25_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedPeer {
    pub device_id: String,
    pub device_name: String,
    pub shared_key_hex: String,
    #[serde(default)]
    pub last_synced_at: Option<i64>,
    #[serde(default)]
    pub last_addr: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    pub enabled: bool,
    pub device_id: String,
    pub device_name: String,
    #[serde(default)]
    pub peers: Vec<TrustedPeer>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredPeerInfo {
    pub device_id: String,
    pub device_name: String,
    pub addr: String,
    pub paired: bool,
    pub in_sync: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairedPeerInfo {
    pub device_id: String,
    pub device_name: String,
    pub online: bool,
    pub in_sync: bool,
    pub last_synced_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub enabled: bool,
    pub device_id: String,
    pub device_name: String,
    pub tcp_port: Option<u16>,
    pub pairing_code: Option<String>,
    pub pairing_expires_at: Option<i64>,
    pub paired_peers: Vec<PairedPeerInfo>,
    pub nearby_peers: Vec<DiscoveredPeerInfo>,
}

#[derive(Clone)]
struct DiscoveredEntry {
    device_id: String,
    device_name: String,
    addr: SocketAddr,
    revision: String,
    last_seen_ms: i64,
}

struct PairingSession {
    code: String,
    expires_at_ms: i64,
    attempts: u8,
}

struct SyncState {
    tcp_port: Option<u16>,
    running: Option<Arc<AtomicBool>>,
    pairing: Option<PairingSession>,
    discovered: HashMap<String, DiscoveredEntry>,
    last_auto_sync: HashMap<String, i64>,
}

impl Default for SyncState {
    fn default() -> Self {
        Self {
            tcp_port: None,
            running: None,
            pairing: None,
            discovered: HashMap::new(),
            last_auto_sync: HashMap::new(),
        }
    }
}

#[derive(Default)]
pub struct SyncRuntime(Mutex<SyncState>);

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Beacon {
    proto: String,
    device_id: String,
    device_name: String,
    tcp_port: u16,
    revision: String,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WireRequest {
    PairInit {
        device_id: String,
        device_name: String,
        salt: String,
        nonce_b: String,
    },
    SyncReq {
        device_id: String,
        nonce: String,
        ciphertext: String,
    },
}

#[derive(Serialize, Deserialize)]
struct PairChallengeReply {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ciphertext: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct PairChallengeInner {
    device_id: String,
    device_name: String,
    nonce_b: String,
    secret_a: String,
}

#[derive(Serialize, Deserialize)]
struct PairConfirmMsg {
    nonce: String,
    ciphertext: String,
}

#[derive(Serialize, Deserialize)]
struct PairConfirmInner {
    nonce_b: String,
    secret_b: String,
}

#[derive(Serialize, Deserialize)]
struct SyncReply {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ciphertext: Option<String>,
}

fn default_device_name() -> String {
    if cfg!(target_os = "android") {
        "Android Phone".to_string()
    } else if let Ok(name) = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")) {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return trimmed.chars().take(40).collect();
        }
        "Desktop".to_string()
    } else {
        "Desktop".to_string()
    }
}

fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(crate::data_file(app)?.with_file_name("sync-config.json"))
}

pub fn load_or_init_config<R: Runtime>(app: &AppHandle<R>) -> Result<SyncConfig, String> {
    let path = config_path(app)?;
    if path.exists() {
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        if let Ok(cfg) = serde_json::from_slice::<SyncConfig>(&bytes) {
            if !cfg.device_id.is_empty() {
                return Ok(cfg);
            }
        }
    }
    let cfg = SyncConfig {
        enabled: false,
        device_id: uuid::Uuid::new_v4().to_string(),
        device_name: default_device_name(),
        peers: Vec::new(),
    };
    save_config(app, &cfg)?;
    Ok(cfg)
}

fn save_config<R: Runtime>(app: &AppHandle<R>, config: &SyncConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let data = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    vault::atomic_write(&path, &data)
}

fn derive_pairing_key(code: &str, id_a: &str, id_b: &str, salt: &[u8; 16]) -> Result<[u8; 32], String> {
    let (min_id, max_id) = if id_a <= id_b { (id_a, id_b) } else { (id_b, id_a) };
    let material = format!("onebyone-pair:{code}:{min_id}:{max_id}");
    let params = Params::new(19456, 2, 1, Some(32)).map_err(|e| e.to_string())?;
    let mut out = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(material.as_bytes(), salt, &mut out)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

fn aead_encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<(String, String), String> {
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext)
        .map_err(|_| "Transport encryption failed".to_string())?;
    Ok((hex::encode(nonce), hex::encode(ct)))
}

fn aead_decrypt(key: &[u8; 32], nonce_hex: &str, ct_hex: &str) -> Result<Vec<u8>, String> {
    let nonce_vec = hex::decode(nonce_hex).map_err(|_| "Invalid nonce".to_string())?;
    let nonce: [u8; 12] = nonce_vec.try_into().map_err(|_| "Invalid nonce length".to_string())?;
    let ct = hex::decode(ct_hex).map_err(|_| "Invalid ciphertext".to_string())?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    cipher
        .decrypt(Nonce::from_slice(&nonce), ct.as_ref())
        .map_err(|_| "Authentication failed or wrong pairing code".to_string())
}

fn decode_key32(hex_str: &str) -> Result<[u8; 32], String> {
    hex::decode(hex_str)
        .map_err(|_| "Invalid peer key".to_string())?
        .try_into()
        .map_err(|_| "Invalid peer key length".to_string())
}

fn read_line_bounded(reader: &mut BufReader<TcpStream>, max_bytes: u64) -> Result<String, String> {
    let mut line = String::new();
    reader
        .by_ref()
        .take(max_bytes + 1)
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    if line.is_empty() || line.len() as u64 > max_bytes || !line.ends_with('\n') {
        return Err("Invalid or oversized sync message".into());
    }
    Ok(line)
}

fn current_local_workspace<R: Runtime>(app: &AppHandle<R>) -> Result<Option<Workspace>, String> {
    let state = app.state::<VaultRuntime>();
    let vault_guard = state.0.lock().map_err(|e| e.to_string())?;
    let path = crate::data_file(app)?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let encrypted = vault::is_encrypted(&bytes)?;
    if encrypted && vault_guard.key.is_none() {
        return Err("Vault locked".into());
    }
    let plaintext = if encrypted {
        vault::open(vault_guard.key.as_ref().unwrap(), &bytes)?
    } else {
        bytes
    };
    let mut ws: Workspace = serde_json::from_slice(&plaintext).map_err(|e| e.to_string())?;
    ws.normalize();
    Ok(Some(ws))
}

fn apply_merged_workspace<R: Runtime>(app: &AppHandle<R>, remote: &Workspace) -> Result<Workspace, String> {
    let state = app.state::<VaultRuntime>();
    let vault_guard = state.0.lock().map_err(|e| e.to_string())?;
    let path = crate::data_file(app)?;
    let (local_opt, encrypted) = if path.exists() {
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        let enc = vault::is_encrypted(&bytes)?;
        if enc && vault_guard.key.is_none() {
            return Err("Vault locked".into());
        }
        let plain = if enc {
            vault::open(vault_guard.key.as_ref().unwrap(), &bytes)?
        } else {
            bytes
        };
        let mut ws: Workspace = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
        ws.normalize();
        (Some(ws), enc)
    } else {
        (None, vault_guard.key.is_some())
    };

    let merged = match &local_opt {
        Some(local) => sync_merge::merge_workspaces(local, remote),
        None => {
            let mut adopted = remote.clone();
            adopted.normalize();
            adopted
        }
    };

    let changed = local_opt
        .as_ref()
        .map(|l| sync_merge::sync_revision(l) != sync_merge::sync_revision(&merged))
        .unwrap_or(true);

    if changed {
        let serialized = serde_json::to_vec(&merged).map_err(|e| e.to_string())?;
        let out = if encrypted || vault_guard.key.is_some() {
            vault::seal(vault_guard.key.as_ref().ok_or("Vault locked")?, &serialized)?
        } else {
            serialized
        };
        let history_rt = app.state::<crate::history::HistoryRuntime>();
        let mut history = history_rt.0.lock().map_err(|e| e.to_string())?;
        vault::atomic_write(&path, &out)?;
        if let Some(prev) = &local_opt {
            history.record(prev, &merged);
        }
        drop(history);
        drop(vault_guard);
        let _ = app.emit("sync-updated", ());
    }
    Ok(merged)
}

/// Core responder handler, separated from Tauri runtime so socket roundtrips can also be unit-tested directly.
fn handle_tcp_stream(
    stream: TcpStream,
    my_device_id: &str,
    my_device_name: &str,
    take_pairing_attempt: impl FnOnce() -> Result<String, String>,
    complete_pairing: impl FnOnce(TrustedPeer) -> Result<(), String>,
    lookup_peer_key: impl FnOnce(&str) -> Option<[u8; 32]>,
    merge_callback: impl FnOnce(&str, Workspace) -> Result<Workspace, String>,
) -> Result<(), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;
    let peer_sock = stream.peer_addr().ok();
    let mut reader = BufReader::new(stream);
    let line = read_line_bounded(&mut reader, 4_194_304)?;
    let req: WireRequest = serde_json::from_str(&line).map_err(|_| "Malformed wire request".to_string())?;

    match req {
        WireRequest::PairInit {
            device_id,
            device_name,
            salt,
            nonce_b,
        } => {
            if device_id.is_empty() || device_id == my_device_id {
                let reply = PairChallengeReply {
                    ok: false,
                    error: Some("Invalid peer device ID".into()),
                    nonce: None,
                    ciphertext: None,
                };
                let _ = writeln!(reader.get_mut(), "{}", serde_json::to_string(&reply).unwrap());
                return Err("Invalid peer device ID".into());
            }
            let code = match take_pairing_attempt() {
                Ok(c) => c,
                Err(err) => {
                    let reply = PairChallengeReply {
                        ok: false,
                        error: Some(err.clone()),
                        nonce: None,
                        ciphertext: None,
                    };
                    let _ = writeln!(reader.get_mut(), "{}", serde_json::to_string(&reply).unwrap());
                    return Err(err);
                }
            };
            let salt_bytes: [u8; 16] = hex::decode(&salt)
                .map_err(|_| "Bad salt".to_string())?
                .try_into()
                .map_err(|_| "Bad salt len".to_string())?;
            let k = derive_pairing_key(&code, my_device_id, &device_id, &salt_bytes)?;
            let mut secret_a = [0u8; 32];
            OsRng.fill_bytes(&mut secret_a);
            let inner = PairChallengeInner {
                device_id: my_device_id.to_string(),
                device_name: my_device_name.to_string(),
                nonce_b: nonce_b.clone(),
                secret_a: hex::encode(secret_a),
            };
            let (nonce, ciphertext) = aead_encrypt(&k, &serde_json::to_vec(&inner).unwrap())?;
            let reply = PairChallengeReply {
                ok: true,
                error: None,
                nonce: Some(nonce),
                ciphertext: Some(ciphertext),
            };
            writeln!(reader.get_mut(), "{}", serde_json::to_string(&reply).unwrap())
                .map_err(|e| e.to_string())?;

            // Wait for Initiator confirmation proving knowledge of K.
            let confirm_line = read_line_bounded(&mut reader, 65_536)?;
            let confirm: PairConfirmMsg =
                serde_json::from_str(&confirm_line).map_err(|_| "Malformed pair confirm".to_string())?;
            let plain = aead_decrypt(&k, &confirm.nonce, &confirm.ciphertext)?;
            let confirm_inner: PairConfirmInner =
                serde_json::from_slice(&plain).map_err(|_| "Invalid pair confirm body".to_string())?;
            if confirm_inner.nonce_b != nonce_b {
                return Err("Pair nonce mismatch".into());
            }
            let secret_b: [u8; 32] = hex::decode(&confirm_inner.secret_b)
                .map_err(|_| "Bad secret_b".to_string())?
                .try_into()
                .map_err(|_| "Bad secret_b len".to_string())?;
            let mut hasher = Sha256::new();
            hasher.update(secret_a);
            hasher.update(secret_b);
            let shared_key: [u8; 32] = hasher.finalize().into();

            complete_pairing(TrustedPeer {
                device_id,
                device_name: device_name.chars().take(40).collect(),
                shared_key_hex: hex::encode(shared_key),
                last_synced_at: None,
                last_addr: peer_sock.map(|s| s.to_string()),
            })?;
            writeln!(reader.get_mut(), r#"{{"ok":true}}"#).map_err(|e| e.to_string())?;
            Ok(())
        }
        WireRequest::SyncReq {
            device_id,
            nonce,
            ciphertext,
        } => {
            let Some(shared_key) = lookup_peer_key(&device_id) else {
                let reply = SyncReply {
                    ok: false,
                    error: Some("Unpaired device".into()),
                    nonce: None,
                    ciphertext: None,
                };
                let _ = writeln!(reader.get_mut(), "{}", serde_json::to_string(&reply).unwrap());
                return Err("Unpaired device".into());
            };
            let plain = match aead_decrypt(&shared_key, &nonce, &ciphertext) {
                Ok(p) => p,
                Err(err) => {
                    let reply = SyncReply {
                        ok: false,
                        error: Some(err.clone()),
                        nonce: None,
                        ciphertext: None,
                    };
                    let _ = writeln!(reader.get_mut(), "{}", serde_json::to_string(&reply).unwrap());
                    return Err(err);
                }
            };
            let remote_ws: Workspace =
                serde_json::from_slice(&plain).map_err(|e| format!("Invalid workspace JSON: {e}"))?;
            match merge_callback(&device_id, remote_ws) {
                Ok(merged) => {
                    let (resp_nonce, resp_ct) =
                        aead_encrypt(&shared_key, &serde_json::to_vec(&merged).unwrap())?;
                    let reply = SyncReply {
                        ok: true,
                        error: None,
                        nonce: Some(resp_nonce),
                        ciphertext: Some(resp_ct),
                    };
                    writeln!(reader.get_mut(), "{}", serde_json::to_string(&reply).unwrap())
                        .map_err(|e| e.to_string())?;
                    Ok(())
                }
                Err(err) => {
                    let reply = SyncReply {
                        ok: false,
                        error: Some(err.clone()),
                        nonce: None,
                        ciphertext: None,
                    };
                    let _ = writeln!(reader.get_mut(), "{}", serde_json::to_string(&reply).unwrap());
                    Err(err)
                }
            }
        }
    }
}

fn client_pair_handshake(
    addr: SocketAddr,
    my_device_id: &str,
    my_device_name: &str,
    expected_peer_id: Option<&str>,
    code: &str,
) -> Result<TrustedPeer, String> {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5))
        .map_err(|_| "Cannot connect to peer on LAN".to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|e| e.to_string())?;

    let mut salt = [0u8; 16];
    let mut nonce_b = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce_b);
    let nonce_b_hex = hex::encode(nonce_b);

    let init = WireRequest::PairInit {
        device_id: my_device_id.to_string(),
        device_name: my_device_name.to_string(),
        salt: hex::encode(salt),
        nonce_b: nonce_b_hex.clone(),
    };
    writeln!(stream, "{}", serde_json::to_string(&init).unwrap()).map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(stream);
    let line = read_line_bounded(&mut reader, 65_536)?;
    let reply: PairChallengeReply =
        serde_json::from_str(&line).map_err(|_| "Invalid reply from peer".to_string())?;
    if !reply.ok {
        return Err(reply.error.unwrap_or_else(|| "Peer rejected pairing".into()));
    }

    // If expected_peer_id is unknown (manual IP pairing), we need peer's device_id to derive K.
    // When pairing from discovered list we know expected_peer_id; otherwise require discovered peer ID.
    let target_id = expected_peer_id.ok_or("Peer device ID required")?;
    let k = derive_pairing_key(code, my_device_id, target_id, &salt)?;
    let plain = aead_decrypt(
        &k,
        reply.nonce.as_deref().unwrap_or(""),
        reply.ciphertext.as_deref().unwrap_or(""),
    )?;
    let inner: PairChallengeInner =
        serde_json::from_slice(&plain).map_err(|_| "Invalid challenge payload".to_string())?;
    if inner.nonce_b != nonce_b_hex || inner.device_id != target_id {
        return Err("Peer identity verification failed".into());
    }
    let secret_a: [u8; 32] = hex::decode(&inner.secret_a)
        .map_err(|_| "Invalid peer key share".to_string())?
        .try_into()
        .map_err(|_| "Invalid peer key share len".to_string())?;

    let mut secret_b = [0u8; 32];
    OsRng.fill_bytes(&mut secret_b);
    let confirm_inner = PairConfirmInner {
        nonce_b: nonce_b_hex,
        secret_b: hex::encode(secret_b),
    };
    let (c_nonce, c_ct) = aead_encrypt(&k, &serde_json::to_vec(&confirm_inner).unwrap())?;
    let confirm_msg = PairConfirmMsg {
        nonce: c_nonce,
        ciphertext: c_ct,
    };
    writeln!(
        reader.get_mut(),
        "{}",
        serde_json::to_string(&confirm_msg).unwrap()
    )
    .map_err(|e| e.to_string())?;

    let ack_line = read_line_bounded(&mut reader, 4096)?;
    let ack: serde_json::Value =
        serde_json::from_str(&ack_line).map_err(|_| "Missing pairing ack".to_string())?;
    if ack["ok"] != true {
        return Err("Peer failed to finalize pairing".into());
    }

    let mut hasher = Sha256::new();
    hasher.update(secret_a);
    hasher.update(secret_b);
    let shared_key: [u8; 32] = hasher.finalize().into();

    Ok(TrustedPeer {
        device_id: inner.device_id,
        device_name: inner.device_name,
        shared_key_hex: hex::encode(shared_key),
        last_synced_at: None,
        last_addr: Some(addr.to_string()),
    })
}

fn client_sync_exchange(
    addr: SocketAddr,
    my_device_id: &str,
    shared_key: &[u8; 32],
    local_ws: &Workspace,
) -> Result<Workspace, String> {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(4))
        .map_err(|_| "Peer unreachable on LAN".to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(12)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(12)))
        .map_err(|e| e.to_string())?;

    let (nonce, ciphertext) =
        aead_encrypt(shared_key, &serde_json::to_vec(local_ws).map_err(|e| e.to_string())?)?;
    let req = WireRequest::SyncReq {
        device_id: my_device_id.to_string(),
        nonce,
        ciphertext,
    };
    writeln!(stream, "{}", serde_json::to_string(&req).unwrap()).map_err(|e| e.to_string())?;

    let mut reader = BufReader::new(stream);
    let line = read_line_bounded(&mut reader, 4_194_304)?;
    let reply: SyncReply = serde_json::from_str(&line).map_err(|_| "Invalid sync reply".to_string())?;
    if !reply.ok {
        return Err(reply.error.unwrap_or_else(|| "Sync failed on peer".into()));
    }
    let plain = aead_decrypt(
        shared_key,
        reply.nonce.as_deref().unwrap_or(""),
        reply.ciphertext.as_deref().unwrap_or(""),
    )?;
    serde_json::from_slice(&plain).map_err(|e| format!("Invalid merged workspace: {e}"))
}

fn bind_discovery_socket() -> Result<UdpSocket, String> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP)).map_err(|e| e.to_string())?;
    let _ = socket.set_reuse_address(true);
    let _ = socket.set_broadcast(true);
    socket
        .bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, DISCOVERY_PORT).into())
        .map_err(|e| e.to_string())?;
    let _ = socket.join_multicast_v4(&MULTICAST_ADDR, &Ipv4Addr::UNSPECIFIED);
    let _ = socket.set_multicast_loop_v4(true);
    let udp: UdpSocket = socket.into();
    let _ = udp.set_read_timeout(Some(Duration::from_millis(800)));
    Ok(udp)
}

pub fn notify_local_change<R: Runtime>(app: &AppHandle<R>) {
    let Ok(cfg) = load_or_init_config(app) else { return };
    if !cfg.enabled {
        return;
    }
    let tcp_port = {
        let rt = app.state::<SyncRuntime>();
        let Ok(st) = rt.0.lock() else { return };
        st.tcp_port
    };
    let Some(port) = tcp_port else { return };
    let revision = current_local_workspace(app)
        .ok()
        .flatten()
        .map(|ws| sync_merge::sync_revision(&ws))
        .unwrap_or_default();
    send_beacon_once(&cfg.device_id, &cfg.device_name, port, &revision);
}

fn send_beacon_once(device_id: &str, device_name: &str, tcp_port: u16, revision: &str) {
    let Ok(sock) = UdpSocket::bind("0.0.0.0:0") else { return };
    let _ = sock.set_broadcast(true);
    let beacon = Beacon {
        proto: PROTO_VERSION.to_string(),
        device_id: device_id.to_string(),
        device_name: device_name.to_string(),
        tcp_port,
        revision: revision.to_string(),
    };
    let Ok(bytes) = serde_json::to_vec(&beacon) else { return };
    let _ = sock.send_to(&bytes, SocketAddrV4::new(MULTICAST_ADDR, DISCOVERY_PORT));
    let _ = sock.send_to(&bytes, SocketAddrV4::new(Ipv4Addr::BROADCAST, DISCOVERY_PORT));
}

pub fn start_if_enabled<R: Runtime>(app: AppHandle<R>) {
    if let Ok(cfg) = load_or_init_config(&app) {
        if cfg.enabled {
            let _ = ensure_background_workers(&app);
        }
    }
}

fn stop_background_workers<R: Runtime>(app: &AppHandle<R>) {
    let rt = app.state::<SyncRuntime>();
    if let Ok(mut st) = rt.0.lock() {
        if let Some(flag) = st.running.take() {
            flag.store(false, Ordering::SeqCst);
        }
        st.tcp_port = None;
        st.pairing = None;
        st.discovered.clear();
    };
}

fn ensure_background_workers<R: Runtime>(app: &AppHandle<R>) -> Result<u16, String> {
    let rt = app.state::<SyncRuntime>();
    {
        let st = rt.0.lock().map_err(|e| e.to_string())?;
        if let (Some(port), Some(flag)) = (st.tcp_port, st.running.as_ref()) {
            if flag.load(Ordering::SeqCst) {
                return Ok(port);
            }
        }
    }

    let listener = TcpListener::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    let _ = listener.set_nonblocking(false);
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let running = Arc::new(AtomicBool::new(true));

    {
        let mut st = rt.0.lock().map_err(|e| e.to_string())?;
        if let Some(prev) = st.running.take() {
            prev.store(false, Ordering::SeqCst);
        }
        st.tcp_port = Some(port);
        st.running = Some(running.clone());
    }

    // Worker 1: TCP Sync & Pairing Responder
    let app_tcp = app.clone();
    let running_tcp = running.clone();
    std::thread::spawn(move || {
        for incoming in listener.incoming() {
            if !running_tcp.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = incoming else { continue };
            let app_conn = app_tcp.clone();
            std::thread::spawn(move || {
                let Ok(cfg) = load_or_init_config(&app_conn) else { return };
                let my_id = cfg.device_id.clone();
                let my_name = cfg.device_name.clone();
                let app_pair_take = app_conn.clone();
                let app_pair_done = app_conn.clone();
                let app_lookup = app_conn.clone();
                let app_merge = app_conn.clone();

                let _ = handle_tcp_stream(
                    stream,
                    &my_id,
                    &my_name,
                    move || {
                        let rt = app_pair_take.state::<SyncRuntime>();
                        let mut st = rt.0.lock().map_err(|e| e.to_string())?;
                        let now = sync_merge::now_ms();
                        let session = st.pairing.as_mut().ok_or("No active pairing code on target device")?;
                        if now > session.expires_at_ms {
                            st.pairing = None;
                            return Err("Pairing code expired".into());
                        }
                        session.attempts += 1;
                        if session.attempts > MAX_PAIR_ATTEMPTS {
                            st.pairing = None;
                            return Err("Too many pairing attempts; generate a new code".into());
                        }
                        Ok(session.code.clone())
                    },
                    move |new_peer| {
                        let rt = app_pair_done.state::<SyncRuntime>();
                        if let Ok(mut st) = rt.0.lock() {
                            st.pairing = None;
                        }
                        let mut current_cfg = load_or_init_config(&app_pair_done)?;
                        current_cfg.peers.retain(|p| p.device_id != new_peer.device_id);
                        current_cfg.peers.push(new_peer);
                        save_config(&app_pair_done, &current_cfg)?;
                        let _ = app_pair_done.emit("sync-status-changed", ());
                        Ok(())
                    },
                    move |peer_id| {
                        let cfg = load_or_init_config(&app_lookup).ok()?;
                        let peer = cfg.peers.iter().find(|p| p.device_id == peer_id)?;
                        decode_key32(&peer.shared_key_hex).ok()
                    },
                    move |peer_id, remote_ws| {
                        let merged = apply_merged_workspace(&app_merge, &remote_ws)?;
                        if let Ok(mut cfg) = load_or_init_config(&app_merge) {
                            if let Some(p) = cfg.peers.iter_mut().find(|p| p.device_id == peer_id) {
                                p.last_synced_at = Some(sync_merge::now_ms());
                                let _ = save_config(&app_merge, &cfg);
                            }
                        }
                        let _ = app_merge.emit("sync-status-changed", ());
                        Ok(merged)
                    },
                );
            });
        }
    });

    // Worker 2: UDP Discovery Receiver + Periodic Broadcaster + Auto-Sync
    let app_udp = app.clone();
    let running_udp = running;
    std::thread::spawn(move || {
        let recv_sock = bind_discovery_socket().ok();
        let mut last_broadcast = 0i64;
        let mut buf = [0u8; 2048];

        while running_udp.load(Ordering::SeqCst) {
            let now = sync_merge::now_ms();
            if now - last_broadcast >= 4_000 {
                last_broadcast = now;
                if let Ok(cfg) = load_or_init_config(&app_udp) {
                    if cfg.enabled {
                        let rev = current_local_workspace(&app_udp)
                            .ok()
                            .flatten()
                            .map(|ws| sync_merge::sync_revision(&ws))
                            .unwrap_or_default();
                        send_beacon_once(&cfg.device_id, &cfg.device_name, port, &rev);
                    }
                }
            }

            if let Some(sock) = &recv_sock {
                if let Ok((len, src_addr)) = sock.recv_from(&mut buf) {
                    if let Ok(beacon) = serde_json::from_slice::<Beacon>(&buf[..len]) {
                        if beacon.proto == PROTO_VERSION && beacon.tcp_port > 0 {
                            handle_incoming_beacon(&app_udp, beacon, src_addr.ip());
                        }
                    }
                }
            } else {
                std::thread::sleep(Duration::from_millis(1000));
            }
        }
    });

    Ok(port)
}

fn handle_incoming_beacon<R: Runtime>(app: &AppHandle<R>, beacon: Beacon, src_ip: IpAddr) {
    let Ok(cfg) = load_or_init_config(app) else { return };
    if beacon.device_id.is_empty() || beacon.device_id == cfg.device_id {
        return;
    }
    let peer_addr = SocketAddr::new(src_ip, beacon.tcp_port);
    let now = sync_merge::now_ms();

    let mut should_auto_sync: Option<TrustedPeer> = None;
    {
        let rt = app.state::<SyncRuntime>();
        let Ok(mut st) = rt.0.lock() else { return };
        st.discovered
            .retain(|_, entry| now - entry.last_seen_ms <= PEER_STALE_MS);
        let is_new_or_changed = st
            .discovered
            .get(&beacon.device_id)
            .map(|old| old.revision != beacon.revision || old.addr != peer_addr || old.device_name != beacon.device_name)
            .unwrap_or(true);
        st.discovered.insert(
            beacon.device_id.clone(),
            DiscoveredEntry {
                device_id: beacon.device_id.clone(),
                device_name: beacon.device_name.chars().take(40).collect(),
                addr: peer_addr,
                revision: beacon.revision.clone(),
                last_seen_ms: now,
            },
        );
        if is_new_or_changed {
            let _ = app.emit("sync-status-changed", ());
        }

        if let Some(trusted) = cfg.peers.iter().find(|p| p.device_id == beacon.device_id) {
            if !beacon.revision.is_empty() {
                if let Ok(Some(local_ws)) = current_local_workspace(app) {
                    let local_rev = sync_merge::sync_revision(&local_ws);
                    if local_rev != beacon.revision {
                        let cooldown = if cfg.device_id < beacon.device_id { 3_000 } else { 5_500 };
                        let last = st.last_auto_sync.get(&beacon.device_id).copied().unwrap_or(0);
                        if now - last >= cooldown {
                            st.last_auto_sync.insert(beacon.device_id.clone(), now);
                            should_auto_sync = Some(trusted.clone());
                        }
                    }
                }
            }
        }
    }

    if let Some(peer) = should_auto_sync {
        let app_sync = app.clone();
        std::thread::spawn(move || {
            let _ = sync_single_peer(&app_sync, &peer, Some(peer_addr));
        });
    }
}

fn sync_single_peer<R: Runtime>(
    app: &AppHandle<R>,
    peer: &TrustedPeer,
    addr_override: Option<SocketAddr>,
) -> Result<(), String> {
    let addr = if let Some(a) = addr_override {
        a
    } else {
        let discovered_addr = {
            let rt = app.state::<SyncRuntime>();
            let st = rt.0.lock().map_err(|e| e.to_string())?;
            st.discovered.get(&peer.device_id).map(|d| d.addr)
        };
        if let Some(a) = discovered_addr {
            a
        } else if let Some(last) = &peer.last_addr {
            last.parse::<SocketAddr>()
                .map_err(|_| "Peer is currently offline".to_string())?
        } else {
            return Err("Peer not found on LAN".into());
        }
    };

    let cfg = load_or_init_config(app)?;
    let key = decode_key32(&peer.shared_key_hex)?;
    let local_ws = current_local_workspace(app)?
        .unwrap_or_else(|| Workspace {
            lists: Vec::new(),
            active_list_id: String::new(),
            deleted_todos: Default::default(),
            deleted_lists: Default::default(),
        });

    let remote_merged = client_sync_exchange(addr, &cfg.device_id, &key, &local_ws)?;
    apply_merged_workspace(app, &remote_merged)?;

    let mut updated_cfg = load_or_init_config(app)?;
    if let Some(saved_peer) = updated_cfg.peers.iter_mut().find(|p| p.device_id == peer.device_id) {
        saved_peer.last_synced_at = Some(sync_merge::now_ms());
        saved_peer.last_addr = Some(addr.to_string());
        save_config(app, &updated_cfg)?;
    }
    let _ = app.emit("sync-status-changed", ());
    Ok(())
}

#[tauri::command]
pub fn get_sync_status<R: Runtime>(app: AppHandle<R>) -> Result<SyncStatus, String> {
    let cfg = load_or_init_config(&app)?;
    let local_rev = current_local_workspace(&app)
        .ok()
        .flatten()
        .map(|ws| sync_merge::sync_revision(&ws))
        .unwrap_or_default();
    let now = sync_merge::now_ms();
    let rt = app.state::<SyncRuntime>();
    let mut st = rt.0.lock().map_err(|e| e.to_string())?;
    st.discovered
        .retain(|_, entry| now - entry.last_seen_ms <= PEER_STALE_MS);
    if st.pairing.as_ref().is_some_and(|p| now > p.expires_at_ms) {
        st.pairing = None;
    }

    let paired_ids: std::collections::HashSet<&str> =
        cfg.peers.iter().map(|p| p.device_id.as_str()).collect();

    let paired_peers = cfg
        .peers
        .iter()
        .map(|p| {
            let disc = st.discovered.get(&p.device_id);
            PairedPeerInfo {
                device_id: p.device_id.clone(),
                device_name: disc
                    .map(|d| d.device_name.clone())
                    .unwrap_or_else(|| p.device_name.clone()),
                online: disc.is_some(),
                in_sync: disc.is_some_and(|d| !local_rev.is_empty() && d.revision == local_rev),
                last_synced_at: p.last_synced_at,
            }
        })
        .collect();

    let nearby_peers = st
        .discovered
        .values()
        .filter(|d| !paired_ids.contains(d.device_id.as_str()))
        .map(|d| DiscoveredPeerInfo {
            device_id: d.device_id.clone(),
            device_name: d.device_name.clone(),
            addr: d.addr.to_string(),
            paired: false,
            in_sync: !local_rev.is_empty() && d.revision == local_rev,
        })
        .collect();

    Ok(SyncStatus {
        enabled: cfg.enabled,
        device_id: cfg.device_id,
        device_name: cfg.device_name,
        tcp_port: st.tcp_port,
        pairing_code: st.pairing.as_ref().map(|p| p.code.clone()),
        pairing_expires_at: st.pairing.as_ref().map(|p| p.expires_at_ms),
        paired_peers,
        nearby_peers,
    })
}

#[tauri::command]
pub fn set_sync_enabled<R: Runtime>(app: AppHandle<R>, enabled: bool, device_name: Option<String>) -> Result<SyncStatus, String> {
    let mut cfg = load_or_init_config(&app)?;
    cfg.enabled = enabled;
    if let Some(name) = device_name {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            cfg.device_name = trimmed.chars().take(40).collect();
        }
    }
    save_config(&app, &cfg)?;
    if enabled {
        let port = ensure_background_workers(&app)?;
        let rev = current_local_workspace(&app)
            .ok()
            .flatten()
            .map(|ws| sync_merge::sync_revision(&ws))
            .unwrap_or_default();
        send_beacon_once(&cfg.device_id, &cfg.device_name, port, &rev);
    } else {
        stop_background_workers(&app);
    }
    get_sync_status(app)
}

#[tauri::command]
pub fn generate_pairing_code<R: Runtime>(app: AppHandle<R>) -> Result<SyncStatus, String> {
    let mut cfg = load_or_init_config(&app)?;
    if !cfg.enabled {
        cfg.enabled = true;
        save_config(&app, &cfg)?;
    }
    let port = ensure_background_workers(&app)?;
    let code_num = OsRng.next_u32() % 1_000_000;
    let code = format!("{code_num:06}");
    let expires_at_ms = sync_merge::now_ms() + PAIR_TTL_MS;
    {
        let rt = app.state::<SyncRuntime>();
        let mut st = rt.0.lock().map_err(|e| e.to_string())?;
        st.pairing = Some(PairingSession {
            code,
            expires_at_ms,
            attempts: 0,
        });
    }
    let rev = current_local_workspace(&app)
        .ok()
        .flatten()
        .map(|ws| sync_merge::sync_revision(&ws))
        .unwrap_or_default();
    send_beacon_once(&cfg.device_id, &cfg.device_name, port, &rev);
    get_sync_status(app)
}

#[tauri::command]
pub async fn pair_with_peer<R: Runtime>(
    app: AppHandle<R>,
    peer_device_id: String,
    code: String,
) -> Result<SyncStatus, String> {
    let clean_code: String = code.chars().filter(|c| c.is_ascii_digit()).collect();
    if clean_code.len() != 6 {
        return Err("Enter a 6-digit pairing code".into());
    }
    let mut cfg = load_or_init_config(&app)?;
    if !cfg.enabled {
        cfg.enabled = true;
        save_config(&app, &cfg)?;
    }
    ensure_background_workers(&app)?;

    let addr = {
        let rt = app.state::<SyncRuntime>();
        let st = rt.0.lock().map_err(|e| e.to_string())?;
        st.discovered
            .get(&peer_device_id)
            .map(|d| d.addr)
            .ok_or_else(|| "Device no longer visible on LAN; keep both apps open on the same Wi-Fi".to_string())?
    };

    let app_work = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let peer = client_pair_handshake(
            addr,
            &cfg.device_id,
            &cfg.device_name,
            Some(&peer_device_id),
            &clean_code,
        )?;
        let mut latest_cfg = load_or_init_config(&app_work)?;
        latest_cfg.peers.retain(|p| p.device_id != peer.device_id);
        latest_cfg.peers.push(peer.clone());
        save_config(&app_work, &latest_cfg)?;
        // Immediately synchronize workspaces after pairing succeeds.
        let _ = sync_single_peer(&app_work, &peer, Some(addr));
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    get_sync_status(app)
}

#[tauri::command]
pub async fn sync_now<R: Runtime>(app: AppHandle<R>) -> Result<SyncStatus, String> {
    let cfg = load_or_init_config(&app)?;
    if !cfg.enabled {
        return Err("LAN sync is disabled".into());
    }
    let port = ensure_background_workers(&app)?;
    let rev = current_local_workspace(&app)?
        .map(|ws| sync_merge::sync_revision(&ws))
        .unwrap_or_default();
    send_beacon_once(&cfg.device_id, &cfg.device_name, port, &rev);

    if cfg.peers.is_empty() {
        return Err("No paired devices yet".into());
    }

    let app_work = app.clone();
    let peers = cfg.peers.clone();
    let results = tauri::async_runtime::spawn_blocking(move || {
        let mut synced = 0usize;
        let mut last_err = String::new();
        for peer in &peers {
            match sync_single_peer(&app_work, peer, None) {
                Ok(()) => synced += 1,
                Err(e) => last_err = e,
            }
        }
        (synced, last_err)
    })
    .await
    .map_err(|e| e.to_string())?;

    if results.0 == 0 && !results.1.is_empty() {
        return Err(results.1);
    }
    get_sync_status(app)
}

#[tauri::command]
pub fn remove_paired_peer<R: Runtime>(app: AppHandle<R>, peer_device_id: String) -> Result<SyncStatus, String> {
    let mut cfg = load_or_init_config(&app)?;
    cfg.peers.retain(|p| p.device_id != peer_device_id);
    save_config(&app, &cfg)?;
    get_sync_status(app)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn six_digit_pairing_and_encrypted_sync_roundtrip_over_tcp() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let desktop_ws = Arc::new(Mutex::new({
            let mut ws: Workspace = serde_json::from_value(json!({
                "activeListId": "l1",
                "lists": [{"id": "l1", "title": "Shared", "color": "green", "board": {"todos": [
                    {"id": "t1", "title": "From Desktop", "completed": false, "createdAt": 100, "parentId": null}
                ]}}]
            }))
            .unwrap();
            sync_merge::stamp_changes(None, &mut ws, 1000);
            ws
        }));
        let paired_on_desktop: Arc<Mutex<Option<TrustedPeer>>> = Arc::new(Mutex::new(None));

        let desktop_ws_srv = desktop_ws.clone();
        let paired_srv = paired_on_desktop.clone();

        let server = std::thread::spawn(move || {
            // Connection 1: Wrong pairing code rejected
            let (s1, _) = listener.accept().unwrap();
            assert!(handle_tcp_stream(
                s1,
                "dev-desktop",
                "Desktop PC",
                || Ok("654321".into()),
                |_| unreachable!(),
                |_| None,
                |_, _| unreachable!(),
            )
            .is_err());

            // Connection 2: Valid 6-digit pairing code succeeds and derives identical key
            let (s2, _) = listener.accept().unwrap();
            let paired_slot = paired_srv.clone();
            handle_tcp_stream(
                s2,
                "dev-desktop",
                "Desktop PC",
                || Ok("654321".into()),
                move |peer| {
                    *paired_slot.lock().unwrap() = Some(peer);
                    Ok(())
                },
                |_| None,
                |_, _| unreachable!(),
            )
            .unwrap();

            // Connection 3: Encrypted Workspace sync merges mobile + desktop tasks
            let (s3, _) = listener.accept().unwrap();
            let saved_peer = paired_srv.lock().unwrap().clone().unwrap();
            let key = decode_key32(&saved_peer.shared_key_hex).unwrap();
            handle_tcp_stream(
                s3,
                "dev-desktop",
                "Desktop PC",
                || Err("No active code".into()),
                |_| unreachable!(),
                move |id| (id == "dev-android").then_some(key),
                move |_, remote_ws| {
                    let mut guard = desktop_ws_srv.lock().unwrap();
                    let merged = sync_merge::merge_workspaces(&guard, &remote_ws);
                    *guard = merged.clone();
                    Ok(merged)
                },
            )
            .unwrap();
        });

        // 1. Wrong code fails
        assert!(client_pair_handshake(
            addr,
            "dev-android",
            "Pixel 10",
            Some("dev-desktop"),
            "000000"
        )
        .is_err());

        // 2. Correct code pairs and produces matching 256-bit shared key
        let peer_on_mobile = client_pair_handshake(
            addr,
            "dev-android",
            "Pixel 10",
            Some("dev-desktop"),
            "654321",
        )
        .unwrap();
        assert_eq!(peer_on_mobile.device_id, "dev-desktop");
        assert_eq!(peer_on_mobile.device_name, "Desktop PC");

        // 3. Mobile creates a task in Shared list and syncs over AES-256-GCM TCP
        let mut mobile_ws: Workspace = serde_json::from_value(json!({
            "activeListId": "l1",
            "lists": [{"id": "l1", "title": "Shared", "color": "green", "board": {"todos": [
                {"id": "t2", "title": "From Android", "completed": true, "createdAt": 200, "parentId": null}
            ]}}]
        }))
        .unwrap();
        sync_merge::stamp_changes(None, &mut mobile_ws, 2000);

        let mobile_key = decode_key32(&peer_on_mobile.shared_key_hex).unwrap();
        let merged_reply = client_sync_exchange(addr, "dev-android", &mobile_key, &mobile_ws).unwrap();
        let final_mobile = sync_merge::merge_workspaces(&mobile_ws, &merged_reply);

        server.join().unwrap();

        let final_desktop = desktop_ws.lock().unwrap().clone();
        assert_eq!(
            sync_merge::sync_revision(&final_mobile),
            sync_merge::sync_revision(&final_desktop)
        );
        assert_eq!(final_mobile.lists[0].board.todos.len(), 2);
    }
}

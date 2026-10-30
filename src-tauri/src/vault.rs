use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path};
use zeroize::Zeroizing;

const FORMAT: &str = "zen-todo-encrypted";

#[derive(Serialize, Deserialize)]
struct Envelope {
    format: String,
    version: u32,
    kdf: String,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: String,
    nonce: String,
    ciphertext: String,
}

pub struct Key {
    bytes: Zeroizing<[u8; 32]>,
    salt: [u8; 16],
}

fn derive(password: &str, salt: [u8; 16]) -> Result<Key, String> {
    let params = Params::new(19456, 2, 1, Some(32)).map_err(|e| e.to_string())?;
    let mut bytes = Zeroizing::new([0u8; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), &salt, bytes.as_mut()).map_err(|e| e.to_string())?;
    Ok(Key { bytes, salt })
}

fn decode<const N: usize>(value: &str) -> Result<[u8; N], String> {
    hex::decode(value).map_err(|e| e.to_string())?.try_into().map_err(|_| "Invalid encrypted data".into())
}

pub fn is_encrypted(data: &[u8]) -> Result<bool, String> {
    let value: serde_json::Value = serde_json::from_slice(data).map_err(|e| e.to_string())?;
    Ok(value.get("format").and_then(|v| v.as_str()) == Some(FORMAT))
}

pub fn create(password: &str) -> Result<Key, String> {
    let mut salt = [0; 16];
    OsRng.fill_bytes(&mut salt);
    derive(password, salt)
}

pub fn unlock(data: &[u8], password: &str) -> Result<(Key, Vec<u8>), String> {
    let envelope: Envelope = serde_json::from_slice(data).map_err(|e| e.to_string())?;
    if envelope.format != FORMAT || envelope.version != 1 || envelope.kdf != "argon2id"
        || (envelope.memory_kib, envelope.iterations, envelope.parallelism) != (19456, 2, 1) {
        return Err("Unsupported encrypted data format".into());
    }
    let key = derive(password, decode(&envelope.salt)?)?;
    let plaintext = decrypt(&key, &envelope.nonce, &envelope.ciphertext)?;
    Ok((key, plaintext))
}

fn encrypt(key: &Key, data: &[u8]) -> Result<(String, String), String> {
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let cipher = Aes256Gcm::new_from_slice(key.bytes.as_ref()).map_err(|e| e.to_string())?;
    let ciphertext = cipher.encrypt(Nonce::from_slice(&nonce), data).map_err(|_| "Encryption failed")?;
    Ok((hex::encode(nonce), hex::encode(ciphertext)))
}

fn decrypt(key: &Key, nonce: &str, ciphertext: &str) -> Result<Vec<u8>, String> {
    let nonce: [u8; 12] = decode(nonce)?;
    let ciphertext = hex::decode(ciphertext).map_err(|e| e.to_string())?;
    let cipher = Aes256Gcm::new_from_slice(key.bytes.as_ref()).map_err(|e| e.to_string())?;
    cipher.decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref()).map_err(|_| "Incorrect password or damaged data".into())
}

pub fn seal(key: &Key, data: &[u8]) -> Result<Vec<u8>, String> {
    let (nonce, ciphertext) = encrypt(key, data)?;
    serde_json::to_vec(&Envelope { format: FORMAT.into(), version: 1, kdf: "argon2id".into(),
        memory_kib: 19456, iterations: 2, parallelism: 1, salt: hex::encode(key.salt), nonce, ciphertext })
        .map_err(|e| e.to_string())
}

pub fn open(key: &Key, data: &[u8]) -> Result<Vec<u8>, String> {
    let envelope: Envelope = serde_json::from_slice(data).map_err(|e| e.to_string())?;
    decrypt(key, &envelope.nonce, &envelope.ciphertext)
}

pub fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    let mut tmp = tempfile::NamedTempFile::new_in(path.parent().ok_or("Invalid data path")?).map_err(|e| e.to_string())?;
    tmp.write_all(data).and_then(|_| tmp.as_file().sync_all()).map_err(|e| e.to_string())?;
    tmp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encrypted_roundtrip_and_tampering() {
        let key = create("test password").unwrap();
        let data = seal(&key, "private 待办".as_bytes()).unwrap();
        assert!(!String::from_utf8_lossy(&data).contains("private"));
        assert!(unlock(&data, "wrong").is_err());
        assert_eq!(unlock(&data, "test password").unwrap().1, "private 待办".as_bytes());
        let mut envelope: Envelope = serde_json::from_slice(&data).unwrap();
        envelope.ciphertext.replace_range(0..2, "ff");
        assert!(unlock(&serde_json::to_vec(&envelope).unwrap(), "test password").is_err());
    }

    #[test]
    fn encrypted_file_replaces_existing_data_and_survives_wrong_password() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("todos.json");
        let original = br#"{"lists":[{"title":"private"}]}"#;
        std::fs::write(&path, original).unwrap();
        let key = create("secret").unwrap();
        let encrypted = seal(&key, original).unwrap();
        assert_eq!(unlock(&encrypted, "secret").unwrap().1, original);
        atomic_write(&path, &encrypted).unwrap();
        let saved = std::fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&saved).contains("private"));
        assert!(unlock(&saved, "wrong").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), saved);
        assert_eq!(unlock(&saved, "secret").unwrap().1, original);
    }
}

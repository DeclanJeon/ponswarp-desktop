use crate::turn::config::{TurnAuthMethod, TurnConfig};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chrono::Utc;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone)]
pub struct TurnCredentials {
    pub username: String,
    pub password: String,
    pub expires_at: i64,
}

pub fn generate_turn_credentials(config: &TurnConfig, username: &str) -> Result<TurnCredentials, String> {
    if config.auth_method != TurnAuthMethod::LongTerm {
        return Err("LongTerm credentials require TURN_SECRET".to_string());
    }

    let secret = config
        .secret
        .as_ref()
        .ok_or_else(|| "LongTerm credentials require TURN_SECRET".to_string())?;

    let expires_at = Utc::now().timestamp() + 24 * 3600;
    let username_raw = format!("{}:{}", expires_at, username);

    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    hasher.update(username_raw.as_bytes());
    let digest = hasher.finalize();

    Ok(TurnCredentials {
        username: username_raw,
        password: STANDARD.encode(digest),
        expires_at,
    })
}

pub fn should_refresh_credentials(creds: &TurnCredentials, config: &TurnConfig) -> bool {
    let now = Utc::now().timestamp();
    let remaining = creds.expires_at - now;
    if remaining <= 0 {
        return true;
    }

    let total_lifetime = 24.0 * 3600.0;
    let elapsed = total_lifetime - remaining as f64;
    elapsed >= total_lifetime * config.refresh_ratio
}

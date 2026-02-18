use serde::{Deserialize, Serialize};
use std::env;
use std::time::Duration;

fn default_timeout() -> u64 {
    30
}

fn default_ratio() -> f64 {
    0.8
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TurnAuthMethod {
    LongTerm,
    #[default]
    ShortTerm,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnConfig {
    pub server_url: String,
    pub realm: String,
    pub enable_tls: bool,
    #[serde(default)]
    pub auth_method: TurnAuthMethod,
    pub username: Option<String>,
    pub password: Option<String>,
    pub secret: Option<String>,
    #[serde(default = "default_timeout")]
    pub timeout_sec: u64,
    #[serde(default = "default_ratio")]
    pub refresh_ratio: f64,
}

impl Default for TurnConfig {
    fn default() -> Self {
        Self {
            server_url: String::new(),
            realm: "example.com".to_string(),
            enable_tls: true,
            auth_method: TurnAuthMethod::ShortTerm,
            username: None,
            password: None,
            secret: None,
            timeout_sec: default_timeout(),
            refresh_ratio: default_ratio(),
        }
    }
}

impl TurnConfig {
    pub fn from_env() -> Result<Self, String> {
        let server_url = env::var("TURN_SERVER_URL")
            .map_err(|e| format!("TURN_SERVER_URL not set: {}", e))?;
        let secret = env::var("TURN_SECRET").ok();
        let username = env::var("TURN_USERNAME").ok();
        let password = env::var("TURN_PASSWORD").ok();

        let auth_method = if secret.is_some() {
            TurnAuthMethod::LongTerm
        } else {
            TurnAuthMethod::ShortTerm
        };

        let config = Self {
            server_url,
            realm: env::var("TURN_REALM").unwrap_or_else(|_| "example.com".to_string()),
            enable_tls: env::var("TURN_ENABLE_TLS")
                .unwrap_or_else(|_| "true".to_string())
                .parse()
                .unwrap_or(true),
            auth_method,
            username,
            password,
            secret,
            timeout_sec: env::var("TURN_TIMEOUT_SEC")
                .unwrap_or_else(|_| default_timeout().to_string())
                .parse()
                .unwrap_or(default_timeout()),
            refresh_ratio: env::var("TURN_REFRESH_RATIO")
                .unwrap_or_else(|_| default_ratio().to_string())
                .parse()
                .unwrap_or(default_ratio()),
        };

        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), String> {
        if !self.server_url.contains(':') {
            return Err(format!("Invalid TURN_SERVER_URL format: {}", self.server_url));
        }

        match self.auth_method {
            TurnAuthMethod::LongTerm => {
                if self.secret.is_none() {
                    return Err("TURN_SECRET must be set for LongTerm authentication".to_string());
                }
            }
            TurnAuthMethod::ShortTerm => {
                if self.username.is_none() || self.password.is_none() {
                    return Err(
                        "TURN_USERNAME and TURN_PASSWORD must be set for ShortTerm authentication"
                            .to_string(),
                    );
                }
            }
        }

        if self.timeout_sec < 5 || self.timeout_sec > 300 {
            return Err(format!(
                "Invalid TURN_TIMEOUT_SEC: {} (must be between 5 and 300)",
                self.timeout_sec
            ));
        }

        if !(0.5..=0.95).contains(&self.refresh_ratio) {
            return Err(format!(
                "Invalid TURN_REFRESH_RATIO: {} (must be between 0.5 and 0.95)",
                self.refresh_ratio
            ));
        }

        Ok(())
    }

    pub fn timeout_duration(&self) -> Duration {
        Duration::from_secs(self.timeout_sec)
    }

    pub fn is_enabled(&self) -> bool {
        !self.server_url.is_empty()
            && match self.auth_method {
                TurnAuthMethod::LongTerm => self.secret.is_some(),
                TurnAuthMethod::ShortTerm => self.username.is_some() && self.password.is_some(),
            }
    }
}

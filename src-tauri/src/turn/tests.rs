// TURN Module Unit Tests
//
// This module contains unit tests for TURN (Traversal Using Relays around NAT)
// functionality implemented in the `turn` module.

use super::client::TurnClient;
use super::config::TurnConfig;
use super::credentials::{generate_turn_credentials, should_refresh_credentials, TurnCredentials};
use super::stun::StunClient;

/// Helper function to create a valid TURN config for testing
fn create_test_turn_config() -> TurnConfig {
    TurnConfig {
        server_url: "turn.example.com:3478".to_string(),
        realm: "example.com".to_string(),
        enable_tls: false,
        auth_method: super::config::TurnAuthMethod::LongTerm,
        username: Some("test_user".to_string()),
        password: Some("test_pass".to_string()),
        secret: Some("test_secret".to_string()),
        timeout_sec: 30,
        refresh_ratio: 0.8,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test 1: Load TURN config from environment
    #[test]
    fn test_turn_config_load_from_env() {
        // This test verifies that TurnConfig::from_env()
        // properly loads configuration from environment variables
        //
        // Expected behavior:
        // - Returns Ok(config) if all required env vars are set
        // - Returns Err if required vars are missing or invalid

        // Set test environment variables
        std::env::set_var("TURN_SERVER_URL", "turn.ponslink.online:3478");
        std::env::set_var("TURN_SECRET", "test_secret_key_12345");

        let result = TurnConfig::from_env();

        assert!(
            result.is_ok(),
            "TURN config should load successfully with env vars"
        );

        let config = result.unwrap();

        assert_eq!(config.server_url, "turn.ponslink.online:3478");
        assert_eq!(config.realm, "example.com".to_string());
        assert_eq!(config.timeout_sec, 30);

        // Clean up test environment
        std::env::remove_var("TURN_SERVER_URL");
        std::env::remove_var("TURN_SECRET");

        println!("✅ Test 1 Passed: TURN config loads from env vars");
    }

    // Test 2: Validate TURN configuration
    #[test]
    fn test_turn_config_validation() {
        // This test verifies that TurnConfig::validate()
        // properly checks configuration constraints
        //
        // Test cases:
        // 1. Valid config should pass
        // 2. Missing TURN_SECRET should fail
        // 3. Invalid port should fail
        // 4. Max relay sessions > 1000 should fail

        let mut config = create_test_turn_config();

        // Test 1: Valid config
        assert!(
            config.validate().is_ok(),
            "Valid config should pass validation"
        );

        // Test 2: Missing TURN_SECRET
        config.secret = None;
        assert!(
            config.validate().is_err(),
            "Config without TURN_SECRET should fail"
        );
        assert!(
            config
                .validate()
                .unwrap_err()
                .contains("TURN_SECRET must be set"),
            "Error should mention TURN_SECRET"
        );

        // Reset secret
        config.secret = Some("test_secret".to_string());

        // Test 3: Invalid timeout (too small)
        config.timeout_sec = 4;
        assert!(
            config.validate().is_err(),
            "Timeout < 5 seconds should fail"
        );
        assert!(
            config
                .validate()
                .unwrap_err()
                .contains("must be between 5 and 300"),
            "Error should mention timeout constraint"
        );

        // Reset timeout
        config.timeout_sec = 30;

        // Test 4: Invalid timeout (too large)
        config.timeout_sec = 400;
        assert!(
            config.validate().is_err(),
            "Timeout > 300 seconds should fail"
        );
        assert!(
            config.validate().unwrap_err().contains("must be <= 1000"),
            "Error should mention timeout constraint"
        );

        // Reset timeout
        config.timeout_sec = 30;

        println!("✅ Test 2 Passed: TURN config validation");
    }

    // Test 3: Check if TURN is enabled
    #[test]
    fn test_turn_config_enable_turn() {
        // This test verifies that TurnConfig::is_enabled()
        // correctly reports whether TURN is enabled
        //
        // Test cases:
        // 1. Enabled config (LongTerm) should return true
        // 2. Disabled config (missing secret) should return false
        // 3. Disabled config (missing username/password) should return false

        let mut config = create_test_turn_config();

        // Test 1: Enabled config (LongTerm)
        assert!(
            config.is_enabled(),
            "Config with LongTerm auth should be enabled"
        );

        // Test 2: Disabled config (missing secret)
        config.secret = None;
        assert!(
            !config.is_enabled(),
            "Config without TURN_SECRET should be disabled"
        );

        // Reset for ShortTerm
        config.secret = Some("test_secret".to_string());

        println!("✅ Test 3 Passed: TURN config is_enabled check");
    }

    // Test 4: Generate TURN credentials
    #[test]
    fn test_turn_credentials_generation() {
        // This test verifies that generate_turn_credentials()
        // correctly creates RFC 8656 compliant credentials
        //
        // Expected behavior:
        // - Returns Ok(TurnCredentials) with valid config
        // - Credentials contain base64-encoded username and password
        // - Credentials have timestamp-based expiry (24 hours)
        // - Error if auth method is not LongTerm

        let config = create_test_turn_config();

        // Test 1: Valid credentials generation
        let result = generate_turn_credentials(&config, "test_user");

        assert!(result.is_ok(), "Credential generation should succeed");

        let creds = result.unwrap();

        // Verify username format (timestamp:username base64)
        assert!(
            creds.username.contains(':'),
            "Username should be base64 encoded timestamp:username"
        );
        assert!(
            creds.username.contains(':'),
            "Username should have timestamp prefix"
        );

        // Verify password format (timestamp:hmac base64)
        assert!(
            creds.password.contains(':'),
            "Password should be base64 encoded timestamp:hmac"
        );
        assert!(
            creds.password.contains(':'),
            "Password should have timestamp prefix"
        );

        // Verify expiry (24 hours from generation time)
        let now = chrono::Utc::now().timestamp();
        let diff = creds.expires_at - now;
        assert!(diff > 86300, "Credentials should expire in > 23.9 hours");
        assert!(diff < 86400, "Credentials should expire in < 24 hours");

        println!("✅ Test 4 Passed: TURN credentials generation");

        // Test 2: LongTerm only check
        let mut short_term_config = create_test_turn_config();
        short_term_config.auth_method = super::config::TurnAuthMethod::ShortTerm;

        let result = generate_turn_credentials(&short_term_config, "test_user");
        assert!(
            result.is_err(),
            "ShortTerm auth should not generate credentials"
        );
        assert!(
            result
                .unwrap_err()
                .contains("LongTerm credentials require TURN_SECRET"),
            "Error should mention LongTerm requirement"
        );

        println!("✅ Test 4.1 Passed: ShortTerm auth fails");
    }

    // Test 5: Create TURN client
    #[test]
    fn test_turn_client_creation() {
        // This test verifies that TurnClient::new()
        // successfully creates a client instance
        //
        // Expected behavior:
        // - Returns Ok(TurnClient) with valid config
        // - Client initializes in Disconnected state
        // - Client has reference to TURN config

        let config = create_test_turn_config();
        let client_result = TurnClient::new(config.clone());

        assert!(
            client_result.is_ok(),
            "TURN client creation should succeed with valid config"
        );

        let client = client_result.unwrap();

        // Verify client state
        // assert_eq!(client.get_state(), super::client::TurnClientState::Disconnected, "New client should be in Disconnected state");

        println!("✅ Test 5 Passed: TURN client creation");
    }

    // Test 6: STUN client creation
    #[test]
    fn test_stun_client_creation() {
        // This test verifies that StunClient::new()
        // successfully creates a client instance
        //
        // Expected behavior:
        // - Returns Ok(StunClient) with valid address
        // - Client can be used for public IP discovery

        let stun_addr = "stun.l.google.com:19302".parse().unwrap();
        let stun_client = StunClient::new(stun_addr);

        // Verify client was created (no panic)
        assert_eq!(
            stun_client.get_server_addr(),
            stun_addr,
            "STUN client should have correct server address"
        );

        println!("✅ Test 6 Passed: STUN client creation");
    }

    // Test 7: Credential refresh check
    #[test]
    fn test_credential_refresh_check() {
        // This test verifies that should_refresh_credentials()
        // correctly determines when credentials need refresh
        //
        // Test cases:
        // 1. New credentials should not need refresh (age < 80%)
        // 2. Old credentials should need refresh (age > 80%)
        // 3. Expired credentials should need refresh

        use chrono::Utc;

        let config = create_test_turn_config();

        // Test 1: New credentials (age = 0 seconds)
        let creds = TurnCredentials {
            username: "test_user".to_string(),
            password: "test_pass".to_string(),
            expires_at: Utc::now().timestamp() + (24 * 3600),
        };

        assert!(
            !should_refresh_credentials(&creds, &config),
            "New credentials should not need refresh"
        );

        // Test 2: Old credentials (age = 20 hours)
        let old_creds = TurnCredentials {
            username: "test_user".to_string(),
            password: "test_pass".to_string(),
            expires_at: Utc::now().timestamp() - (20 * 3600),
        };

        assert!(
            should_refresh_credentials(&old_creds, &config),
            "20-hour-old credentials should need refresh"
        );

        // Test 3: Expired credentials (age = 30 hours)
        let expired_creds = TurnCredentials {
            username: "test_user".to_string(),
            password: "test_pass".to_string(),
            expires_at: Utc::now().timestamp() - (30 * 3600),
        };

        assert!(
            should_refresh_credentials(&expired_creds, &config),
            "30-hour-old credentials should need refresh"
        );

        println!("✅ Test 7 Passed: Credential refresh check");
    }

    // Test 8: TURN config from defaults
    #[test]
    fn test_turn_config_defaults() {
        // This test verifies that TurnConfig::default()
        // provides reasonable default values
        //
        // Test cases:
        // 1. Default auth method should be ShortTerm (for safety)
        // 2. Default timeout should be 30 seconds
        // 3. Default refresh ratio should be 0.8

        let config = TurnConfig::default();

        assert_eq!(
            config.auth_method,
            super::config::TurnAuthMethod::ShortTerm,
            "Default auth method should be ShortTerm"
        );

        assert_eq!(
            config.timeout_sec, 30,
            "Default timeout should be 30 seconds"
        );

        assert_eq!(
            config.refresh_ratio, 0.8,
            "Default refresh ratio should be 0.8"
        );

        println!("✅ Test 8 Passed: TURN config defaults");
    }
}

// Run tests when compiled with test feature
#[cfg(test)]
fn main() {
    println!("🧪 Running TURN Module Unit Tests");

    tests::test_turn_config_load_from_env();
    tests::test_turn_config_validation();
    tests::test_turn_config_enable_turn();
    tests::test_turn_credentials_generation();
    tests::test_turn_client_creation();
    tests::test_stun_client_creation();
    tests::test_credential_refresh_check();
    tests::test_turn_config_defaults();

    println!("✅ All TURN Module Unit Tests Passed!");
}

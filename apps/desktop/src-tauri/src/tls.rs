//! TLS trust for self-hosted servers (ADR-0004).
//!
//! The webview's own fetch hard-fails on self-signed certificates, so every
//! API request tunnels through Rust. Two custom rustls verifiers implement
//! the TOFU model:
//!
//! - [`CapturingVerifier`] (probe only): accepts any certificate but records
//!   the end-entity DER so the UI can show its SHA-256 fingerprint for the
//!   user to confirm. Nothing sensitive is sent on probe requests.
//! - [`PinnedVerifier`] (all API traffic): accepts exactly the pinned
//!   fingerprint — anything else is a hard failure, never a silent bypass.
//!
//! When the server's certificate validates against the OS trust store
//! (reverse proxy with a real cert, Tailscale HTTPS), normal validation is
//! used and pinning is skipped.

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::{DigitallySignedStruct, Error as TlsError, SignatureScheme};
use rustls_pki_types::{CertificateDer, ServerName, UnixTime};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

pub fn fingerprint_hex(cert_der: &[u8]) -> String {
    hex::encode(Sha256::digest(cert_der))
}

fn supported_schemes() -> Vec<SignatureScheme> {
    vec![
        SignatureScheme::RSA_PKCS1_SHA256,
        SignatureScheme::RSA_PKCS1_SHA384,
        SignatureScheme::RSA_PKCS1_SHA512,
        SignatureScheme::RSA_PSS_SHA256,
        SignatureScheme::RSA_PSS_SHA384,
        SignatureScheme::RSA_PSS_SHA512,
        SignatureScheme::ECDSA_NISTP256_SHA256,
        SignatureScheme::ECDSA_NISTP384_SHA384,
        SignatureScheme::ED25519,
    ]
}

/// Records the server certificate during the TOFU probe.
#[derive(Debug)]
pub struct CapturingVerifier {
    pub seen_cert: Arc<Mutex<Option<Vec<u8>>>>,
}

impl ServerCertVerifier for CapturingVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        *self.seen_cert.lock().unwrap() = Some(end_entity.as_ref().to_vec());
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        supported_schemes()
    }
}

/// Accepts exactly one certificate: the pinned fingerprint.
#[derive(Debug)]
pub struct PinnedVerifier {
    pub pinned_fingerprint: String,
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        if fingerprint_hex(end_entity.as_ref()) == self.pinned_fingerprint.to_lowercase() {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(TlsError::General(
                "server certificate does not match the pinned fingerprint".into(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        supported_schemes()
    }
}

pub fn client_with_verifier(
    verifier: Arc<dyn ServerCertVerifier>,
) -> Result<reqwest::Client, reqwest::Error> {
    let tls = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .timeout(std::time::Duration::from_secs(30))
        .build()
}

/// Standard client: OS/native root validation, no pinning.
pub fn os_trust_client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
}

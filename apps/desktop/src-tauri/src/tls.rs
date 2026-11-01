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
//! Both verifiers check the handshake signature with rustls' own algorithms:
//! the certificate is public (it's sent in every handshake), so a fingerprint
//! match alone proves nothing — only the signature proves the peer holds the
//! certificate's private key.
//!
//! When the server's certificate validates against the OS trust store
//! (reverse proxy with a real cert, Tailscale HTTPS), normal validation is
//! used and pinning is skipped.

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{self, CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::{DigitallySignedStruct, Error as TlsError, SignatureScheme};
use rustls_pki_types::{CertificateDer, ServerName, UnixTime};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

pub fn fingerprint_hex(cert_der: &[u8]) -> String {
    hex::encode(Sha256::digest(cert_der))
}

fn provider() -> CryptoProvider {
    crypto::ring::default_provider()
}

fn signature_algorithms() -> WebPkiSupportedAlgorithms {
    provider().signature_verification_algorithms
}

fn verify_tls12(
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
) -> Result<HandshakeSignatureValid, TlsError> {
    crypto::verify_tls12_signature(message, cert, dss, &signature_algorithms())
}

fn verify_tls13(
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
) -> Result<HandshakeSignatureValid, TlsError> {
    crypto::verify_tls13_signature(message, cert, dss, &signature_algorithms())
}

fn supported_schemes() -> Vec<SignatureScheme> {
    signature_algorithms().supported_schemes()
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
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls12(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls13(message, cert, dss)
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
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls12(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls13(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        supported_schemes()
    }
}

fn config_with_verifier(verifier: Arc<dyn ServerCertVerifier>) -> rustls::ClientConfig {
    rustls::ClientConfig::builder_with_provider(Arc::new(provider()))
        .with_safe_default_protocol_versions()
        .expect("ring provider supports the default protocol versions")
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth()
}

pub fn client_with_verifier(
    verifier: Arc<dyn ServerCertVerifier>,
) -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .use_preconfigured_tls(config_with_verifier(verifier))
        .timeout(std::time::Duration::from_secs(30))
        .build()
}

/// Standard client: OS/native root validation, no pinning.
pub fn os_trust_client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::server::{ClientHello, ResolvesServerCert};
    use rustls::sign::CertifiedKey;
    use rustls::{ClientConnection, ServerConnection};
    use rustls_pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};

    // Throwaway P-256 material generated for these tests only.
    const SERVER_CERT: &[u8] = include_bytes!("testdata/server-cert.der");
    const SERVER_KEY: &[u8] = include_bytes!("testdata/server-key.pk8.der");
    const ATTACKER_KEY: &[u8] = include_bytes!("testdata/attacker-key.pk8.der");

    /// Serves the given cert with the given key, without checking they match —
    /// exactly what a MITM replaying the real server's public cert does.
    #[derive(Debug)]
    struct FixedCert(Arc<CertifiedKey>);

    impl ResolvesServerCert for FixedCert {
        fn resolve(&self, _hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
            Some(self.0.clone())
        }
    }

    fn server(key: &[u8]) -> ServerConnection {
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.to_vec()));
        let signer = crypto::ring::sign::any_supported_type(&key).unwrap();
        let certified = CertifiedKey::new(vec![CertificateDer::from(SERVER_CERT.to_vec())], signer);
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_cert_resolver(Arc::new(FixedCert(Arc::new(certified))));
        ServerConnection::new(Arc::new(config)).unwrap()
    }

    fn client(version: &'static rustls::SupportedProtocolVersion) -> ClientConnection {
        let pinned = PinnedVerifier { pinned_fingerprint: fingerprint_hex(SERVER_CERT) };
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(provider()))
            .with_protocol_versions(&[version])
            .unwrap()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(pinned))
            .with_no_client_auth();
        ClientConnection::new(Arc::new(config), ServerName::try_from("vault.local").unwrap()).unwrap()
    }

    /// Pumps an in-memory handshake; returns the client's error, if any.
    fn handshake(mut c: ClientConnection, mut s: ServerConnection) -> Result<(), TlsError> {
        for _ in 0..10 {
            let mut buf = Vec::new();
            while c.wants_write() {
                c.write_tls(&mut buf).unwrap();
            }
            let mut rd = &buf[..];
            while !rd.is_empty() {
                s.read_tls(&mut rd).unwrap();
            }
            // A server-side failure surfaces to the client as an alert.
            let _ = s.process_new_packets();

            let mut buf = Vec::new();
            while s.wants_write() {
                s.write_tls(&mut buf).unwrap();
            }
            let mut rd = &buf[..];
            while !rd.is_empty() {
                c.read_tls(&mut rd).unwrap();
            }
            c.process_new_packets()?;

            if !c.is_handshaking() && !s.is_handshaking() {
                return Ok(());
            }
        }
        panic!("handshake did not finish");
    }

    #[test]
    fn pinned_cert_with_its_own_key_connects() {
        handshake(client(&rustls::version::TLS13), server(SERVER_KEY)).unwrap();
        handshake(client(&rustls::version::TLS12), server(SERVER_KEY)).unwrap();
    }

    #[test]
    fn pinned_cert_replayed_with_another_key_is_rejected() {
        for version in [&rustls::version::TLS13, &rustls::version::TLS12] {
            let err = handshake(client(version), server(ATTACKER_KEY)).unwrap_err();
            assert!(
                matches!(err, TlsError::InvalidCertificate(_) | TlsError::PeerMisbehaved(_)),
                "unexpected error: {err:?}"
            );
        }
    }

    #[test]
    fn other_cert_is_rejected() {
        let pinned = PinnedVerifier { pinned_fingerprint: "00".repeat(32) };
        let cert = CertificateDer::from(SERVER_CERT.to_vec());
        let name = ServerName::try_from("vault.local").unwrap();
        assert!(pinned.verify_server_cert(&cert, &[], &name, &[], UnixTime::now()).is_err());
    }
}

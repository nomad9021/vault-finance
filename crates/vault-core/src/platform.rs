//! What the host reports that the shell's pure logic needs: server probes
//! and Tailscale status (apps/desktop/src/platform/types.ts), and the
//! private-network choice (apps/desktop/src/lib/privateNetwork.ts).

use serde::{Deserialize, Serialize};

/// `HostPlatform.kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostKind {
    Tauri,
    Browser,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub reachable: bool,
    /// SHA-256 of the server's TLS certificate (DER), hex.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    /// Normal TLS validation succeeded (pinning skipped, ADR-0004).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trusted_by_os: Option<bool>,
    /// Transport error chain when unreachable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// HTTP status when something answered, but not like a Vault server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
}

impl ProbeResult {
    pub fn trusted_by_os(&self) -> bool {
        self.trusted_by_os == Some(true)
    }
    /// The fingerprint when it's non-empty (JS truthiness).
    pub fn fingerprint(&self) -> Option<&str> {
        self.fingerprint.as_deref().filter(|f| !f.is_empty())
    }
}

/// This computer's Tailscale, as its CLI reports it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleStatus {
    pub installed: bool,
    /// Running | Stopped | NeedsLogin | NeedsMachineAuth | Starting | NoState | DaemonDown | NotInstalled | Unknown
    pub state: String,
    pub ips: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dns_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_url: Option<String>,
    pub health: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// How this computer reaches the server away from home.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrivateNetworkId {
    #[default]
    Tailscale,
    Headscale,
    Netbird,
    Twingate,
    Zerotier,
    Wireguard,
    Other,
    None,
}

impl PrivateNetworkId {
    pub const ALL: [PrivateNetworkId; 8] = [
        Self::Tailscale,
        Self::Headscale,
        Self::Netbird,
        Self::Twingate,
        Self::Zerotier,
        Self::Wireguard,
        Self::Other,
        Self::None,
    ];

    /// The localStorage key the choice is saved under.
    pub const STORAGE_KEY: &'static str = "private-network";

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tailscale => "tailscale",
            Self::Headscale => "headscale",
            Self::Netbird => "netbird",
            Self::Twingate => "twingate",
            Self::Zerotier => "zerotier",
            Self::Wireguard => "wireguard",
            Self::Other => "other",
            Self::None => "none",
        }
    }
    /// `getPrivateNetwork` over the saved value: Tailscale unless a known id.
    pub fn from_saved(saved: Option<&str>) -> Self {
        Self::ALL
            .into_iter()
            .find(|n| Some(n.as_str()) == saved)
            .unwrap_or_default()
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Tailscale => "Tailscale",
            Self::Headscale => "Headscale",
            Self::Netbird => "NetBird",
            Self::Twingate => "Twingate",
            Self::Zerotier => "ZeroTier",
            Self::Wireguard => "WireGuard",
            Self::Other => "Another VPN",
            Self::None => "None, only on my home network",
        }
    }
    /// Where to get its client (https only).
    pub fn url(self) -> Option<&'static str> {
        match self {
            Self::Tailscale => Some("https://tailscale.com/download"),
            Self::Headscale => Some("https://headscale.net"),
            Self::Netbird => Some("https://netbird.io"),
            Self::Twingate => Some("https://www.twingate.com/download"),
            Self::Zerotier => Some("https://www.zerotier.com/download/"),
            Self::Wireguard => Some("https://www.wireguard.com/install/"),
            Self::Other | Self::None => None,
        }
    }
    /// The app can read and switch this one through the Tailscale client.
    pub fn uses_tailscale_client(self) -> bool {
        matches!(self, Self::Tailscale | Self::Headscale)
    }
    /// How to name it in a sentence, or `None` with no private network.
    pub fn network_name(self) -> Option<&'static str> {
        match self {
            Self::None => None,
            Self::Other => Some("your VPN"),
            n => Some(n.label()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_host_reports() {
        let p: ProbeResult = serde_json::from_str(
            r#"{"reachable":true,"fingerprint":"9f86d081884c7d65","trustedByOs":false}"#,
        )
        .unwrap();
        assert_eq!(p.fingerprint(), Some("9f86d081884c7d65"));
        assert!(!p.trusted_by_os());
        let t: TailscaleStatus = serde_json::from_str(
            r#"{"installed":true,"state":"Running","ips":["100.70.1.2","fd7a:115c:a1e0::1"],
                "dnsName":"pats-macbook.tail1234.ts.net.","health":[]}"#,
        )
        .unwrap();
        assert_eq!(t.ips.len(), 2);
        assert_eq!(
            PrivateNetworkId::from_saved(Some("netbird")),
            PrivateNetworkId::Netbird
        );
        assert_eq!(
            PrivateNetworkId::from_saved(None),
            PrivateNetworkId::Tailscale
        );
        assert_eq!(PrivateNetworkId::Other.network_name(), Some("your VPN"));
        assert_eq!(PrivateNetworkId::None.network_name(), None);
        assert!(PrivateNetworkId::Headscale.uses_tailscale_client());
    }
}

//! Mirrors packages/shared/src/downloads.ts: where people get the desktop
//! app, and the invite message that carries everything a new member needs.

pub const RELEASES_PAGE_URL: &str = "https://github.com/nomad9021/vault-finance/releases/latest";

const DOWNLOAD_BASE: &str = "https://github.com/nomad9021/vault-finance/releases/download";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppDownload {
    pub label: &'static str,
    pub url: String,
}

/// Installers for one version; the app and server share a version number.
pub fn app_downloads(version: &str) -> Vec<AppDownload> {
    let file =
        |suffix: &str| format!("{DOWNLOAD_BASE}/v{version}/Vault.Finance_{version}_{suffix}");
    vec![
        AppDownload {
            label: "Mac (Apple chip)",
            url: file("aarch64.dmg"),
        },
        AppDownload {
            label: "Mac (Intel)",
            url: file("x64.dmg"),
        },
        AppDownload {
            label: "Windows",
            url: file("x64-setup.exe"),
        },
        AppDownload {
            label: "Linux",
            url: file("amd64.AppImage"),
        },
    ]
}

/// A message to paste into a text or chat: install the app, open the
/// invite link to set a password, then sign in at the server's address.
pub fn invite_message(
    inviter_name: &str,
    invite_url: &str,
    server_address: &str,
    version: &str,
) -> String {
    let downloads = app_downloads(version)
        .iter()
        .map(|d| format!("   {}: {}", d.label, d.url))
        .collect::<Vec<_>>()
        .join("\n");
    [
        format!("{inviter_name} invited you to Vault Finance."),
        String::new(),
        "1. Install the app for your computer:".into(),
        downloads,
        format!("   (All downloads: {RELEASES_PAGE_URL})"),
        String::new(),
        "   On a Mac: Apple menu > About This Mac shows \"Chip: Apple M...\" for Apple chip; otherwise pick Intel.".into(),
        "   Open the downloaded file and drag Vault Finance into Applications. The first time you open it,".into(),
        "   your Mac will say it can't check the app. Click Done, then open System Settings > Privacy & Security,".into(),
        "   scroll down, click Open Anyway next to Vault Finance, and confirm. After that it opens normally.".into(),
        String::new(),
        "2. Open this link to choose your password. It works once and lasts 7 days:".into(),
        format!("   {invite_url}"),
        String::new(),
        format!("3. Open Vault Finance, connect to {server_address}, and sign in."),
        String::new(),
        "You need to be on our home Wi-Fi or VPN for the link and the app to reach the server. Your browser and the app may warn about the server's certificate the first time; that's expected.".into(),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    // packages/shared/src/downloads.test.ts
    #[test]
    fn links_each_computer_to_that_versions_installer() {
        let base = "https://github.com/nomad9021/vault-finance/releases/download/v0.1.18";
        assert_eq!(
            app_downloads("0.1.18"),
            vec![
                AppDownload {
                    label: "Mac (Apple chip)",
                    url: format!("{base}/Vault.Finance_0.1.18_aarch64.dmg")
                },
                AppDownload {
                    label: "Mac (Intel)",
                    url: format!("{base}/Vault.Finance_0.1.18_x64.dmg")
                },
                AppDownload {
                    label: "Windows",
                    url: format!("{base}/Vault.Finance_0.1.18_x64-setup.exe")
                },
                AppDownload {
                    label: "Linux",
                    url: format!("{base}/Vault.Finance_0.1.18_amd64.AppImage")
                },
            ]
        );
    }

    #[test]
    fn has_the_downloads_the_invite_link_and_where_to_connect() {
        let text = invite_message(
            "Pat",
            "https://192.168.1.122:8443/invite?token=a.b",
            "https://192.168.1.122:8443",
            "0.1.19",
        );
        for needle in [
            "Pat invited you to Vault Finance.",
            "Windows: https://github.com/nomad9021/vault-finance/releases/download/v0.1.19/",
            "Linux: ",
            "Mac (Intel): ",
            "click Open Anyway next to Vault Finance",
            "https://192.168.1.122:8443/invite?token=a.b",
            "connect to https://192.168.1.122:8443",
        ] {
            assert!(text.contains(needle), "{needle}");
        }
    }
}

//! The pure parts of apps/desktop/src/lib/serverRoute.ts: one server, up to
//! two addresses (home and VPN). The first stays the server's identity;
//! only the transport moves. Probing and fetching are async in the shell;
//! the decisions they make are here.

use crate::platform::{HostKind, ProbeResult};
use crate::url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerRoute {
    pub primary: String,
    pub alternate: Option<String>,
    /// The address requests go to right now.
    pub active: String,
}

/// The saved-setting key for a server's second address.
pub fn alternate_address_key(primary: &str) -> String {
    format!("alternate-address:{primary}")
}

pub fn new_route(primary: &str, alternate: Option<&str>) -> ServerRoute {
    ServerRoute {
        primary: primary.into(),
        alternate: alternate.map(Into::into),
        active: primary.into(),
    }
}

/// Send a request built for the primary address to the active one.
pub fn rewrite_url(route: &ServerRoute, url: &str) -> String {
    match url.strip_prefix(route.primary.as_str()) {
        Some(rest) => format!("{}{rest}", route.active),
        None => url.to_string(),
    }
}

/// The address `pickAddress` settles on, with the probe that describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Picked {
    pub address: String,
    pub probe: ProbeResult,
}

/// `pickAddress`: both addresses are probed together and the first that
/// answers wins. `arrivals` are the probes in the order they came back;
/// when none is reachable, the primary's probe is reported.
pub fn pick_address(
    primary: &str,
    alternate: Option<&str>,
    arrivals: &[(&str, ProbeResult)],
) -> Picked {
    let primary_probe = || {
        arrivals
            .iter()
            .find(|(a, _)| *a == primary)
            .map(|(_, p)| p.clone())
            .unwrap_or_default()
    };
    if alternate.is_none_or(str::is_empty) {
        return Picked {
            address: primary.into(),
            probe: primary_probe(),
        };
    }
    arrivals
        .iter()
        .find(|(a, p)| p.reachable && (*a == primary || Some(*a) == alternate))
        .map(|(a, p)| Picked {
            address: (*a).into(),
            probe: p.clone(),
        })
        .unwrap_or_else(|| Picked {
            address: primary.into(),
            probe: primary_probe(),
        })
}

/// `makeReselect`'s update once the probes are in: only a reachable address moves the route.
pub fn apply_pick(route: &mut ServerRoute, picked: &Picked) {
    if picked.probe.reachable {
        route.active = picked.address.clone();
    }
}

/// `routedFetch` after a request to `tried` failed and the route was
/// probed again: retry only reads, and only when the address changed.
/// A write may already have reached the server, so it's reported.
pub fn should_retry(route: &ServerRoute, tried: &str, method: &str) -> bool {
    route.alternate.is_some() && route.active != tried && (method == "GET" || method == "HEAD")
}

/// Whether a failed request should look for the other address at all.
pub fn should_reselect(route: &ServerRoute) -> bool {
    route.alternate.is_some()
}

/// A link someone else can open. A relative one is built on the address
/// this app reached the server at, unless that only works on this computer.
pub fn shareable_invite_link(link: &str, address: Option<&str>) -> Option<String> {
    if link.starts_with("http") {
        return Some(link.into());
    }
    let base = Url::parse(address?)?;
    let h = base.hostname.as_str();
    let local =
        h == "localhost" || h.ends_with(".localhost") || h == "[::1]" || h.starts_with("127.");
    if local {
        None
    } else {
        base.join(link)
    }
}

/// A plain http:// address has no certificate to check.
pub fn downgrades_transport(primary: &str, alternate: &str) -> bool {
    primary.starts_with("https://") && !alternate.starts_with("https://")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AlternateTrust {
    /// Valid for the OS, or no pinning on this platform: nothing to store.
    Os,
    /// Same certificate as the server we already trust: pin it.
    Same { fingerprint: String },
    /// No pin to compare with, so the person must confirm it.
    Confirm { fingerprint: String },
    /// A different certificate from the server we trust.
    Mismatch,
}

pub fn alternate_trust(
    kind: HostKind,
    primary_pin: Option<&str>,
    probe: &ProbeResult,
) -> AlternateTrust {
    let Some(fp) = probe
        .fingerprint()
        .filter(|_| kind == HostKind::Tauri && !probe.trusted_by_os())
    else {
        return AlternateTrust::Os;
    };
    match primary_pin.filter(|p| !p.is_empty()) {
        None => AlternateTrust::Confirm {
            fingerprint: fp.into(),
        },
        Some(pin) if pin.to_lowercase() == fp.to_lowercase() => AlternateTrust::Same {
            fingerprint: fp.into(),
        },
        Some(_) => AlternateTrust::Mismatch,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // apps/desktop/src/lib/serverRoute.test.ts
    const HOME: &str = "https://192.168.1.10:8443";
    const VPN: &str = "https://100.70.0.1:8443";

    fn ok() -> ProbeResult {
        ProbeResult {
            reachable: true,
            ..Default::default()
        }
    }
    fn down() -> ProbeResult {
        ProbeResult {
            reachable: false,
            error: Some("operation timed out".into()),
            ..Default::default()
        }
    }

    #[test]
    fn rewrite_url_moves_a_request_and_keeps_the_path() {
        let route = ServerRoute {
            active: VPN.into(),
            ..new_route(HOME, Some(VPN))
        };
        assert_eq!(
            rewrite_url(&route, &format!("{HOME}/api/v1/members?x=1")),
            format!("{VPN}/api/v1/members?x=1")
        );
        assert_eq!(
            rewrite_url(&route, "https://other.example/api"),
            "https://other.example/api"
        );
        assert_eq!(
            alternate_address_key(HOME),
            "alternate-address:https://192.168.1.10:8443"
        );
    }

    #[test]
    fn pick_address_uses_whichever_answers() {
        assert_eq!(
            pick_address(HOME, Some(VPN), &[(HOME, down()), (VPN, ok())]).address,
            VPN
        );
        assert_eq!(
            pick_address(HOME, Some(VPN), &[(HOME, ok()), (VPN, down())]).address,
            HOME
        );
        assert_eq!(
            pick_address(HOME, Some(VPN), &[(VPN, down()), (HOME, ok())]).address,
            HOME
        );
    }

    #[test]
    fn pick_address_doesnt_wait_for_a_slow_address() {
        // The VPN probe never came back: the home answer alone decides.
        assert_eq!(pick_address(HOME, Some(VPN), &[(HOME, ok())]).address, HOME);
    }

    #[test]
    fn pick_address_reports_the_first_address_when_neither_answers() {
        assert_eq!(
            pick_address(HOME, Some(VPN), &[(VPN, down()), (HOME, down())]),
            Picked {
                address: HOME.into(),
                probe: down()
            }
        );
    }

    #[test]
    fn pick_address_works_with_one_address() {
        assert_eq!(pick_address(HOME, None, &[(HOME, ok())]).address, HOME);
    }

    /// `routedFetch` with a fetch that fails for HOME, driven synchronously.
    fn fetch(
        route: &mut ServerRoute,
        answers: &[(&str, ProbeResult)],
        url: &str,
        method: &str,
        calls: &mut Vec<String>,
    ) -> Result<u16, &'static str> {
        let send = |u: String, calls: &mut Vec<String>| {
            calls.push(u.clone());
            if u.starts_with(HOME) {
                Err("connection failed")
            } else {
                Ok(200)
            }
        };
        let tried = route.active.clone();
        match send(rewrite_url(route, url), calls) {
            Ok(s) => Ok(s),
            Err(e) => {
                if !should_reselect(route) {
                    return Err(e);
                }
                let picked = pick_address(
                    &route.primary.clone(),
                    route.alternate.clone().as_deref(),
                    answers,
                );
                apply_pick(route, &picked);
                if !should_retry(route, &tried, method) {
                    return Err(e);
                }
                send(rewrite_url(route, url), calls)
            }
        }
    }

    #[test]
    fn retries_a_read_on_the_address_that_answers_and_stays_there() {
        let answers = [(HOME, down()), (VPN, ok())];
        let mut route = new_route(HOME, Some(VPN));
        let mut calls = vec![];
        assert_eq!(
            fetch(
                &mut route,
                &answers,
                &format!("{HOME}/api/v1/x"),
                "GET",
                &mut calls
            ),
            Ok(200)
        );
        assert_eq!(
            calls,
            [format!("{HOME}/api/v1/x"), format!("{VPN}/api/v1/x")]
        );
        assert_eq!(route.active, VPN);
        fetch(
            &mut route,
            &answers,
            &format!("{HOME}/api/v1/y"),
            "GET",
            &mut calls,
        )
        .unwrap();
        assert_eq!(calls.last().unwrap(), &format!("{VPN}/api/v1/y"));
    }

    #[test]
    fn never_repeats_a_write_but_moves_for_the_next_one() {
        let mut route = new_route(HOME, Some(VPN));
        let mut calls = vec![];
        let r = fetch(
            &mut route,
            &[(HOME, down()), (VPN, ok())],
            &format!("{HOME}/api/v1/x"),
            "POST",
            &mut calls,
        );
        assert_eq!(r, Err("connection failed"));
        assert_eq!(calls.len(), 1);
        assert_eq!(route.active, VPN);
    }

    #[test]
    fn reports_the_failure_when_neither_address_answers() {
        let mut route = new_route(HOME, Some(VPN));
        let r = fetch(
            &mut route,
            &[(HOME, down()), (VPN, down())],
            &format!("{HOME}/api/v1/x"),
            "GET",
            &mut vec![],
        );
        assert_eq!(r, Err("connection failed"));
        assert_eq!(route.active, HOME);
    }

    #[test]
    fn behaves_as_before_with_one_address() {
        let mut route = new_route(HOME, None);
        let mut calls = vec![];
        let r = fetch(
            &mut route,
            &[(HOME, down())],
            &format!("{HOME}/api/v1/x"),
            "GET",
            &mut calls,
        );
        assert_eq!(r, Err("connection failed"));
        assert_eq!(calls.len(), 1);
    }

    #[test]
    fn shareable_invite_links() {
        assert_eq!(
            shareable_invite_link("https://vault.example/invite?token=a.b", Some(HOME)).as_deref(),
            Some("https://vault.example/invite?token=a.b")
        );
        assert_eq!(
            shareable_invite_link("/invite?token=a.b", Some(HOME)),
            Some(format!("{HOME}/invite?token=a.b"))
        );
        assert_eq!(
            shareable_invite_link("/invite?token=a.b", Some("https://localhost:8443")),
            None
        );
        assert_eq!(
            shareable_invite_link("/invite?token=a.b", Some("http://127.0.0.1:8444")),
            None
        );
        assert_eq!(shareable_invite_link("/invite?token=a.b", None), None);
    }

    #[test]
    fn downgrades_transport_refuses_plain_http_for_an_https_server() {
        assert!(downgrades_transport(HOME, "http://100.70.0.1:8080"));
        assert!(!downgrades_transport(HOME, VPN));
        assert!(!downgrades_transport(
            "http://127.0.0.1:8444",
            "http://localhost:8444"
        ));
    }

    #[test]
    fn alternate_trust_cases() {
        let probe = |fp: &str| ProbeResult {
            reachable: true,
            fingerprint: Some(fp.into()),
            ..Default::default()
        };
        assert_eq!(
            alternate_trust(HostKind::Tauri, Some("AB"), &probe("ab")),
            AlternateTrust::Same {
                fingerprint: "ab".into()
            }
        );
        assert_eq!(
            alternate_trust(HostKind::Tauri, Some("ab"), &probe("cd")),
            AlternateTrust::Mismatch
        );
        assert_eq!(
            alternate_trust(HostKind::Tauri, None, &probe("cd")),
            AlternateTrust::Confirm {
                fingerprint: "cd".into()
            }
        );
        assert_eq!(
            alternate_trust(
                HostKind::Tauri,
                Some("ab"),
                &ProbeResult {
                    reachable: true,
                    trusted_by_os: Some(true),
                    ..Default::default()
                }
            ),
            AlternateTrust::Os
        );
        assert_eq!(
            alternate_trust(HostKind::Browser, Some("ab"), &probe("cd")),
            AlternateTrust::Os
        );
    }
}

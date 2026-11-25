//! Just enough of the WHATWG `URL` for server addresses: scheme, hostname,
//! port, origin, and resolving a link against an address.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Url {
    /// Lowercase, without ":".
    pub scheme: String,
    /// `URL.hostname`: lowercase, IPv6 kept in brackets. Empty for
    /// non-special schemes.
    pub hostname: String,
    /// `URL.port`: `None` when absent or the scheme's default.
    pub port: Option<u16>,
    /// Path, query and fragment (starts with "/" for http/https).
    pub rest: String,
    special: bool,
}

fn default_port(scheme: &str) -> Option<u16> {
    match scheme {
        "http" | "ws" => Some(80),
        "https" | "wss" => Some(443),
        "ftp" => Some(21),
        _ => None,
    }
}

impl Url {
    /// `new URL(s)`, or `None` where it would throw.
    pub fn parse(s: &str) -> Option<Url> {
        let s = s.trim_matches(|c: char| c <= ' ');
        let colon = s.find(':')?;
        let scheme = &s[..colon];
        let mut chars = scheme.chars();
        if !chars.next()?.is_ascii_alphabetic()
            || !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        {
            return None;
        }
        let scheme = scheme.to_ascii_lowercase();
        let after = &s[colon + 1..];
        let special = default_port(&scheme).is_some() || scheme == "file";
        if !special {
            return Some(Url {
                scheme,
                hostname: String::new(),
                port: None,
                rest: after.into(),
                special,
            });
        }
        let body = after.trim_start_matches(['/', '\\']);
        let end = body.find(['/', '?', '#', '\\']).unwrap_or(body.len());
        let (authority, rest) = body.split_at(end);
        let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        let (host, port) = if host_port.starts_with('[') {
            let close = host_port.find(']')?;
            let tail = &host_port[close + 1..];
            let port = match tail {
                "" => None,
                t => Some(t.strip_prefix(':')?),
            };
            (&host_port[..=close], port)
        } else {
            match host_port.split_once(':') {
                Some((h, p)) => (h, Some(p)),
                None => (host_port, None),
            }
        };
        if host.is_empty() && scheme != "file" {
            return None;
        }
        let port = match port {
            None | Some("") => None,
            Some(p) if p.bytes().all(|b| b.is_ascii_digit()) => {
                let n: u32 = p.trim_start_matches('0').parse().unwrap_or(0);
                let n = u16::try_from(n).ok()?;
                (Some(n) != default_port(&scheme)).then_some(n)
            }
            Some(_) => return None,
        };
        let rest = rest.replace('\\', "/");
        let rest = if rest.starts_with('/') {
            rest
        } else {
            format!("/{rest}")
        };
        Some(Url {
            scheme,
            hostname: host.to_lowercase(),
            port,
            rest,
            special,
        })
    }

    /// `URL.origin` for http(s): `scheme://host[:port]`.
    pub fn origin(&self) -> String {
        match self.port {
            Some(p) => format!("{}://{}:{p}", self.scheme, self.hostname),
            None => format!("{}://{}", self.scheme, self.hostname),
        }
    }

    /// `new URL(link, self).toString()` for the links a server hands back.
    pub fn join(&self, link: &str) -> Option<String> {
        if let Some(abs) = Url::parse(link).filter(|u| u.special) {
            return Some(abs.to_string());
        }
        if !self.special {
            return None;
        }
        Some(if link.starts_with("//") {
            Url::parse(&format!("{}:{link}", self.scheme))?.to_string()
        } else if link.starts_with('/') {
            format!("{}{link}", self.origin())
        } else {
            let path_end = self.rest.find(['?', '#']).unwrap_or(self.rest.len());
            let path = &self.rest[..path_end];
            if link.starts_with('?') {
                format!("{}{path}{link}", self.origin())
            } else if link.starts_with('#') {
                let q_end = self.rest.find('#').unwrap_or(self.rest.len());
                format!("{}{}{link}", self.origin(), &self.rest[..q_end])
            } else {
                let dir = &path[..=path.rfind('/').unwrap_or(0)];
                format!("{}{dir}{link}", self.origin())
            }
        })
    }
}

impl std::fmt::Display for Url {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.special {
            write!(f, "{}{}", self.origin(), self.rest)
        } else {
            write!(f, "{}:{}", self.scheme, self.rest)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_addresses() {
        let u = Url::parse("https://Vault.LAN:8443/api?x=1").unwrap();
        assert_eq!(
            (u.scheme.as_str(), u.hostname.as_str(), u.port),
            ("https", "vault.lan", Some(8443))
        );
        assert_eq!(u.origin(), "https://vault.lan:8443");
        assert_eq!(Url::parse("https://x:443").unwrap().port, None);
        assert_eq!(
            Url::parse("http://[FD7A:115C:A1E0::1]:8443")
                .unwrap()
                .hostname,
            "[fd7a:115c:a1e0::1]"
        );
        assert_eq!(Url::parse("https://u:p@host/").unwrap().hostname, "host");
        assert_eq!(
            Url::parse("https://192.168.1.10:8443").unwrap().to_string(),
            "https://192.168.1.10:8443/"
        );
        assert!(Url::parse("not a url").is_none());
        assert!(Url::parse("https://").is_none());
        assert!(Url::parse("https://h:99999").is_none());
        assert_eq!(Url::parse("vault.lan:8443").unwrap().hostname, "");
    }

    #[test]
    fn joins_links() {
        let base = Url::parse("https://192.168.1.10:8443").unwrap();
        assert_eq!(
            base.join("/invite?token=a.b").unwrap(),
            "https://192.168.1.10:8443/invite?token=a.b"
        );
        assert_eq!(
            base.join("https://x.example/a").unwrap(),
            "https://x.example/a"
        );
        let deep = Url::parse("https://h/app/page?q").unwrap();
        assert_eq!(deep.join("invite").unwrap(), "https://h/app/invite");
        assert_eq!(deep.join("?t=1").unwrap(), "https://h/app/page?t=1");
    }
}

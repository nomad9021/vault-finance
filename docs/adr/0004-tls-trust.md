# ADR-0004: TLS trust — Trust-On-First-Use certificate pinning

## Status

Accepted

## Context

The server must serve HTTPS, but the common deployment is a self-signed cert or
an internal CA on a home LAN. Asking a household member to import a root CA
into their OS trust store is a support burden the spec explicitly wants
avoided ("document how clients trust it").

## Decision

The setup wizard generates a self-signed cert (or the user supplies their own /
an internal CA). On first connect, the desktop client fetches the cert, shows
its SHA-256 fingerprint for the user to confirm (ideally read aloud/compared
out-of-band the first time, same UX pattern as SSH host keys), then pins that
fingerprint locally. Every subsequent connection compares against the pinned
fingerprint; a mismatch is a hard error with an explicit "the server's
certificate changed — verify this is expected before continuing" prompt, never
a silent bypass.

If the fingerprint validates against the OS trust store instead (proper CA,
e.g. via Tailscale HTTPS or Let's Encrypt through a reverse proxy), TOFU pinning
is skipped and normal TLS validation applies.

## Consequences

- No cert import step in the setup docs for the default path.
- The client must persist pinned fingerprints per server address, and Settings
  needs an "unpin / re-verify server identity" action for the legitimate case
  of the user rotating their own cert.

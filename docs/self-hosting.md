# Self-hosting guide

> **Status**: skeleton only. This becomes the first-class deliverable it needs
> to be as each milestone in [roadmap.md](roadmap.md) lands — most sections
> below can't be written accurately until the thing they describe exists. The
> structure is fixed now so nothing referenced from [architecture.md](architecture.md)
> or the ADRs links to a missing page.

## Planned sections

1. **Requirements** — Docker + Docker Compose, disk space for Postgres +
   Ollama models, a machine that stays on (this is a server, not a
   one-off script).
2. **Quick start** — clone, copy `.env.example`, `docker compose up -d`, open
   the desktop app, complete the setup wizard. Target: five commands or fewer.
3. **Configuring remote access** — connecting over a LAN vs. a VPN/overlay
   (Tailscale is the documented example from the spec); what to put in the
   desktop app's "server address" field in each case.
4. **TLS and certificate trust** — what Trust-On-First-Use means in practice
   for this app ([ADR-0004](adr/0004-tls-trust.md)), what the fingerprint
   confirmation screen looks like, and how to swap in your own cert (internal
   CA, or a reverse proxy with a real one) instead of the wizard-generated
   self-signed one.
5. **AI setup** — running Ollama in the bundled Compose service vs. pointing
   at an existing Ollama install elsewhere on the network; how to pull a
   model; what happens when AI is unreachable.
6. **Hardware sizing for Ollama** — RAM/VRAM expectations per common model
   size class (e.g. 7–8B, 13–14B, 30B+), to be filled in with real numbers
   measured during milestone M4 rather than vendor-quoted figures.
7. **Backups** — which Docker volumes hold state (Postgres data, uploaded
   attachments/receipts), and a recommended backup command.
8. **Updating** — server: `docker compose pull && docker compose up -d`;
   desktop: in-app auto-updater, what the version-compatibility warning means
   if you update one side and not the other.
9. **Troubleshooting** — common first-run issues (port conflicts, cert
   fingerprint mismatches after a redeploy, Ollama model not found).
10. **Manual release steps for maintainers** — the macOS notarization steps
    that must happen in a browser/CLI outside CI (Apple Developer account,
    `notarytool` credentials as GitHub Actions secrets), referenced from the
    M6 CI milestone.

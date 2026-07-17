# ADR-0006: AI is optional, off by default, and multi-provider

## Status

Accepted (supersedes the "local AI only, no cloud APIs, ever" stance of the
original spec and [ADR-0005](0005-ai-streaming.md)'s Ollama-only framing;
ADR-0005's NDJSON streaming transport is unchanged).

## Context

The original design integrated a single local AI runtime (Ollama) and treated
it as an always-present, privacy-preserving feature. In practice:

- Not every self-hoster wants to run a multi-GB model, and CPU-only Ollama is
  slow. Forcing an AI setup step on first run added friction for users who
  don't want AI at all.
- Users who *do* want strong AI often already have an OpenAI or Anthropic API
  key and would rather use it than run a local model.

## Decision

1. **AI is off by default.** First-run setup no longer configures AI; the
   assistant and every AI-touching surface are hidden until the owner enables
   it. The app is fully usable — and looks AI-free — out of the box.
2. **Bring-your-own-provider.** Settings → AI offers a curated provider
   dropdown: **Ollama** (local, base URL configurable), **OpenAI**, and
   **Anthropic (Claude)**. Cloud providers take the user's own API key.
3. **The server holds credentials and makes all provider calls.** The desktop
   client only ever talks to its own server (unchanged from ADR-0005). API
   keys are stored in the server's Postgres and never returned by any endpoint
   (`hasApiKey` boolean only). A key therefore lives only on the user's own
   hardware.
4. **Honest privacy.** With Ollama, nothing leaves the user's server. With a
   cloud provider, a bounded financial-context summary is sent to that provider
   under the user's key on each question. The desktop UI shows an explicit
   warning before a cloud provider can be enabled, and the docs state this
   plainly rather than claiming a blanket "nothing ever leaves your server."

## Consequences

- One provider-abstraction interface on the server (`listModels`,
  `streamChat`, `generateText`); routes never branch on provider. Cloud
  providers use their official SDKs (`openai`, `@anthropic-ai/sdk`); Ollama
  uses its native HTTP API.
- The privacy guarantee is now conditional and must be communicated as such —
  "no AI, nothing leaves your server, by default; cloud AI is opt-in and sends
  data to your chosen provider."
- Adding a fourth provider later is a single new client implementing the
  interface, plus an enum entry.

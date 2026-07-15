# ADR-0005: AI streaming transport — NDJSON over chunked HTTP, not SSE

## Status

Accepted

## Context

Ollama's chat API streams tokens. The chosen transport must carry the same
bearer-token auth as every other endpoint and work in a Tauri webview and
(later) on iOS.

## Decision

The server re-streams Ollama's output as newline-delimited JSON over a chunked
`text/plain` (or `application/x-ndjson`) HTTP response, not `text/event-stream`
via `EventSource`.

## Rationale

`EventSource` cannot set custom request headers, so it cannot carry
`Authorization: Bearer <token>` — the only ways around that are passing the
token in the URL (logged in server access logs, rejected) or a cookie-based
session (rejected by [ADR-0003](0003-auth-design.md)'s device-session model).
Plain `fetch()` with a `ReadableStream` reader has no such restriction, works
identically in a Tauri webview and a Swift `URLSession` streaming task, and
NDJSON framing is trivial to parse incrementally on both.

## Consequences

The client owns reconnect/retry logic for streaming responses (no built-in
`EventSource` auto-reconnect) — acceptable, since a dropped AI response should
surface as "response interrupted, retry" rather than silently resuming.

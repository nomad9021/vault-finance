# ADR-0002: Desktop framework — Tauri 2.x

## Status

Accepted

## Context

Phase 1 needs real installable Windows/macOS/Linux apps (not app-store
distributed) with native window chrome, tray support, and auto-update. Phase 2
needs an iOS app from largely the same codebase, without a rewrite, distributed
through the App Store.

## Decision

Tauri 2.x with one React + TypeScript frontend, shared between all Phase 1
desktop targets and reused for the Phase 2 iOS target.

## Rationale

- Tauri 2 is the only mainstream option that targets both desktop and iOS/Android
  from one Rust shell + web frontend, which directly satisfies "no rewrite for
  Phase 2."
- Binary size and memory footprint are far below Electron, which matters for a
  self-hosted-adjacent, privacy-conscious audience likely to also be
  resource-conscious.
- Native window controls, system tray, and OS-level secure storage (for refresh
  tokens) are first-class Tauri plugins, not third-party bolt-ons.
- The existing Claude Design source of truth is already plain React/HTML/CSS —
  it drops into a Tauri webview with no translation layer.

## Consequences

- The Rust shell is a real second language surface for the project; core app
  logic still lives in TypeScript, and Rust is only touched for
  plugin/native-integration code (tray, secure storage, updater config).
- Phase 2's iOS build requires a macOS CI runner regardless of framework choice
  (Apple tooling requirement, not a Tauri limitation) — see the roadmap's CI
  milestone and [self-hosting.md](../self-hosting.md) for the "no local Mac"
  constraint.

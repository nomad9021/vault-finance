# ADR-0001: Backend framework — Node/TypeScript + Fastify over Go

## Status

Accepted

## Context

The spec leaves this open with a "your call, justify it" between Node
(Fastify/NestJS) and Go. This is a solo-maintained, long-lived, self-hosted
open-source-style project where the frontend is fixed as React/TypeScript
(inherited from the Claude Design source of truth).

## Decision

Node.js + TypeScript on Fastify.

## Rationale

- **Shared types across the whole stack.** With a TS backend, request/response
  DTOs, Zod validation schemas, and even the API client can live in
  `packages/shared` and be imported by both `apps/server` and `apps/desktop`
  with zero codegen. A Go backend would need OpenAPI-generated TS types as a
  build step to get the same guarantee — an extra moving part for a
  single-maintainer project to keep green.
- **Fastify over NestJS.** NestJS's DI/decorator-heavy structure suits large
  teams more than a solo maintainer; Fastify is a thinner layer with excellent
  plugin encapsulation (`fastify-plugin`) that still supports clean module
  boundaries (see [folder-structure.md](../folder-structure.md)) without the
  ceremony.
- **Streaming.** Fastify's raw Node stream access makes proxying Ollama's
  chunked NDJSON stream straightforward.

## Consequences / documented tradeoff

Go would produce a single static binary with a smaller memory footprint —
genuinely nicer for a background service on a home server. We accept the larger
Node runtime footprint in exchange for the shared-types win, since this app's
data volume (one household's finances) is small enough that Node's overhead is
irrelevant in practice. If server resource usage ever becomes a real complaint
from self-hosters, this ADR is the place to revisit that tradeoff.

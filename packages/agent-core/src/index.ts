// @atiende/agent-core — en esta fase solo contiene el gateway LLM único (ver
// ./gateway/). `runner.ts`/`tool.ts`/`trace.ts`/`redact.ts` (el resto del núcleo de
// agentes de hoteles/packages/agent-core) quedan fuera de alcance de esta entrega —
// ver docs/REQUISITOS.md.
export * from "./gateway/index.ts";

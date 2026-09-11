// `@atiende/core-authz` — autorización transversal de plataforma.
//
// NOTA DE ALCANCE (11-sep-2026): este paquete se crea en esta rama
// conteniendo SOLO `impersonation/` (superadmin con impersonación auditada
// por cookie firmada). Un route-area.ts/roles.ts/audit.ts/rate-limiter.ts
// genéricos de plataforma NO existían en el repo al momento de esta tarea
// (verificado con `git log --all` antes de empezar) — no se inventaron aquí
// para no exceder el alcance pedido (impersonación). Si otra rama los agrega
// después, este módulo se integra con ellos entonces; por ahora
// `impersonation/` es autocontenido y no depende de ningún otro submódulo de
// `core-authz`.
export * from "./impersonation/index.ts";

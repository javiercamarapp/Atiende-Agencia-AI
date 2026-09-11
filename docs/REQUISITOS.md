# Matriz de requisitos trazable — Atiende (núcleo del monorepo fusionado)

## 0. Alcance honesto de esta entrega

Este documento describe **solo el esqueleto inicial del monorepo `atiende`**: la
estructura de carpetas del diseño aprobado, y tres paquetes de núcleo con código real
y pruebas — `@atiende/core-tenancy`, `@atiende/core-auth` y el gateway LLM de
`@atiende/agent-core`. **Ninguna vertical de negocio está migrada todavía.**

Explícitamente NO construido en esta entrega (cada uno es una carpeta reservada con un
`README.md` que dice esto mismo):

- **Ninguna** de las 5 verticales (hoteles, restaurantes, citas, licitaciones, rentas):
  ni su UI (`apps/web/src/verticals/*`), ni sus rutas de API (`apps/api/src/routes/verticals/*`),
  ni sus jobs de fondo (`apps/worker/src/jobs/*`), ni sus paquetes de dominio
  (`packages/domain-*`).
- `apps/web`, `apps/api`, `apps/worker` no tienen código propio todavía — no hay
  `package.json` de app, ni servidor Hono, ni SPA Vite. Solo existe el árbol de
  carpetas del diseño.
- `packages/db`: no hay motor de conexión (PGlite/embedded-postgres/Postgres
  gestionado) ni una sola migración SQL escrita. El esquema `core` (`organization`,
  `property`, `membership`) que describen `docs/` de diseño y que
  `@atiende/core-tenancy`/`@atiende/core-auth` asumen en sus consultas **no existe
  como SQL ejecutable todavía** — solo como contrato TypeScript.
- Ningún servidor MCP (`packages/mcp-servers/*`), ni `@atiende/ui`, ni
  `@atiende/billing` (deliberadamente sin contrato, ver diseño §7).
- `docs/referencia/` está vacío — no se copió ningún documento de los 5 repos origen.

Lo que SÍ es real en esta entrega, con código + pruebas en verde (ver §2):
`@atiende/core-tenancy`, `@atiende/core-auth`, y `packages/agent-core/src/gateway/*`.

## 1. Metodología

Cada renglón de §2 es un requisito verificable en una frase, con el archivo real que lo
implementa, el archivo de prueba que lo verifica, y el estado. Solo hay dos estados en
este documento: **hecho** (código real + prueba real en verde, verificado en esta misma
entrega) y **pendiente** (carpeta reservada, sin código). No hay estados intermedios
porque no hay vertical con trabajo parcial todavía — es una fase binaria: núcleo
construido, verticales no empezadas.

## 2. Matriz de requisitos canónicos

### 2.1 TEN — `@atiende/core-tenancy`

| ID | Requisito | Archivo | Prueba | Estado |
|---|---|---|---|---|
| REQ-TEN-001 | El modelo de tenancy es de dos niveles (organización → property), generalizado de `hotel_staff`/`location`/`org_id` de hoteles — no un modelo nuevo inventado. | `packages/core-tenancy/src/types.ts` | — (tipos, verificado por `tsc --noEmit`) | hecho |
| REQ-TEN-002 | `propertyIds: null` en una `Membership` da acceso a TODAS las properties de la organización (equivalente a owner/admin de plataforma); un array acota el alcance. | `packages/core-tenancy/src/session.ts` (`hasPropertyAccess`) | `packages/core-tenancy/tests/session.spec.ts` | hecho |
| REQ-TEN-003 | El acceso a una property se rechaza fail-closed (`PropertyAccessDeniedError`) cuando la membership no la incluye — nunca se degrada en silencio. | `packages/core-tenancy/src/session.ts` (`assertPropertyAccess`) | `packages/core-tenancy/tests/session.spec.ts` | hecho |
| REQ-TEN-004 | El `platformRole` (techo común: owner/admin/member/viewer) se puede exigir por acción sin que `core-tenancy` conozca ningún rol fino de vertical. | `packages/core-tenancy/src/session.ts` (`assertPlatformRole`) | `packages/core-tenancy/tests/session.spec.ts` | hecho |
| REQ-TEN-005 | Los claims de sesión de tenant (`TenantSessionClaims`) se construyen SIEMPRE a partir de la membership verificada en vivo, nunca de un claim de JWT potencialmente obsoleto; acotar a una property de ruta nunca amplía el alcance real de la membership. | `packages/core-tenancy/src/session.ts` (`buildTenantSessionClaims`) | `packages/core-tenancy/tests/session.spec.ts` | hecho |
| REQ-TEN-006 | Solo las 5 verticales de esta fase (`hoteles`,`restaurantes`,`rentas`,`licitaciones`,`citas`) son válidas; `despachos` y cualquier otro string se rechazan explícitamente. | `packages/core-tenancy/src/types.ts` (`isVertical`) | `packages/core-tenancy/tests/types.spec.ts` | hecho |

### 2.2 AUTH — `@atiende/core-auth`

| ID | Requisito | Archivo | Prueba | Estado |
|---|---|---|---|---|
| REQ-AUTH-001 | JWT propio HS256 (`jose`), claims `{sub, org_id, vertical, property_ids, email, type}`, exp corta + refresh — generaliza `hoteles/apps/api/src/lib/jwt.ts` (ADR-004) a las 5 verticales. | `packages/core-auth/src/jwt.ts` | `packages/core-auth/tests/jwt.spec.ts` | hecho |
| REQ-AUTH-002 | Un token expirado se distingue de un token inválido por tipo de error (`TokenExpiredError` vs `TokenInvalidError`), para que el llamador pueda dar un mensaje distinto ("expiró, inicia sesión de nuevo" vs "token inválido"). | `packages/core-auth/src/jwt.ts` | `packages/core-auth/tests/jwt.spec.ts` | hecho |
| REQ-AUTH-003 | `authMiddleware` rechaza con 401 la ausencia de `Authorization: Bearer`, un secreto incorrecto, o un token expirado — nunca deja pasar una request sin identidad resuelta. | `packages/core-auth/src/middleware.ts` | `packages/core-auth/tests/middleware.spec.ts` | hecho |
| REQ-AUTH-004 | `requirePropertyMembership` resuelve organizationId/propertyIds/platformRole/verticalRole SIEMPRE contra `core.membership` en vivo (vía `TenantDbSession.query`), nunca contra el claim del JWT — un claim con `org_id` obsoleto queda sobrescrito por la membership real. | `packages/core-auth/src/middleware.ts` | `packages/core-auth/tests/middleware.spec.ts` ("REESCRIBE organizationId...") | hecho |
| REQ-AUTH-005 | Sin fila de membership para la property de la ruta: 403 explícito (defensa en profundidad, además de la RLS que ya lo bloquearía). Con `allowedRoles` configurado, un `platformRole` fuera de la lista también es 403. | `packages/core-auth/src/middleware.ts` | `packages/core-auth/tests/middleware.spec.ts` | hecho |
| REQ-AUTH-006 | El header `X-Property-Id`, si viene presente, debe coincidir con el parámetro de ruta — un valor distinto es 403 (selector de property activa consistente). | `packages/core-auth/src/middleware.ts` | `packages/core-auth/tests/middleware.spec.ts` | hecho |
| REQ-AUTH-007 | `assertVerticalRole` es una segunda capa explícita para el rol fino de vertical (string opaco para `core-auth`) — se llama dentro del handler, después de `requirePropertyMembership`. | `packages/core-auth/src/middleware.ts` | `packages/core-auth/tests/middleware.spec.ts` | hecho |

### 2.3 GTW — Gateway LLM único (`@atiende/agent-core/gateway`)

| ID | Requisito | Archivo | Prueba | Estado |
|---|---|---|---|---|
| REQ-GTW-001 | `LlmProvider` (tipo) declara `countryOfResidence` (ISO alpha-2, o `'unknown'` para un agregador multi-vendor); `OpenRouterProvider` es `'unknown'` por defecto y solo configurable si el operador confirmó la ruta real; `AnthropicProvider`/`OpenAiProvider` (integración directa) vienen fijos a `'US'`, sin parámetro de constructor. El gate que CONSUME este campo sí está probado (ver REQ-GTW-005) con proveedores fake parametrizados; las 3 clases reales en sí no tienen prueba unitaria propia. | `packages/agent-core/src/gateway/types.ts`, `providers/{openrouter,anthropic,openai}.ts` | — (ver REQ-GTW-008) | pendiente |
| REQ-GTW-002 | Un error de proveedor se clasifica en reintentable (red/5xx/429/408, vía `isRetryableProviderError`) o no reintentable (el resto, p.ej. 4xx de negocio): solo el primero dispara fallback cross-provider y cuenta como fallo del circuit breaker. | `packages/agent-core/src/gateway/retryable.ts`, `gateway.ts` | `packages/agent-core/tests/gateway/fallback.spec.ts` | hecho |
| REQ-GTW-003 | Circuit breaker por proveedor (`CircuitBreaker`): se abre tras `failureThreshold` fallos consecutivos dentro de `failureWindowSeconds` (default 5/60s), permanece OPEN `openDurationSeconds` (default 30s) y luego vuelve a aceptar intentos; fail-open (deja pasar todo) si no hay `store` configurado — es defensa en profundidad, no el único control. | `packages/agent-core/src/gateway/circuit-breaker.ts` | `packages/agent-core/tests/gateway/circuit-breaker.spec.ts` | hecho |
| REQ-GTW-004 | `LlmGateway.complete()` hace fallback en cascada por la escalera registrada con `registerLadder(role, providers)` ante un error reintentable, hasta agotarla (`AllProvidersFailedError` con el detalle de cada intento); un error no reintentable detiene la escalera de inmediato, sin probar el siguiente proveedor. | `packages/agent-core/src/gateway/gateway.ts` | `packages/agent-core/tests/gateway/fallback.spec.ts` | hecho |
| REQ-GTW-005 | Con una `ResidencyPolicy` activa (`enabled:true`, `requiredCountry`), `applyResidencyGate` filtra la escalera a los proveedores con `countryOfResidence === requiredCountry` ANTES de tocar red o presupuesto; si ninguno cumple, lanza `ResidencyGateBlockedError` — nunca degrada en silencio a un proveedor no conforme (p.ej. OpenRouter/`'unknown'`). | `packages/agent-core/src/gateway/residency.ts` | `packages/agent-core/tests/gateway/residency.spec.ts` | hecho |
| REQ-GTW-006 | El presupuesto de una corrida (`reserveBudget`/`settleBudget` sobre un `GatewayBudget`) se reserva ANTES de llamar al proveedor y se ajusta al costo real después; agotar el tope por corrida (`maxRunUsd`) rechaza con `GatewayBudgetExceededError('run', …)` sin llamar al proveedor. | `packages/agent-core/src/gateway/budget.ts` | `packages/agent-core/tests/gateway/budget.spec.ts` | hecho |
| REQ-GTW-007 | El presupuesto por carril (`LlmLane`: `interactive`/`batch`/`background`) reserva una fracción del techo diario del tenant (`interactiveReserveFraction`, default 0.4) exclusiva para `'interactive'`; un carril de fondo/batch que la agote rechaza con `GatewayBudgetExceededError('lane', …)` ANTES de intentar cualquier proveedor. | `packages/agent-core/src/gateway/budget.ts` | `packages/agent-core/tests/gateway/budget.spec.ts` | hecho |
| REQ-GTW-008 | Existen 3 proveedores reales (HTTP real vía `fetch` nativo, no simulado en producción): OpenRouter, Anthropic directo, OpenAI directo — cada uno arma el body/headers del contrato documentado de su API y parsea texto/tokens/costo real de la respuesta. | `packages/agent-core/src/gateway/providers/{openrouter,anthropic,openai}.ts` | — (sin prueba unitaria propia del `fetch`/parseo de cada adaptador; solo `FakeLlmProvider` está bajo test hoy) | pendiente |
| REQ-GTW-009 | Un proveedor que falla DESPUÉS de reservar presupuesto (fallo del proveedor, no del gate de residencia ni del presupuesto) libera la reserva a $0 en el ledger en vez de cobrar el estimado — nunca se factura una llamada sin uso real. | `packages/agent-core/src/gateway/gateway.ts` (`settleBudget(..., 0)` en el `catch`) | — (el código se ejecuta en cada caso de fallo de `fallback.spec.ts`, pero ningún test afirma el efecto sobre el ledger — p.ej. `remainingUsd()`/`reservedRunUsd` tras el fallo) | pendiente |

## 3. Lo que este documento NO cubre (y por qué)

Los ~276 requisitos de negocio que ya existen en `hoteles/docs/REQUISITOS.md` (reservas,
housekeeping, revenue, CRM, etc.) **no se repiten aquí** porque ninguno de esos
comportamientos existe todavía en `atiende` — viven en el repo `hoteles` origen hasta
que la vertical se porte. Cuando se porte, ese trabajo debe traer su propia matriz de
requisitos honesta (adaptando REQ-TEN/REQ-RES/... a los nombres genéricos de
`core-tenancy`) y añadirla a este documento, no reescribir estas filas.

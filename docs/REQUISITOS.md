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
| REQ-GTW-001 | `LlmProvider` declara `countryOfResidence` (ISO alpha-2 o `"UNKNOWN"`); un proxy multi-vendor (OpenRouter) DEBE declarar `"UNKNOWN"` siempre, nunca configurable a un país fijo. | `packages/agent-core/src/gateway/provider.ts`, `providers/openRouter.ts` | `packages/agent-core/tests/providers/openRouter.spec.ts` | hecho |
| REQ-GTW-002 | `ProviderTransientError` (red/5xx/429/timeout) es distinto de `ProviderHttpError` (4xx de config): solo el primero dispara fallback cross-provider y cuenta como fallo del circuit breaker. | `packages/agent-core/src/gateway/provider.ts` | `packages/agent-core/tests/providers/*.spec.ts`, `router.spec.ts` | hecho |
| REQ-GTW-003 | Circuit breaker por proveedor: se abre tras N fallos transitorios consecutivos, pasa a half-open tras un tiempo configurable, permite intentos de prueba limitados, y un `ProviderHttpError` NUNCA cuenta como fallo. | `packages/agent-core/src/gateway/circuitBreaker.ts` | `packages/agent-core/tests/circuitBreaker.spec.ts` | hecho |
| REQ-GTW-004 | `GatewayRouter.complete()` hace fallback en cascada ante `ProviderTransientError` al siguiente proveedor elegible (disponible + breaker no abierto); un `ProviderHttpError` se propaga tal cual, sin reintentar. | `packages/agent-core/src/gateway/router.ts` | `packages/agent-core/tests/router.spec.ts` | hecho |
| REQ-GTW-005 | Un carril declarado de tolerancia cero (`zeroToleranceLaneRoles`) SOLO considera proveedores con `countryOfResidence === requiredCountryForZeroTolerance` (default "US"); si ninguno está disponible, `NoCompliantProviderError` — nunca degrada a un proveedor no conforme (p.ej. OpenRouter/"UNKNOWN"). | `packages/agent-core/src/gateway/router.ts` | `packages/agent-core/tests/router.spec.ts` | hecho |
| REQ-GTW-006 | El presupuesto de una corrida (`RunBudget`: tokens/tiempo/USD) se agota de forma consultable en cualquier dimensión configurada, con reloj inyectable para pruebas deterministas. | `packages/agent-core/src/gateway/budget.ts` | `packages/agent-core/tests/budget.spec.ts` | hecho |
| REQ-GTW-007 | El presupuesto por carril (`LaneBudgetTracker`) bloquea una llamada ANTES de intentar cualquier proveedor si el carril ya está agotado, y registra el costo real tras un éxito. | `packages/agent-core/src/gateway/budget.ts`, `router.ts` | `packages/agent-core/tests/budget.spec.ts`, `router.spec.ts` | hecho |
| REQ-GTW-008 | Existen 3 proveedores reales (HTTP real, no simulado en producción): OpenRouter (`UNKNOWN`), Anthropic directo (`US`), OpenAI directo (`US`) — cada uno clasifica sus propios errores HTTP en transitorio/no-transitorio según el mismo criterio (429/5xx transitorio, resto `ProviderHttpError`). | `packages/agent-core/src/gateway/providers/{openRouter,anthropicDirect,openaiDirect}.ts` | `packages/agent-core/tests/providers/*.spec.ts` | hecho |
| REQ-GTW-009 | Ninguna integración de proveedor real se declara "verificada contra el servicio real" sin haberlo corrido de verdad — cada una lleva su propia constante explícita en `false` (`OPENROUTER_INTEGRATION_VERIFIED_AGAINST_REAL_API` ya existía en hoteles; se replican `ANTHROPIC_INTEGRATION_VERIFIED_AGAINST_REAL_API`/`OPENAI_INTEGRATION_VERIFIED_AGAINST_REAL_API`). | `packages/agent-core/src/gateway/providers/*.ts` | — (constante, no requiere prueba) | hecho |

## 3. Lo que este documento NO cubre (y por qué)

Los ~276 requisitos de negocio que ya existen en `hoteles/docs/REQUISITOS.md` (reservas,
housekeeping, revenue, CRM, etc.) **no se repiten aquí** porque ninguno de esos
comportamientos existe todavía en `atiende` — viven en el repo `hoteles` origen hasta
que la vertical se porte. Cuando se porte, ese trabajo debe traer su propia matriz de
requisitos honesta (adaptando REQ-TEN/REQ-RES/... a los nombres genéricos de
`core-tenancy`) y añadirla a este documento, no reescribir estas filas.

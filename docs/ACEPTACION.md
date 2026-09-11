# Criterios de aceptación — Atiende (núcleo del monorepo fusionado)

Fuente: `docs/REQUISITOS.md` (22 REQ-* canónicos, §2.1–§2.3; 19 en estado **hecho** y
REQ-GTW-001/REQ-GTW-008/REQ-GTW-009 en **pendiente** — código de producción real, sin
prueba unitaria propia todavía, ver nota en cada fila). Este documento no inventa
requisitos: cada fila rastrea exactamente un ID de `docs/REQUISITOS.md`, mismo orden
y agrupación.

## 1. Principios

1. **Evidencia = comando + salida real.** Cada fila de §2 se marcó `hecho` únicamente
   después de ejecutar el comando exacto listado y confirmar que terminó en verde — no
   hay ninguna fila marcada `hecho` "porque el código se ve bien".
2. **Nada de mocks de red en producción.** Los proveedores del gateway
   (`OpenRouterProvider`/`AnthropicProvider`/`OpenAiProvider`) hacen HTTP real vía
   `fetch` nativo contra el endpoint documentado de cada API — no hay SDK ni cliente
   que pueda esconder una llamada simulada. Ninguno de los tres se ha ejercitado
   contra el servicio real (sin credenciales en este entorno) ni tiene todavía una
   prueba unitaria propia que inyecte un `fetch` fiel al contrato de su API — ver
   REQ-GTW-008 (**pendiente**) en `docs/REQUISITOS.md`. Lo que sí está bajo prueba es
   el motor del gateway que los orquesta (`tests/gateway/*.spec.ts`), usando
   `FakeLlmProvider` para simular éxito/fallo sin red.
3. **Alcance = solo núcleo.** No existe ninguna fila de vertical de negocio en este
   documento — ver `docs/REQUISITOS.md` §0/§3 para el detalle honesto de qué falta.

## 2. Tabla maestra de criterios de aceptación

Columnas: **ID** · **Criterio de aceptación** (observable) · **Tipo de prueba** ·
**Comando ejecutado** · **Resultado**.

### 2.1 TEN — `@atiende/core-tenancy`

| ID | Criterio de aceptación | Tipo de prueba | Comando ejecutado | Resultado |
|---|---|---|---|---|
| REQ-TEN-001 | `tsc --noEmit` sobre `packages/core-tenancy` no reporta ningún error de tipos para `Vertical`/`Organization`/`Property`/`Membership`/`TenancyEngine`. | typecheck | `npx tsc --noEmit -p packages/core-tenancy/tsconfig.json` | **hecho**: 0 errores. |
| REQ-TEN-002 | `hasPropertyAccess` devuelve `true` para `propertyIds:null` con cualquier id de property, `true` solo si el id está en el array en otro caso, `false` para un array vacío. | unit (Vitest) | `npx vitest run packages/core-tenancy/tests/session.spec.ts` | **hecho**: 4/4 tests de `hasPropertyAccess` en verde. |
| REQ-TEN-003 | `assertPropertyAccess` no lanza cuando hay acceso; lanza `PropertyAccessDeniedError` con `propertyId`/`code` correctos cuando no lo hay. | unit (Vitest) | `npx vitest run packages/core-tenancy/tests/session.spec.ts` | **hecho**: 3/3 tests en verde. |
| REQ-TEN-004 | `assertPlatformRole` no lanza con un rol permitido; lanza `InsufficientPlatformRoleError` con un rol fuera de la lista. | unit (Vitest) | `npx vitest run packages/core-tenancy/tests/session.spec.ts` | **hecho**: 2/2 tests en verde. |
| REQ-TEN-005 | `buildTenantSessionClaims` propaga `propertyIds` completo sin `propertyId` explícito; lo acota a `[propertyId]` con uno explícito (incluso si la membership es `propertyIds:null`); rechaza con `PropertyAccessDeniedError` si la membership no tiene acceso a ese `propertyId`. | unit (Vitest) | `npx vitest run packages/core-tenancy/tests/session.spec.ts` | **hecho**: 4/4 tests en verde. |
| REQ-TEN-006 | `isVertical` acepta exactamente las 5 verticales y rechaza `"despachos"`/cualquier string arbitrario/cadena vacía. | unit (Vitest) | `npx vitest run packages/core-tenancy/tests/types.spec.ts` | **hecho**: 2/2 tests en verde. |

### 2.2 AUTH — `@atiende/core-auth`

| ID | Criterio de aceptación | Tipo de prueba | Comando ejecutado | Resultado |
|---|---|---|---|---|
| REQ-AUTH-001 | Un access token firmado con `signAccessToken` y verificado con `verifyAccessToken` devuelve exactamente los mismos claims, incluido `property_ids:null` sobreviviendo el roundtrip; un refresh token análogo también hace roundtrip. | unit (Vitest, `jose` real) | `npx vitest run packages/core-auth/tests/jwt.spec.ts` | **hecho**: 8/8 tests en verde. |
| REQ-AUTH-002 | Un token con `ttlSeconds:-1` (ya expirado) lanza `TokenExpiredError`; un token firmado con otro secreto o del tipo equivocado (access↔refresh) lanza `TokenInvalidError`. | unit (Vitest) | `npx vitest run packages/core-auth/tests/jwt.spec.ts` | **hecho**: 4/4 tests en verde. |
| REQ-AUTH-003 | Una app Hono real montando `authMiddleware` responde 401 sin header `Authorization` y 401 con un token firmado con secreto distinto. | unit (Vitest + `Hono().request()` real, sin mocks de framework) | `npx vitest run packages/core-auth/tests/middleware.spec.ts` | **hecho**: 2/2 tests en verde. |
| REQ-AUTH-004 | Con una membership resuelta que trae `organization_id:"org-real"` distinto del `org_id` del claim del token (`"org-claim-obsoleto"`), la respuesta trae `organizationId:"org-real"` — nunca el claim. | unit (Vitest) | `npx vitest run packages/core-auth/tests/middleware.spec.ts` | **hecho**: verificado explícitamente en el test "REESCRIBE organizationId/propertyIds/platformRole...". |
| REQ-AUTH-005 | 403 cuando la consulta de membership no devuelve filas; 403 cuando el `platform_role` resuelto no está en `allowedRoles`. | unit (Vitest) | `npx vitest run packages/core-auth/tests/middleware.spec.ts` | **hecho**: 2/2 tests en verde. |
| REQ-AUTH-006 | 403 cuando el header `X-Property-Id` enviado no coincide con `:propertyId` de la ruta. | unit (Vitest) | `npx vitest run packages/core-auth/tests/middleware.spec.ts` | **hecho**: 1/1 test en verde. |
| REQ-AUTH-007 | 200 cuando `assertVerticalRole` recibe un `verticalRole` dentro de la lista permitida; 403 cuando no. | unit (Vitest) | `npx vitest run packages/core-auth/tests/middleware.spec.ts` | **hecho**: 2/2 tests en verde. |

### 2.3 GTW — Gateway LLM (`@atiende/agent-core/gateway`)

| ID | Criterio de aceptación | Tipo de prueba | Comando ejecutado | Resultado |
|---|---|---|---|---|
| REQ-GTW-001 | `new OpenRouterProvider({apiKey, model}).countryOfResidence === 'unknown'` sin excepción de configuración; `AnthropicProvider`/`OpenAiProvider` reportan `'US'` sin parámetro. | unit (Vitest) | — (ninguna prueba instancia las 3 clases reales; el gate que consume `countryOfResidence` sí está probado con `FakeLlmProvider`, ver REQ-GTW-005) | **pendiente**: verificable por lectura del código fuente, sin prueba automatizada — ver REQ-GTW-008. |
| REQ-GTW-002 | `isRetryableProviderError` clasifica 5xx/429/408/errores de red como reintentable y el resto (p.ej. 401/400) como no reintentable; `LlmGateway.complete()` solo reintenta con el siguiente proveedor de la escalera en el primer caso. | unit (Vitest) | `npx vitest run packages/agent-core/tests/gateway/fallback.spec.ts` | **hecho**: 5/5 tests en verde. |
| REQ-GTW-003 | Con `failureThreshold:N`, el breaker abre exactamente en el N-ésimo fallo consecutivo dentro de `failureWindowSeconds` (no antes); permanece OPEN `openDurationSeconds` y luego vuelve a aceptar intentos; sin `store` configurado, `checkCircuit`/`reportFailure`/`reportSuccess` son no-op (fail-open). | unit (Vitest) | `npx vitest run packages/agent-core/tests/gateway/circuit-breaker.spec.ts` | **hecho**: 6/6 tests en verde. |
| REQ-GTW-004 | Con un `FakeLlmProvider` primario que lanza un error reintentable y uno de respaldo que responde con éxito, `LlmGateway.complete()` devuelve la respuesta del respaldo con `fallbackUsed:true`; con el primario lanzando un error no reintentable, la promesa se rechaza con ese error sin llamar al respaldo (`callCount` del respaldo permanece en 0). | unit (Vitest) | `npx vitest run packages/agent-core/tests/gateway/fallback.spec.ts` | **hecho**: verificado explícitamente, 5/5 tests en verde. |
| REQ-GTW-005 | Con una `ResidencyPolicy{enabled:true, requiredCountry:'US'}` y solo un proveedor `'unknown'` disponible, `complete()` lanza `ResidencyGateBlockedError` — nunca lo usa aunque sea el único disponible; con un proveedor `'US'` también registrado, la escalera se filtra a ese. | unit (Vitest) | `npx vitest run packages/agent-core/tests/gateway/residency.spec.ts` | **hecho**: 8/8 tests en verde. |
| REQ-GTW-006 | `reserveBudget` rechaza con `GatewayBudgetExceededError('run', …)` en cuanto `reservedRunUsd + amountUsd > maxRunUsd`, sin siquiera llamar a `store.reserve` (el ledger de gasto diario del tenant); el proveedor nunca se invoca (`callCount === 0`). | unit (Vitest) | `npx vitest run packages/agent-core/tests/gateway/budget.spec.ts` | **hecho**: 4/4 tests en verde. |
| REQ-GTW-007 | Con un carril `'batch'`/`'background'` cuyo gasto no-interactivo ya toca `maxTenantDailyUsd - interactiveReserveUsd`, `reserveBudget` rechaza con `GatewayBudgetExceededError('lane', …)`; el mismo gasto no bloquea al carril `'interactive'`, que solo respeta el techo diario total del tenant. | unit (Vitest) | `npx vitest run packages/agent-core/tests/gateway/budget.spec.ts` | **hecho**: cubierto dentro de los 4/4 tests de `budget.spec.ts`. |
| REQ-GTW-008 | Los 3 proveedores (`OpenRouterProvider`/`AnthropicProvider`/`OpenAiProvider`) arman el body/headers del contrato documentado de su API (OpenRouter/OpenAI: Chat Completions; Anthropic: Messages API con `system` aparte) y parsean texto/tokens/costo reales de la respuesta — sin prueba unitaria propia que inyecte un `fetch` fiel a cada contrato. | unit (Vitest) | — (no existe `packages/agent-core/tests/gateway/providers/*.spec.ts` todavía) | **pendiente**: código de producción real y en uso por el gateway, sin cobertura de test directa. |
| REQ-GTW-009 | Con un proveedor que reserva presupuesto y luego falla, `settleBudget(..., 0)` libera la reserva completa — el ledger del tenant queda como si esa llamada nunca se hubiera cobrado. | unit (Vitest) | — (ningún test de `fallback.spec.ts`/`budget.spec.ts` afirma el efecto en el ledger tras un fallo, solo que el fallback ocurre) | **pendiente**: comportamiento real en `gateway.ts`, sin aserción directa todavía. |

## 3. Corrida completa (evidencia agregada)

```
$ npx tsc --noEmit -p tsconfig.json                     # 0 errores
$ npm run typecheck --workspaces --if-present            # 0 errores (3 paquetes)
$ npx eslint packages                                     # 0 errores, 0 warnings
$ npx vitest run --config vitest.config.ts
  Test Files  10 passed (10)
       Tests  85 passed (85)
```

Ningún test se saltó, se marcó `skip`, ni se dejó en rojo "para después". El hash del
commit que fija esta corrida está en el mensaje del commit inicial del repositorio.

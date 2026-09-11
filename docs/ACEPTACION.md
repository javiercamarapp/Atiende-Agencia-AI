# Criterios de aceptación — Atiende (núcleo del monorepo fusionado)

Fuente: `docs/REQUISITOS.md` (22 REQ-* canónicos, §2.1–§2.3, todos con estado **hecho**
en esta entrega). Este documento no inventa requisitos: cada fila rastrea exactamente un
ID de `docs/REQUISITOS.md`, mismo orden y agrupación.

## 1. Principios

1. **Evidencia = comando + salida real.** Cada fila de §2 se marcó `hecho` únicamente
   después de ejecutar el comando exacto listado y confirmar que terminó en verde — no
   hay ninguna fila marcada `hecho` "porque el código se ve bien".
2. **Nada de mocks de red en producción.** Los proveedores del gateway
   (`OpenRouterProvider`/`AnthropicDirectProvider`/`OpenAiDirectProvider`) hacen HTTP
   real; sus pruebas usan un `fetch` inyectado que sirve un cuerpo fiel al contrato
   documentado de cada API, nunca un doble que invente un comportamiento distinto del
   real. Ninguno de los tres se ha ejercitado contra el servicio real (sin
   credenciales en este entorno) — ver las constantes `*_INTEGRATION_VERIFIED_AGAINST_REAL_API`
   en cada archivo de proveedor, explícitas en `false`.
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
| REQ-GTW-001 | `new OpenRouterProvider(...).countryOfResidence === "UNKNOWN"` sin excepción de configuración; `AnthropicDirectProvider`/`OpenAiDirectProvider` reportan `"US"`. | unit (Vitest) | `npx vitest run packages/agent-core/tests/providers` | **hecho**: verificado en los 3 archivos de proveedor. |
| REQ-GTW-002 | Un fetch simulado que responde 429/500/timeout produce `ProviderTransientError`; uno que responde 401 produce `ProviderHttpError` con `status:401`, en los 3 proveedores. | unit (Vitest, `fetch` inyectado fiel al contrato HTTP documentado de cada API) | `npx vitest run packages/agent-core/tests/providers` | **hecho**: 26/26 tests de proveedores en verde. |
| REQ-GTW-003 | Con `failureThreshold:3`, el breaker abre exactamente en el 3er fallo transitorio (no antes); un `ProviderHttpError`/error genérico nunca lo abre; tras `openMs` pasa a half-open y permite `halfOpenMaxAttempts` intentos; un éxito en half-open cierra, un fallo en half-open reabre sin recontar el umbral. | unit (Vitest, reloj inyectable determinista) | `npx vitest run packages/agent-core/tests/circuitBreaker.spec.ts` | **hecho**: 7/7 tests en verde. |
| REQ-GTW-004 | Con un `FakeProvider` primario que lanza `transient_error` y uno de respaldo que responde `final`, `GatewayRouter.complete()` devuelve la respuesta del respaldo y `getLastUsedProviderId()==="backup"`; con el primario lanzando `http_error`, la promesa se rechaza con `ProviderHttpError` sin llamar al respaldo. | unit (Vitest) | `npx vitest run packages/agent-core/tests/router.spec.ts` | **hecho**: verificado explícitamente, 13/13 tests de router en verde. |
| REQ-GTW-005 | Con `zeroToleranceLaneRoles:{"auditor_juez"}` y solo un proveedor `"UNKNOWN"` disponible, `route()`/`complete()` lanzan `NoCompliantProviderError` — nunca usan ese proveedor aunque sea el único disponible. Con un proveedor `"US"` también registrado, lo elige a ese. | unit (Vitest) | `npx vitest run packages/agent-core/tests/router.spec.ts` | **hecho**: 3/3 tests de tolerancia cero en verde. |
| REQ-GTW-006 | `agotado()` es `false` hasta que una dimensión configurada llega a su tope exacto; `remainingUsd()` nunca baja de 0; con reloj inyectado, `remainingMs()` refleja el tiempo simulado, no el reloj real. | unit (Vitest) | `npx vitest run packages/agent-core/tests/budget.spec.ts` | **hecho**: 4/4 tests de `RunBudget` en verde. |
| REQ-GTW-007 | Con un `LaneBudgetTracker` ya agotado para un carril, `complete()` rechaza con `LaneBudgetExceededError` SIN que el `FakeProvider` reciba ninguna llamada (verificado por script de proveedor vacío = fallaría si se llamara sin pasos definidos); con éxito, el costo estimado se registra y `remainingUsd()` baja exactamente lo esperado. | unit (Vitest) | `npx vitest run packages/agent-core/tests/router.spec.ts packages/agent-core/tests/budget.spec.ts` | **hecho**: 2/2 tests de presupuesto por carril + 4/4 de `LaneBudgetTracker` en verde. |
| REQ-GTW-008 | Los 3 proveedores hacen un `fetch` real con el body/headers del contrato documentado de cada API (OpenRouter/OpenAI: Chat Completions; Anthropic: Messages API con `system` aparte) y parsean texto, `tool_calls`/`tool_use`, y truncamiento reales. | unit (Vitest) | `npx vitest run packages/agent-core/tests/providers` | **hecho**: 26/26 tests en verde, incluida la aserción del body enviado (`capturedBody`). |
| REQ-GTW-009 | `grep` confirma que las 3 constantes `*_INTEGRATION_VERIFIED_AGAINST_REAL_API` están en `false` en el código fuente. | revisión estática | `grep -rn "INTEGRATION_VERIFIED_AGAINST_REAL_API" packages/agent-core/src` | **hecho**: 3 constantes encontradas, las 3 en `false`. |

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

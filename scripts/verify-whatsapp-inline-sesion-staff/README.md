# verify-whatsapp-inline-sesion-staff

Verificación ANTES/DESPUÉS contra Postgres **real** del hallazgo de la auditoría
a2b (severidad CRÍTICA) — primo directo del hallazgo ya cerrado en PR #166
(`fix(email-inline): el drenado inline aborta la transacción de negocio en sesión
de staff`): el disparo INLINE de WhatsApp (`triggerCitasWhatsAppDispatchInline`/
`triggerHotelesWhatsAppDispatchInline`/`triggerRestaurantesWhatsAppDispatchInline`,
todos construidos sobre el `triggerInline` compartido de `apps/api/src/routes/
internal/whatsapp-dispatch.ts`) corre sobre la MISMA transacción que la ruta que
lo invoca. Con sesión de staff (`auth.uid()` no nulo), `<vertical>.
claim_messaging_outbox_batch` SIEMPRE lanza `42501` — **exactamente el mismo
guard** que ya usa `claim_email_outbox_batch` (`if auth.uid() is not null then
raise exception ... using errcode = '42501'`), correcto y necesario (la función
es cross-tenant, drena de TODAS las organizaciones; **no se afloja**). Sin un
`SAVEPOINT` alrededor, esa excepción deja la transacción COMPLETA abortada, y el
`commit;` que corre después (en `packages/db/src/managed-postgres-engine.ts`, que
nunca revisa el resultado del `commit;`) le devuelve "ROLLBACK" a Postgres en
silencio — cualquier escritura de negocio de ESE MISMO request (el cambio de
estado de un pedido, en el caso real de este hallazgo) se pierde con una
respuesta 2xx.

## Auditoría de call sites (parte 1 de la tarea)

`triggerInline` (núcleo compartido de los 3 disparadores exportados) tiene
exactamente **6 call sites** en todo el repo — las 3 verticales con agente de
WhatsApp (citas/hoteles/restaurantes; despachos/licitaciones/rentas no tienen
integración de WhatsApp saliente, solo correo):

| Call site | Sesión | ¿Vulnerable hoy? |
|---|---|---|
| `verticals/citas/whatsapp.ts` (webhook de Meta) | **Sistema** (`deps.engine.withAppSession({ userId: null }, ...)`) | Protegido por el mismo `triggerInline` (SAVEPOINT incondicional) — **corrección de wording (no bloqueante, revisión de PR #169)**: `packages/db/src/managed-postgres-engine.ts:141` corre SIEMPRE `set local role authenticated;`, también en sesión de sistema (`auth.uid()` sí queda `null` ahí, pero el ROL de Postgres es el mismo). Contra una base sin las migraciones `0{15,17,19}_messaging_outbox_dispatch_authenticated_grants.sql` (el `EXECUTE` solo estaba en `service_role`), el fallo de permisos ocurre al nivel de GRANT de Postgres ANTES de que el cuerpo de la función evalúe `auth.uid()` — así que estos 3 webhooks TAMBIÉN habrían recibido `42501` en esa base, no solo las 2 rutas de staff. El `SAVEPOINT` de `triggerInline` los cubre igual (es incondicional), pero clasificarlos "No vulnerable" subestimaba el impacto real de la base sin migrar. |
| `verticals/hoteles/whatsapp.ts` (webhook de Meta) | **Sistema** (mismo patrón) | Igual que citas — ver nota de arriba. |
| `verticals/restaurantes/whatsapp.ts` (webhook de Meta) | **Sistema** (mismo patrón) | Igual que citas/hoteles — ver nota de arriba. |
| `verticals/restaurantes/admin-orders.ts` línea ~155 (`PATCH .../admin/orders/:orderId/status`) | **Staff** (`authMiddleware` → `dbSession(deps.engine)` → `c.get("db")`, `MANAGER_ROLES`) | **SÍ, antes de este fix** — ver mecanismo abajo. |
| `verticals/restaurantes/repartidor-orders.ts` línea ~106 (`PATCH .../repartidor/orders/:orderId/status`) | **Staff** (mismo middleware, `REPARTIDOR_ROLES`) | **SÍ, antes de este fix** — mismo mecanismo. |
| `routes/internal/whatsapp-dispatch.ts` — `dispatchWhatsAppVertical` (el cron, `GET/POST /internal/whatsapp/dispatch`) | **Sistema** (`deps.engine.withAppSession({ userId: null }, ...)`, función DISTINTA de `triggerInline`, abre su propia sesión) | No aplica — no es un disparo inline, es el barrido de respaldo. |

Confirmado leyendo el código real (no solo el comentario de cabecera de
`whatsapp-dispatch.ts`, que a la fecha de esta auditoría seguía afirmando "el
único llamador es el webhook, sesión de sistema" — cierto cuando se escribió,
desactualizado desde que Fase 8 agregó `admin-orders.ts`/`repartidor-orders.ts`
sin auditar este punto, exactamente el hallazgo que motiva esta tarea).

### Por qué SÍ lanza, en las 3 combinaciones posibles del guard/migraciones

Verificado leyendo `claim_messaging_outbox_batch` de las 3 verticales
(`migrations/007_messaging_outbox*.sql` + `migrations/0{15,17,19}_messaging_
outbox_dispatch_authenticated_grants.sql`, supabase/migrations `20240101000116-
118`): las 3 tienen el guard interno `if auth.uid() is not null then raise
exception ... errcode = '42501'`. Contra la base real (que va ~30 migraciones
atrás de `main`, ver `docs/DEPLOY.md`), hay 3 escenarios posibles y los 3 abortan
la transacción igual:

1. **Base con esas migraciones aplicadas** (`GRANT EXECUTE ... TO authenticated`
   ya corrido): la función existe y es alcanzable por el rol `authenticated` —
   lanza el `raise exception` interno, SQLSTATE `42501`.
2. **Base sin esas migraciones pero con una versión anterior de la función**
   (solo `GRANT EXECUTE ... TO service_role`, el estado pre-fix documentado en el
   comentario de cabecera de esas migraciones): Postgres nunca llega a ejecutar
   el cuerpo de la función — falla en el chequeo de permisos ANTES, con
   `permission denied for function claim_messaging_outbox_batch`, SQLSTATE
   también `42501`.
3. **Base sin la función siquiera creada** (antes de `migrations/007`): SQLSTATE
   `42883` (`undefined function`).

Las 3 abortan la transacción completa igual (25P02 hasta un `ROLLBACK TO
SAVEPOINT`) — el SAVEPOINT del hotfix es correcto en los 3 casos sin necesitar
distinguir cuál aplica.

## Qué demuestra (parte 2 de la tarea)

Para **restaurantes** — el flujo REAL, no uno sintético: `restaurantes.orders`,
exactamente el `UPDATE ... SET status = ...` de
`postgres-repository.ts::updateOrderStatus`, el mismo que
`admin-orders.ts`/`repartidor-orders.ts` disparan hoy. Dos escenarios
independientes, porque el request real tiene DOS puntos donde puede abortarse
antes del `commit;` — cada uno con su propio SAVEPOINT en el código real:

1. **`claim_messaging_outbox_batch`** (el escenario original, ver bloque
   "RESTAURANTES" de `assertions.sql`): sesión de staff cambia un pedido de
   `pending` a `preparando`, llama `claim_messaging_outbox_batch` (falla
   `42501`, guard cross-tenant, correcto y necesario), y hace `commit;` sobre la
   transacción ya abortada — el cambio de estado se PIERDE (**ANTES**,
   `restaurantes_antes_status_perdido_deberia_ser_0` = 0) / PERSISTE (**DESPUÉS**,
   con `SAVEPOINT sp_inline_whatsapp_dispatch` / `ROLLBACK TO SAVEPOINT` +
   `RELEASE SAVEPOINT`, mismo patrón que
   `apps/api/src/routes/internal/whatsapp-dispatch.ts::triggerInline`,
   `restaurantes_despues_status_persiste_deberia_ser_1` = 1).
2. **`resolveActiveWhatsAppPhoneNumberId`** (Blocker A de la revisión
   independiente de PR #169, ver bloque "RESTAURANTES — Blocker A" de
   `assertions.sql`): ANTES de llegar a `claim_messaging_outbox_batch`,
   `order-notifications.ts::tryNotifyCustomerOnOrderStatusChange` (llamado desde
   `order-lifecycle.ts::changeOrderStatus`, ANTES de `triggerInline`) hace
   `select phone_number_id from restaurantes.whatsapp_channel_config where
   organization_id = $1` (`postgres-repository.ts:631`). Esa tabla no tuvo
   `GRANT select` a `authenticated` hasta
   `supabase/migrations/20240101000140_017_restaurantes_sistema_whatsapp_channel_config.sql`
   — el fixture lo reproduce con un `revoke select ... from authenticated;`
   antes del escenario (la base real va detrás de esa migración). El escenario
   **DESPUÉS** cubre el flujo completo de un solo request: UPDATE +
   SELECT de canal (falla `42501`, absorbido con
   `SAVEPOINT sp_order_notify_best_effort`) + `claim_messaging_outbox_batch`
   (falla `42501`, absorbido con el `SAVEPOINT sp_inline_whatsapp_dispatch` de
   `triggerInline`) + `commit;` — el cambio de estado PERSISTE
   (`restaurantes_blocker_a_despues_status_persiste_deberia_ser_1` = 1) pese a
   que AMBOS best-effort de esta request fallaron.

Para **citas** (`citas.providers`) y **hoteles** (`hoteles.guest`) — mismo
mecanismo del escenario 1, defensa en profundidad: hoy ningún call site de
citas/hoteles invoca su `triggerXWhatsAppDispatchInline` en sesión de staff
(solo el webhook, sesión de sistema, ver tabla de arriba), pero comparten el
mismo `triggerInline` — este verify prueba que el mecanismo SQL también los
protege si un call site de staff se agrega ahí en el futuro, sin tener que
tocar este archivo.

Este verify demuestra el mecanismo a nivel SQL (idéntico al que ejecutan
`triggerInline` y `order-notifications.ts::runNotifyBestEffort` vía
`db.exec(...)` sobre `c.get("db")`); los tests unitarios
(`apps/api/tests/whatsapp-inline-dispatch-savepoint.spec.ts` para
`triggerInline`, `packages/domain-restaurantes/tests/
order-notifications-savepoint.spec.ts` para el SAVEPOINT de
`tryNotifyCustomerOnOrderStatusChange`) cubren la capa TypeScript con un doble
de sesión que reproduce el estado abortado real (`AbortAwareFakeSession` — a
diferencia del doble usado en `restaurantes-email-dispatch-savepoint.spec.ts`
de PR #166, este SÍ pone `aborted = true` en el propio mock ANTES de lanzar, y
el test afirma que una consulta POSTERIOR al trigger resuelve, no solo que la
secuencia de `exec()` fue la esperada).

## Cómo correrlo

```
scripts/verify-whatsapp-inline-sesion-staff/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente, p. ej.
`brew install postgresql@17`). Levanta un cluster Postgres efímero en un
directorio temporal (puerto `55467`, propio -- no bloqueante de la revisión de
PR #169: el `55434` original chocaba con
`verify-superadmin-caller-binding/run.sh` si ambos corrieran en paralelo en la
misma máquina), aplica todas las migraciones reales de `supabase/migrations/` en
orden, corre los escenarios de `assertions.sql`, y apaga/borra el cluster al
salir — no toca ningún Postgres existente ni dato real.

## CI

Mismo contrato de 3 archivos (`bootstrap.sql` + `post-migrations.sql` +
`assertions.sql`) que el resto de `scripts/verify-*/` — `scripts/verify-real-
postgres-ci/run-gate.mjs` lo descubre solo (no hace falta tocar el workflow) y lo
corre en `.github/workflows/postgres-real-gate.yml` en cada PR/push.

## Por qué no es parte de `npm test`

Igual que el resto de `scripts/verify-*/` contra Postgres real (ver el README de
`verify-outbox-grants` para el detalle) — este monorepo no tiene todavía un tier
de pruebas contra Postgres real dentro de `vitest`.

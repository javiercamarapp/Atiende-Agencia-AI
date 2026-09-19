# verify-restaurantes-sql

Verificación contra Postgres **real** de las RPC y reglas SQL que
`packages/domain-restaurantes/src/postgres-repository.ts` usa de verdad — el hueco
que la auditoría del 18-sep-2026 señaló para restaurantes: "puerto completo y
probado (443 tests); único hueco real: nunca se prueba el repositorio Postgres
contra SQL real (todos los tests corren contra el repositorio en memoria)". Corre a
mano vía `run.sh` y automáticamente en cada PR/push vía
`.github/workflows/postgres-real-gate.yml`.

## Qué demuestra (22 escenarios)

1. **`create_order_idempotent`** (`migrations/003`, grants reales en
   `migrations/013_rpc_anti_duplicado_authenticated_grants.sql`) — escenarios 1-4:
   solo la sesión de sistema puede crearlo (staff real se rechaza), el mismo
   `idempotency_key` + mismo payload devuelve el MISMO pedido sin duplicar fila, y
   reutilizar el mismo `idempotency_key` con un payload distinto se rechaza (PT409).
2. **`calc_customer_tier`** (`migrations/002`, cortes 95/90/70) — escenario 5: el
   cliente de mayor gasto cae en `BLACK`.
3. **`restaurantes.known_zone` / `nearest_branch_by_colonia`** (`migrations/005`) —
   escenarios 6-7. Ver la sección de hallazgos abajo: esta migración corrige un GAP
   real (GRANT+policy faltantes), pero el flujo completo de punta a punta sigue
   bloqueado por una causa DISTINTA y documentada, no corregida aquí.
4. **Append atómico + rate-limit de WhatsApp** (`migrations/004`) — escenarios 8-12:
   `whatsapp_append_turn` acumula turnos atómicamente y rechaza a staff real (solo
   sistema); `claim_whatsapp_message` deduplica at-least-once (un segundo claim
   inmediato del mismo `message_id` se rechaza); `consume_api_rate_limit` rechaza la
   petición que rebasa `max_requests` dentro de la ventana.
5. **Asignación de repartidor** (`migrations/008`) + guarda TOCTOU de
   `updateOrderStatus`/`updateAssignedOrderStatus` — escenarios 13-15: staff de la
   organización dueña sí asigna, staff de otra organización no (RLS), y un UPDATE
   con `fromStatus` ya obsoleto actualiza CERO filas (nunca pisa un estado que ya
   cambió por otra escritura concurrente).
6. **Promociones** (`migrations/010`) — escenarios 16-17:
   `increment_promotion_uses` incrementa bajo el tope y, con dos intentos
   casi-simultáneos ya en el tope (concurrencia simulada dentro de la misma
   transacción), el UPDATE atómico `where ... and times_used < max_uses` nunca lo
   rebasa — `times_used` queda exactamente en 2, no en 3.
7. **Notificaciones de pedido** (`migrations/009`) — escenario 18:
   `enqueue_staff_order_notification` es idempotente por
   `(organization_id, order_id, event_type)` — un reintento nunca duplica la fila.
8. **KPIs agregados** (`migrations/006`, `security invoker`) — escenarios 19-20:
   staff de la organización dueña ve sus totales reales; staff de OTRA organización
   pasando el `organization_id` ajeno como parámetro obtiene TODO en cero — la
   protección real es el RLS de la tabla base (`restaurantes.orders`), no el
   parámetro de la función.
9. **Aislamiento cross-tenant básico** — escenarios 21-22: staff de otra
   organización no ve ni pedidos ni clientes ajenos vía RLS directa.

## Bug real corregido: `restaurantes.known_zone` sin GRANT ni policy

`packages/domain-restaurantes/migrations/016_known_zone_authenticated_grant.sql`
(mirror: `supabase/migrations/20240101000133_...`). `known_zone` (migrations/005)
se creó con `enable row level security` pero **sin ningún GRANT ni policy** — a
diferencia de TODAS las demás tablas del paquete. `nearest_branch_by_colonia()` no
es `security definer`, así que corre con los permisos del rol invocador
(`authenticated`, siempre — ver `managed-postgres-engine.ts::withAppSession`).
Verificado contra Postgres real, ANTES del fix: cualquier llamada fallaba con
`permission denied for table known_zone`. El GRANT solo no habría bastado (también
verificado): con RLS habilitada y CERO policies, el acceso se deniega por default
incluso con GRANT — el resultado habría sido 0 filas SIEMPRE, en silencio,
indistinguible del "cero-match real" que la función ya documenta como contrato. El
fix agrega el GRANT SELECT a `authenticated` + una policy con el MISMO criterio ya
usado por `014_catalogo_publico_scoped.sql` (sesión de sistema O membership real de
la organización dueña — nunca `using (true)`, que reabriría la misma fuga
cross-tenant que esa migración cerró).

## Hallazgo conocido, verificado, NO corregido en esta rama: `core.property` sin
## escape hatch de sesión de sistema

Verificado contra Postgres real (reproducible con el propio `run.sh`/`--keep-db`):
incluso DESPUÉS del fix de `known_zone` de arriba,
`restaurantes.nearest_branch_by_colonia()` de punta a punta sigue devolviendo 0
filas bajo sesión de sistema, porque la función hace `join core.property p on
p.id = bd.property_id`, y la policy de SELECT de `core.property`
(`packages/db/migrations/0001_core_schema.sql`, nunca tocada por ninguna migración
posterior) es:

```sql
create policy "staff ve properties de su organización"
  on core.property for select
  using (core.has_property_access(auth.uid(), core.property.id));
```

`core.has_property_access` exige una fila de `core.membership` con
`user_id = auth.uid()` — con `auth.uid() IS NULL` (sesión de sistema) esto NUNCA
matchea, así que **cualquier consulta bajo sesión de sistema que haga JOIN contra
`core.property` devuelve cero filas de property**, sin importar el GRANT ni el
resto de policies.

**Impacto real, verificado directamente con `psql` reproduciendo la sesión exacta
de `withAppSession({userId:null})`:** esto no es exclusivo de
`nearest_branch_by_colonia` — `PostgresRestaurantesRepository.findBranch()`
(`postgres-repository.ts`, usada por `orders.ts::prepareCreateOrder` — el corazón
de CUALQUIER creación de pedido) hace exactamente el mismo JOIN. Bajo sesión de
sistema (el checkout público real: web/voz/WhatsApp, `apps/api/src/routes/
verticals/restaurantes/public.ts` y `voice-tools.ts`, siempre
`withAppSession({userId:null})`), `findBranch()` **también devuelve `null`
siempre**, y `prepareCreateOrder` lo traduce en
`OrderValidationError("Sucursal '...' no encontrada o inactiva")` — es decir, **la
creación de pedidos vía checkout público (web, voz, WhatsApp) para restaurantes
está rota de punta a punta contra Postgres real, para CUALQUIER organización**, y
ningún test de este repo puede verlo (el repositorio en memoria nunca aplica RLS de
`core.property`).

**Por qué NO se corrige en esta rama** (regla explícita de la tarea: "si un
hallazgo exige una decisión de diseño grande, documéntalo como fallo conocido, no
lo disfraces de should_fail"): `core.property` es una tabla `core` compartida por
las 6 verticales (hoteles/citas/rentas/licitaciones/despachos/restaurantes) — un
cambio a su RLS no es una decisión de "solo restaurantes", afecta a cualquier otra
vertical con un flujo público/de sistema equivalente, y otra rama trabaja en
paralelo sobre partes adyacentes del monorepo (facturación/billing, prefijo
`...000132`). Agregar el mismo escape hatch `auth.uid() is null or
core.has_property_access(...)` ya usado consistentemente en el resto del repo
(`hoteles.night_audit_run`, las policies de cron de rentas, y el propio
`restaurantes.known_zone` de este PR) es la corrección obviamente correcta, pero
es una decisión de plataforma, no de este script.

El escenario 6 de `assertions.sql` por eso NO ejercita
`nearest_branch_by_colonia()` de punta a punta (seguiría fallando por esta causa
ajena al fix de `known_zone`) — verifica en su lugar, aislado, que la pieza que SÍ
se corrige en esta rama (GRANT+policy de `known_zone`) funciona.

## Contraste repositorio TypeScript ↔ SQL

Se revisó `packages/domain-restaurantes/src/postgres-repository.ts` completo contra
la ÚLTIMA versión de cada función SQL que invoca (`create_order_idempotent`,
`calc_customer_tier`, `nearest_branch_by_colonia`, las 5 funciones de WhatsApp
atómico/rate-limit, el dispatcher de `messaging_outbox`/email outbox,
`increment_promotion_uses`, `enqueue_staff_order_notification`, los 5 agregados de
KPIs de `migrations/006`): nombres, número/orden de parámetros y columnas
coinciden en todos los métodos revisados. Sin descuadres repositorio↔SQL
encontrados en esta pasada.

## Sobre un smoke test del repositorio TypeScript contra Postgres real

Verificado (`grep -rln "embedded-postgres|pglite|PG_TEST_URL"`): este repo NO tiene
ningún mecanismo existente para correr `PostgresRestaurantesRepository` (ni ningún
otro `postgres-repository.ts`) contra una base real desde `vitest` — solo
comentarios en `packages/db/src/{in-memory-tenancy-engine,core-repository}.ts` que
documentan la ausencia ("Aún no portado"). Por instrucción explícita de esta tarea,
no se agrega una dependencia nueva (embedded-postgres/PGlite) solo para esto — el
alcance de esta verificación queda limitado a los scripts SQL de este directorio +
el contraste estático de arriba.

## Cómo correrlo

```
scripts/verify-restaurantes-sql/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH.

## CI

Corre automáticamente en cada PR/push vía `scripts/verify-real-postgres-ci/
run-gate.mjs` + `.github/workflows/postgres-real-gate.yml`.

## Por qué no es parte de `npm test`

Mismo criterio que `scripts/verify-outbox-grants/README.md` — ver esa sección.

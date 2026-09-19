# verify-caller-binding-fase2

Verificación, contra un Postgres **real**, de la Fase 2 del hallazgo de
seguridad de `packages/db/migrations/0011_superadmin_caller_binding.sql`
(Fase 1: las 12 funciones `core.*_for_superadmin`). Esta fase cierra el mismo
patrón — función `security definer`, `grant execute ... to authenticated`, un
parámetro plano de identidad/alcance sin atar a `auth.uid()` (o, para el
puñado de funciones genuinamente pre-autenticación, sin ningún guard de "solo
sesión de sistema") — en 14 funciones más del esquema `core`, corregidas por
`packages/db/migrations/0012_caller_binding_fase2.sql`:

| Función | Migración fuente | Clase | Guard nuevo |
|---|---|---|---|
| `revoke_refresh_token` | `0003_refresh_token_revocation.sql` | B (sistema) | `auth.uid() is null` |
| `revoke_all_refresh_tokens` | `0006_revoke_all_sessions.sql` | C (self) | `auth.uid() = p_user_id` |
| `is_platform_superadmin` | `0010_platform_superadmin.sql` | C (self) | `auth.uid() = p_staff_id` |
| `get_organization_billing_for_checkout` | `0009_billing_saas_schema.sql` | C (self) | `auth.uid() = p_caller_id` |
| `get_organization_billing_for_webhook` | `0009_billing_saas_schema.sql` | B (sistema) | `auth.uid() is null` |
| `upsert_organization_billing` | `0009_billing_saas_schema.sql` | B (sistema) | `auth.uid() is null` |
| `list_notifications_for_staff` | `0013_notifications_schema.sql` | C (self) | `auth.uid() = p_staff_id` |
| `count_unread_notifications_for_staff` | `0013_notifications_schema.sql` | C (self) | `auth.uid() = p_staff_id` |
| `mark_notification_read` | `0013_notifications_schema.sql` | C (self) | `auth.uid() = p_staff_id` |
| `mark_all_notifications_read` | `0013_notifications_schema.sql` | C (self) | `auth.uid() = p_staff_id` |
| `link_google_identity` | `0008_staff_google_identity.sql` | A (pre-auth) | `auth.uid() is null` |
| `find_staff_by_google_sub` | `0008_staff_google_identity.sql` | A (pre-auth) | `auth.uid() is null` |
| `create_magic_link_token` | `0009_magic_link_login.sql` | A (pre-auth) | `auth.uid() is null` |
| `create_auth_exchange_code` | `0008_auth_exchange_code.sql` | A (pre-auth) | `auth.uid() is null` |

Ver el comentario de cabecera de `0012_caller_binding_fase2.sql` para el
razonamiento completo de cada una (incluido el inventario de por qué el resto
de funciones `security definer` con un parámetro de identidad/alcance de
`supabase/migrations/` — las RPC anti-duplicado de citas/hoteles/restaurantes,
`enqueue_messaging_outbox`/`claim_email_outbox_batch`/`complete_email_outbox_job`
de las 6 verticales, `list_org_members(_by_vertical_role)`,
`update_membership_role`, `create_owner_portal_invite` — ya estaban
protegidas, "Clase D").

## Qué demuestra

Cada función tiene un escenario POSITIVO (el caller legítimo — su único call
site real hoy en `apps/api` — sigue funcionando exactamente igual) y uno
NEGATIVO (el hueco real que este fix cierra: otra sesión `authenticated` real,
o una sesión de sistema cuando corresponde, pasando el mismo id/alcance que
antes de este fix SÍ hubiera funcionado). Más un representante de `anon` sin
acceso por grupo (las 14 comparten el mismo `revoke all ... from public;
grant execute ... to authenticated;` heredado sin cambios de su migración
original).

Bono: escribir el escenario positivo de `get_organization_billing_for_checkout`
expuso un bug PREEXISTENTE (nunca antes ejercitado contra Postgres real, ver
el comentario de esa función en `0012_caller_binding_fase2.sql`) — un
`where organization_id = ...` ambiguo entre la columna de `core.membership` y
la columna de salida de `returns table (organization_id uuid, ...)` que
rompía la ruta legítima para TODO caller. Se corrigió en la misma migración
con el alias `m.` (mismo patrón que `core.update_membership_role` ya
documentaba).

## Cómo correrlo

```
scripts/verify-caller-binding-fase2/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente, p.
ej. `brew install postgresql@17`). Mismo mecanismo que
`scripts/verify-superadmin-caller-binding/run.sh`: levanta un cluster Postgres
efímero, aplica las migraciones reales de `supabase/migrations/` en orden,
corre los 34 escenarios de `assertions.sql`, y apaga/borra el cluster al
salir.

## CI

Este script (`bootstrap.sql` + `post-migrations.sql` + `assertions.sql`) corre
en CI automáticamente, en cada PR/push — `scripts/verify-real-postgres-ci/
run-gate.mjs` lo descubre solo (cualquier `scripts/verify-*/` con esos 3
archivos), sin tocar el workflow. Corrida local contra Postgres real (Postgres
17 vía Homebrew) el 19-sep-2026: **34/34 escenarios OK**, y el gate completo
(`run-gate.mjs` sin argumento, las 5 verificaciones de `scripts/verify-*/`
existentes) también en verde — sin regresiones sobre
`verify-superadmin-caller-binding`/`verify-llm-usage-budget-guard`/
`verify-outbox-grants`/`verify-rentas-cron-rls`.

## Por qué no es parte de `npm test`

Mismo motivo que `scripts/verify-superadmin-caller-binding/README.md`: este
monorepo no tiene todavía ningún tier de pruebas contra Postgres real dentro
de `npm test`/`vitest` — `InMemoryCoreRepository` nunca aplica `GRANT`/
`auth.uid()` reales, así que no puede detectar este tipo de hueco por diseño.

## Fuera de alcance de esta migración (documentado, no ignorado)

Se encontraron hallazgos DEL MISMO PATRÓN en esquemas de vertical, fuera de
`core`:

- `despachos.record_audit_log` (`008_despachos_audit_log.sql`) — sin ningún
  guard, `p_actor_user_id`/`p_organization_id` explícitos, GRANT a
  `authenticated`; su único call site real (`ProductionDespachosAuditSink`) ya
  corre siempre en sesión de sistema.
- `hoteles.record_fraude_audit_log` (`017_fraude_audit_log.sql`) — mismo
  patrón, mismo tipo de call site único en sesión de sistema.
- `restaurantes.enqueue_staff_order_notification`
  (`009_order_notifications.sql`) y `restaurantes.increment_promotion_uses`
  (`010_promotions.sql`) — mismo patrón, ambas con único call site en
  `createOrder` (checkout público, sesión de sistema).
- `rentas.find_owner_credential_by_email` (`013_owner_portal_security_
  definer.sql`) — devuelve `password_hash` en texto (columna hasheada, pero
  el hash en sí) para CUALQUIER `authenticated` que la invoque por RPC
  directo; su único call site real (login del portal de propietario) ya corre
  siempre en sesión de sistema — candidata al mismo guard `auth.uid() is
  null` que `core.create_magic_link_token`.
- `rentas.revoke_owner_refresh_token` (`017_owner_portal_refresh_revocation.
  sql`) — mismo patrón que `core.revoke_all_refresh_tokens`, con la ventaja
  de que su único call site YA abre la sesión como el owner real
  (`withAppSession({ userId: ownerId })`) — el fix sería puramente SQL, cero
  cambio de TypeScript.

Los seis quedan FUERA de esta migración a propósito: cada uno vive en un
paquete de dominio distinto (`packages/domain-despachos/migrations/`,
`packages/domain-hoteles/migrations/`, `packages/domain-restaurantes/
migrations/`, `packages/domain-rentas/migrations/`), y el espejo de
`supabase/migrations/` exige que cada archivo mirror tenga una fuente
byte-idéntica en SU paquete (`scripts/verify-migration-versions/README.md`) —
arreglarlos exigiría un archivo/prefijo de timestamp propio por paquete, y
esta tarea tiene instrucción explícita de usar EXACTAMENTE el prefijo
`20240101000128` para un solo archivo (`core`, mismo paquete que la Fase 1).
Se reportan aquí como hallazgo relacionado para una PR de seguimiento
dedicada, mismo criterio que esta misma investigación ya aplicó a
`get_organization_billing_for_checkout` en la Fase 1 (`scripts/verify-
superadmin-caller-binding/README.md`, sección "Fuera de alcance" — ese
hallazgo específico SÍ se cerró aquí).

`core.has_property_access`/`core.get_organization_billing_info` se revisaron
y se dejan sin cambio: son primitivas INTERNAS (la primera, usada dentro de
~40 policies RLS de las 6 verticales vía `core.has_property_access(auth.uid(),
property_id)`, nunca invocada con un `auth.uid()` ajeno desde código de la
aplicación; la segunda, sin GRANT directo a `authenticated`, solo alcanzable
por las dos funciones de arriba que ya validan por su cuenta) — no son una
superficie de API con contrato propio.

# verify-caller-binding-fase3

Verificación, contra un Postgres **real**, de la Fase 3 del hallazgo de
seguridad de `packages/db/migrations/0011_superadmin_caller_binding.sql`
(Fase 1) / `0012_caller_binding_fase2.sql` (Fase 2): función `security
definer`, `grant execute ... to authenticated`, un parámetro plano de
identidad/alcance sin atar a la sesión (`auth.uid()`). Esta fase cierra lo
que la Fase 2 dejó documentado como "fuera de alcance" en
`scripts/verify-caller-binding-fase2/README.md`:

1. **`core.find_staff_by_email`/`find_staff_by_id`/`find_memberships_by_
   user_id`** (`packages/db/migrations/0011_login_lookup_security_
   definer.sql`) — se usaban en dos contextos sin distinguirlos: login/
   refresh/magic-link/Google (pre-autenticación, sesión de sistema) y
   administración de staff de las 5 verticales con alta de staff
   (`admin-staff.ts` busca a OTRO usuario por correo). `packages/db/
   migrations/0016_caller_binding_fase3.sql`:
   - Blinda las tres funciones originales con un guard de solo-sistema
     (`auth.uid() is not null -> raise ... 42501`) — seguro porque
     `ProductionCoreRepository` (verificado call site por call site) las
     invoca SIEMPRE con `withAppSession({ userId: null })`, sin importar
     qué identidad reciban como argumento.
   - Agrega `core.find_staff_for_org_admin(organization_id, email)` y
     `core.is_staff_org_member_for_org_admin(organization_id,
     target_user_id)` — exigen `auth.uid()` no nulo Y que sea owner/admin
     de `organization_id` (mismo umbral que `core.update_membership_role`),
     devuelven SOLO id/email/full_name (nunca `password_hash`), y las usan
     los 5 `admin-staff.ts` vía `deps.coreStaffRepo(c.get("db"))` (sesión
     real por-request) en vez de `deps.coreRepo` (sesión de sistema fija).

2. **Seis funciones señaladas por el README de la Fase 2**, una migración
   nueva por vertical (mismo paquete de dominio que cada una, prefijo propio
   — ver `scripts/verify-migration-versions/README.md` para por qué no
   pueden compartir archivo con `core`):
   - `packages/domain-despachos/migrations/010_despachos_caller_binding_
     fase3.sql` — `despachos.record_audit_log`: Clase B (solo sistema, único
     caller real `ProductionDespachosAuditSink`, sesión de sistema
     verificada).
   - `packages/domain-hoteles/migrations/023_hoteles_caller_binding_
     fase3.sql` — `hoteles.record_fraude_audit_log`: Clase B, mismo
     criterio (`ProductionHotelesFraudeAuditSink`).
   - `packages/domain-restaurantes/migrations/018_restaurantes_caller_
     binding_fase3.sql`:
     - `restaurantes.enqueue_staff_order_notification`: el README de la
       Fase 2 la daba por Clase B ("único call site en createOrder"), pero
       un re-audit de call sites (esta fase) encontró que la Fase 12
       (asignación de repartidor) agregó DOS callers autenticados reales
       más (`admin-orders.ts`/`repartidor-orders.ts`) — un guard de solo-
       sistema los habría roto. Guard nuevo, org-scoped: sesión de sistema
       sin restricción (createOrder), sesión autenticada real exige
       membership en `p_organization_id` (mismo criterio que la policy de
       SELECT de la propia tabla).
     - `restaurantes.increment_promotion_uses`: Clase B confirmada (único
       caller real `createOrder`, sesión de sistema).
   - `packages/domain-rentas/migrations/019_rentas_caller_binding_
     fase3.sql`:
     - `rentas.find_owner_credential_by_email`: Clase A (pre-auth, solo
       sistema — único caller real `POST .../owner-portal/auth/login`).
     - `rentas.revoke_owner_refresh_token`: Clase C (self) — su único
       caller real YA abría la sesión como el propietario real
       (`withAppSession({ userId: ownerId })`); el fix es puramente SQL
       (`auth.uid() = p_owner_id`), sin cambio de TypeScript.

3. **Barrido de las migraciones agregadas después de la Fase 2**
   (`...000129` a `...000142`, 13 archivos): todas las funciones `security
   definer` nuevas con `grant execute ... to authenticated` ya traían el
   guard correcto (`auth.uid() is not null -> raise ... 42501` de solo-
   sistema, o `auth.uid() is null or auth.uid() <> p_caller_id -> raise` de
   self-binding) desde que se escribieron — cero hallazgos nuevos. No
   generó ninguna migración adicional.

## Qué demuestra

Un escenario POSITIVO (el caller legítimo sigue funcionando exactamente
igual) y uno NEGATIVO (el hueco real que este fix cierra) por función, más:

- `find_staff_for_org_admin`/`is_staff_org_member_for_org_admin`: un admin
  de una organización NUNCA puede buscar/verificar staff de OTRA
  organización (escenarios 11/17), un miembro sin rango de admin es
  rechazado (10/16), y ninguna de las dos devuelve `password_hash` —
  probado ESTRUCTURALMENTE (escenario 13: `select password_hash from
  core.find_staff_for_org_admin(...)` falla con "column does not exist",
  la columna ni siquiera existe en el tipo de retorno).
- `enqueue_staff_order_notification`: un caller autenticado de la
  organización A no puede inyectar una notificación falsa en la bandeja de
  la organización B (escenario 26), mientras el checkout público (sesión
  de sistema) y el staff real de esa misma organización (admin/repartidor)
  siguen funcionando sin cambio (24/25).
- Representante de `anon` sin acceso por función tocada.
- Escenario 8: recorrido SQL completo de login bajo sesión de sistema
  (`find_staff_by_email` + `find_memberships_by_user_id` encadenadas, el
  mismo par que ejecuta `POST /auth/login` real).

## Cómo correrlo

```
scripts/verify-caller-binding-fase3/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH (Postgres instalado localmente).
Mismo mecanismo que `scripts/verify-caller-binding-fase2/run.sh`: levanta un
cluster Postgres efímero, aplica las migraciones reales de `supabase/
migrations/` en orden, corre los 37 escenarios de `assertions.sql`, y
apaga/borra el cluster al salir.

## CI

Este script (`bootstrap.sql` + `post-migrations.sql` + `assertions.sql`)
corre en CI automáticamente, en cada PR/push —
`scripts/verify-real-postgres-ci/run-gate.mjs` lo descubre solo. Corrida
local contra Postgres real (Postgres 17 vía Homebrew) el 19-sep-2026:
**37/37 escenarios OK**, y el gate completo (`run-gate.mjs` sin argumento,
las 16 verificaciones de `scripts/verify-*/` existentes, 327 escenarios en
total) también en verde — sin regresiones sobre ninguna de las
verificaciones de fases anteriores (`verify-caller-binding-fase2`,
`verify-superadmin-caller-binding`, `verify-core-rls-sesion-sistema`,
`verify-flujos-sistema`/`-2`, y el resto).

## Por qué no es parte de `npm test`

Mismo motivo que `scripts/verify-superadmin-caller-binding/README.md`: este
monorepo no tiene todavía ningún tier de pruebas contra Postgres real dentro
de `npm test`/`vitest` — `InMemoryCoreRepository` nunca aplica `GRANT`/
`auth.uid()` reales, así que no puede detectar este tipo de hueco por
diseño.

## Orden de despliegue

- Guard de solo-sistema en `find_staff_by_email`/`find_staff_by_id`/
  `find_memberships_by_user_id`, `despachos.record_audit_log`, `hoteles.
  record_fraude_audit_log`, `restaurantes.increment_promotion_uses`,
  `rentas.find_owner_credential_by_email`: compatibles con el código VIEJO
  Y el nuevo (todos sus callers reales ya corren en sesión de sistema hoy);
  la migración puede aplicarse en cualquier orden relativo al deploy de
  `apps/api`.
- `restaurantes.enqueue_staff_order_notification`: mismo criterio — sus
  callers reales (sistema y autenticados) ya pasan `p_organization_id`
  real, el guard nuevo solo restringe un caso que ningún caller legítimo
  ejercita.
- `rentas.revoke_owner_refresh_token`: mismo criterio — su único caller ya
  abre la sesión como el propietario real.
- `core.find_staff_for_org_admin`/`core.is_staff_org_member_for_org_admin`
  (funciones NUEVAS): el código de `admin-staff.ts` que las llama debe
  desplegarse DESPUÉS (o en el mismo deploy) que esta migración — si el
  código nuevo llegara antes, esas dos llamadas fallarían (función
  inexistente) en vez de degradar. Ver el comentario de cabecera de
  `packages/db/migrations/0016_caller_binding_fase3.sql`.

## Fuera de alcance de esta fase (documentado, no ignorado)

- `apps/api/src/routes/verticals/hoteles/asistencia.ts` (`GET .../fraude/
  cross-check`, exporta CSV de asistencia): usa `deps.coreRepo.
  findStaffById(staffUserId)` con un `staffUserId` de query param, sin
  verificar que ese staff pertenezca a la MISMA organización/property del
  admin que exporta — el guard nuevo de `find_staff_by_id` no rompe este
  call site (sigue en sesión de sistema) ni lo hace MÁS seguro: cierra el
  bypass por RPC directo, pero la falta de scoping por-organización en la
  capa TS de esa ruta concreta es un hallazgo DISTINTO (autorización de
  negocio, no caller-binding de una función `security definer`), fuera del
  alcance de esta pasada — candidato a una PR de seguimiento dedicada.

# verify-core-rls-sesion-sistema

Verificación contra Postgres **real** del hallazgo MÁS GRAVE documentado hasta ahora
en este repo (visto por primera vez en `scripts/verify-restaurantes-sql/README.md`,
PR #138, sección "Hallazgo conocido, verificado, NO corregido en esta rama"): las
policies de SELECT de `core.organization`/`core.property`
(`packages/db/migrations/0001_core_schema.sql`, nunca redefinidas salvo la policy
ADITIVA de `owner_portal_core_organization_policy.sql`, que no la reemplaza)
exigían `auth.uid()` no nulo. Bajo **sesión de sistema**
(`packages/db/src/managed-postgres-engine.ts::withAppSession({ userId: null })`,
usada por TODOS los flujos sin usuario de las 6 verticales: checkout público,
Server Tools de voz, webhooks de WhatsApp/CFDI, crons y dispatchers), `auth.uid()`
es SIEMPRE `NULL` — así que cualquier lectura o JOIN directo contra esas dos tablas
devolvía **CERO filas SIEMPRE, en silencio** (nunca un error visible).

Corre a mano vía `run.sh` y automáticamente en cada PR/push vía
`.github/workflows/postgres-real-gate.yml` (descubierto solo por
`scripts/verify-real-postgres-ci/run-gate.mjs`).

## El fix

`packages/db/migrations/0015_core_rls_sesion_sistema.sql` (mirror byte-idéntico:
`supabase/migrations/20240101000136_0015_core_rls_sesion_sistema.sql`) reemplaza
SOLO las dos policies de SELECT afectadas (`drop policy if exists` + `create
policy` con el MISMO nombre), agregando `auth.uid() is null or` delante de la regla
ya existente:

```sql
create policy "staff ve su propia organización"
  on core.organization for select
  using (
    auth.uid() is null
    or exists (select 1 from core.membership m where m.organization_id = core.organization.id and m.user_id = auth.uid())
  );

create policy "staff ve properties de su organización"
  on core.property for select
  using (auth.uid() is null or core.has_property_access(auth.uid(), core.property.id));
```

Sin cambios de GRANT (ya existía `grant select ... to authenticated` desde
`0001_core_schema.sql`; ni `core.organization` ni `core.property` otorgan acceso a
`anon`, y este fix no lo agrega). Sin cambios de TypeScript — el bug era
exclusivamente de RLS; las queries que los repositorios `postgres-repository.ts` de
las 6 verticales ya ejecutaban eran (y siguen siendo) correctas.

### Decisión de diseño: por qué `core.organization`/`core.property` sí, y
### `core.membership`/`core.staff_user` NO

Dos caminos posibles, con riesgo NO equivalente (ver el análisis ya hecho en
`scripts/verify-superadmin-caller-binding/README.md` y la cabecera de
`supabase/migrations/20240101000127_0011_superadmin_caller_binding.sql`):

- **(A) Escape hatch en la policy** (`auth.uid() is null or <regla actual>`) —
  amplía lo que ve CUALQUIER sesión de sistema a TODA la tabla, para TODAS las
  organizaciones. Ya es el patrón establecido de este repo para datos de catálogo
  de bajo riesgo: `restaurantes.known_zone`
  (`..._016_known_zone_authenticated_grant.sql`),
  `restaurantes.categories/products/branch_products/branch_detail`
  (`..._014_catalogo_publico_scoped.sql`), y 9 tablas de `rentas.*`
  (`..._015_cron_publico_rls_escape_hatch.sql`).
- **(B) Función `security definer` acotada**, con guard explícito de solo-sistema —
  patrón YA usado en este repo exactamente para lo sensible: login
  (`core.find_staff_by_email`/`find_staff_by_id`/`find_memberships_by_user_id`,
  `...000113_0011_login_lookup_security_definer.sql`, motivado por el MISMO
  síntoma — "ningún login funcionaba nunca" — que este hallazgo, pero sobre
  `core.staff_user`/`core.membership`) y alta de tenant
  (`rentas.register_tenant_onboarding`, que SÍ escribe en
  `core.organization`/`core.property`/`core.membership` bajo sesión de sistema sin
  abrir RLS de esas tablas).

El análisis de `...000127` (verificado de nuevo aquí, sin contradecirlo) concluye:
`supabase/config.toml::api.schemas` expone el schema `core` por PostgREST, pero HOY
ningún flujo real de este repo emite a un cliente externo un JWT de Supabase Auth
con rol `authenticated` (`apps/web` nunca usa Supabase Auth; el único cliente
`@supabase/supabase-js` — `realtime-client.ts` de citas — solo abre un WebSocket de
Realtime con un JWT PROPIO sin claim `role`, nunca invoca `.rpc()`/REST) — un
cliente externo no puede HOY obtener una sesión `authenticated` con `auth.uid()`
NULL vía PostgREST, pero es "una configuración de distancia" (alineación de
"Third-Party Auth" que el código ya prepara activamente para Realtime). Por eso,
tabla por tabla:

- **`core.property`/`core.organization` → camino (A).** Datos de catálogo sin PII
  (id/organization_id/vertical/name/slug/status) — el mismo perfil de riesgo que
  `restaurantes.categories/products` (que además exponen lo mismo a `anon`, sin ni
  siquiera exigir rol `authenticated`). Coherente con el precedente ya establecido
  tres veces en este repo para exactamente este perfil de dato. Universal entre las
  6 verticales (a diferencia de una tabla de una sola vertical) — una función
  `security definer` distinta por vertical sería 6 veces el mismo remedio para el
  mismo problema; la policy compartida en `core` es la superficie correcta para
  arreglarlo una sola vez.
- **`core.membership`/`core.staff_user` → SIN CAMBIO.** Son las dos tablas `core`
  genuinamente sensibles — `membership` expone la estructura organizacional
  completa de la plataforma (qué usuario pertenece a qué organización, con qué
  rol); `staff_user` expone `email` + `password_hash` de TODO staff de TODA
  organización. Exactamente el perfil que el criterio de la tarea marca como "mala
  idea" para el camino (A). Se auditaron los call sites de sesión de sistema de las
  6 verticales (ver la tabla en el PR) y ninguno necesita hoy un SELECT directo
  nuevo contra estas dos tablas que no esté ya cubierto por una función `security
  definer` existente (`core.find_staff_by_email`/`find_staff_by_id`/
  `find_memberships_by_user_id`/`find_staff_by_google_sub`, y las funciones
  `*_for_superadmin` ya atadas a `auth.uid() = p_caller_id` desde `...000127`). Si
  un flujo futuro de sistema necesita un lookup puntual de membership/staff_user,
  el remedio es una función `security definer` nueva y acotada (camino B), nunca
  abrir estas dos tablas completas a sesión de sistema — los escenarios 14-15 de
  `assertions.sql` son un guard de regresión explícito para esto: si algún cambio
  futuro le agregara un escape hatch a `core.membership`/`core.staff_user` por
  error, este script empezaría a fallar.

## Qué demuestra (15 escenarios)

Fixtures: una organización + una property activa por cada una de las 6
verticales, más una segunda organización de restaurantes ("B") para el escenario
de aislamiento cross-tenant, y `restaurantes.branch_detail`/`restaurantes.customers`
mínimos para poder ejercitar el checkout público completo.

1. **(1-6) Cada vertical que estaba rota YA resuelve sus filas** bajo sesión de
   sistema tras el fix: restaurantes, citas, hoteles, rentas, licitaciones,
   despachos — todas resuelven `core.organization`/`core.property` por slug (o,
   para licitaciones, enumeran organizaciones activas — el patrón real de
   `listActiveOrganizations()` que usan discover-tenders/deadline-reminders/
   alert-notifications).
2. **(7-8) Recorrido SQL completo del checkout público de restaurantes**: buscar
   organización por slug → resolver sucursal (`core.property` JOIN
   `restaurantes.branch_detail`) → `create_order_idempotent()`, TODO bajo sesión de
   sistema — el recorrido exacto de `PostgresRestaurantesRepository.findBranch()` →
   `orders.ts::prepareCreateOrder`. El escenario 8 confirma además que repetir la
   MISMA `idempotency_key` devuelve el MISMO pedido (no un 404 de
   organización/sucursal, ni un pedido duplicado). Ver también los escenarios 23-24
   agregados en `scripts/verify-restaurantes-sql/assertions.sql` con este mismo PR
   — cobertura deliberadamente duplicada del mismo recorrido, en dos scripts con
   propósito distinto (éste: el fix de plataforma `core`; el otro: el contrato
   completo del vertical restaurantes).
3. **(9-11) Aislamiento cross-tenant**: staff autenticado (auth.uid() real) de la
   organización B sigue SIN ver la organización/property de la organización A — el
   fix es un `OR` con `auth.uid() is null`, nunca `using (true)`; la regla original
   sigue aplicando tal cual para cualquier `auth.uid()` real. El escenario 11 es el
   control positivo: staff de la organización A sigue viendo su PROPIA
   organización/property exactamente igual que antes del fix.
4. **(12-13) `anon` sigue sin acceso**: ningún GRANT nuevo — las dos queries fallan
   con `permission denied for table organization/property`, igual que antes.
5. **(14-15) `core.membership`/`core.staff_user` siguen devolviendo CERO filas**
   bajo sesión de sistema — confirma que el fix no se desbordó a las dos tablas que
   se decidió dejar sin cambio (ver "Decisión de diseño" arriba). Guard de
   regresión de seguridad explícito.

## Verificado antes/después (evidencia real, no solo el diseño)

`run.sh` acepta `CORE_RLS_SKIP_FIX=1` para reproducir el estado ANTES del fix
(aplica TODAS las migraciones reales EXCEPTO
`20240101000136_0015_core_rls_sesion_sistema.sql`):

```
CORE_RLS_SKIP_FIX=1 scripts/verify-core-rls-sesion-sistema/run.sh
```

Resultado real de correr ambos modos contra Postgres real (18/19-sep-2026):

| Escenario | Antes del fix (`CORE_RLS_SKIP_FIX=1`) | Después del fix (normal) |
|---|---|---|
| 1-6 (cada vertical resuelve org/property) | `0` (bug reproducido) | `1` |
| 7 (checkout completo crea el pedido) | `ERROR: null value in column "organization_id" ... violates not-null constraint` (el JOIN de sucursal no resolvió nada, `property_id`/`organization_id` llegan `NULL` a `create_order_idempotent`) | `1` |
| 8 (mismo pedido, no duplicado) | mismo `ERROR` que #7 | `1` |
| 9-10 (aislamiento cross-tenant) | `0` (sin cambio — nunca dependió del fix) | `0` |
| 11 (control positivo, propia org) | `1` (sin cambio) | `1` |
| 12-13 (anon sin acceso) | `ERROR: permission denied` (sin cambio) | `ERROR: permission denied` |
| 14-15 (membership/staff_user siguen cerradas) | `0` (sin cambio) | `0` |

Los escenarios 9-15 se comportan IGUAL en ambos modos — confirma que
`CORE_RLS_SKIP_FIX=1` de verdad aísla solo la pieza relevante (nada más se ve
afectado por quitar esa única migración).

## Fuera de alcance de esta migración (documentado, no disfrazado)

- **`licitaciones.can_access_org`/`can_write_org`/`can_decide_org`**
  (`..._002_compliance_and_package.sql`) son funciones `security definer` PROPIAS
  de esa vertical (no de `core`) que también exigen `auth.uid()` no nulo, sin
  escape hatch. Con este fix, `listActiveOrganizations()` de licitaciones empieza a
  recorrer organizaciones reales bajo sesión de sistema (escenario 5 de arriba),
  pero un INSERT posterior en `licitaciones.tender` gateado por `can_write_org`
  seguiría fallando — de "silenciosamente 0 organizaciones" a "ruidosamente roto en
  el INSERT". Arreglar esas 3 funciones es una decisión de esa vertical específica
  (¿escape hatch total, o acotado a las columnas que discovery necesita escribir?),
  fuera del alcance "RLS de `core` para sesión de sistema" de esta rama.
- **Cualquier tabla de vertical (no `core`) cuya policy use
  `core.has_property_access(auth.uid(), property_id)` directo, sin el wrapper
  `auth.uid() is null or ...`**, sigue sin escape hatch — este fix NO modifica
  `core.has_property_access` en sí (que sigue devolviendo `false` para
  `p_user_id is null`, correcto para su uso dentro de otras policies que SÍ tienen
  su propio wrapper), solo las dos policies de `core.organization`/`core.property`
  que lo invocaban SIN wrapper. Ejemplo real encontrado durante la auditoría de
  este PR: `hoteles.fnb_order` (INSERT, `..._001_hoteles_schema.sql`) — su policy
  es `with check (core.has_property_access(auth.uid(), property_id))`, sin el `or
  auth.uid() is null`, así que el Server Tool de voz `crear_ticket_huesped_fnb`
  (`apps/api/src/routes/verticals/hoteles/voice-tools.ts`, sesión de sistema) sigue
  sin poder insertar un pedido de F&B tras este fix. Es un hallazgo real, pero de
  una tabla de UNA vertical (no de `core`), con su propia policy — arreglarlo es
  una decisión de esa vertical/tabla, no de esta migración de plataforma. Reportado
  en el PR como hallazgo de seguimiento.

## Cómo correrlo

```
scripts/verify-core-rls-sesion-sistema/run.sh
```

Requiere `initdb`/`pg_ctl`/`psql` en PATH.

## CI

Corre automáticamente en cada PR/push vía `scripts/verify-real-postgres-ci/
run-gate.mjs` + `.github/workflows/postgres-real-gate.yml` (descubierto solo, sin
cambios al workflow).

## Por qué no es parte de `npm test`

Mismo criterio que `scripts/verify-outbox-grants/README.md`/
`scripts/verify-restaurantes-sql/README.md` — requiere Postgres real
(`initdb`/`pg_ctl`/`psql`), no disponible en el sandbox de `npm test`. Corre en CI
vía el servicio `postgres:` dedicado del workflow.

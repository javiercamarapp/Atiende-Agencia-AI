-- Fase 2 de la investigación de seguridad de `0011_superadmin_caller_binding.sql`
-- (ese archivo cerró las 12 funciones `*_for_superadmin` del back office de
-- plataforma; su propio README -- `scripts/verify-superadmin-caller-binding/
-- README.md`, sección "Fuera de alcance" -- señaló explícitamente
-- `core.get_organization_billing_for_checkout` como el primer hallazgo
-- relacionado pendiente). Esta migración recorre TODO `supabase/migrations/`
-- (las 125 migraciones aplicadas hasta `0011_superadmin_caller_binding.sql`,
-- usando la ÚLTIMA definición de cada función -- varias se redefinen) buscando
-- el mismo patrón: función `security definer` + `grant execute ... to
-- authenticated` + un parámetro plano de identidad o alcance
-- (`p_caller_id`/`p_user_id`/`p_staff_id`/`p_organization_id`/email/...) sin
-- atar a `auth.uid()` (la identidad real de la sesión Postgres, ver
-- `packages/db/src/managed-postgres-engine.ts::withAppSession`).
--
-- Inventario completo (nombre, esquema, clase, qué se hizo) -- ver la tabla
-- completa en la descripción del PR; resumen de las 4 clases usadas (mismo
-- criterio que ya estableció `0011_superadmin_caller_binding.sql`):
--   A. Pre-autenticación por diseño (login/magic-link/Google/exchange-code):
--      no pueden exigir `auth.uid()` porque login ocurre ANTES de que exista
--      sesión -- se les agrega el guard INVERSO (`auth.uid() is null`),
--      verificado call-site-por-call-site que `apps/api` SIEMPRE las invoca
--      en sesión de sistema.
--   B. De sistema (webhook de Stripe): mismo guard inverso, mismo criterio.
--   C. En nombre de un usuario autenticado ya identificado por
--      `authMiddleware` (revocar mis sesiones, mi propio status de
--      superadmin, mis notificaciones, billing de mi organización): se ata el
--      parámetro a `auth.uid()`, y el commit hermano de TypeScript
--      (`apps/api/src/production/core-repository.ts`) cambia esos call sites
--      de sesión de SISTEMA a sesión COMO el caller real -- mismo patrón
--      exacto que `0011_superadmin_caller_binding.sql` ya estableció para las
--      12 funciones de superadmin.
--   D. Ya protegidas -- la gran mayoría del inventario cae aquí (RPCs
--      anti-duplicado de citas/hoteles/restaurantes, `enqueue_messaging_
--      outbox`/`claim_email_outbox_batch`/`complete_email_outbox_job` de las 6
--      verticales, `list_org_members(_by_vertical_role)`, `update_membership_
--      role`, `create_owner_portal_invite`, `record_audit_log`-style de
--      despachos/hoteles): cada una YA tiene su propio guard real
--      (`auth.uid() is null`, un chequeo de membership, o ambos vía `or`) de
--      un endurecimiento previo -- se auditaron una por una, sin tocarlas.
--      `core.has_property_access`/`core.get_organization_billing_info` son
--      primitivas INTERNAS (nunca una superficie de API con su propio
--      contrato) -- se dejan igual.
--
-- Alcance de ESTA migración: únicamente el esquema `core` (por eso vive en
-- `packages/db/migrations/`, el único paquete cuyo espejo es
-- `supabase/migrations/`, mismo criterio de `0011_superadmin_caller_binding.
-- sql`). Se encontraron hallazgos DEL MISMO PATRÓN en esquemas de vertical
-- (`despachos.record_audit_log`, `hoteles.record_fraude_audit_log`,
-- `restaurantes.enqueue_staff_order_notification`/`increment_promotion_uses`,
-- `rentas.find_owner_credential_by_email`/`revoke_owner_refresh_token`) --
-- deliberadamente FUERA de esta migración: arreglarlas exige un archivo/mirror
-- propio en su paquete de dominio (`packages/domain-*/migrations/`) con su
-- PROPIO prefijo de timestamp nuevo (ver `scripts/verify-migration-versions/
-- README.md`: el espejo de `supabase/migrations/` debe ser byte-idéntico a UNA
-- fuente real por paquete), y esta tarea tiene instrucción explícita de usar
-- EXACTAMENTE el prefijo `20240101000128` para un solo archivo. Quedan
-- documentadas aquí como hallazgo relacionado para una PR de seguimiento
-- dedicada (mismo criterio que este mismo archivo aplicó al billing de
-- checkout en la Fase 1).
--
-- Orden de despliegue seguro: código primero, migración después -- ver el
-- detalle por función abajo. Ninguna de las funciones de Clase A/B necesita
-- ningún cambio de TypeScript (siempre se invocan en sesión de sistema desde
-- antes de esta migración); las de Clase C si lo necesitan (ver el commit
-- hermano) -- la función NUEVA sigue aceptando la sesión VIEJA (de sistema)
-- sin romperse hasta que ese commit se despliegue, porque el guard nuevo es
-- ESTRICTAMENTE más angosto que "sin guard": el único caller real hoy (código
-- ya desplegado, sesión de sistema) simplemente empieza a fallar con 42501 en
-- cuanto esta migración se aplica -- por eso el código (que abre la sesión
-- correcta) DEBE desplegarse ANTES que esta migración, nunca al revés, para
-- las 8 funciones de Clase C de abajo.

-- ═══════════════════════════════════════════════════════════════════════════
-- Clase C — revocación de sesiones (`0003_refresh_token_revocation.sql`/
-- `0006_revoke_all_sessions.sql`)
-- ═══════════════════════════════════════════════════════════════════════════

-- `revoke_all_refresh_tokens(p_user_id)`: el ÚNICO call site real
-- (`POST /auth/revoke-sessions`, `apps/api/src/routes/auth.ts`) YA tiene
-- `authMiddleware` montado y YA pasa `c.get("userId")` (nunca un id del body,
-- confirmado por el propio comentario de cabecera de `0006_revoke_all_
-- sessions.sql`: "siempre self-service... nunca un id recibido") -- pero
-- `ProductionCoreRepository.revokeAllRefreshTokens` abría la llamada en
-- sesión de SISTEMA (`withAppSession({ userId: null })`), así que
-- `auth.uid()` era SIEMPRE null dentro de la función -- el mismo patrón
-- exacto que `0011_superadmin_caller_binding.sql` corrigió para las 12
-- funciones de superadmin. El commit hermano de TypeScript cambia ese único
-- call site a `withAppSession({ userId: callerId })`.
create or replace function core.revoke_all_refresh_tokens(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception 'revoke_all_refresh_tokens: el caller autenticado debe coincidir con p_user_id' using errcode = '42501';
  end if;

  update core.staff_user set sessions_revoked_at = now() where id = p_user_id;
end;
$$;

-- `revoke_refresh_token(p_jti, p_user_id, p_expires_at)`: a diferencia de la
-- anterior, sus DOS call sites reales (`POST /auth/logout`, `POST
-- /auth/refresh` -- ambos en `apps/api/src/routes/auth.ts`) NUNCA montan
-- `authMiddleware`: el actor se identifica por el `sub` YA verificado
-- (firma) del propio refresh token que se está cerrando, no por un Bearer de
-- sesión -- exactamente el mismo momento "antes/sin sesión autenticada" que
-- login (ver el comentario de cabecera de `0003_refresh_token_revocation.
-- sql`). Los dos call sites abren `withAppSession({ userId: null })` HOY y
-- siguen así después de esta migración (Clase B, no C) -- el guard correcto
-- es "solo sesión de sistema", nunca alcanzable por un `authenticated` con
-- `auth.uid()` real. Sin cambio de TypeScript.
create or replace function core.revoke_refresh_token(p_jti uuid, p_user_id uuid, p_expires_at timestamptz)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'revoke_refresh_token es solo para la sesión de sistema (logout/refresh, antes de que exista Bearer de sesión)' using errcode = '42501';
  end if;

  insert into core.revoked_refresh_token (jti, user_id, expires_at)
  values (p_jti, p_user_id, p_expires_at)
  on conflict (jti) do nothing;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Clase C — status propio de superadmin (`0010_platform_superadmin.sql`)
-- ═══════════════════════════════════════════════════════════════════════════

-- `is_platform_superadmin(p_staff_id)`: TODOS sus call sites reales
-- (`GET /auth/me`, y las 3 rutas de `superadmin.ts`/`superadmin-llm-usage.ts`/
-- `superadmin-integraciones.ts`) pasan SIEMPRE `c.get("userId")` -- el propio
-- id del caller ya verificado por `authMiddleware`, JAMÁS el id de otro staff
-- (verificado con `grep -rn "isPlatformSuperadmin"` sobre todo `apps/api/src`
-- antes de decidir este guard) -- pero corría en sesión de SISTEMA
-- (`withAppSession({ userId: null })`), así que `auth.uid()` nunca coincidía
-- con nada. Antes de esta migración, cualquier sesión `authenticated`
-- (staff de CUALQUIER tenant, sin necesitar ser superadmin) podía llamarla
-- por RPC directo pasando el UUID de un superadmin real y aprender si esa
-- cuenta es superadmin -- un oráculo binario que no debería existir sin
-- atadura, aunque su impacto por sí solo sea menor (nunca confirma/niega
-- datos de negocio, solo un booleano). Las 8 llamadas INTERNAS de este mismo
-- archivo (`core.*_for_superadmin`, ya corregidas en `0011_superadmin_caller_
-- binding.sql`) siguen funcionando sin cambio: todas pasan `p_caller_id`, que
-- en ese punto YA es `= auth.uid()` por el guard que esa migración agregó --
-- este guard nuevo, evaluado de nuevo ahí, es tautológicamente cierto.
-- El commit hermano de TypeScript cambia los 4 call sites de sesión de
-- sistema a `withAppSession({ userId: staffId })`.
create or replace function core.is_platform_superadmin(p_staff_id uuid)
returns boolean
language sql stable security definer set search_path = core, pg_temp
as $$
  select auth.uid() is not null and auth.uid() = p_staff_id
    and exists (select 1 from core.platform_superadmin where staff_user_id = p_staff_id);
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Clase C/B — billing SaaS de plataforma (`0009_billing_saas_schema.sql`,
-- hallazgo explícitamente señalado como pendiente por el README de
-- `scripts/verify-superadmin-caller-binding/`)
-- ═══════════════════════════════════════════════════════════════════════════

-- `get_organization_billing_for_checkout(p_caller_id, p_organization_id)`:
-- MISMO patrón EXACTO que las 12 funciones de superadmin de la Fase 1 --
-- `POST /billing/checkout` (`apps/api/src/routes/billing.ts`) YA monta
-- `authMiddleware` y YA pasa `c.get("userId")` como `p_caller_id`, pero
-- `ProductionCoreRepository.getOrganizationBillingForCheckout` abría la
-- llamada en sesión de SISTEMA -- cualquier `authenticated` real (staff de
-- CUALQUIER organización) podía llamarla por RPC directo pasando el
-- `organization_id`/UUID de owner/admin de OTRA organización y leer su
-- `stripe_customer_id`/`stripe_subscription_id`/`seats`/`status` reales (el
-- chequeo de membership/superadmin interno solo protege ESCRITURA de negocio,
-- nunca validó que el `p_caller_id` recibido fuera honesto). Se agrega la
-- atadura ANTES del resto de checks (mismo orden que
-- `core.create_prospecto_for_superadmin`): la organización inexistente y la
-- falta de autoridad siguen sin filtrar nada sensible (mismo criterio ya
-- documentado en el comentario original de esta función), la atadura de
-- identidad simplemente se resuelve primero. El commit hermano de TypeScript
-- cambia este único call site a `withAppSession({ userId: callerId })`.
--
-- BUG PREEXISTENTE encontrado al escribir el escenario positivo de
-- `scripts/verify-caller-binding-fase2/assertions.sql` contra Postgres real
-- (nunca antes ejercitada: el propio README de `scripts/verify-superadmin-
-- caller-binding/` la marcó "fuera de alcance" en la Fase 1, y el repositorio
-- en memoria de los tests unitarios no aplica PL/pgSQL real) -- el `where
-- organization_id = p_organization_id and user_id = p_caller_id` original
-- (sin alias) es AMBIGUO para Postgres dentro de esta función: `organization_
-- id` es SIMULTÁNEAMENTE columna de `core.membership` Y columna de SALIDA de
-- `returns table (organization_id uuid, ...)`, que PL/pgSQL trae al scope
-- como variable implícita -- exactamente el mismo gotcha que el comentario de
-- cabecera de `core.update_membership_role` (`0007_update_membership_role.
-- sql`) ya documentó y resolvió con el alias `m.`. Esto rompía la ruta
-- LEGÍTIMA para TODO caller real (el error de "ambiguous" ocurre al
-- planear/ejecutar la sentencia, no solo cuando el `exists` sería falso) --
-- `POST /billing/checkout` nunca pudo haber completado un checkout real
-- contra Postgres real desde que esta función se escribió. Se corrige aquí
-- con el mismo alias `m.` que su propio precedente ya establece -- ningún
-- cambio de comportamiento para el caller legítimo más allá de "ahora sí
-- funciona".
create or replace function core.get_organization_billing_for_checkout(p_caller_id uuid, p_organization_id uuid)
returns table (
  organization_id uuid,
  vertical text,
  owner_email text,
  stripe_customer_id text,
  stripe_subscription_id text,
  price_id text,
  seats integer,
  status text,
  current_period_end timestamptz
)
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'get_organization_billing_for_checkout: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
  if not exists (select 1 from core.organization where id = p_organization_id) then
    raise exception 'La organización % no existe.', p_organization_id;
  end if;
  if not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id and m.user_id = p_caller_id and m.platform_role in ('owner','admin')
  ) and not core.is_platform_superadmin(p_caller_id) then
    raise exception 'No tienes autoridad para administrar el billing de esta organización.';
  end if;
  return query select * from core.get_organization_billing_info(p_organization_id);
end;
$$;

-- `get_organization_billing_for_webhook(p_organization_id)`: su ÚNICO call
-- site real (`POST /billing/webhook`, mismo archivo) NUNCA monta
-- `authMiddleware` -- la autoridad real es la firma HMAC de Stripe, verificada
-- ANTES de llegar aquí (`verificarFirmaWebhookStripe`) -- corre en sesión de
-- SISTEMA hoy y sigue así después de esta migración (Clase B). Se filtra en
-- silencio (mismo criterio de "cero filas, nunca un error que confirme/niegue
-- datos" que ya usan las funciones de lectura de `0011_superadmin_caller_
-- binding.sql`) en vez de lanzar, porque su propio caller (el handler del
-- webhook) ya trata "sin fila" como "organización nueva, sin billing previo"
-- -- un comportamiento válido que no necesita distinguirse de "guard
-- rechazado" (este guard nunca debería activarse en producción real: ningún
-- call site real pasa `auth.uid()` no-nulo). Sin cambio de TypeScript.
create or replace function core.get_organization_billing_for_webhook(p_organization_id uuid)
returns table (
  organization_id uuid,
  vertical text,
  owner_email text,
  stripe_customer_id text,
  stripe_subscription_id text,
  price_id text,
  seats integer,
  status text,
  current_period_end timestamptz
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select * from core.get_organization_billing_info(p_organization_id) where auth.uid() is null;
$$;

-- `upsert_organization_billing(...)`: mismo criterio que la anterior -- su
-- único call site real (el mismo handler de `POST /billing/webhook`) siempre
-- corre en sesión de sistema. A diferencia de la lectura de arriba, esta es
-- una ESCRITURA (fija el estado de billing real de una organización) -- se
-- rechaza con un error explícito (`42501`) en vez de filtrarse en silencio,
-- mismo criterio que el resto de funciones de escritura de este archivo. Sin
-- cambio de TypeScript.
create or replace function core.upsert_organization_billing(
  p_organization_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_price_id text,
  p_seats integer,
  p_status text,
  p_current_period_end timestamptz
)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'upsert_organization_billing es solo para la sesión de sistema (webhook de Stripe)' using errcode = '42501';
  end if;

  insert into core.organization_billing (
    organization_id, stripe_customer_id, stripe_subscription_id, price_id, seats, status, current_period_end, updated_at
  )
  values (
    p_organization_id, p_stripe_customer_id, p_stripe_subscription_id, p_price_id, p_seats, p_status, p_current_period_end, now()
  )
  on conflict (organization_id) do update set
    stripe_customer_id = excluded.stripe_customer_id,
    stripe_subscription_id = excluded.stripe_subscription_id,
    price_id = excluded.price_id,
    seats = excluded.seats,
    status = excluded.status,
    current_period_end = excluded.current_period_end,
    updated_at = now();
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Clase C — notificaciones (`0013_notifications_schema.sql`)
-- ═══════════════════════════════════════════════════════════════════════════

-- Las 4 funciones de abajo comparten el MISMO hallazgo: su propio comentario
-- de cabecera original (`0013_notifications_schema.sql`) ya documentaba "el
-- caller TS siempre pasa el userId de la sesión JWT ya verificada... nunca un
-- id arbitrario" -- verificado de nuevo aquí (`apps/api/src/routes/
-- notifications.ts`: las 4 usan `c.get("userId")`, bajo `authMiddleware`
-- montado en `/notifications/*`) -- pero las 4 corrían en sesión de SISTEMA
-- (`withAppSession({ userId: null })`), así que `auth.uid()` nunca coincidía
-- con el `p_staff_id` recibido. El commit hermano de TypeScript cambia los 4
-- call sites a `withAppSession({ userId: staffId })`.
create or replace function core.list_notifications_for_staff(p_staff_id uuid)
returns table (
  id uuid,
  vertical text,
  titulo text,
  cuerpo text,
  entidad_tipo text,
  entidad_id uuid,
  created_at timestamptz,
  read_at timestamptz
)
language sql stable security definer set search_path = core, pg_temp
as $$
  select n.id, n.vertical, n.titulo, n.cuerpo, n.entidad_tipo, n.entidad_id, n.created_at, nr.read_at
  from core.notification n
  left join core.notification_read nr on nr.notification_id = n.id and nr.staff_user_id = p_staff_id
  where n.staff_user_id = p_staff_id
    and auth.uid() is not null and auth.uid() = p_staff_id
  order by n.created_at desc
  limit 50;
$$;

create or replace function core.count_unread_notifications_for_staff(p_staff_id uuid)
returns integer
language sql stable security definer set search_path = core, pg_temp
as $$
  select count(*)::integer
  from core.notification n
  where n.staff_user_id = p_staff_id
    and auth.uid() is not null and auth.uid() = p_staff_id
    and not exists (
      select 1 from core.notification_read nr
      where nr.notification_id = n.id and nr.staff_user_id = p_staff_id
    );
$$;

create or replace function core.mark_notification_read(p_staff_id uuid, p_notification_id uuid)
returns void
language plpgsql security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() <> p_staff_id then
    raise exception 'mark_notification_read: el caller autenticado debe coincidir con p_staff_id' using errcode = '42501';
  end if;

  if not exists (
    select 1 from core.notification where id = p_notification_id and staff_user_id = p_staff_id
  ) then
    raise exception 'notification not found' using errcode = 'P0002';
  end if;

  insert into core.notification_read (staff_user_id, notification_id)
  values (p_staff_id, p_notification_id)
  on conflict (staff_user_id, notification_id) do nothing;
end;
$$;

create or replace function core.mark_all_notifications_read(p_staff_id uuid)
returns integer
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_affected integer;
begin
  if auth.uid() is null or auth.uid() <> p_staff_id then
    raise exception 'mark_all_notifications_read: el caller autenticado debe coincidir con p_staff_id' using errcode = '42501';
  end if;

  insert into core.notification_read (staff_user_id, notification_id)
  select p_staff_id, n.id
  from core.notification n
  where n.staff_user_id = p_staff_id
  on conflict (staff_user_id, notification_id) do nothing;

  get diagnostics v_affected = row_count;
  return coalesce(v_affected, 0);
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Clase A — pre-autenticación (Google login, magic-link, exchange-code)
-- ═══════════════════════════════════════════════════════════════════════════

-- Las 4 funciones de abajo son genuinamente pre-auth: ocurren ANTES de que
-- exista una sesión con `auth.uid()` real (login por Google, solicitud/canje
-- de magic-link, canje de código de intercambio) -- no pueden exigir
-- `auth.uid() = <algo>` porque, por diseño, todavía no hay sesión de la que
-- leerlo. Verificado call-site-por-call-site (`grep -rn` sobre
-- `apps/api/src/routes/auth-google.ts`/`auth-magic-link.ts` antes de decidir
-- el guard): CADA una tiene un ÚNICO call site real, y los 4 abren siempre
-- `withAppSession({ userId: null })` -- nunca se llaman desde una ruta con
-- `authMiddleware` montado. Se les agrega el guard INVERSO (`auth.uid() is
-- null`), defensa en profundidad real: hoy ninguna ruta autenticada las
-- alcanza, pero antes de este guard un `authenticated` real con sesión propia
-- podría haberlas invocado por RPC directo (p. ej. `link_google_identity`
-- para vincular la cuenta de Google de OTRO staff a la propia, o `create_
-- magic_link_token`/`create_auth_exchange_code` para emitirse un token de
-- sesión de OTRO staff sin conocer su contraseña). Sin cambio de TypeScript
-- en ninguna de las 4 -- los call sites ya son exactamente los que este guard
-- exige.
create or replace function core.link_google_identity(p_staff_id uuid, p_sub text, p_email text)
returns void
language plpgsql security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'link_google_identity es solo para el flujo de login por Google (antes de que exista sesión propia)' using errcode = '42501';
  end if;

  insert into core.staff_google_identity (staff_user_id, provider_sub, email)
  values (p_staff_id, p_sub, p_email)
  on conflict (provider_sub) do update
    set email = excluded.email
    where core.staff_google_identity.staff_user_id = excluded.staff_user_id;
end;
$$;

create or replace function core.find_staff_by_google_sub(p_sub text)
returns setof core.staff_user
language sql stable security definer set search_path = core, pg_temp
as $$
  select su.* from core.staff_user su
  join core.staff_google_identity gi on gi.staff_user_id = su.id
  where gi.provider_sub = p_sub
    and auth.uid() is null;
$$;

create or replace function core.create_magic_link_token(p_staff_id uuid, p_token_hash text, p_expires_at timestamptz)
returns void
language plpgsql security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'create_magic_link_token es solo para el flujo de login (antes de que exista sesión propia)' using errcode = '42501';
  end if;

  insert into core.magic_link_token (staff_user_id, token_hash, expires_at)
  values (p_staff_id, p_token_hash, p_expires_at);
end;
$$;

create or replace function core.create_auth_exchange_code(p_staff_id uuid, p_code_hash text, p_expires_at timestamptz)
returns void
language plpgsql security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'create_auth_exchange_code es solo para el flujo de login (antes de que exista sesión propia)' using errcode = '42501';
  end if;

  insert into core.auth_exchange_code (staff_user_id, code_hash, expires_at)
  values (p_staff_id, p_code_hash, p_expires_at);
end;
$$;

-- Sin cambios de GRANT en ninguna de las 15 funciones de arriba -- todas ya
-- tenían exactamente `revoke all ... from public; grant execute ... to
-- authenticated;` desde su migración original (verificado contra cada
-- archivo fuente antes de escribir este archivo) -- este archivo solo
-- reemplaza el CUERPO. `anon` sigue sin poder llamar ninguna.

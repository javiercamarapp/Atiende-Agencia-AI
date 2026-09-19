-- Fase 3 del hallazgo de seguridad "caller binding" (ver `0011_superadmin_caller_
-- binding.sql`/`0012_caller_binding_fase2.sql`: funciones `security definer` con
-- `grant execute ... to authenticated` que reciben una identidad/alcance por
-- PARÁMETRO y confían en él sin atarlo a `auth.uid()`). Esta pasada cierra el hueco
-- que la Fase 2 dejó documentado en `scripts/verify-caller-binding-fase2/README.md`
-- ("Fuera de alcance"): `core.find_staff_by_email`/`find_staff_by_id`/
-- `find_memberships_by_user_id` (`0011_login_lookup_security_definer.sql`, ver
-- `supabase/migrations/20240101000113_...`) se usan en DOS contextos reales, hoy sin
-- distinguirlos:
--
--   (i) LOGIN/refresh/magic-link/Google/`GET /auth/me` — pre-autenticación o
--       lectura de la sesión propia. Verificado call site por call site (`apps/api/
--       src/production/core-repository.ts::ProductionCoreRepository`): los TRES
--       métodos abren SIEMPRE `engine.withAppSession({ userId: null })` —
--       sesión de SISTEMA, `auth.uid()` NULL — sin importar qué identidad reciban
--       como argumento (incluidos los usos "self", ej. `GET /auth/me` pasando
--       `c.get("userId")`, o `POST /auth/select-org`). Ninguna llamada real por este
--       camino tiene HOY una sesión con `auth.uid()` real.
--
--   (ii) ADMINISTRACIÓN DE STAFF — `admin-staff.ts` de las 5 verticales con alta de
--       staff (hoteles/restaurantes/despachos/licitaciones/citas): un admin YA
--       autenticado busca a OTRO usuario por correo (para invitarlo o detectar que
--       ya es staff de su organización). Este uso pasaba por `deps.coreRepo`
--       (mismo objeto de (i), sesión de sistema hardcodeada) — funcionaba porque
--       `auth.uid()` es NULL de todas formas, pero significa que hoy CUALQUIER
--       sesión `authenticated` real que llamara estas funciones por RPC directo
--       (bypass de la capa HTTP) podría enumerar `core.staff_user` completo por
--       correo/id — incluido `password_hash` — y leer las membresías de CUALQUIER
--       usuario, sin ninguna atadura a su propia organización.
--
-- Esta migración:
--   1. Blinda (i): agrega el guard "solo sesión de sistema" (`auth.uid() is not
--      null -> raise ... 42501`, MISMO patrón que `core.revoke_refresh_token` en
--      `0012_caller_binding_fase2.sql`) a las tres funciones. Seguro por el
--      call-site-audit de arriba: bloquea el RPC directo de un `authenticated` real,
--      sin afectar NINGÚN caller de producción (todos corren ya en sesión de
--      sistema). Firma/retorno/`search_path`/GRANTs sin cambio; solo cambia el
--      lenguaje de `sql` a `plpgsql` (necesario para el guard imperativo).
--   2. Cierra (ii) con dos funciones NUEVAS, acotadas: `core.find_staff_for_org_
--      admin(organization_id, email)`/`core.is_staff_org_member_for_org_admin
--      (organization_id, target_user_id)`. Exigen `auth.uid()` no nulo Y que
--      `auth.uid()` tenga `platform_role` owner/admin en `p_organization_id` —
--      MISMO umbral exacto que ya aplica `core.update_membership_role` (rank >= 3,
--      ver `0007_update_membership_role.sql`) y que la capa TS ya usa
--      (`STAFF_INVITE_ROLES`/`canInviteStaff`) — se reutiliza ese criterio, no se
--      inventa uno nuevo. `find_staff_for_org_admin` devuelve SOLO
--      id/email/full_name — NUNCA `password_hash` (a diferencia de
--      `find_staff_by_email`, esta función no sirve para login, solo para que un
--      admin vea si ya existe una cuenta con ese correo). El commit hermano de
--      TypeScript cambia los 5 `admin-staff.ts` para llamarlas desde
--      `deps.coreStaffRepo(c.get("db"))` (sesión real por-request, `auth.uid()` =
--      el admin real) en vez de `deps.coreRepo` (sesión de sistema).
--
-- Orden de despliegue: CUALQUIER ORDEN (hallazgo de revisión real: mergear a `main`
-- despliega el código de inmediato, pero la base de datos REAL va detrás — las
-- migraciones se aplican después, a mano — así que "código antes que migración" es
-- el caso normal, no la excepción). Los métodos `PostgresCoreRepository.
-- findStaffForOrgAdmin`/`isStaffOrgMember` (ver `packages/db/src/postgres-core-
-- repository.ts`) llaman primero a `core.find_staff_for_org_admin`/`core.is_staff_
-- org_member_for_org_admin`; si esta migración TODAVÍA no se aplicó, Postgres
-- responde SQLSTATE 42883 (`undefined_function`) y esos métodos degradan
-- automáticamente al camino anterior a esta fase (`core.find_staff_by_email`/
-- `core.find_memberships_by_user_id`, todavía sin el guard de solo-sistema en ese
-- escenario — misma migración, ambos cambios llegan juntos), aplicando en
-- TypeScript la MISMA restricción de autorización que exigiría la función nueva
-- (`auth.uid()` owner/admin de la organización) antes de tocar esas funciones
-- viejas — nunca un camino más ancho que el que esta migración habría impuesto. El
-- guard de `find_staff_by_email`/`find_staff_by_id`/`find_memberships_by_user_id`
-- (una vez aplicada la migración) sigue siendo compatible con el código VIEJO y el
-- nuevo (ambos llaman siempre desde sesión de sistema). Ver el comentario de
-- cabecera de `findStaffForOrgAdmin`/`isStaffOrgMember` en `postgres-core-
-- repository.ts` para el detalle completo del fallback.

create or replace function core.find_staff_by_email(p_email text)
returns setof core.staff_user
language plpgsql stable security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'find_staff_by_email: solo alcanzable desde sesión de sistema' using errcode = '42501';
  end if;
  return query select * from core.staff_user where email = p_email;
end;
$$;

revoke all on function core.find_staff_by_email(text) from public;
grant execute on function core.find_staff_by_email(text) to authenticated;

create or replace function core.find_staff_by_id(p_id uuid)
returns setof core.staff_user
language plpgsql stable security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'find_staff_by_id: solo alcanzable desde sesión de sistema' using errcode = '42501';
  end if;
  return query select * from core.staff_user where id = p_id;
end;
$$;

revoke all on function core.find_staff_by_id(uuid) from public;
grant execute on function core.find_staff_by_id(uuid) to authenticated;

create or replace function core.find_memberships_by_user_id(p_user_id uuid)
returns table (
  organization_id uuid,
  slug text,
  name text,
  vertical text,
  platform_role text,
  vertical_role text,
  property_ids uuid[]
)
language plpgsql stable security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'find_memberships_by_user_id: solo alcanzable desde sesión de sistema' using errcode = '42501';
  end if;
  return query
    select m.organization_id, o.slug, o.name, o.vertical, m.platform_role, m.vertical_role, m.property_ids
    from core.membership m
    join core.organization o on o.id = m.organization_id
    where m.user_id = p_user_id
    order by o.name asc;
end;
$$;

revoke all on function core.find_memberships_by_user_id(uuid) from public;
grant execute on function core.find_memberships_by_user_id(uuid) to authenticated;

-- Uso (ii) — administración de staff (`admin-staff.ts`, 5 verticales). Devuelve
-- SOLO id/email/full_name de un `core.staff_user` por correo EXACTO (global, no
-- acotado a la organización -- el punto de esta búsqueda es detectar una cuenta que
-- puede pertenecer a OTRA organización todavía, exactamente igual que hacía
-- `findStaffByEmail` antes de esta migración) -- nunca `password_hash` ni
-- `created_via`/`email_verified_at`/`sessions_revoked_at` (esta función no sirve
-- para login). Autorización real DENTRO de la función (nunca solo una promesa de la
-- capa TS, mismo principio que el resto de `core`): exige `auth.uid()` no nulo y
-- que sea owner/admin de `p_organization_id` -- MISMO umbral que ya aplica
-- `core.update_membership_role` (rank >= 3) para gestionar staff de esa
-- organización.
create or replace function core.find_staff_for_org_admin(p_organization_id uuid, p_email text)
returns table (id uuid, email text, full_name text)
language plpgsql stable security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id
      and m.user_id = auth.uid()
      and m.platform_role in ('owner', 'admin')
  ) then
    raise exception 'find_staff_for_org_admin: se requiere ser owner/admin de la organización' using errcode = '42501';
  end if;

  return query
    select su.id, su.email, su.full_name
    from core.staff_user su
    where su.email = p_email;
end;
$$;

revoke all on function core.find_staff_for_org_admin(uuid, text) from public;
grant execute on function core.find_staff_for_org_admin(uuid, text) to authenticated;

-- Complementa a la de arriba: ¿`p_target_user_id` (normalmente el `id` que acaba de
-- devolver `find_staff_for_org_admin`) ya es miembro de `p_organization_id`? --
-- `admin-staff.ts` la usa para decidir "conflicto, ese correo ya es staff de esta
-- organización" antes de crear la invitación, sin exponer la lista completa de
-- membresías (de CUALQUIER organización) del target, a diferencia de la vieja
-- `findMembershipsByUserId(existingStaff.id)` que este call site reemplaza. Mismo
-- umbral de autorización que `find_staff_for_org_admin`.
create or replace function core.is_staff_org_member_for_org_admin(p_organization_id uuid, p_target_user_id uuid)
returns boolean
language plpgsql stable security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id
      and m.user_id = auth.uid()
      and m.platform_role in ('owner', 'admin')
  ) then
    raise exception 'is_staff_org_member_for_org_admin: se requiere ser owner/admin de la organización' using errcode = '42501';
  end if;

  return exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id and m.user_id = p_target_user_id
  );
end;
$$;

revoke all on function core.is_staff_org_member_for_org_admin(uuid, uuid) from public;
grant execute on function core.is_staff_org_member_for_org_admin(uuid, uuid) to authenticated;

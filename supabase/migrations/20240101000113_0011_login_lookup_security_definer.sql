-- Hallazgo crítico de producción (2026-09-16, primera vez que DATABASE_URL
-- apuntó con la contraseña correcta a Postgres real): ningún login -- ni
-- password ni magic link -- funcionaba nunca. Causa raíz: `core.staff_user`
-- tiene RLS habilitado con UNA sola policy de SELECT, `id = auth.uid()` (ver
-- 0001_core_schema), y ninguna tabla de este esquema tiene GRANT directo al
-- rol `authenticated` (mismo criterio ya documentado en
-- `core.staff_google_identity`: "este monorepo NO aprovisiona `service_role`
-- ... acceso exclusivamente vía funciones security definer"). El login por
-- correo ocurre ANTES de que exista una sesión autenticada -- por definición
-- no se puede conocer el `auth.uid()` del usuario que se busca, así que la
-- policy `id = auth.uid()` SIEMPRE bloquea la fila incluso cuando existe.
-- `ProductionCoreRepository.findStaffByEmail`/`findStaffById`/
-- `findMembershipsByUserId` corrían como queries crudas contra las tablas
-- (nunca a través de una función `security definer`) -- las tres devolvían
-- CERO filas siempre en producción real, sin importar que el dato sí
-- existiera (confirmado: `core.staff_user` sí tiene la fila del seed de
-- superadmin, pero `findStaffByEmail` regresaba null vía el rol
-- `authenticated`). `findStaffByGoogleSub`/`linkGoogleIdentity` YA seguían el
-- patrón correcto (`core.find_staff_by_google_sub`/`core.link_google_identity`,
-- ver 0008) -- por eso Google login nunca mostró este síntoma (aunque tampoco
-- se pudo probar de punta a punta, al no haber credenciales reales de Google
-- configuradas todavía).
--
-- Mismo patrón EXACTO que `core.find_staff_by_google_sub` (0008) y
-- `core.accept_staff_invite` (0002): función `security definer` +
-- `set search_path = core, pg_temp` + `revoke all from public` +
-- `grant execute to authenticated`. No se toca ninguna policy de RLS
-- existente ni se abre ningún GRANT directo sobre las tablas -- la
-- superficie de acceso sigue siendo exactamente tan angosta como antes,
-- solo que ahora accesible desde el flujo de login real.

create or replace function core.find_staff_by_email(p_email text)
returns setof core.staff_user
language sql stable security definer set search_path = core, pg_temp
as $$
  select * from core.staff_user where email = p_email;
$$;

revoke all on function core.find_staff_by_email(text) from public;
grant execute on function core.find_staff_by_email(text) to authenticated;

create or replace function core.find_staff_by_id(p_id uuid)
returns setof core.staff_user
language sql stable security definer set search_path = core, pg_temp
as $$
  select * from core.staff_user where id = p_id;
$$;

revoke all on function core.find_staff_by_id(uuid) from public;
grant execute on function core.find_staff_by_id(uuid) to authenticated;

-- `find_memberships_by_user_id`: mismo join/orden que la query cruda que
-- reemplaza (`postgres-core-repository.ts::findMembershipsByUserId`) -- se
-- usa tanto en sesión de sistema (login: `ProductionCoreRepository`) como en
-- llamadas ya autenticadas (GET /auth/me), así que no valida `auth.uid()`
-- internamente -- a diferencia de `core.list_org_members_by_vertical_role`
-- (que sí lo hace porque expone datos de OTROS miembros), esta función solo
-- regresa las membresías del `p_user_id` que el caller ya pasó explícito, el
-- mismo dato que la capa TS de arriba ya decide a quién pedírselo.
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
language sql stable security definer set search_path = core, pg_temp
as $$
  select m.organization_id, o.slug, o.name, o.vertical, m.platform_role, m.vertical_role, m.property_ids
  from core.membership m
  join core.organization o on o.id = m.organization_id
  where m.user_id = p_user_id
  order by o.name asc;
$$;

revoke all on function core.find_memberships_by_user_id(uuid) from public;
grant execute on function core.find_memberships_by_user_id(uuid) to authenticated;

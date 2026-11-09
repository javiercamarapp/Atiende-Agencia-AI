-- REQ-SUPERADMIN: back office de plataforma, cruzado a las 6 verticales --
-- rol nuevo, distinto de `core.membership.platform_role` (ese es "owner/admin/
-- member/viewer" DENTRO de una sola organización; esto es "puede ver TODAS las
-- organizaciones de TODAS las verticales", sin pertenecer a ninguna).
--
-- `core.platform_superadmin` es deliberadamente una tabla aparte (no una
-- columna en `core.staff_user`): un flag de este alcance debe ser fácil de
-- auditar (cuándo se otorgó, a quién) y fácil de revocar sin migración nueva
-- -- mismo criterio que ya separa `core.staff_invite` de `core.membership`.
--
-- Alta inicial: UN staff_user real (creado aquí mismo, `created_via='seed'`,
-- sin password -- entra por Google o "Continuar con correo", igual que
-- cualquier otra cuenta passwordless de este monorepo) vinculado a la tabla de
-- superadmins. Alta de superadmins ADICIONALES queda fuera de este pase (no
-- hay todavía una ruta HTTP para gestionar esta tabla -- ver el comentario de
-- `apps/api/src/routes/superadmin.ts` para el detalle de alcance).
insert into core.staff_user (id, email, password_hash, full_name, created_via, email_verified_at)
values ('11111111-1111-1111-1111-111111111111', 'javiercamaraportepetit@gmail.com', null, 'Javier Cámara Portepetit', 'seed', now())
on conflict (email) do nothing;

create table core.platform_superadmin (
  staff_user_id uuid primary key references core.staff_user(id) on delete cascade,
  granted_at timestamptz not null default now()
);

alter table core.platform_superadmin enable row level security;

-- Mismo criterio que `core.staff_google_identity`/`core.magic_link_token`:
-- este monorepo no aprovisiona `service_role` -- acceso exclusivamente vía la
-- función `security definer` de abajo.
revoke all on core.platform_superadmin from public, anon, authenticated;

insert into core.platform_superadmin (staff_user_id)
select id from core.staff_user where email = 'javiercamaraportepetit@gmail.com'
on conflict (staff_user_id) do nothing;

-- `is_platform_superadmin`: usado por `GET /auth/me` (para que el frontend
-- decida si redirigir a `/superadmin` en vez del landing normal de una
-- vertical) y por cada ruta de `apps/api/src/routes/superadmin.ts` (defensa
-- real DENTRO de la función, nunca solo un chequeo en TS -- mismo principio
-- que el resto de este monorepo).
create or replace function core.is_platform_superadmin(p_staff_id uuid)
returns boolean
language sql stable security definer set search_path = core, pg_temp
as $$
  select exists (select 1 from core.platform_superadmin where staff_user_id = p_staff_id);
$$;

revoke all on function core.is_platform_superadmin(uuid) from public;
grant execute on function core.is_platform_superadmin(uuid) to authenticated;

-- `list_all_organizations_for_superadmin`: el chequeo de autorización vive
-- DENTRO de la función (no confía en que el caller ya haya validado
-- `is_platform_superadmin` en TS) -- un caller que no es superadmin obtiene
-- cero filas, nunca un error que confirme/niegue si la tabla tiene datos.
create or replace function core.list_all_organizations_for_superadmin(p_caller_id uuid)
returns setof core.organization
language sql stable security definer set search_path = core, pg_temp
as $$
  select o.* from core.organization o
  where exists (select 1 from core.platform_superadmin ps where ps.staff_user_id = p_caller_id)
  order by o.created_at desc;
$$;

revoke all on function core.list_all_organizations_for_superadmin(uuid) from public;
grant execute on function core.list_all_organizations_for_superadmin(uuid) to authenticated;

-- `count_staff_by_organization_for_superadmin`: igual criterio de
-- autorización interna -- cuenta de `core.membership` por organización, para
-- que el dashboard muestre "N miembros" sin exponer identidades.
create or replace function core.count_staff_by_organization_for_superadmin(p_caller_id uuid)
returns table (organization_id uuid, staff_count bigint)
language sql stable security definer set search_path = core, pg_temp
as $$
  select m.organization_id, count(*)::bigint as staff_count
  from core.membership m
  where exists (select 1 from core.platform_superadmin ps where ps.staff_user_id = p_caller_id)
  group by m.organization_id;
$$;

revoke all on function core.count_staff_by_organization_for_superadmin(uuid) from public;
grant execute on function core.count_staff_by_organization_for_superadmin(uuid) to authenticated;

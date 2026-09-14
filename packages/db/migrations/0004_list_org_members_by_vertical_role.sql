-- Fase 12 restaurantes — hallazgo de auditoría (severidad ALTA, "asignar repartidor a
-- un pedido no tiene UI: el panel de repartidor siempre estará vacío"): `PATCH
-- .../admin/orders/:orderId/assign-repartidor` (Fase 8, `admin-orders.ts`) es el ÚNICO
-- lugar que despacha un pedido, pero el panel admin no tenía forma de listar QUÉ staff
-- de la organización tiene `verticalRole = 'repartidor'` para construir un selector
-- real (`admin-staff.ts` -- Fase 10 -- solo listaba invitaciones PENDIENTES, nunca
-- membresías ya aceptadas). Sin ese selector, `Pedidos.tsx` no menciona "repartidor" en
-- ninguna parte y ese PATCH queda inalcanzable desde la UI.
--
-- Gap adicional descubierto al construir esto (verificado contra el código real, no
-- solo sospechado): la policy "staff ve su propia membership" (`0001_core_schema.sql`)
-- restringe `core.membership` a `user_id = auth.uid()` -- SOLO la fila propia de quien
-- consulta. La validación que YA existía en `assign-repartidor`
-- (`deps.coreRepo.findMembershipsByUserId(raw.repartidorId)`) corre sobre la sesión de
-- SISTEMA de `ProductionCoreRepository` (`engine.withAppSession({ userId: null }, ...)`,
-- ver `apps/api/src/production/core-repository.ts`) -- sin `auth.uid()` real, esa
-- policy nunca deja ver la membership de NADIE, ni siquiera la del propio staff que se
-- está validando. Contra Postgres real (nunca contra el repo en memoria de los tests,
-- que no emula RLS), `esRepartidorDeEstaOrg` era SIEMPRE `false`: ese PATCH ya estaba
-- roto en producción para cualquier organización real, mismo síntoma/causa raíz que
-- este hallazgo.
--
-- Solución (una sola función real, usada tanto por el selector nuevo como por el
-- arreglo de `assign-repartidor`, ver `apps/api/src/routes/verticals/restaurantes/
-- admin-orders.ts`/`admin-staff.ts`): función `security definer`, MISMO patrón exacto
-- que `core.has_property_access` (`0001_core_schema.sql`) y
-- `core.accept_staff_invite` (`0002_staff_invite_schema.sql`) -- nunca ensanchar la
-- policy de SELECT de `core.membership`/`core.staff_user` en general (seguiría
-- filtrando PII de TODO el staff de la organización a cualquier compañero con sesión
-- real, mucho más ancho de lo que este gap pide). `core.list_org_members_by_vertical_
-- role` devuelve SOLO id/email/nombre/property_ids de los miembros con el
-- `vertical_role` EXACTO pedido, y únicamente si quien llama (`auth.uid()`) es TAMBIÉN
-- miembro de esa misma organización -- defensa en profundidad real; la autorización
-- fina por rol (MANAGER_ROLES puede listar/asignar, REPARTIDOR_ROLES no) la sigue
-- imponiendo la capa TS (`assertVerticalRole`), igual que el resto del monorepo.
create or replace function core.list_org_members_by_vertical_role(p_organization_id uuid, p_vertical_role text)
returns table (
  user_id uuid,
  email text,
  full_name text,
  property_ids uuid[]
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select su.id, su.email, su.full_name, m.property_ids
  from core.membership m
  join core.staff_user su on su.id = m.user_id
  where m.organization_id = p_organization_id
    and m.vertical_role = p_vertical_role
    and exists (
      select 1 from core.membership caller
      where caller.organization_id = p_organization_id
        and caller.user_id = auth.uid()
    )
  order by su.full_name asc;
$$;

revoke all on function core.list_org_members_by_vertical_role(uuid, text) from public;
-- El caller SIEMPRE corre bajo el rol `authenticated` (ver
-- `ManagedPostgresEngine.withAppSession`: `set local role authenticated` en toda
-- sesión, con o sin `auth.uid()` real) -- nunca `anon`, mismo criterio que
-- `core.accept_staff_invite`.
grant execute on function core.list_org_members_by_vertical_role(uuid, text) to authenticated;

-- FASE 3 (producto, restaurantes) — hallazgo real: hoy NO existe ninguna forma de
-- dar de baja a un miembro de staff YA ACEPTADO (`core.membership`) -- solo existe
-- revocar una invitación PENDIENTE (`core.revoke_staff_invite`, `migrations/
-- 0002_staff_invite_schema.sql`). Mismo criterio de "mecanismo genérico vive en
-- core" que ya se aplicó a `core.list_org_members`/`core.update_membership_role`
-- (`migrations/0007_update_membership_role.sql`, ver su comentario de cabecera):
-- este PR lo construye para restaurantes (`admin-staff.ts`), pero la función vive
-- aquí, en `core`, para que las otras 5 verticales con el mismo patrón de alta de
-- staff (despachos/citas/licitaciones/hoteles/rentas) puedan exponer su propia
-- ruta sin tocar `core` de nuevo -- mismo motivo por el que `update_membership_role`
-- ya vive aquí en vez de duplicarse por vertical.
--
-- `core.remove_membership(organization_id, target_user_id)` -- SOLO elimina la fila
-- de `core.membership` de ESTA organización, NUNCA `core.staff_user` (ese usuario
-- puede seguir siendo staff de OTRA organización, o aceptar una invitación nueva
-- más adelante -- borrar la cuenta completa sería un alcance mucho mayor que "dar
-- de baja de esta organización", y ninguna ruta real lo pide).
--
-- Autoridad real DENTRO de la función (nunca solo la capa TS que la llama, mismo
-- principio que `update_membership_role`):
--   1. Nunca auto-baja -- un staff no puede darse de baja a sí mismo por esta vía
--      (mismo criterio que "nunca auto-cambio de rol" de `update_membership_role`:
--      evita que una sesión comprometida se remueva a sí misma para borrar rastro,
--      o que alguien se quede sin acceso por error de un clic; retirarse de una
--      organización, si algún día se construye, es un flujo DISTINTO y deliberado,
--      fuera de alcance aquí).
--   2. El caller debe ser admin/owner (`platform_role` rango >= 3) de
--      `organization_id` -- mismo umbral que `update_membership_role`.
--   3. El caller nunca puede dar de baja a alguien de MÁS alcance que el suyo (un
--      admin nunca puede dar de baja a un owner) -- misma jerarquía de rango que
--      `update_membership_role`.
--   4. CASO LÍMITE decidido explícitamente para esta fase ("no dejar la
--      organización sin ningún owner"): si el target es `owner`, la baja se
--      RECHAZA cuando es el ÚNICO owner que queda -- sin este chequeo, el último
--      owner podría quedar removido (por otro owner con exactamente el mismo
--      rango, la única combinación que la regla 3 permitiría) y la organización
--      quedaría sin nadie con el rango más alto, sin ningún camino de recuperación
--      real (nadie podría volver a invitar a un owner). Un owner solitario,
--      además, ya está protegido de auto-bajarse por la regla 1 -- este chequeo
--      cubre el caso restante: OTRO owner dando de baja al único owner.
create or replace function core.remove_membership(
  p_organization_id uuid,
  p_target_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_caller_role text;
  v_target_role text;
  v_rank_caller int;
  v_rank_target int;
  v_owner_count int;
begin
  if p_target_user_id = auth.uid() then
    raise exception 'no puedes darte de baja a ti mismo' using errcode = 'P0001';
  end if;

  select m.platform_role into v_caller_role
    from core.membership m
    where m.organization_id = p_organization_id and m.user_id = auth.uid();
  if v_caller_role is null then
    raise exception 'no perteneces a esta organización' using errcode = 'P0001';
  end if;

  select m.platform_role into v_target_role
    from core.membership m
    where m.organization_id = p_organization_id and m.user_id = p_target_user_id;
  if v_target_role is null then
    raise exception 'el staff indicado no pertenece a esta organización' using errcode = 'P0001';
  end if;

  v_rank_caller := case v_caller_role when 'owner' then 4 when 'admin' then 3 when 'member' then 2 when 'viewer' then 1 else 0 end;
  v_rank_target := case v_target_role when 'owner' then 4 when 'admin' then 3 when 'member' then 2 when 'viewer' then 1 else 0 end;

  -- Mismo umbral que `update_membership_role`: solo admin/owner dan de baja staff.
  if v_rank_caller < 3 then
    raise exception 'tu rol no alcanza para dar de baja a un staff' using errcode = 'P0001';
  end if;
  -- Nunca dar de baja a alguien de más alcance que el propio.
  if v_rank_caller < v_rank_target then
    raise exception 'no puedes dar de baja a alguien con más alcance que el tuyo' using errcode = 'P0001';
  end if;

  -- Caso límite explícito de esta fase (ver comentario de cabecera, punto 4).
  if v_target_role = 'owner' then
    select count(*) into v_owner_count
      from core.membership m
      where m.organization_id = p_organization_id and m.platform_role = 'owner';
    if v_owner_count <= 1 then
      raise exception 'no puedes dejar la organización sin ningún owner' using errcode = 'P0001';
    end if;
  end if;

  delete from core.membership m
    where m.organization_id = p_organization_id and m.user_id = p_target_user_id;
end;
$$;

revoke all on function core.remove_membership(uuid, uuid) from public;
-- Mismo criterio que `update_membership_role`/`list_org_members`: el caller SIEMPRE
-- corre bajo el rol `authenticated` (`ManagedPostgresEngine.withAppSession`), nunca
-- `anon` -- el guard `auth.uid()` de arriba de todos modos rechazaría a `anon` (su
-- `auth.uid()` es NULL, cae en "no perteneces a esta organización"), pero no se le
-- concede EXECUTE de todas formas, mismo principio de menor privilegio que el resto
-- de este archivo.
grant execute on function core.remove_membership(uuid, uuid) to authenticated;

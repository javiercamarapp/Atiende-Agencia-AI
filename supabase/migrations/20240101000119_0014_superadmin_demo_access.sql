-- "Entrar a los otros paneles" — pedido real de Javier: desde superadmin, poder
-- entrar a cada una de las 6 soluciones "con tu propia sesión, sin credenciales
-- ajenas" (mismo patrón que `selector-vista.tsx` de Likida, referencia de solo
-- lectura) para ver cómo se ve y PROBAR botones/comandos reales -- explícitamente
-- NO solo una foto estática ("sin datos pero puede probar comandos botones etc"),
-- pero tampoco tocar nunca los datos reales de un cliente real.
--
-- Diseño elegido (deliberadamente el más simple y seguro de los que se evaluaron):
-- NO se inventa un mecanismo de impersonación/token nuevo. Se reutiliza el modelo
-- real que YA existe (`core.organization`/`core.membership`) creando, de forma
-- idempotente, una organización DEMO por vertical ("Demo — Vista previa") con el
-- superadmin como miembro real de ella (rol de acceso total de esa vertical). A
-- partir de ahí, el flujo de siempre (`POST /auth/select-org`, ya construido y
-- probado) hace el resto -- el superadmin entra al Shell REAL de esa vertical con
-- un token REAL, exactamente como cualquier staff. Cero superficie de seguridad
-- nueva: es el mismo modelo de autorización que ya protege a cada cliente real,
-- nunca un atajo que lo bypasee.
--
-- "Sin datos" se cumple porque la organización demo empieza genuinamente vacía
-- (0 reservas/pedidos/propiedades/lo que sea) -- exactamente lo que ve un cliente
-- nuevo el día 1. "Puede probar comandos y botones" se cumple porque es una
-- organización REAL: crear una propiedad/reserva/pedido de prueba ahí adentro
-- funciona de verdad, sin fingir nada -- solo que nunca es la organización de un
-- cliente real.
--
-- Mismo criterio de acceso que el resto del back office de plataforma: sin GRANT
-- directo, función `security definer` que valida `is_platform_superadmin`
-- DENTRO de la función.

-- Columnas de salida con nombres DISTINTOS a cualquier columna real de
-- `core.organization`/`core.membership` a propósito -- `RETURNS TABLE` crea
-- variables PL/pgSQL implícitas con esos mismos nombres, y esas variables ganan
-- ambigüedad real contra columnas homónimas en CUALQUIER punto del cuerpo,
-- incluida la lista de columnas de un `ON CONFLICT (...)` (que no admite calificar
-- con el nombre de la tabla). Encontrado en vivo verificando contra producción:
-- primero "column reference \"slug\" is ambiguous" en el SELECT, luego
-- "organization_id" ambiguo en el ON CONFLICT tras el primer fix a medias.
create or replace function core.ensure_demo_access_for_superadmin(p_caller_id uuid, p_vertical text)
returns table (demo_organization_id uuid, demo_slug text)
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_org_id uuid;
  v_slug text;
  v_vertical_role text;
  v_org_name text;
begin
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_vertical not in ('hoteles','restaurantes','rentas','licitaciones','citas','despachos') then
    raise exception 'vertical inválida' using errcode = '22023';
  end if;

  -- Rol de acceso total real de cada vertical (ver packages/domain-<vertical>/src/
  -- roles.ts -- el mismo vocabulario que ya usa cualquier staff real, nunca un rol
  -- inventado solo para esto).
  v_vertical_role := case p_vertical
    when 'hoteles' then 'owner'
    when 'restaurantes' then 'owner'
    when 'citas' then 'owner'
    when 'licitaciones' then 'owner'
    when 'despachos' then 'admin'
    when 'rentas' then 'admin_gestora'
  end;

  v_slug := 'demo-' || p_vertical;
  v_org_name := 'Demo — Vista previa (' || p_vertical || ')';

  select o.id into v_org_id from core.organization o where o.slug = v_slug;

  if v_org_id is null then
    insert into core.organization (vertical, name, slug, status)
    values (p_vertical, v_org_name, v_slug, 'active')
    returning id into v_org_id;
  end if;

  insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role)
  values (p_caller_id, v_org_id, null, 'owner', v_vertical_role)
  on conflict (user_id, organization_id) do nothing;

  return query select v_org_id as demo_organization_id, v_slug as demo_slug;
end;
$$;

revoke all on function core.ensure_demo_access_for_superadmin(uuid, text) from public;
grant execute on function core.ensure_demo_access_for_superadmin(uuid, text) to authenticated;

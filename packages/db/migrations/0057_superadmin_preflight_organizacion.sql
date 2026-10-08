-- Superadmin: "Listo para produccion" de una organizacion de restaurantes (go-live G-05/G-16) -- hechos de SOLO LECTURA.
--
-- Problema (disponibilidad del arranque): el dia de conectar el numero real de una organizacion hay ~20 condiciones de datos y de
-- canal que hoy se revisan a mano (sucursales activas con menu y horario, canal de WhatsApp, voz, privacidad, equipo). El superadmin
-- NO es miembro de la organizacion, asi que las policies de restaurantes.* (que exigen membresia o sesion de sistema) no le dejan
-- leer nada de eso, y las lecturas de la ficha 360 (0052) solo cuentan pasos gruesos. Esta migracion agrega UNA funcion que junta, en
-- una sola lectura, los hechos que necesita el calculo puro del preflight (apps/api/src/superadmin-preflight, que reutiliza
-- packages/domain-restaurantes/src/onboarding.ts::buildOnboardingChecklist sin duplicarlo).
--
-- Que agrega (nada escribe ni toca datos existentes):
--   core.get_org_preflight_restaurantes_for_superadmin(p_caller_id uuid, p_organization_id uuid) returns jsonb
--     * organizacion inexistente -> NULL; vertical distinta de 'restaurantes' -> {vertical, restaurantes: null} (el preflight marca
--       "no aplica");
--     * restaurantes -> sucursales (activa, coordenadas, productos disponibles, horario crudo, pedido minimo a domicilio, zonas, numero
--       propio de WhatsApp, decision de voz), canal general de WhatsApp, agente configurado y nombre,
--       si hay pedidos, y la configuracion de privacidad (responsable, URL del aviso, version) con los avisos publicados.
--     * Cada bloque corre en su propio subbloque: si una tabla o columna falta en este despliegue, ESE bloque queda en NULL ("no se
--       pudo medir") y el resto se entrega; nunca se inventa un cero ni un "hecho".
--
-- Requiere: 0001 (core), 0010/0012 (core.is_platform_superadmin) y las migraciones de restaurantes 001/017/023/025/029/030 (si alguna
-- falta, su bloque queda en NULL como se dijo arriba).
--
-- Justificacion de seguridad (cada funcion trae su razon):
--   * security definer porque lee tablas de restaurantes.* y core.* donde el superadmin no tiene policy; `set search_path = core,
--     pg_temp` fijo y todas las tablas calificadas con su schema; ningun SQL dinamico ni parametro de texto libre.
--   * Autorizacion DENTRO de la funcion: auth.uid() = p_caller_id y superadmin de plataforma real (core.is_platform_superadmin). Un
--     staff normal, un uid ajeno (caller-binding), la sesion de sistema (uid nulo) y anon reciben 42501 (rechazo explicito: no se
--     devuelven "cero filas" que parezcan una organizacion vacia).
--   * revoke all ... from public, anon y grant execute SOLO a `authenticated` (rol bajo el que corre toda sesion de la app); nunca a anon.
--   * Aislamiento entre organizaciones: TODA lectura se filtra por p_organization_id (o por las sucursales de esa organizacion);
--     la funcion no recibe otro identificador.
--   * Privacidad: devuelve conteos, banderas y nombres de sucursal; NO devuelve correos, telefonos, numeros de WhatsApp, URL del aviso
--     de privacidad ni textos de clientes, ni secretos (de la URL solo se informa si existe).

create or replace function core.get_org_preflight_restaurantes_for_superadmin(p_caller_id uuid, p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path = core, pg_temp as $$
declare
  v_vertical text;
  v_sucursales jsonb := null;
  v_general boolean := null;
  v_agente jsonb := null;
  v_pedidos boolean := null;
  v_privacidad jsonb := null;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    raise exception 'acceso denegado: solo el superadmin de plataforma lee el preflight de una organizacion' using errcode = '42501';
  end if;

  select o.vertical into v_vertical from core.organization o where o.id = p_organization_id;
  if v_vertical is null then
    return null;
  end if;
  if v_vertical <> 'restaurantes' then
    return jsonb_build_object('vertical', v_vertical, 'restaurantes', null);
  end if;

  -- Sucursales con todo lo que el checklist del dueño mide por sucursal (el equipo se lee con core.list_org_team_for_superadmin, 0053).
  begin
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id,
        'nombre', p.name,
        'activa', p.status = 'active',
        'conCoordenadas', (bd.lat is not null and bd.lng is not null),
        'productosDisponibles', (select count(*) from restaurantes.branch_products bp where bp.property_id = p.id and bp.is_available),
        'horario', (select to_jsonb(bpol.horario) from restaurantes.branch_policy bpol where bpol.property_id = p.id),
        'conPedidoMinimoDomicilio', coalesce((select bpol.pedido_minimo_domicilio is not null from restaurantes.branch_policy bpol where bpol.property_id = p.id), false),
        'zonasDeEntrega', (select count(*) from restaurantes.branch_delivery_zone z where z.property_id = p.id),
        'conWhatsappPropio', exists (select 1 from restaurantes.whatsapp_branch_channel c where c.property_id = p.id),
        'voz', case
                 when not exists (select 1 from restaurantes.branch_voice_config v where v.property_id = p.id) then 'sin_configurar'
                 when (select v.habilitado from restaurantes.branch_voice_config v where v.property_id = p.id) then 'habilitada'
                 else 'deshabilitada'
               end
      ) order by bd.display_order, p.name), '[]'::jsonb)
      into v_sucursales
    from core.property p
    join restaurantes.branch_detail bd on bd.property_id = p.id
    where p.organization_id = p_organization_id;
  exception when undefined_table or undefined_column then
    v_sucursales := null;
  end;

  begin
    select exists (select 1 from restaurantes.whatsapp_channel_config c where c.organization_id = p_organization_id and nullif(btrim(c.phone_number_id), '') is not null)
      into v_general;
  exception when undefined_table or undefined_column then
    v_general := null;
  end;

  begin
    select jsonb_build_object(
        'configurada', exists (select 1 from restaurantes.whatsapp_agent_config a where a.organization_id = p_organization_id and a.property_id is null),
        'conNombre', exists (select 1 from restaurantes.whatsapp_agent_config a
                              where a.organization_id = p_organization_id and a.property_id is null and nullif(btrim(coalesce(a.agent_name, '')), '') is not null))
      into v_agente;
  exception when undefined_table or undefined_column then
    v_agente := null;
  end;

  begin
    select exists (select 1 from restaurantes.orders ord where ord.organization_id = p_organization_id) into v_pedidos;
  exception when undefined_table or undefined_column then
    v_pedidos := null;
  end;

  begin
    select jsonb_build_object(
        'configurada', pc.organization_id is not null,
        'conResponsable', coalesce(nullif(btrim(pc.responsible_name), '') is not null, false),
        'conAviso', coalesce(pc.notice_url is not null, false),
        'version', pc.notice_version,
        'avisosPublicados', (select count(*) from core.privacy_notice_version nv where nv.organization_id = p_organization_id))
      into v_privacidad
    from (select 1) one
    left join restaurantes.privacy_config pc on pc.organization_id = p_organization_id;
  exception when undefined_table or undefined_column then
    v_privacidad := null;
  end;

  return jsonb_build_object(
    'vertical', v_vertical,
    'restaurantes', jsonb_build_object(
      'sucursales', v_sucursales,
      'whatsappGeneral', v_general,
      'agente', v_agente,
      'hayPedidos', v_pedidos,
      'privacidad', v_privacidad));
end;
$$;
revoke all on function core.get_org_preflight_restaurantes_for_superadmin(uuid, uuid) from public, anon;
grant execute on function core.get_org_preflight_restaurantes_for_superadmin(uuid, uuid) to authenticated;

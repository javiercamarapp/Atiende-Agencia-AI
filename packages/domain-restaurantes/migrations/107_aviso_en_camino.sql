-- 107 -- Aviso «su pedido va en camino» por WhatsApp (decision del dueno de PM, 9-nov-2026).
--
-- Cuando un pedido a DOMICILIO pasa a `en_camino` se avisa al cliente UNA vez, venga de WhatsApp, de una llamada (agente de voz) o del panel.
-- Dentro de la ventana de 24 h de su conversacion se manda texto libre; fuera de ella (siempre en pedidos por llamada) solo la plantilla utility
-- aprobada de la organizacion (catalogo core.whatsapp_plantilla, evento `order.en_camino`). Sin plantilla aprobada NO se envia nada y el pedido queda
-- marcado `omitido_falta_plantilla` (estado honesto); el TypeScript emite UNA notificacion in-app al dueno.
--
-- Por que hace falta SQL: el cambio a `en_camino` lo hace una sesion de STAFF o de CHOFER (auth.uid() real). Esa sesion no puede leer el ledger de
-- mensajes entrantes (ventana de 24 h), ni el catalogo de plantillas (solo owner/admin; `core.whatsapp_plantilla_aprobada` es solo-sistema), ni la
-- huella del consentimiento (091). Una funcion definer devuelve SOLO booleanos y el nombre/idioma/variables de la plantilla aprobada; nunca el telefono.
--
-- QUE HACE (aditivo e idempotente):
--   1. restaurantes.orders.aviso_en_camino (+ aviso_en_camino_at): como termino el aviso de ESE pedido (texto | plantilla | omitido_*). Un estado
--      «enviado» (texto/plantilla) no se vuelve a pisar: el aviso sale una sola vez por pedido (el outbox ademas deduplica por pedido).
--   2. restaurantes.aviso_en_camino_config: interruptor por organizacion. Sin fila = ENCENDIDO (decision del dueno: por omision para restaurantes con
--      WhatsApp conectado; sin canal conectado no hay a donde enviar y el TypeScript lo omite).
--   3. restaurantes.aviso_en_camino_contexto(org, pedido) -> jsonb: interruptor, ventana abierta, consentimiento (091), plantilla aprobada, ya avisado.
--   4. restaurantes.aviso_en_camino_marcar(org, pedido, estado) -> boolean: registra el resultado en el pedido.
--   5. restaurantes.aviso_en_camino_config_leer / _guardar: lectura (gestores) y cambio (owner/admin de toda la organizacion).
--
-- Justificacion de seguridad:
--  * aviso_en_camino_config: RLS activa, `revoke all` de public/anon/authenticated, sin policies (solo funciones); service_role lee/escribe.
--  * Columnas nuevas de orders: el authenticated ya tiene UPDATE de tabla completa (007) y no se concede nada nuevo; las escribe la funcion definer.
--    Solo guardan un codigo de estado (CHECK cerrado) y una marca de tiempo; nada de PII.
--  * aviso_en_camino_contexto / _marcar: SECURITY DEFINER con search_path fijo (pg_temp al final), revoke de public/anon, grant a authenticated
--    (este monorepo siempre conecta como authenticated; la sesion de sistema es auth.uid() nulo, ver 015). Autorizacion dentro: sistema; o owner/admin/staff
--    de la organizacion con alcance a la sucursal del pedido; o el CHOFER asignado a ESE pedido. Cualquier otro (otro tenant, otra sucursal, chofer
--    ajeno) => 42501. El pedido se busca por (organizacion, id): un pedido de otra organizacion es «inexistente» (null / false), nunca se filtra.
--    La ventana se calcula con las huellas SHA-256 del telefono DENTRO de la funcion (el llamador no inyecta telefonos ni huellas: no es un oraculo de
--    «¿este numero escribio?»). Devuelve solo booleanos y la plantilla aprobada de ESA organizacion (nombre, idioma, nombres de variables).
--  * aviso_en_camino_config_guardar: owner/admin con membresia de alcance organizacional (property_ids nulo); sistema => 42501 (es una decision del dueno).
--  * aviso_en_camino_config_leer: sistema u owner/admin/staff de la organizacion.
--
-- Compatibilidad con la base SIN migrar: el TypeScript captura 42883/42P01/42703 en SAVEPOINT y cae al aviso anterior (texto libre + plantilla
-- `pedido_en_camino` declarada en el payload; el gateway decide con WHATSAPP_APPROVED_TEMPLATES). Orden de despliegue: cualquiera.
--
-- REVERSA (no destruye nada historico; solo se pierde el estado del aviso y el interruptor):
--     drop function if exists restaurantes.aviso_en_camino_config_guardar(uuid, boolean);
--     drop function if exists restaurantes.aviso_en_camino_config_leer(uuid);
--     drop function if exists restaurantes.aviso_en_camino_marcar(uuid, uuid, text);
--     drop function if exists restaurantes.aviso_en_camino_contexto(uuid, uuid);
--     drop table if exists restaurantes.aviso_en_camino_config;
--     alter table restaurantes.orders drop column if exists aviso_en_camino, drop column if exists aviso_en_camino_at;

alter table restaurantes.orders
  add column if not exists aviso_en_camino text check (aviso_en_camino is null or aviso_en_camino in (
    'texto', 'plantilla', 'omitido_falta_plantilla', 'omitido_sin_consentimiento', 'omitido_baja', 'omitido_desactivado'
  )),
  add column if not exists aviso_en_camino_at timestamptz;

create table if not exists restaurantes.aviso_en_camino_config (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  activo boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references core.staff_user(id) on delete set null
);
alter table restaurantes.aviso_en_camino_config enable row level security;
revoke all on restaurantes.aviso_en_camino_config from public, anon, authenticated;
grant select, insert, update, delete on restaurantes.aviso_en_camino_config to service_role;

-- ¿Puede la sesion actual operar el aviso de este pedido? (helper interno, no se concede a nadie).
create or replace function restaurantes.aviso_en_camino_puede(p_organization_id uuid, p_property_id uuid, p_repartidor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
  select auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.user_id = auth.uid()
        and m.organization_id = p_organization_id
        and (
          (m.vertical_role in ('owner', 'admin', 'staff') and (m.property_ids is null or p_property_id = any (m.property_ids)))
          or (m.vertical_role = 'repartidor' and p_repartidor_id is not null and p_repartidor_id = auth.uid())
        )
    );
$$;
revoke all on function restaurantes.aviso_en_camino_puede(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function restaurantes.aviso_en_camino_contexto(p_organization_id uuid, p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_o restaurantes.orders;
  v_digitos text;
  v_d10 text;
  v_huellas text[];
  v_activo boolean;
  v_ventana boolean;
  v_consentimiento text;
  v_plantilla jsonb;
begin
  select * into v_o from restaurantes.orders o where o.id = p_order_id and o.organization_id = p_organization_id;
  if not found then
    return null;
  end if;
  if not restaurantes.aviso_en_camino_puede(p_organization_id, v_o.property_id, v_o.assigned_repartidor_id) then
    raise exception 'aviso_en_camino_contexto: sin acceso a este pedido' using errcode = '42501';
  end if;

  select c.activo into v_activo from restaurantes.aviso_en_camino_config c where c.organization_id = p_organization_id;

  -- Huellas del telefono en los formatos que llegan de Meta (+52 / +521) y tal cual (E.164 con codigo de pais).
  v_digitos := regexp_replace(coalesce(v_o.customer_phone, ''), '[^0-9]', '', 'g');
  v_d10 := case when char_length(v_digitos) >= 10 then right(v_digitos, 10) end;
  v_huellas := array_remove(array[
    case when char_length(v_digitos) between 10 and 15 then encode(sha256(convert_to('+' || v_digitos, 'UTF8')), 'hex') end,
    case when v_d10 is not null then encode(sha256(convert_to('+52' || v_d10, 'UTF8')), 'hex') end,
    case when v_d10 is not null then encode(sha256(convert_to('+521' || v_d10, 'UTF8')), 'hex') end
  ], null);

  -- Ventana de 24 h de Meta (con 1 h de margen para la demora del despachador): el cliente escribio a la organizacion hace menos de 23 h.
  v_ventana := cardinality(v_huellas) > 0 and exists (
    select 1 from restaurantes.whatsapp_inbound_events e
    where e.organization_id = p_organization_id
      and e.phone_hash = any (v_huellas)
      and e.claimed_at > now() - interval '23 hours'
  );

  -- Consentimiento de avisos (091): una revocacion (BAJA/STOP o un NO registrado) gana; vigente = otorgado y no revocado.
  select case when bool_or(c.revocado_en is not null or not c.otorgado) then 'revocado'
              when bool_or(c.otorgado and c.revocado_en is null) then 'vigente'
         end
    into v_consentimiento
  from restaurantes.whatsapp_aviso_consentimiento c
  where c.organization_id = p_organization_id and c.telefono_hash = any (v_huellas);

  select jsonb_build_object('nombre', p.nombre, 'idioma', p.idioma, 'variables', to_jsonb(p.variables))
    into v_plantilla
  from core.whatsapp_plantilla p
  where p.organization_id = p_organization_id and p.vertical = 'restaurantes' and p.evento = 'order.en_camino' and p.estado = 'aprobada'
  order by p.aprobada_en desc nulls last, p.id
  limit 1;

  return jsonb_build_object(
    'activo', coalesce(v_activo, true),
    'ventana_abierta', v_ventana,
    'consentimiento', coalesce(v_consentimiento, 'sin_registro'),
    -- Pedido capturado por personal (llamada/mostrador/whatsapp manual, 090): sin consentimiento registrado no se avisa (091).
    'requiere_consentimiento', v_o.canal_captura is not null,
    'aviso_whatsapp', v_o.aviso_whatsapp,
    'plantilla', v_plantilla,
    'ya_avisado', coalesce(v_o.aviso_en_camino in ('texto', 'plantilla'), false)
  );
end;
$$;

create or replace function restaurantes.aviso_en_camino_marcar(p_organization_id uuid, p_order_id uuid, p_estado text)
returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_o restaurantes.orders;
begin
  if p_estado is null or p_estado not in ('texto', 'plantilla', 'omitido_falta_plantilla', 'omitido_sin_consentimiento', 'omitido_baja', 'omitido_desactivado') then
    raise exception 'aviso_en_camino_marcar: estado invalido' using errcode = '22023';
  end if;
  select * into v_o from restaurantes.orders o where o.id = p_order_id and o.organization_id = p_organization_id for update;
  if not found then
    return false;
  end if;
  if not restaurantes.aviso_en_camino_puede(p_organization_id, v_o.property_id, v_o.assigned_repartidor_id) then
    raise exception 'aviso_en_camino_marcar: sin acceso a este pedido' using errcode = '42501';
  end if;
  -- Una sola vez: un aviso ya encolado (texto/plantilla) no se pisa.
  if v_o.aviso_en_camino in ('texto', 'plantilla') then
    return false;
  end if;
  update restaurantes.orders set aviso_en_camino = p_estado, aviso_en_camino_at = now()
  where id = p_order_id and organization_id = p_organization_id;
  return true;
end;
$$;

create or replace function restaurantes.aviso_en_camino_config_leer(p_organization_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v boolean;
begin
  if auth.uid() is not null and not exists (
    select 1 from core.membership m
    where m.user_id = auth.uid() and m.organization_id = p_organization_id and m.vertical_role in ('owner', 'admin', 'staff')
  ) then
    raise exception 'aviso_en_camino_config_leer: sin acceso a la organizacion' using errcode = '42501';
  end if;
  select c.activo into v from restaurantes.aviso_en_camino_config c where c.organization_id = p_organization_id;
  return coalesce(v, true);
end;
$$;

create or replace function restaurantes.aviso_en_camino_config_guardar(p_organization_id uuid, p_activo boolean)
returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if p_activo is null then
    raise exception 'aviso_en_camino_config_guardar: activo es obligatorio' using errcode = '22023';
  end if;
  if auth.uid() is null or not exists (
    select 1 from core.membership m
    where m.user_id = auth.uid() and m.organization_id = p_organization_id and m.vertical_role in ('owner', 'admin') and m.property_ids is null
  ) then
    raise exception 'aviso_en_camino_config_guardar: requiere owner/admin de toda la organizacion' using errcode = '42501';
  end if;
  insert into restaurantes.aviso_en_camino_config as c (organization_id, activo, updated_by)
  values (p_organization_id, p_activo, auth.uid())
  on conflict (organization_id) do update set activo = excluded.activo, updated_at = now(), updated_by = auth.uid();
  return p_activo;
end;
$$;

revoke all on function restaurantes.aviso_en_camino_contexto(uuid, uuid) from public, anon;
revoke all on function restaurantes.aviso_en_camino_marcar(uuid, uuid, text) from public, anon;
revoke all on function restaurantes.aviso_en_camino_config_leer(uuid) from public, anon;
revoke all on function restaurantes.aviso_en_camino_config_guardar(uuid, boolean) from public, anon;
grant execute on function restaurantes.aviso_en_camino_contexto(uuid, uuid) to authenticated, service_role;
grant execute on function restaurantes.aviso_en_camino_marcar(uuid, uuid, text) to authenticated, service_role;
grant execute on function restaurantes.aviso_en_camino_config_leer(uuid) to authenticated, service_role;
grant execute on function restaurantes.aviso_en_camino_config_guardar(uuid, boolean) to authenticated;

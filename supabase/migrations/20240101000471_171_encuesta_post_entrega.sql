-- 171 -- Encuesta post-entrega por WhatsApp (F4b, paso 18 del dia): UNA pregunta de 1 a 5 y comentario opcional, UNA sola vez por pedido,
-- solo dentro de la ventana de 24 h de WhatsApp o con plantilla aprobada (y consentimiento), con baja (opt-out), registro y metricas.
-- Prefijo de supabase/migrations: 20240101000471. Requiere: 091 (consentimiento_aviso_vigente), 090/170 (orders), 001 (whatsapp_conversations).
--
-- Revision de #713 (P1-2): SIN filtrado de resenas. La encuesta no ofrece enlace de resena a nadie (politicas de Google y FTC 16 CFR 465 prohiben condicionarlo a la calificacion), por eso
-- la configuracion ya no guarda ningun enlace.
--
-- Que agrega:
--   1. restaurantes.encuesta_config (por sucursal; APAGADA por omision) y restaurantes.encuesta_optout (huella del telefono, sin telefono).
--   2. restaurantes.encuesta_entrega: un renglon por pedido (UNIQUE) con estado enviada | respondida | omitida (+ motivo), canal de envio,
--      calificacion 1..5 y comentario <= 500. El renglon se reserva ANTES de encolar el mensaje: dos barridos nunca envian dos encuestas.
--   3. Funciones: encuesta_config_leer / encuesta_config_guardar (panel), encuesta_candidatas, encuesta_contexto, encuesta_reservar,
--      encuesta_estado_para, encuesta_responder, encuesta_comentar, encuesta_optout_registrar (solo sistema) y encuesta_metricas (panel).
--
-- Privacidad: la huella es sha256 de los ultimos 10 digitos del telefono (la calcula el TypeScript o la funcion); NINGUNA tabla guarda telefono ni nombre.
-- El comentario es texto libre del cliente: solo lo leen owner/admin/staff de su organizacion (policy) y no sale en notificaciones ni en logs.
-- Justificacion de seguridad:
--  * Tablas con RLS; `revoke all` de public/anon/authenticated; `grant select` a authenticated POR COLUMNA (todas menos phone_hash) con policy de
--    owner/admin/staff de la organizacion. Nadie escribe directo: toda escritura es por las funciones definer de abajo.
--  * Funciones SECURITY DEFINER con search_path fijo y `revoke all from public, anon`; GRANT EXECUTE solo a authenticated. Las de sistema (candidatas,
--    contexto, reservar, estado_para, responder, comentar, optout_registrar) exigen auth.uid() NULO (42501 si hay usuario): las ejecuta el motor, nunca el staff.
--    Las del panel exigen membresia: config_guardar solo owner/admin, config_leer y metricas owner/admin/staff con alcance a la sucursal.
--  * Toda busqueda lleva organization_id: una huella de otra organizacion no toca nada. Respuesta fuera de rango => 22023.
-- Compatibilidad con la base SIN migrar: 42883/42P01/42703 => el TypeScript responde «no disponible aun» y nunca un 500.
-- REVERSA: drop de las funciones listadas y de las tres tablas (se pierde el registro de encuestas; no se toca ningun pedido).

create table if not exists restaurantes.encuesta_config (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  habilitada boolean not null default false,
  actualizado_en timestamptz not null default now()
);

create table if not exists restaurantes.encuesta_optout (
  organization_id uuid not null references core.organization(id) on delete cascade,
  phone_hash text not null check (phone_hash ~ '^[0-9a-f]{64}$'),
  creado_en timestamptz not null default now(),
  primary key (organization_id, phone_hash)
);

create table if not exists restaurantes.encuesta_entrega (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  order_id uuid not null references restaurantes.orders(id) on delete cascade,
  phone_hash text not null check (phone_hash ~ '^[0-9a-f]{64}$'),
  estado text not null check (estado in ('enviada', 'respondida', 'omitida')),
  omitido_motivo text check (omitido_motivo is null or omitido_motivo in ('opt_out', 'cliente_reciente', 'sin_ventana_ni_plantilla', 'sin_canal', 'sin_telefono')),
  canal_envio text check (canal_envio is null or canal_envio in ('texto', 'plantilla')),
  enviada_en timestamptz,
  calificacion smallint check (calificacion is null or calificacion between 1 and 5),
  comentario text check (comentario is null or length(comentario) <= 500),
  respondida_en timestamptz,
  creada_en timestamptz not null default now(),
  unique (order_id),
  check ((estado = 'respondida') = (calificacion is not null)),
  check ((estado = 'omitida') = (omitido_motivo is not null))
);
create index if not exists encuesta_entrega_org_prop_idx on restaurantes.encuesta_entrega (organization_id, property_id, creada_en desc);
create index if not exists encuesta_entrega_hash_idx on restaurantes.encuesta_entrega (organization_id, phone_hash, creada_en desc);

alter table restaurantes.encuesta_config enable row level security;
alter table restaurantes.encuesta_optout enable row level security;
alter table restaurantes.encuesta_entrega enable row level security;
revoke all on restaurantes.encuesta_config, restaurantes.encuesta_optout, restaurantes.encuesta_entrega from public, anon, authenticated;
grant select on restaurantes.encuesta_config to authenticated;
grant select (id, organization_id, property_id, order_id, estado, omitido_motivo, canal_envio, enviada_en, calificacion, comentario, respondida_en, creada_en)
  on restaurantes.encuesta_entrega to authenticated;

drop policy if exists "staff lee la config de encuestas de su organizacion" on restaurantes.encuesta_config;
create policy "staff lee la config de encuestas de su organizacion" on restaurantes.encuesta_config for select
  using (exists (select 1 from core.membership m where m.user_id = auth.uid() and m.organization_id = encuesta_config.organization_id and m.vertical_role in ('owner', 'admin', 'staff')));
drop policy if exists "staff lee las encuestas de su organizacion" on restaurantes.encuesta_entrega;
create policy "staff lee las encuestas de su organizacion" on restaurantes.encuesta_entrega for select
  using (exists (select 1 from core.membership m where m.user_id = auth.uid() and m.organization_id = encuesta_entrega.organization_id and m.vertical_role in ('owner', 'admin', 'staff')));

-- ---------------------------------------------------------------------------
-- Panel: configuracion
-- ---------------------------------------------------------------------------
create or replace function restaurantes.encuesta_config_leer(p_organization_id uuid, p_property_id uuid)
returns table (habilitada boolean)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
begin
  if auth.uid() is null then
    raise exception 'encuesta_config_leer no es para la sesion de sistema' using errcode = '42501';
  end if;
  if not exists (
    select 1 from core.membership m join core.property p on p.id = p_property_id and p.organization_id = p_organization_id
    where m.user_id = auth.uid() and m.organization_id = p_organization_id and m.vertical_role in ('owner', 'admin', 'staff')
      and (m.property_ids is null or p_property_id = any (m.property_ids))
  ) then
    raise exception 'sin permiso para esta sucursal' using errcode = '42501';
  end if;
  return query select coalesce(c.habilitada, false) from (select 1) u left join restaurantes.encuesta_config c on c.property_id = p_property_id and c.organization_id = p_organization_id;
end;
$$;

create or replace function restaurantes.encuesta_config_guardar(p_organization_id uuid, p_property_id uuid, p_habilitada boolean)
returns void
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'encuesta_config_guardar no es para la sesion de sistema' using errcode = '42501';
  end if;
  if p_habilitada is null then
    raise exception 'encuesta_config_guardar: falta habilitada' using errcode = '22023';
  end if;
  if not exists (
    select 1 from core.membership m join core.property p on p.id = p_property_id and p.organization_id = p_organization_id
    where m.user_id = auth.uid() and m.organization_id = p_organization_id and m.vertical_role in ('owner', 'admin')
      and (m.property_ids is null or p_property_id = any (m.property_ids))
  ) then
    raise exception 'solo owner/admin de la sucursal configuran la encuesta' using errcode = '42501';
  end if;
  insert into restaurantes.encuesta_config (property_id, organization_id, habilitada, actualizado_en)
  values (p_property_id, p_organization_id, p_habilitada, now())
  on conflict (property_id) do update set habilitada = excluded.habilitada, actualizado_en = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- Sistema: barrido de envio
-- ---------------------------------------------------------------------------
-- Pedidos entregados hace >= 2 h (y <= 36 h, para poder diferir el silencio nocturno) de sucursales con la encuesta encendida y SIN renglon de encuesta.
create or replace function restaurantes.encuesta_candidatas(p_ahora timestamptz, p_limite integer default 50)
returns table (order_id uuid, organization_id uuid, property_id uuid, customer_phone text, delivered_at timestamptz, zona_horaria text, phone_hash text,
               ultimo_entrante_at timestamptz, ultima_encuesta_at timestamptz, opt_out boolean, consentimiento boolean)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
begin
  if auth.uid() is not null then
    raise exception 'encuesta_candidatas es solo para la sesion de sistema' using errcode = '42501';
  end if;
  return query
  select x.order_id, x.organization_id, x.property_id, x.customer_phone, x.delivered_at, x.zona_horaria, x.phone_hash,
         (select max(case when m ->> 'at' ~ '^\d{4}-\d{2}-\d{2}T' then (m ->> 'at')::timestamptz end)
            from restaurantes.whatsapp_conversations w, jsonb_array_elements(w.messages) m
           where w.organization_id = x.organization_id and m ->> 'role' = 'user'
             and right(regexp_replace(w.phone, '\D', '', 'g'), 10) = x.digitos),
         (select max(e.enviada_en) from restaurantes.encuesta_entrega e where e.organization_id = x.organization_id and e.phone_hash = x.phone_hash and e.estado in ('enviada', 'respondida')),
         exists (select 1 from restaurantes.encuesta_optout o where o.organization_id = x.organization_id and o.phone_hash = x.phone_hash),
         restaurantes.consentimiento_aviso_vigente(x.organization_id, '+52' || x.digitos)
  from (
    select o.id as order_id, o.organization_id, o.property_id, o.customer_phone, o.delivered_at, bd.zona_horaria,
           right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) as digitos,
           encode(sha256(convert_to(right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10), 'UTF8')), 'hex') as phone_hash
    from restaurantes.orders o
    join restaurantes.encuesta_config c on c.property_id = o.property_id and c.organization_id = o.organization_id and c.habilitada
    left join restaurantes.branch_detail bd on bd.property_id = o.property_id
    where o.status in ('entregado', 'completado')
      and o.delivered_at is not null
      and o.delivered_at <= p_ahora - interval '2 hours'
      and o.delivered_at > p_ahora - interval '36 hours'
      and length(regexp_replace(coalesce(o.customer_phone, ''), '\D', '', 'g')) >= 10
      and not exists (select 1 from restaurantes.encuesta_entrega e where e.order_id = o.id)
    order by o.delivered_at
    limit greatest(1, least(coalesce(p_limite, 50), 200))
  ) x;
end;
$$;

-- Reserva el renglon (una sola vez por pedido). Devuelve true solo a quien lo reservo; quien pierde la carrera NO envia.
create or replace function restaurantes.encuesta_reservar(
  p_organization_id uuid, p_order_id uuid, p_phone_hash text, p_estado text, p_omitido_motivo text, p_canal_envio text
) returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_prop uuid;
  v_n integer;
begin
  if auth.uid() is not null then
    raise exception 'encuesta_reservar es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_estado not in ('enviada', 'omitida') or p_phone_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'encuesta_reservar: argumento invalido' using errcode = '22023';
  end if;
  select property_id into v_prop from restaurantes.orders where id = p_order_id and organization_id = p_organization_id;
  if v_prop is null then
    raise exception 'pedido no encontrado' using errcode = 'P0404';
  end if;
  insert into restaurantes.encuesta_entrega (organization_id, property_id, order_id, phone_hash, estado, omitido_motivo, canal_envio, enviada_en)
  values (p_organization_id, v_prop, p_order_id, p_phone_hash, p_estado, case when p_estado = 'omitida' then p_omitido_motivo end,
          case when p_estado = 'enviada' then p_canal_envio end, case when p_estado = 'enviada' then now() end)
  on conflict (order_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- Sistema: respuestas entrantes
-- ---------------------------------------------------------------------------
-- Que espera el telefono: 'calificacion' (hay una encuesta enviada hace <= 30 min sin responder), 'comentario' (respondio hace <= 30 min y aun sin comentario) o 'ninguna'.
-- Revision de #713 (P1-1): el mensaje solo se toma como respuesta si el telefono NO tiene otra actividad despues de la pregunta. En la conversacion, el unico mensaje posterior a
-- la encuesta debe ser el que se esta evaluando (la encuesta sale por el outbox y no se agrega al hilo): si hay mas (el agente pregunto algo, el cliente ya escribia) o hay un
-- pedido nuevo del telefono posterior a la encuesta, el mensaje es del agente y NO se intercepta. Para el comentario, el unico mensaje del cliente posterior a la calificacion
-- debe ser el actual (el hilo ya trae la respuesta fija de la calificacion).
create or replace function restaurantes.encuesta_estado_para(p_organization_id uuid, p_phone_hash text, p_ahora timestamptz)
returns text
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_e restaurantes.encuesta_entrega;
  v_digitos text;
  v_desde timestamptz;
  v_total integer;
  v_cliente integer;
begin
  if auth.uid() is not null then
    raise exception 'encuesta_estado_para es solo para la sesion de sistema' using errcode = '42501';
  end if;
  select * into v_e from restaurantes.encuesta_entrega e
  where e.organization_id = p_organization_id and e.phone_hash = p_phone_hash and e.estado in ('enviada', 'respondida')
  order by e.enviada_en desc limit 1;
  if not found then return 'ninguna'; end if;
  if v_e.estado = 'enviada' then
    if v_e.enviada_en <= p_ahora - interval '30 minutes' then return 'ninguna'; end if;
    v_desde := v_e.enviada_en;
  elsif v_e.estado = 'respondida' and v_e.comentario is null then
    if v_e.respondida_en <= p_ahora - interval '30 minutes' then return 'ninguna'; end if;
    v_desde := v_e.respondida_en;
  else
    return 'ninguna';
  end if;
  select right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) into v_digitos from restaurantes.orders o where o.id = v_e.order_id and o.organization_id = p_organization_id;
  if v_digitos is null then return 'ninguna'; end if;
  if exists (
    select 1 from restaurantes.orders o
    where o.organization_id = p_organization_id and o.id <> v_e.order_id and o.created_at > v_e.enviada_en
      and right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) = v_digitos
  ) then return 'ninguna'; end if;
  select count(*), count(*) filter (where m ->> 'role' = 'user') into v_total, v_cliente
  from restaurantes.whatsapp_conversations w, jsonb_array_elements(w.messages) m
  where w.organization_id = p_organization_id and right(regexp_replace(w.phone, '\D', '', 'g'), 10) = v_digitos
    and m ->> 'at' ~ '^\d{4}-\d{2}-\d{2}T' and (case when m ->> 'at' ~ '^\d{4}-\d{2}-\d{2}T' then (m ->> 'at')::timestamptz end) > v_desde;
  if v_e.estado = 'enviada' then
    return case when v_total <= 1 then 'calificacion' else 'ninguna' end;
  end if;
  return case when v_cliente <= 1 and v_total <= 2 then 'comentario' else 'ninguna' end;
end;
$$;

create or replace function restaurantes.encuesta_responder(p_organization_id uuid, p_phone_hash text, p_calificacion integer, p_ahora timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_e restaurantes.encuesta_entrega;
  v_num bigint;
begin
  if auth.uid() is not null then
    raise exception 'encuesta_responder es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_calificacion is null or p_calificacion < 1 or p_calificacion > 5 then
    raise exception 'encuesta_responder: calificacion fuera de 1 a 5' using errcode = '22023';
  end if;
  select * into v_e from restaurantes.encuesta_entrega e
  where e.organization_id = p_organization_id and e.phone_hash = p_phone_hash and e.estado = 'enviada' and e.enviada_en > p_ahora - interval '30 minutes'
  order by e.enviada_en desc limit 1 for update;
  if not found then
    return jsonb_build_object('resultado', 'sin_encuesta');
  end if;
  update restaurantes.encuesta_entrega set estado = 'respondida', calificacion = p_calificacion, respondida_en = p_ahora where id = v_e.id;
  select order_number into v_num from restaurantes.orders where id = v_e.order_id;
  return jsonb_build_object('resultado', 'respondida', 'encuesta_id', v_e.id, 'order_id', v_e.order_id, 'property_id', v_e.property_id, 'order_number', v_num);
end;
$$;

create or replace function restaurantes.encuesta_comentar(p_organization_id uuid, p_phone_hash text, p_comentario text, p_ahora timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_e restaurantes.encuesta_entrega;
  v_texto text := left(btrim(coalesce(p_comentario, '')), 500);
begin
  if auth.uid() is not null then
    raise exception 'encuesta_comentar es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if v_texto = '' then
    raise exception 'encuesta_comentar: comentario vacio' using errcode = '22023';
  end if;
  select * into v_e from restaurantes.encuesta_entrega e
  where e.organization_id = p_organization_id and e.phone_hash = p_phone_hash and e.estado = 'respondida' and e.comentario is null and e.respondida_en > p_ahora - interval '30 minutes'
  order by e.respondida_en desc limit 1 for update;
  if not found then
    return jsonb_build_object('resultado', 'sin_encuesta');
  end if;
  update restaurantes.encuesta_entrega set comentario = v_texto where id = v_e.id;
  return jsonb_build_object('resultado', 'comentada', 'encuesta_id', v_e.id, 'order_id', v_e.order_id, 'property_id', v_e.property_id, 'calificacion', v_e.calificacion);
end;
$$;

create or replace function restaurantes.encuesta_optout_registrar(p_organization_id uuid, p_phone_hash text)
returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_n integer;
begin
  if auth.uid() is not null then
    raise exception 'encuesta_optout_registrar es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_phone_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'encuesta_optout_registrar: huella invalida' using errcode = '22023';
  end if;
  insert into restaurantes.encuesta_optout (organization_id, phone_hash) values (p_organization_id, p_phone_hash) on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- Panel: metricas (solo conteos y promedios; sin comentarios ni telefonos)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.encuesta_metricas(p_organization_id uuid, p_property_id uuid, p_desde timestamptz, p_hasta timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_res jsonb;
begin
  if auth.uid() is null then
    raise exception 'encuesta_metricas no es para la sesion de sistema' using errcode = '42501';
  end if;
  if p_desde is null or p_hasta is null or p_hasta <= p_desde or p_hasta - p_desde > interval '366 days' then
    raise exception 'encuesta_metricas: rango invalido (maximo 366 dias)' using errcode = '22023';
  end if;
  if not exists (
    select 1 from core.membership m join core.property p on p.id = p_property_id and p.organization_id = p_organization_id
    where m.user_id = auth.uid() and m.organization_id = p_organization_id and m.vertical_role in ('owner', 'admin', 'staff')
      and (m.property_ids is null or p_property_id = any (m.property_ids))
  ) then
    raise exception 'sin permiso para esta sucursal' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'enviadas', count(*) filter (where e.estado in ('enviada', 'respondida')),
    'respondidas', count(*) filter (where e.estado = 'respondida'),
    'omitidas', count(*) filter (where e.estado = 'omitida'),
    'con_comentario', count(*) filter (where e.comentario is not null),
    'suma_calificacion', coalesce(sum(e.calificacion) filter (where e.estado = 'respondida'), 0),
    'bajas', count(*) filter (where e.calificacion <= 3),
    'distribucion', jsonb_build_object('1', count(*) filter (where e.calificacion = 1), '2', count(*) filter (where e.calificacion = 2), '3', count(*) filter (where e.calificacion = 3),
                                       '4', count(*) filter (where e.calificacion = 4), '5', count(*) filter (where e.calificacion = 5)),
    'omitidas_por_motivo', coalesce((select jsonb_object_agg(z.omitido_motivo, z.n) from (
        select q.omitido_motivo, count(*) as n from restaurantes.encuesta_entrega q
        where q.organization_id = p_organization_id and q.property_id = p_property_id and q.creada_en >= p_desde and q.creada_en < p_hasta and q.estado = 'omitida'
        group by q.omitido_motivo) z), '{}'::jsonb),
    'optouts', (select count(*) from restaurantes.encuesta_optout o where o.organization_id = p_organization_id and o.creado_en >= p_desde and o.creado_en < p_hasta)
  ) into v_res
  from restaurantes.encuesta_entrega e
  where e.organization_id = p_organization_id and e.property_id = p_property_id and e.creada_en >= p_desde and e.creada_en < p_hasta;
  return v_res;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'encuesta_config_leer(uuid, uuid)', 'encuesta_config_guardar(uuid, uuid, boolean)', 'encuesta_candidatas(timestamptz, integer)',
    'encuesta_reservar(uuid, uuid, text, text, text, text)', 'encuesta_estado_para(uuid, text, timestamptz)', 'encuesta_responder(uuid, text, integer, timestamptz)',
    'encuesta_comentar(uuid, text, text, timestamptz)', 'encuesta_optout_registrar(uuid, text)', 'encuesta_metricas(uuid, uuid, timestamptz, timestamptz)'
  ] loop
    execute format('revoke all on function restaurantes.%s from public, anon', f);
    execute format('grant execute on function restaurantes.%s to authenticated', f);
  end loop;
end $$;

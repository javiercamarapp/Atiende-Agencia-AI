-- R-41 (restaurantes): encuesta post-entrega (calificacion 1-5 + comentario), satisfaccion por sucursal y por repartidor,
-- y liga a resenas. Prefijo de supabase/migrations: 20240101000314 (interno restaurantes 061).
-- Requiere: 001 (orders, customers), 008 (orders.assigned_repartidor_id), 019 (audit_log), 022 (branch_detail.zona_horaria),
-- 035 (voz_zona_horaria), 028 (handoff_actor_en_sucursal).
--
-- Flujo (todo real, nada simulado):
--   1. El negocio activa la encuesta POR SUCURSAL (encuesta_config.activa, apagada por defecto) y, si quiere, pega la liga de
--      resenas de la sucursal (https) y el umbral a partir del cual se invita a dejar resena.
--   2. Un barrido idempotente (endpoint interno + boton del panel; sin cron) pide `encuesta_candidatas`: pedidos entregados hace
--      mas de `espera_min` minutos (y menos de 48 h), de sucursales con la encuesta activa y con numero de WhatsApp, sin encuesta registrada. Por cada uno
--      el backend llama `encuesta_registrar_envio` (reserva la fila, una sola vez por pedido) y encola el WhatsApp con la liga
--      firmada en la MISMA transaccion (si el encolado falla, la reserva se revierte con su savepoint).
--   3. El cliente abre la liga (pagina publica sin login), califica y comenta: `encuesta_responder` guarda la PRIMERA respuesta
--      (una por pedido; una segunda recibe `ya_respondida`). Con calificacion >= umbral y liga configurada se le devuelve la liga de
--      resenas; con calificacion <= 2 el backend emite una notificacion in-app (sin PII) al staff.
--   4. Owner/admin consultan `encuesta_resumen`: promedio, distribucion y tasa de respuesta global, por sucursal y por repartidor,
--      mas los comentarios recientes.
--
-- Definiciones (los rotulos de la pantalla las repiten tal cual):
--   * El periodo se mide por el DIA LOCAL de la sucursal (restaurantes.voz_zona_horaria) en que se ENVIO la encuesta; la tasa de
--     respuesta es respondidas / enviadas SOBRE ESA MISMA cohorte (nunca pasa de 100%; NULL si no hubo envios). El promedio es de
--     las respuestas de la cohorte (NULL si no hay respuestas: nunca un 0 inventado).
--   * Repartidor = quien tenia asignado el pedido (orders.assigned_repartidor_id) al registrar el envio; se guarda como foto en la
--     fila de la encuesta. Pedidos sin repartidor (p. ej. recoger en sucursal) cuentan en la sucursal, no en ningun repartidor.
--   * Trafico demo (telefonos ficticios del rango 0009) nunca recibe encuesta.
--
-- Justificacion de seguridad de cada objeto nuevo (uno por uno):
--  * restaurantes.encuesta_config / restaurantes.encuesta_entrega -- tablas nuevas con RLS ACTIVO y SIN policies ni GRANT para
--    authenticated/anon (deny-by-default; `revoke all` explicito). La unica puerta son las funciones definer de abajo, que validan
--    organizacion/sucursal y rol. Se evita abrir SELECT directo porque encuesta_entrega guarda texto libre de clientes y la foto del
--    repartidor. service_role solo recibe SELECT (operacion/diagnostico). Ninguna policy `using (true)`.
--  * encuesta_config.resenas_url -- el CHECK solo admite https:// con host sin credenciales, sin espacios ni `<>"` y hasta 500
--    caracteres (no puede ser un `javascript:` ni un `data:`): es una liga que se muestra y se envia a clientes.
--  * Funciones de staff (`encuesta_config_leer`, `encuesta_config_guardar`, `encuesta_resumen`) -- security definer con search_path
--    fijo (restaurantes, core, pg_temp) y `revoke all ... from public, anon`; EXECUTE a authenticated. Exigen auth.uid() no nulo y
--    owner/admin con alcance a la sucursal (`handoff_actor_en_sucursal(org, property, true)`, 028; el resumen sin sucursal exige
--    owner/admin de la organizacion y se acota a las sucursales de su membership). 42501 igual para sucursal ajena que inexistente
--    (no confirma su existencia). Son definer porque las tablas no tienen DML para authenticated. `encuesta_config_guardar` valida
--    rangos (22023) y deja una fila en audit_log con el actor real (auth.uid()), solo si algo cambio.
--  * Funciones de solo-sistema (`encuesta_candidatas`, `encuesta_registrar_envio`, `encuesta_publica`, `encuesta_responder`) -- el
--    backend las llama en la sesion de sistema (rol authenticated SIN usuario, igual que storefront_order_tracking, 032): exigen
--    `auth.uid() is null` (un staff recibe 42501: ya tiene su propia lectura y no debe usarlas para saltarla), definer, search_path
--    fijo, `revoke ... from public, anon`, EXECUTE a authenticated. Las dos publicas (`encuesta_publica`, `encuesta_responder`) solo
--    se alcanzan con un token HMAC firmado por la API (organizacion + pedido, con vencimiento), validan que la fila pertenezca a la
--    organizacion declarada y NUNCA devuelven nombre, telefono, direccion ni renglones del pedido: solo el nombre de la sucursal, la
--    calificacion propia y, si procede, la liga de resenas. `encuesta_candidatas` SI devuelve telefono y nombre (los necesita el
--    envio de WhatsApp) y por eso es solo-sistema y acotada a la organizacion cuando viene; el barrido global solo lo alcanza el
--    sistema. `encuesta_responder` es idempotente y first-write-wins: el UPDATE exige `respondida_at is null`.

-- ---------------------------------------------------------------------------
-- 1) Tablas
-- ---------------------------------------------------------------------------
create table if not exists restaurantes.encuesta_config (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  activa boolean not null default false,
  espera_min integer not null default 30 check (espera_min between 5 and 1440),
  resenas_url text check (
    resenas_url is null
    or (length(resenas_url) <= 500 and resenas_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]<>"]*)?$')
  ),
  umbral_resena smallint not null default 4 check (umbral_resena between 1 and 5),
  updated_at timestamptz not null default now(),
  updated_by uuid references core.staff_user(id) on delete set null
);
alter table restaurantes.encuesta_config enable row level security;
revoke all on restaurantes.encuesta_config from public, anon, authenticated;
grant select on restaurantes.encuesta_config to service_role;

create table if not exists restaurantes.encuesta_entrega (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  order_id uuid not null unique references restaurantes.orders(id) on delete cascade,
  -- Foto del repartidor asignado al registrar el envio (puede ser nulo: recoger en sucursal, o repartidor dado de baja).
  repartidor_id uuid references core.staff_user(id) on delete set null,
  enviada_at timestamptz not null default now(),
  respondida_at timestamptz,
  calificacion smallint check (calificacion between 1 and 5),
  comentario text check (comentario is null or char_length(comentario) between 1 and 1000),
  check ((respondida_at is null) = (calificacion is null))
);
create index if not exists encuesta_entrega_org_prop_enviada_idx on restaurantes.encuesta_entrega (organization_id, property_id, enviada_at desc);
alter table restaurantes.encuesta_entrega enable row level security;
revoke all on restaurantes.encuesta_entrega from public, anon, authenticated;
grant select on restaurantes.encuesta_entrega to service_role;

-- ---------------------------------------------------------------------------
-- 2) Configuracion por sucursal (staff owner/admin)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.encuesta_config_leer(p_organization_id uuid, p_property_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_cfg restaurantes.encuesta_config;
begin
  if auth.uid() is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, true) then
    raise exception 'encuesta_config_leer: sin acceso a la sucursal' using errcode = '42501';
  end if;
  select * into v_cfg from restaurantes.encuesta_config c where c.property_id = p_property_id and c.organization_id = p_organization_id;
  return jsonb_build_object(
    'activa', coalesce(v_cfg.activa, false),
    'espera_min', coalesce(v_cfg.espera_min, 30),
    'resenas_url', v_cfg.resenas_url,
    'umbral_resena', coalesce(v_cfg.umbral_resena, 4)
  );
end;
$$;

create or replace function restaurantes.encuesta_config_guardar(
  p_organization_id uuid,
  p_property_id uuid,
  p_activa boolean,
  p_espera_min integer,
  p_resenas_url text,
  p_umbral_resena integer
) returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_antes jsonb;
  v_url text := nullif(btrim(coalesce(p_resenas_url, '')), '');
  v_despues jsonb;
begin
  if auth.uid() is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, true) then
    raise exception 'encuesta_config_guardar: sin acceso a la sucursal' using errcode = '42501';
  end if;
  if p_activa is null or p_espera_min is null or p_espera_min not between 5 and 1440 or p_umbral_resena is null or p_umbral_resena not between 1 and 5 then
    raise exception 'encuesta_config_guardar: valores fuera de rango' using errcode = '22023';
  end if;
  if v_url is not null and (length(v_url) > 500 or v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]<>"]*)?$') then
    raise exception 'encuesta_config_guardar: la liga de resenas debe ser una URL https valida' using errcode = '22023';
  end if;

  v_antes := restaurantes.encuesta_config_leer(p_organization_id, p_property_id);

  insert into restaurantes.encuesta_config as c (property_id, organization_id, activa, espera_min, resenas_url, umbral_resena, updated_at, updated_by)
  values (p_property_id, p_organization_id, p_activa, p_espera_min, v_url, p_umbral_resena::smallint, now(), auth.uid())
  on conflict (property_id) do update
    set activa = excluded.activa, espera_min = excluded.espera_min, resenas_url = excluded.resenas_url,
        umbral_resena = excluded.umbral_resena, updated_at = now(), updated_by = auth.uid()
    where c.organization_id = p_organization_id;

  v_despues := restaurantes.encuesta_config_leer(p_organization_id, p_property_id);
  if v_antes is distinct from v_despues then
    insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
    values (p_organization_id, auth.uid(), 'encuesta.configuracion_actualizada', 'configuracion', p_property_id, 'encuesta',
            left(v_antes::text, 500), left(v_despues::text, 500));
  end if;
  return v_despues;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) Resumen de satisfaccion (staff owner/admin)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.encuesta_resumen(
  p_organization_id uuid,
  p_desde date,
  p_hasta date,
  p_property_id uuid default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_props uuid[];
  v_scope uuid[];
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'encuesta_resumen: sin acceso' using errcode = '42501';
  end if;
  if p_property_id is not null then
    if not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, true) then
      raise exception 'encuesta_resumen: sin acceso a la sucursal' using errcode = '42501';
    end if;
    v_scope := array[p_property_id];
  else
    select m.property_ids into v_props from core.membership m
    where m.user_id = auth.uid() and m.organization_id = p_organization_id and m.vertical_role in ('owner', 'admin');
    if not found then
      raise exception 'encuesta_resumen: sin acceso a la organizacion' using errcode = '42501';
    end if;
    select coalesce(array_agg(p.id), '{}'::uuid[]) into v_scope from core.property p
    where p.organization_id = p_organization_id and (v_props is null or p.id = any (v_props));
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 91 then
    raise exception 'encuesta_resumen: rango de fechas invalido (maximo 92 dias)' using errcode = '22023';
  end if;

  with cohorte as (
    select e.id, e.property_id, e.repartidor_id, e.calificacion, e.comentario, e.respondida_at, e.order_id
    from restaurantes.encuesta_entrega e
    where e.organization_id = p_organization_id
      and e.property_id = any (v_scope)
      and (e.enviada_at at time zone restaurantes.voz_zona_horaria(e.property_id))::date between p_desde and p_hasta
  ),
  glob as (
    select jsonb_build_object(
      'enviadas', count(*),
      'respondidas', count(*) filter (where calificacion is not null),
      'promedio', round(avg(calificacion)::numeric, 2),
      'distribucion', jsonb_build_array(
        count(*) filter (where calificacion = 1), count(*) filter (where calificacion = 2), count(*) filter (where calificacion = 3),
        count(*) filter (where calificacion = 4), count(*) filter (where calificacion = 5))
    ) as j from cohorte
  ),
  suc as (
    select coalesce(jsonb_agg(x order by x->>'nombre'), '[]'::jsonb) as j from (
      select jsonb_build_object(
        'property_id', p.id, 'nombre', p.name,
        'enviadas', count(c.id), 'respondidas', count(c.id) filter (where c.calificacion is not null),
        'promedio', round(avg(c.calificacion)::numeric, 2)) as x
      from core.property p
      left join cohorte c on c.property_id = p.id
      where p.id = any (v_scope) and p.organization_id = p_organization_id
      group by p.id, p.name
    ) s
  ),
  rep as (
    select coalesce(jsonb_agg(x order by (x->>'enviadas')::int desc, x->>'nombre'), '[]'::jsonb) as j from (
      select jsonb_build_object(
        'repartidor_id', c.repartidor_id,
        'nombre', su.full_name,
        'enviadas', count(*), 'respondidas', count(*) filter (where c.calificacion is not null),
        'promedio', round(avg(c.calificacion)::numeric, 2)) as x
      from cohorte c
      join core.staff_user su on su.id = c.repartidor_id
      where c.repartidor_id is not null
        and exists (select 1 from core.membership m where m.user_id = c.repartidor_id and m.organization_id = p_organization_id)
      group by c.repartidor_id, su.full_name
    ) r
  ),
  rec as (
    select coalesce(jsonb_agg(x order by x->>'respondida_at' desc), '[]'::jsonb) as j from (
      select jsonb_build_object(
        'id', c.id, 'pedido', o.order_number, 'property_id', c.property_id, 'sucursal', p.name,
        'calificacion', c.calificacion, 'comentario', c.comentario, 'respondida_at', c.respondida_at,
        'repartidor', case when exists (select 1 from core.membership m where m.user_id = c.repartidor_id and m.organization_id = p_organization_id)
                           then su.full_name else null end) as x
      from cohorte c
      join restaurantes.orders o on o.id = c.order_id and o.organization_id = p_organization_id
      join core.property p on p.id = c.property_id
      left join core.staff_user su on su.id = c.repartidor_id
      where c.calificacion is not null
      order by c.respondida_at desc
      limit 20
    ) t
  )
  select jsonb_build_object('global', glob.j, 'por_sucursal', suc.j, 'por_repartidor', rep.j, 'recientes', rec.j)
    into v_result from glob, suc, rep, rec;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Solo sistema: candidatas, registro de envio, lectura y respuesta publica
-- ---------------------------------------------------------------------------
create or replace function restaurantes.encuesta_candidatas(
  p_organization_id uuid default null,
  p_ahora timestamptz default null,
  p_limite integer default 100
) returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_ahora timestamptz := coalesce(p_ahora, now());
  v_limite integer := least(greatest(coalesce(p_limite, 100), 1), 500);
begin
  if auth.uid() is not null then
    raise exception 'encuesta_candidatas: solo la sesion de sistema' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(x) from (
      select jsonb_build_object(
        'order_id', o.id, 'organization_id', o.organization_id, 'property_id', o.property_id,
        'org_slug', org.slug, 'sucursal', p.name,
        'customer_name', o.customer_name, 'customer_phone', o.customer_phone) as x
      from restaurantes.orders o
      join restaurantes.encuesta_config c on c.property_id = o.property_id and c.organization_id = o.organization_id and c.activa
      join core.organization org on org.id = o.organization_id
      join core.property p on p.id = o.property_id
      where (p_organization_id is null or o.organization_id = p_organization_id)
        and o.status in ('entregado', 'completado')
        and o.delivered_at is not null
        and o.delivered_at <= v_ahora - make_interval(mins => c.espera_min)
        and o.delivered_at > v_ahora - interval '48 hours'
        and length(regexp_replace(o.customer_phone, '\D', '', 'g')) >= 10
        and right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) not like '0009%'
        -- Solo organizaciones que SI pueden enviar el WhatsApp (numero de la sucursal o de la organizacion): una sin canal no ocupa lugares del lote.
        and (exists (select 1 from restaurantes.whatsapp_branch_channel b where b.organization_id = o.organization_id and b.property_id = o.property_id)
             or exists (select 1 from restaurantes.whatsapp_channel_config w where w.organization_id = o.organization_id))
        and not exists (select 1 from restaurantes.encuesta_entrega e where e.order_id = o.id)
      order by o.delivered_at
      limit v_limite
    ) q
  ), '[]'::jsonb);
end;
$$;

create or replace function restaurantes.encuesta_registrar_envio(p_organization_id uuid, p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_order restaurantes.orders;
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'encuesta_registrar_envio: solo la sesion de sistema' using errcode = '42501';
  end if;
  select * into v_order from restaurantes.orders o where o.id = p_order_id and o.organization_id = p_organization_id;
  if not found or v_order.status not in ('entregado', 'completado') then
    raise exception 'encuesta_registrar_envio: pedido inexistente o no entregado' using errcode = '22023';
  end if;
  insert into restaurantes.encuesta_entrega (organization_id, property_id, order_id, repartidor_id)
  values (v_order.organization_id, v_order.property_id, v_order.id, v_order.assigned_repartidor_id)
  on conflict (order_id) do nothing
  returning id into v_id;
  return v_id is not null;
end;
$$;

create or replace function restaurantes.encuesta_publica(p_organization_id uuid, p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_e restaurantes.encuesta_entrega;
  v_cfg restaurantes.encuesta_config;
  v_sucursal text;
begin
  if auth.uid() is not null then
    raise exception 'encuesta_publica: solo la sesion de sistema' using errcode = '42501';
  end if;
  select * into v_e from restaurantes.encuesta_entrega e where e.order_id = p_order_id and e.organization_id = p_organization_id;
  if not found then return null; end if;
  select p.name into v_sucursal from core.property p where p.id = v_e.property_id;
  select * into v_cfg from restaurantes.encuesta_config c where c.property_id = v_e.property_id;
  return jsonb_build_object(
    'sucursal', v_sucursal,
    'respondida', v_e.respondida_at is not null,
    'calificacion', v_e.calificacion,
    'resenas_url', case when v_e.calificacion is not null and v_cfg.resenas_url is not null and v_e.calificacion >= v_cfg.umbral_resena then v_cfg.resenas_url else null end
  );
end;
$$;

create or replace function restaurantes.encuesta_responder(p_organization_id uuid, p_order_id uuid, p_calificacion integer, p_comentario text)
returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_e restaurantes.encuesta_entrega;
  v_cfg restaurantes.encuesta_config;
  v_comentario text := nullif(btrim(coalesce(p_comentario, '')), '');
  v_estado text;
begin
  if auth.uid() is not null then
    raise exception 'encuesta_responder: solo la sesion de sistema' using errcode = '42501';
  end if;
  if p_calificacion is null or p_calificacion not between 1 and 5 then
    raise exception 'encuesta_responder: la calificacion debe estar entre 1 y 5' using errcode = '22023';
  end if;
  if v_comentario is not null and char_length(v_comentario) > 1000 then
    raise exception 'encuesta_responder: el comentario excede 1000 caracteres' using errcode = '22023';
  end if;

  update restaurantes.encuesta_entrega e
     set calificacion = p_calificacion::smallint, comentario = v_comentario, respondida_at = now()
   where e.order_id = p_order_id and e.organization_id = p_organization_id and e.respondida_at is null
  returning * into v_e;
  if found then
    v_estado := 'registrada';
  else
    select * into v_e from restaurantes.encuesta_entrega e where e.order_id = p_order_id and e.organization_id = p_organization_id;
    if not found then return jsonb_build_object('estado', 'no_encontrada'); end if;
    v_estado := 'ya_respondida';
  end if;
  select * into v_cfg from restaurantes.encuesta_config c where c.property_id = v_e.property_id;
  return jsonb_build_object(
    'estado', v_estado,
    'property_id', v_e.property_id,
    'calificacion', v_e.calificacion,
    'resenas_url', case when v_cfg.resenas_url is not null and v_e.calificacion >= v_cfg.umbral_resena then v_cfg.resenas_url else null end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Permisos de las funciones
-- ---------------------------------------------------------------------------
revoke all on function restaurantes.encuesta_config_leer(uuid, uuid) from public, anon;
revoke all on function restaurantes.encuesta_config_guardar(uuid, uuid, boolean, integer, text, integer) from public, anon;
revoke all on function restaurantes.encuesta_resumen(uuid, date, date, uuid) from public, anon;
revoke all on function restaurantes.encuesta_candidatas(uuid, timestamptz, integer) from public, anon;
revoke all on function restaurantes.encuesta_registrar_envio(uuid, uuid) from public, anon;
revoke all on function restaurantes.encuesta_publica(uuid, uuid) from public, anon;
revoke all on function restaurantes.encuesta_responder(uuid, uuid, integer, text) from public, anon;
grant execute on function restaurantes.encuesta_config_leer(uuid, uuid) to authenticated;
grant execute on function restaurantes.encuesta_config_guardar(uuid, uuid, boolean, integer, text, integer) to authenticated;
grant execute on function restaurantes.encuesta_resumen(uuid, date, date, uuid) to authenticated;
grant execute on function restaurantes.encuesta_candidatas(uuid, timestamptz, integer) to authenticated;
grant execute on function restaurantes.encuesta_registrar_envio(uuid, uuid) to authenticated;
grant execute on function restaurantes.encuesta_publica(uuid, uuid) to authenticated;
grant execute on function restaurantes.encuesta_responder(uuid, uuid, integer, text) to authenticated;

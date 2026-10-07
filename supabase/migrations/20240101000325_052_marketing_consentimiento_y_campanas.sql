-- Autopiloto de restaurantes 2 (reactivacion de clientes inactivos): consentimiento de mensajes PROMOCIONALES por cliente y canal,
-- configuracion de marketing por organizacion, campanas borrador -> aprobacion con un clic -> encolado en el outbox, y atribucion.
-- Incluye tambien (pieza E, al final) los umbrales y candidatos de la alerta al dueño «WhatsApp silencioso» y el helper de organizacion de restaurantes.
-- Interno 052, prefijo de supabase/migrations 20240101000325. Requiere: 001 (customers, orders), 007 (messaging_outbox), 010 (promotions),
-- 019 (audit_log), 030 (privacy_config), 035 (voz_zona_horaria), core 0050 (whatsapp_plantilla).
--
-- Principios (decisiones del brief, no de este archivo):
--   * CONSENTIMIENTO PRIMERO: nadie entra a un segmento ni a un envio sin un consentimiento `otorgado` vigente (con fecha, fuente y version del aviso).
--   * NUNCA ENVIO CIEGO: el sistema solo genera un BORRADOR (segmento, conteo, promocion vigente, costo estimado); encola unicamente cuando un
--     owner/admin lo aprueba. Rechazar o ignorar no envia nada (el borrador sin decidir expira a los 3 dias).
--   * Todo apagado por omision: sin fila en marketing_config o con `activo = false` no se genera ninguna campana.
--   * Meta cobra por mensaje: la tarifa por mensaje y el tope mensual los fija el negocio; sin tarifa no se puede aprobar (el costo debe verse antes).
--   * Plantilla: sin plantilla de marketing APROBADA en core.whatsapp_plantilla (PL-31) el envio queda como estado honesto, no se encola.
--
-- Piezas:
--   A) marketing_config            -- activo, tarifa, tope mensual, minimo de segmento, plantilla (una fila por organizacion).
--   B) marketing_consentimiento    -- estado vigente por (organizacion, cliente, canal) + marketing_consentimiento_evento (historial inmutable).
--   C) marketing_campana / marketing_campana_envio -- campana, y un renglon por cliente (encolado | control | cancelado_baja).
--   D) funciones: marketing_registrar_consentimiento y marketing_revocar_por_telefono (solo sistema), marketing_generar_borradores (solo sistema,
--      tick diario), marketing_guardar_config / marketing_decidir_campana / marketing_config_leer / marketing_resumen_campanas (owner/admin).
--
-- Segmentos EXCLUYENTES por dias desde el ultimo pedido: inactivo_30 [30,60), inactivo_60 [60,90), inactivo_90 [90,365). Un cliente cae en uno solo.
-- Tope de frecuencia: un cliente no recibe dos mensajes de campana en 14 dias (se mide sobre envios `encolado`). Idempotencia: UNIQUE (campana, cliente).
-- Grupo de control del 10 % (asignacion DETERMINISTA por hash del telefono): no recibe mensaje; sirve para medir el ingreso incremental.
-- Ventana horaria: los mensajes se programan entre las 10:00 y las 20:00 hora de la sucursal principal, la de menor display_order (fuera de ella, a las 10:00 siguientes).
--
-- Justificacion de seguridad (una por una):
--   * Tablas A, B, C: RLS habilitada; `revoke all` a public/anon/authenticated/service_role y GRANT SELECT por COLUMNA a authenticated con policy de
--     owner/admin de LA organizacion (misma forma que order_privacy_consent, 063; nunca `using (true)`). Ningun rol inserta/actualiza/borra directo: toda
--     escritura pasa por las funciones de D. anon sin ningun privilegio. marketing_campana_envio no guarda telefono ni nombre (solo ids).
--   * marketing_registrar_consentimiento / marketing_revocar_por_telefono / marketing_generar_borradores: security definer, search_path fijo, revoke de
--     public/anon y grant a authenticated (el backend abre la sesion de sistema con ese rol sin usuario, igual que system_record_order_privacy_consent);
--     guard `auth.uid() is null`: ningun usuario logueado puede fabricar consentimientos ni disparar borradores. El cliente debe pertenecer a la
--     organizacion declarada (42501). La version del aviso la decide LA BASE (privacy_config.notice_version), nunca el navegador.
--   * marketing_guardar_config / marketing_decidir_campana / marketing_config_leer / marketing_resumen_campanas: security definer, search_path fijo,
--     revoke de public/anon, grant a authenticated; exigen auth.uid() y vertical_role owner/admin con alcance a TODA la organizacion (property_ids nulo: clientes y campanas son de la organizacion, no de una sucursal) DUENA del dato (derivada de la fila,
--     nunca del llamador: una campana ajena responde igual que una inexistente, 42501). Aprobar revalida en ese instante el consentimiento, el tope por
--     cliente, el tope mensual, la plantilla aprobada y el WhatsApp conectado: un consentimiento revocado entre el borrador y el clic NO recibe mensaje.
--   * marketing_en_control / marketing_elegibles: internas, sin EXECUTE para nadie salvo el dueno de las funciones que las invocan.
--   * BAJA/ALTO: el webhook (apps/api) llama marketing_revocar_por_telefono, que revoca el consentimiento y mata (`dead`) los mensajes de campana aun
--     `pending`/`failed` de ese telefono; ademas la lista de supresion de plataforma (SA-L-46) ya bloquea en el despachador todo envio no transaccional.
--
-- Compatibilidad con la base SIN migrar: nada de esto existe antes; el TypeScript captura 42883/42P01/42703 dentro de SAVEPOINT y degrada a "no disponible
-- aun" (lista vacia + estado honesto). Mergear no aplica nada: las migraciones las aplica una persona.

-- ---------------------------------------------------------------------------
-- A) Configuracion de marketing por organizacion
-- ---------------------------------------------------------------------------
create table restaurantes.marketing_config (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  activo boolean not null default false,
  -- Centavos MXN por mensaje de marketing de Meta. NULL = sin configurar (no se puede aprobar: el costo debe mostrarse antes).
  tarifa_centavos integer check (tarifa_centavos is null or tarifa_centavos between 1 and 10000),
  -- Tope de costo estimado de campanas APROBADAS por mes calendario (UTC). NULL = sin tope.
  tope_mensual_centavos integer check (tope_mensual_centavos is null or tope_mensual_centavos > 0),
  minimo_segmento integer not null default 10 check (minimo_segmento between 1 and 10000),
  -- Plantilla de marketing aprobada en Meta con EXACTAMENTE 2 variables: {{1}} nombre de la promocion, {{2}} codigo.
  plantilla_nombre text check (plantilla_nombre is null or plantilla_nombre ~ '^[a-z0-9_]{1,255}$'),
  plantilla_idioma text not null default 'es_MX' check (plantilla_idioma ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- B) Consentimiento de mensajes promocionales
-- ---------------------------------------------------------------------------
create table restaurantes.marketing_consentimiento (
  organization_id uuid not null references core.organization(id) on delete cascade,
  customer_id uuid not null references restaurantes.customers(id) on delete cascade,
  canal text not null check (canal in ('whatsapp')),
  estado text not null check (estado in ('otorgado', 'revocado')),
  fuente text not null check (fuente in ('checkout_web', 'agente_whatsapp', 'baja_whatsapp', 'panel')),
  version_aviso text not null check (version_aviso ~ '^[A-Za-z0-9._-]{1,32}$'),
  otorgado_at timestamptz,
  revocado_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (organization_id, customer_id, canal)
);
create index restaurantes_marketing_consentimiento_estado_idx on restaurantes.marketing_consentimiento (organization_id, estado);

-- Historial inmutable (evidencia): un renglon por cambio, sin telefono ni nombre.
create table restaurantes.marketing_consentimiento_evento (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  customer_id uuid not null references restaurantes.customers(id) on delete cascade,
  canal text not null check (canal in ('whatsapp')),
  estado text not null check (estado in ('otorgado', 'revocado')),
  fuente text not null check (fuente in ('checkout_web', 'agente_whatsapp', 'baja_whatsapp', 'panel')),
  version_aviso text not null check (version_aviso ~ '^[A-Za-z0-9._-]{1,32}$'),
  ocurrido_at timestamptz not null default now()
);
create index restaurantes_marketing_consentimiento_evento_idx on restaurantes.marketing_consentimiento_evento (organization_id, customer_id, ocurrido_at desc);

-- ---------------------------------------------------------------------------
-- C) Campanas y envios
-- ---------------------------------------------------------------------------
create table restaurantes.marketing_campana (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  segmento text not null check (segmento in ('inactivo_30', 'inactivo_60', 'inactivo_90')),
  dias_min smallint not null check (dias_min >= 0),
  dias_max smallint not null check (dias_max > dias_min),
  -- Dia (America/Merida) del borrador: UNIQUE con organizacion y segmento = un solo borrador por segmento y dia aunque dos ticks corran a la vez.
  dia date not null,
  estado text not null default 'borrador' check (estado in ('borrador', 'aprobada', 'rechazada', 'expirada')),
  promotion_id uuid references restaurantes.promotions(id) on delete set null,
  -- Copia de la promocion vigente al generar (la campana nunca inventa descuentos y no cambia si luego se edita la promocion).
  promo_nombre text not null check (char_length(promo_nombre) between 1 and 200),
  promo_codigo text not null check (char_length(promo_codigo) between 1 and 40),
  plantilla_nombre text,
  plantilla_idioma text,
  conteo integer not null check (conteo >= 0),
  conteo_control integer not null default 0 check (conteo_control >= 0),
  tarifa_centavos integer check (tarifa_centavos is null or tarifa_centavos > 0),
  costo_estimado_centavos integer check (costo_estimado_centavos is null or costo_estimado_centavos >= 0),
  encolados integer check (encolados is null or encolados >= 0),
  creada_at timestamptz not null default now(),
  decidida_at timestamptz,
  decidida_por uuid references core.staff_user(id) on delete set null,
  unique (organization_id, segmento, dia)
);
create index restaurantes_marketing_campana_org_idx on restaurantes.marketing_campana (organization_id, creada_at desc);

create table restaurantes.marketing_campana_envio (
  id uuid primary key default gen_random_uuid(),
  campana_id uuid not null references restaurantes.marketing_campana(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  customer_id uuid not null references restaurantes.customers(id) on delete cascade,
  estado text not null check (estado in ('encolado', 'control', 'cancelado_baja')),
  outbox_id uuid references restaurantes.messaging_outbox(id) on delete set null,
  created_at timestamptz not null default now(),
  -- Idempotencia por (campana, cliente): aprobar dos veces o dos conexiones a la vez no duplican ni un envio.
  unique (campana_id, customer_id)
);
create index restaurantes_marketing_envio_cliente_idx on restaurantes.marketing_campana_envio (customer_id, created_at desc) where estado = 'encolado';

-- RLS y grants de A, B, C: SOLO lectura para owner/admin de la organizacion.
alter table restaurantes.marketing_config enable row level security;
alter table restaurantes.marketing_consentimiento enable row level security;
alter table restaurantes.marketing_consentimiento_evento enable row level security;
alter table restaurantes.marketing_campana enable row level security;
alter table restaurantes.marketing_campana_envio enable row level security;

create policy "owner/admin lee la configuracion de marketing" on restaurantes.marketing_config for select
  using (exists (select 1 from core.membership m where m.organization_id = marketing_config.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin') and m.property_ids is null));
create policy "owner/admin lee los consentimientos de marketing" on restaurantes.marketing_consentimiento for select
  using (exists (select 1 from core.membership m where m.organization_id = marketing_consentimiento.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin') and m.property_ids is null));
create policy "owner/admin lee el historial de consentimientos de marketing" on restaurantes.marketing_consentimiento_evento for select
  using (exists (select 1 from core.membership m where m.organization_id = marketing_consentimiento_evento.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin') and m.property_ids is null));
create policy "owner/admin lee las campanas de marketing" on restaurantes.marketing_campana for select
  using (exists (select 1 from core.membership m where m.organization_id = marketing_campana.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin') and m.property_ids is null));
create policy "owner/admin lee los envios de campanas" on restaurantes.marketing_campana_envio for select
  using (exists (select 1 from core.membership m where m.organization_id = marketing_campana_envio.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin') and m.property_ids is null));

revoke all on restaurantes.marketing_config, restaurantes.marketing_consentimiento, restaurantes.marketing_consentimiento_evento, restaurantes.marketing_campana, restaurantes.marketing_campana_envio
  from public, anon, authenticated, service_role;
grant select (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre, plantilla_idioma, updated_by, updated_at)
  on restaurantes.marketing_config to authenticated;
grant select (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at, revocado_at, updated_at)
  on restaurantes.marketing_consentimiento to authenticated;
grant select (id, organization_id, customer_id, canal, estado, fuente, version_aviso, ocurrido_at)
  on restaurantes.marketing_consentimiento_evento to authenticated;
grant select (id, organization_id, segmento, dias_min, dias_max, dia, estado, promotion_id, promo_nombre, promo_codigo, plantilla_nombre, plantilla_idioma, conteo, conteo_control, tarifa_centavos, costo_estimado_centavos, encolados, creada_at, decidida_at, decidida_por)
  on restaurantes.marketing_campana to authenticated;
grant select (id, campana_id, organization_id, customer_id, estado, outbox_id, created_at)
  on restaurantes.marketing_campana_envio to authenticated;

-- ---------------------------------------------------------------------------
-- D0) Helpers internos (sin EXECUTE para nadie: los invocan las funciones de abajo, que corren como su dueno)
-- ---------------------------------------------------------------------------
-- Grupo de control: 10 % determinista por el hash del telefono (solo digitos). Mismo telefono = mismo grupo siempre.
create or replace function restaurantes.marketing_en_control(p_telefono text)
returns boolean language sql immutable set search_path = pg_catalog, pg_temp as $$
  select abs((('x' || substr(md5(regexp_replace(coalesce(p_telefono, ''), '[^0-9]', '', 'g')), 1, 8))::bit(32)::bigint)) % 10 = 0;
$$;
revoke all on function restaurantes.marketing_en_control(text) from public, anon, authenticated, service_role;

-- Clientes elegibles de un segmento: consentimiento vigente, telefono, ultimo pedido en el rango y sin mensaje de campana en 14 dias.
create or replace function restaurantes.marketing_elegibles(p_organization_id uuid, p_dias_min integer, p_dias_max integer, p_now timestamptz)
returns table (customer_id uuid, telefono text, control boolean)
language sql stable set search_path = restaurantes, core, pg_temp as $$
  select c.id, c.phone, restaurantes.marketing_en_control(c.phone)
  from restaurantes.customers c
  where c.organization_id = p_organization_id
    and c.phone is not null and btrim(c.phone) <> ''
    and c.last_order_at is not null
    and c.last_order_at <= p_now - make_interval(days => p_dias_min)
    and c.last_order_at > p_now - make_interval(days => p_dias_max)
    and exists (
      select 1 from restaurantes.marketing_consentimiento mc
      where mc.organization_id = c.organization_id and mc.customer_id = c.id and mc.canal = 'whatsapp' and mc.estado = 'otorgado'
    )
    and not exists (
      select 1 from restaurantes.marketing_campana_envio e
      where e.customer_id = c.id and e.estado = 'encolado' and e.created_at > p_now - interval '14 days'
    );
$$;
revoke all on function restaurantes.marketing_elegibles(uuid, integer, integer, timestamptz) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- D1) Consentimiento (solo sistema)
-- ---------------------------------------------------------------------------
-- Devuelve true si el estado CAMBIO (primer otorgamiento, o paso otorgado <-> revocado); false si ya estaba asi (idempotente).
create or replace function restaurantes.marketing_registrar_consentimiento(p_organization_id uuid, p_customer_id uuid, p_canal text, p_otorgar boolean, p_fuente text)
returns boolean language plpgsql security definer set search_path = restaurantes, core, pg_temp as $$
declare
  v_version text;
  v_estado text := case when p_otorgar then 'otorgado' else 'revocado' end;
  v_actual text;
begin
  if auth.uid() is not null then
    raise exception 'marketing_registrar_consentimiento: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  if p_canal is distinct from 'whatsapp' or p_otorgar is null or p_fuente is null or p_fuente not in ('checkout_web', 'agente_whatsapp', 'baja_whatsapp', 'panel') then
    raise exception 'marketing_registrar_consentimiento: parametros invalidos' using errcode = '22023';
  end if;
  if not exists (select 1 from restaurantes.customers c where c.id = p_customer_id and c.organization_id = p_organization_id) then
    raise exception 'marketing_registrar_consentimiento: el cliente no pertenece a la organizacion' using errcode = '42501';
  end if;
  select coalesce((select pc.notice_version from restaurantes.privacy_config pc where pc.organization_id = p_organization_id), 'v1') into v_version;

  select mc.estado into v_actual from restaurantes.marketing_consentimiento mc
    where mc.organization_id = p_organization_id and mc.customer_id = p_customer_id and mc.canal = p_canal for update;
  if v_actual is not distinct from v_estado then
    return false;
  end if;
  insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso, otorgado_at, revocado_at, updated_at)
  values (p_organization_id, p_customer_id, p_canal, v_estado, p_fuente, v_version, case when p_otorgar then now() end, case when not p_otorgar then now() end, now())
  on conflict (organization_id, customer_id, canal) do update
    set estado = excluded.estado, fuente = excluded.fuente, version_aviso = excluded.version_aviso,
        otorgado_at = case when excluded.estado = 'otorgado' then now() else restaurantes.marketing_consentimiento.otorgado_at end,
        revocado_at = case when excluded.estado = 'revocado' then now() else restaurantes.marketing_consentimiento.revocado_at end,
        updated_at = now();
  insert into restaurantes.marketing_consentimiento_evento (organization_id, customer_id, canal, estado, fuente, version_aviso)
  values (p_organization_id, p_customer_id, p_canal, v_estado, p_fuente, v_version);
  if not p_otorgar then
    perform restaurantes.marketing_cancelar_pendientes(p_organization_id, p_customer_id);
  end if;
  return true;
end;
$$;

-- Mata los mensajes de campana de un cliente que todavia no salieron (pending/failed) y marca su renglon. No toca los `processing` (ya en vuelo:
-- los frena la lista de supresion de plataforma en el despachador).
create or replace function restaurantes.marketing_cancelar_pendientes(p_organization_id uuid, p_customer_id uuid)
returns integer language plpgsql security definer set search_path = restaurantes, core, pg_temp as $$
declare
  v_filas integer;
begin
  update restaurantes.messaging_outbox o
     set status = 'dead', last_error_class = 'baja_marketing'
    from restaurantes.marketing_campana_envio e
   where e.outbox_id = o.id and e.organization_id = p_organization_id and e.customer_id = p_customer_id
     and e.estado = 'encolado' and o.status in ('pending', 'failed');
  get diagnostics v_filas = row_count;
  update restaurantes.marketing_campana_envio e set estado = 'cancelado_baja'
   where e.organization_id = p_organization_id and e.customer_id = p_customer_id and e.estado = 'encolado'
     and exists (select 1 from restaurantes.messaging_outbox o where o.id = e.outbox_id and o.status = 'dead' and o.last_error_class = 'baja_marketing');
  return v_filas;
end;
$$;
revoke all on function restaurantes.marketing_cancelar_pendientes(uuid, uuid) from public, anon, authenticated, service_role;

revoke all on function restaurantes.marketing_registrar_consentimiento(uuid, uuid, text, boolean, text) from public, anon;
grant execute on function restaurantes.marketing_registrar_consentimiento(uuid, uuid, text, boolean, text) to authenticated;

-- BAJA / ALTO por WhatsApp: revoca el consentimiento de TODOS los clientes de la organizacion con ese telefono (solo digitos comparados).
-- Devuelve cuantos consentimientos revoco. Solo sistema.
create or replace function restaurantes.marketing_revocar_por_telefono(p_organization_id uuid, p_telefono text)
returns integer language plpgsql security definer set search_path = restaurantes, core, pg_temp as $$
declare
  v_digitos text := regexp_replace(coalesce(p_telefono, ''), '[^0-9]', '', 'g');
  v_cliente uuid;
  v_total integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'marketing_revocar_por_telefono: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  if length(v_digitos) < 8 then
    raise exception 'marketing_revocar_por_telefono: telefono invalido' using errcode = '22023';
  end if;
  for v_cliente in
    select c.id from restaurantes.customers c where c.organization_id = p_organization_id and regexp_replace(c.phone, '[^0-9]', '', 'g') = v_digitos
  loop
    if restaurantes.marketing_registrar_consentimiento(p_organization_id, v_cliente, 'whatsapp', false, 'baja_whatsapp') then
      v_total := v_total + 1;
    else
      -- Ya estaba revocado (o nunca otorgado): igual se limpian mensajes de campana que hubieran quedado pendientes.
      perform restaurantes.marketing_cancelar_pendientes(p_organization_id, v_cliente);
    end if;
  end loop;
  return v_total;
end;
$$;
revoke all on function restaurantes.marketing_revocar_por_telefono(uuid, text) from public, anon;
grant execute on function restaurantes.marketing_revocar_por_telefono(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- D2) Borradores de campana (solo sistema, tick diario; idempotente por organizacion + segmento + dia)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.marketing_generar_borradores(p_now timestamptz default now())
returns table (campana_id uuid, organization_id uuid, segmento text, conteo integer, costo_estimado_centavos integer)
language plpgsql security definer set search_path = restaurantes, core, pg_temp as $$
#variable_conflict use_column
declare
  v_cfg restaurantes.marketing_config%rowtype;
  v_promo restaurantes.promotions%rowtype;
  v_seg record;
  v_tratados integer;
  v_control integer;
  v_id uuid;
  v_dia date := (p_now at time zone 'America/Merida')::date;
begin
  if auth.uid() is not null then
    raise exception 'marketing_generar_borradores: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  -- Un borrador sin decidir expira a los 3 dias: ignorar no envia nada.
  update restaurantes.marketing_campana k set estado = 'expirada' where k.estado = 'borrador' and k.creada_at < p_now - interval '3 days';

  for v_cfg in select * from restaurantes.marketing_config c where c.activo order by c.organization_id loop
    -- Sin tarifa configurada no hay borrador: el costo debe poder mostrarse antes de aprobar (nunca un borrador con costo NULL).
    if v_cfg.tarifa_centavos is null then
      continue;
    end if;
    -- Promocion vigente: nunca se inventa un descuento. Sin promocion no hay borrador.
    select * into v_promo from restaurantes.promotions p
      where p.organization_id = v_cfg.organization_id and p.is_active
        and (p.starts_at is null or p.starts_at <= p_now) and (p.ends_at is null or p.ends_at > p_now)
        and (p.max_uses is null or p.times_used < p.max_uses)
        -- Solo promociones de TODA la organizacion: una promocion acotada a sucursales (property_ids) no se ofrece a clientes de otras.
        and p.property_ids is null
      order by p.created_at desc, p.id limit 1;
    if not found then
      continue;
    end if;
    for v_seg in select * from (values ('inactivo_30', 30, 60), ('inactivo_60', 60, 90), ('inactivo_90', 90, 365)) as s(segmento, dmin, dmax) loop
      -- Un solo borrador abierto por segmento: no se acumulan borradores sin decidir.
      if exists (select 1 from restaurantes.marketing_campana k where k.organization_id = v_cfg.organization_id and k.segmento = v_seg.segmento and k.estado = 'borrador') then
        continue;
      end if;
      select count(*) filter (where not e.control), count(*) filter (where e.control) into v_tratados, v_control
        from restaurantes.marketing_elegibles(v_cfg.organization_id, v_seg.dmin, v_seg.dmax, p_now) e;
      if v_tratados < v_cfg.minimo_segmento then
        continue;
      end if;
      v_id := null;
      insert into restaurantes.marketing_campana (organization_id, segmento, dias_min, dias_max, dia, promotion_id, promo_nombre, promo_codigo, plantilla_nombre, plantilla_idioma,
                                                  conteo, conteo_control, tarifa_centavos, costo_estimado_centavos)
      values (v_cfg.organization_id, v_seg.segmento, v_seg.dmin, v_seg.dmax, v_dia, v_promo.id, left(regexp_replace(v_promo.name, '[\r\n\t]+', ' ', 'g'), 200), left(v_promo.code, 40),
              v_cfg.plantilla_nombre, v_cfg.plantilla_idioma, v_tratados, v_control, v_cfg.tarifa_centavos,
              case when v_cfg.tarifa_centavos is null then null else v_tratados * v_cfg.tarifa_centavos end)
      on conflict (organization_id, segmento, dia) do nothing
      returning id into v_id;
      if v_id is not null then
        campana_id := v_id; organization_id := v_cfg.organization_id; segmento := v_seg.segmento; conteo := v_tratados;
        costo_estimado_centavos := case when v_cfg.tarifa_centavos is null then null else v_tratados * v_cfg.tarifa_centavos end;
        return next;
      end if;
    end loop;
  end loop;
end;
$$;
revoke all on function restaurantes.marketing_generar_borradores(timestamptz) from public, anon;
grant execute on function restaurantes.marketing_generar_borradores(timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- D3) Guard de owner/admin (interno) y configuracion (owner/admin)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.marketing_es_gestor(p_organization_id uuid)
returns boolean language sql stable security definer set search_path = core, pg_temp as $$
  select auth.uid() is not null and exists (
    select 1 from core.membership m where m.organization_id = p_organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin') and m.property_ids is null
  );
$$;
revoke all on function restaurantes.marketing_es_gestor(uuid) from public, anon, authenticated, service_role;

create or replace function restaurantes.marketing_guardar_config(
  p_organization_id uuid, p_activo boolean, p_tarifa_centavos integer, p_tope_mensual_centavos integer, p_minimo_segmento integer, p_plantilla_nombre text, p_plantilla_idioma text
) returns void language plpgsql security definer set search_path = restaurantes, core, pg_temp as $$
begin
  if not restaurantes.marketing_es_gestor(p_organization_id) then
    raise exception 'marketing_guardar_config: requiere owner/admin de la organizacion' using errcode = '42501';
  end if;
  if p_activo is null or (p_tarifa_centavos is not null and p_tarifa_centavos not between 1 and 10000)
     or (p_tope_mensual_centavos is not null and p_tope_mensual_centavos <= 0) or p_minimo_segmento is null or p_minimo_segmento not between 1 and 10000
     or (p_plantilla_nombre is not null and p_plantilla_nombre !~ '^[a-z0-9_]{1,255}$') or p_plantilla_idioma !~ '^[a-z]{2,3}(_[A-Z]{2})?$' then
    raise exception 'marketing_guardar_config: parametros invalidos' using errcode = '22023';
  end if;
  insert into restaurantes.marketing_config (organization_id, activo, tarifa_centavos, tope_mensual_centavos, minimo_segmento, plantilla_nombre, plantilla_idioma, updated_by, updated_at)
  values (p_organization_id, p_activo, p_tarifa_centavos, p_tope_mensual_centavos, p_minimo_segmento, p_plantilla_nombre, p_plantilla_idioma, auth.uid(), now())
  on conflict (organization_id) do update
    set activo = excluded.activo, tarifa_centavos = excluded.tarifa_centavos, tope_mensual_centavos = excluded.tope_mensual_centavos, minimo_segmento = excluded.minimo_segmento,
        plantilla_nombre = excluded.plantilla_nombre, plantilla_idioma = excluded.plantilla_idioma, updated_by = auth.uid(), updated_at = now();
  insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
  values (p_organization_id, auth.uid(), 'marketing.config_actualizada', 'configuracion', p_organization_id, 'marketing_activo', null, p_activo::text);
end;
$$;
revoke all on function restaurantes.marketing_guardar_config(uuid, boolean, integer, integer, integer, text, text) from public, anon;
grant execute on function restaurantes.marketing_guardar_config(uuid, boolean, integer, integer, integer, text, text) to authenticated;

-- Lectura de la configuracion con los requisitos (estado honesto): promocion vigente, plantilla aprobada, WhatsApp conectado.
create or replace function restaurantes.marketing_config_leer(p_organization_id uuid)
returns table (activo boolean, tarifa_centavos integer, tope_mensual_centavos integer, minimo_segmento integer, plantilla_nombre text, plantilla_idioma text,
               hay_promocion_vigente boolean, plantilla_aprobada boolean, whatsapp_conectado boolean, gastado_mes_centavos bigint, consentimientos_vigentes bigint)
language plpgsql stable security definer set search_path = restaurantes, core, pg_temp as $$
#variable_conflict use_column
declare
  v_cfg restaurantes.marketing_config%rowtype;
begin
  if not restaurantes.marketing_es_gestor(p_organization_id) then
    raise exception 'marketing_config_leer: requiere owner/admin de la organizacion' using errcode = '42501';
  end if;
  select * into v_cfg from restaurantes.marketing_config c where c.organization_id = p_organization_id;
  activo := coalesce(v_cfg.activo, false);
  tarifa_centavos := v_cfg.tarifa_centavos;
  tope_mensual_centavos := v_cfg.tope_mensual_centavos;
  minimo_segmento := coalesce(v_cfg.minimo_segmento, 10);
  plantilla_nombre := v_cfg.plantilla_nombre;
  plantilla_idioma := coalesce(v_cfg.plantilla_idioma, 'es_MX');
  hay_promocion_vigente := exists (
    select 1 from restaurantes.promotions p
    where p.organization_id = p_organization_id and p.is_active and (p.starts_at is null or p.starts_at <= now()) and (p.ends_at is null or p.ends_at > now())
      and (p.max_uses is null or p.times_used < p.max_uses) and p.property_ids is null);
  plantilla_aprobada := v_cfg.plantilla_nombre is not null and exists (
    select 1 from core.whatsapp_plantilla w where w.organization_id = p_organization_id and w.nombre = v_cfg.plantilla_nombre and w.estado = 'aprobada');
  whatsapp_conectado := exists (select 1 from restaurantes.whatsapp_channel_config w where w.organization_id = p_organization_id);
  gastado_mes_centavos := coalesce((select sum(k.costo_estimado_centavos) from restaurantes.marketing_campana k
    where k.organization_id = p_organization_id and k.estado = 'aprobada' and k.decidida_at >= date_trunc('month', now())), 0);
  consentimientos_vigentes := (select count(*) from restaurantes.marketing_consentimiento mc where mc.organization_id = p_organization_id and mc.canal = 'whatsapp' and mc.estado = 'otorgado');
  return next;
end;
$$;
revoke all on function restaurantes.marketing_config_leer(uuid) from public, anon;
grant execute on function restaurantes.marketing_config_leer(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- D4) Aprobar o rechazar una campana (owner/admin, un clic)
-- ---------------------------------------------------------------------------
-- Rechazar solo cambia el estado: no envia nada. Aprobar revalida TODO en ese instante y encola en messaging_outbox (idempotente por
-- (campana, cliente)); un segundo clic o dos conexiones a la vez devuelven el mismo resultado sin duplicar. Errores de negocio (P0001):
-- requiere_tarifa, requiere_marketing_activo, requiere_nuevo_borrador (borrador sin costo o con otra tarifa que la vigente), requiere_plantilla_aprobada,
-- requiere_whatsapp_conectado, tope_mensual_excedido (costo REAL re-evaluado al aprobar, a la tarifa vigente), campana_no_aprobable (incluye borrador de mas de 3 dias).
create or replace function restaurantes.marketing_decidir_campana(p_campana_id uuid, p_aprobar boolean)
returns table (estado text, encolados integer, control integer)
language plpgsql security definer set search_path = restaurantes, core, pg_temp as $$
#variable_conflict use_column
declare
  v_k restaurantes.marketing_campana%rowtype;
  v_cfg restaurantes.marketing_config%rowtype;
  v_phone_number_id text;
  v_zona text;
  v_local timestamp;
  v_siguiente timestamptz;
  v_gastado bigint;
  v_reales integer;
  v_elegible record;
  v_outbox uuid;
  v_enc integer := 0;
  v_ctl integer := 0;
  v_params jsonb;
  v_body text;
begin
  -- Primero una lectura SIN bloqueo para comprobar el acceso: una persona de otra organizacion nunca llega a bloquear la fila ajena.
  select * into v_k from restaurantes.marketing_campana k where k.id = p_campana_id;
  if not found or not restaurantes.marketing_es_gestor(v_k.organization_id) then
    raise exception 'marketing_decidir_campana: campana inexistente o sin acceso' using errcode = '42501';
  end if;
  -- Con el acceso ya comprobado, se bloquea y se relee (decisiones concurrentes se serializan).
  select * into v_k from restaurantes.marketing_campana k where k.id = p_campana_id for update;
  if p_aprobar is null then
    raise exception 'marketing_decidir_campana: parametros invalidos' using errcode = '22023';
  end if;
  if v_k.estado <> 'borrador' then
    -- Idempotente: repetir la misma decision devuelve el estado actual; cambiar de decision se rechaza.
    if (p_aprobar and v_k.estado = 'aprobada') or (not p_aprobar and v_k.estado = 'rechazada') then
      estado := v_k.estado; encolados := coalesce(v_k.encolados, 0); control := v_k.conteo_control; return next; return;
    end if;
    raise exception 'campana_no_aprobable' using errcode = 'P0001';
  end if;

  if not p_aprobar then
    update restaurantes.marketing_campana k set estado = 'rechazada', decidida_at = now(), decidida_por = auth.uid() where k.id = v_k.id;
    insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
    values (v_k.organization_id, auth.uid(), 'marketing.campana_rechazada', 'configuracion', v_k.id, 'estado', 'borrador', 'rechazada');
    estado := 'rechazada'; encolados := 0; control := 0; return next; return;
  end if;

  select * into v_cfg from restaurantes.marketing_config c where c.organization_id = v_k.organization_id;
  if not found or v_cfg.tarifa_centavos is null then
    raise exception 'requiere_tarifa' using errcode = 'P0001';
  end if;
  -- Marketing apagado: un borrador ya abierto no se puede aprobar (rechazar si se puede).
  if not v_cfg.activo then
    raise exception 'requiere_marketing_activo' using errcode = 'P0001';
  end if;
  -- El costo se muestra ANTES de aprobar: un borrador sin costo (generado sin tarifa) o con otra tarifa que la vigente no se aprueba; el tick genera uno nuevo.
  if v_k.tarifa_centavos is null or v_k.costo_estimado_centavos is null or v_k.tarifa_centavos <> v_cfg.tarifa_centavos then
    raise exception 'requiere_nuevo_borrador' using errcode = 'P0001';
  end if;
  -- Un borrador de mas de 3 dias expira aunque el tick aun no lo haya marcado.
  if v_k.creada_at < now() - interval '3 days' then
    raise exception 'campana_no_aprobable' using errcode = 'P0001';
  end if;
  if v_cfg.plantilla_nombre is null or not exists (
       select 1 from core.whatsapp_plantilla w where w.organization_id = v_k.organization_id and w.nombre = v_cfg.plantilla_nombre and w.estado = 'aprobada') then
    raise exception 'requiere_plantilla_aprobada' using errcode = 'P0001';
  end if;
  select w.phone_number_id into v_phone_number_id from restaurantes.whatsapp_channel_config w where w.organization_id = v_k.organization_id;
  if v_phone_number_id is null then
    raise exception 'requiere_whatsapp_conectado' using errcode = 'P0001';
  end if;
  if v_cfg.tope_mensual_centavos is not null then
    select coalesce(sum(k.costo_estimado_centavos), 0) into v_gastado from restaurantes.marketing_campana k
      where k.organization_id = v_k.organization_id and k.estado = 'aprobada' and k.decidida_at >= date_trunc('month', now());
    -- Costo REAL a la tarifa vigente: los elegibles se re-evaluan ahora (mismos 1000 maximo que se encolaran), no se usa el conteo del borrador.
    select count(*) into v_reales from (
      select e.control from restaurantes.marketing_elegibles(v_k.organization_id, v_k.dias_min, v_k.dias_max, now()) e order by e.customer_id limit 1000
    ) r where not r.control;
    if v_gastado + v_reales::bigint * v_cfg.tarifa_centavos > v_cfg.tope_mensual_centavos then
      raise exception 'tope_mensual_excedido' using errcode = 'P0001';
    end if;
  end if;

  -- Ventana horaria 10:00-20:00 de la sucursal principal (la de menor display_order de la organizacion).
  v_zona := restaurantes.voz_zona_horaria((select bd.property_id from restaurantes.branch_detail bd where bd.organization_id = v_k.organization_id order by bd.display_order, bd.property_id limit 1));
  v_local := now() at time zone v_zona;
  v_siguiente := case
    when v_local::time >= time '10:00' and v_local::time < time '20:00' then now()
    when v_local::time < time '10:00' then (date_trunc('day', v_local) + interval '10 hours') at time zone v_zona
    else (date_trunc('day', v_local) + interval '1 day 10 hours') at time zone v_zona
  end;
  v_params := jsonb_build_array(v_k.promo_nombre, v_k.promo_codigo);
  v_body := v_k.promo_nombre || ': usa el código ' || v_k.promo_codigo || ' en tu próximo pedido. Para no recibir más promociones, responde BAJA.';

  -- Re-evalua AHORA quien es elegible (consentimiento vigente, tope de 14 dias): un consentimiento revocado desde el borrador NO recibe mensaje.
  -- Tope de seguridad: 1000 clientes por campana (el resto sigue elegible para la siguiente).
  for v_elegible in
    select e.customer_id, e.telefono, e.control from restaurantes.marketing_elegibles(v_k.organization_id, v_k.dias_min, v_k.dias_max, now()) e order by e.customer_id limit 1000
  loop
    if v_elegible.control then
      insert into restaurantes.marketing_campana_envio (campana_id, organization_id, customer_id, estado) values (v_k.id, v_k.organization_id, v_elegible.customer_id, 'control')
        on conflict (campana_id, customer_id) do nothing;
      if found then v_ctl := v_ctl + 1; end if;
    else
      v_outbox := null;
      insert into restaurantes.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload, next_attempt_at)
      values (v_k.organization_id, 'whatsapp', 'marketing_reactivacion', 'mkt:' || v_k.id::text || ':' || v_elegible.customer_id::text,
              jsonb_build_object('to', v_elegible.telefono, 'phone_number_id', v_phone_number_id, 'body', v_body, 'transaccional', false,
                                 'template', jsonb_build_object('name', v_cfg.plantilla_nombre, 'language', v_cfg.plantilla_idioma, 'params', v_params)),
              v_siguiente)
      on conflict (organization_id, channel, dedupe_key) do nothing
      returning id into v_outbox;
      if v_outbox is not null then
        insert into restaurantes.marketing_campana_envio (campana_id, organization_id, customer_id, estado, outbox_id)
        values (v_k.id, v_k.organization_id, v_elegible.customer_id, 'encolado', v_outbox) on conflict (campana_id, customer_id) do nothing;
        v_enc := v_enc + 1;
      end if;
    end if;
  end loop;

  -- Defensa en profundidad: si lo realmente encolado supera el tope, la excepcion deshace TODO (outbox, envios) en esta transaccion.
  if v_cfg.tope_mensual_centavos is not null and v_gastado + v_enc::bigint * v_cfg.tarifa_centavos > v_cfg.tope_mensual_centavos then
    raise exception 'tope_mensual_excedido' using errcode = 'P0001';
  end if;
  update restaurantes.marketing_campana k
     set estado = 'aprobada', decidida_at = now(), decidida_por = auth.uid(), encolados = v_enc, conteo_control = v_ctl,
         plantilla_nombre = v_cfg.plantilla_nombre, plantilla_idioma = v_cfg.plantilla_idioma, tarifa_centavos = v_cfg.tarifa_centavos,
         costo_estimado_centavos = v_enc * v_cfg.tarifa_centavos
   where k.id = v_k.id;
  insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
  values (v_k.organization_id, auth.uid(), 'marketing.campana_aprobada', 'configuracion', v_k.id, 'encolados', null, v_enc::text);
  estado := 'aprobada'; encolados := v_enc; control := v_ctl; return next;
end;
$$;
revoke all on function restaurantes.marketing_decidir_campana(uuid, boolean) from public, anon;
grant execute on function restaurantes.marketing_decidir_campana(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- D5) Resumen y atribucion (owner/admin)
-- ---------------------------------------------------------------------------
-- Atribucion: pedidos (no cancelados) de clientes de la campana en los 7 dias siguientes a su aprobacion. El KPI honesto es el INCREMENTAL:
-- tasa de recompra de los tratados menos la del grupo de control (10 % determinista, sin mensaje); no se suma "todo lo que volvio".
create or replace function restaurantes.marketing_resumen_campanas(p_organization_id uuid)
returns table (campana_id uuid, segmento text, estado text, conteo integer, conteo_control integer, costo_estimado_centavos integer, promo_nombre text, promo_codigo text,
               creada_at timestamptz, decidida_at timestamptz, encolados integer, enviados integer, recompra_tratados integer, recompra_control integer,
               ingreso_tratados numeric, ventana_cerrada boolean)
language plpgsql stable security definer set search_path = restaurantes, core, pg_temp as $$
#variable_conflict use_column
begin
  if not restaurantes.marketing_es_gestor(p_organization_id) then
    raise exception 'marketing_resumen_campanas: requiere owner/admin de la organizacion' using errcode = '42501';
  end if;
  return query
    select k.id, k.segmento, k.estado, k.conteo, k.conteo_control, k.costo_estimado_centavos, k.promo_nombre, k.promo_codigo, k.creada_at, k.decidida_at, k.encolados,
           (select count(*)::integer from restaurantes.marketing_campana_envio e join restaurantes.messaging_outbox o on o.id = e.outbox_id where e.campana_id = k.id and o.status = 'sent'),
           (select count(distinct e.customer_id)::integer from restaurantes.marketing_campana_envio e
              where e.campana_id = k.id and e.estado = 'encolado' and k.decidida_at is not null
                and exists (select 1 from restaurantes.orders od where od.customer_id = e.customer_id and od.organization_id = k.organization_id and od.status <> 'cancelado'
                            and od.created_at > k.decidida_at and od.created_at <= k.decidida_at + interval '7 days')),
           (select count(distinct e.customer_id)::integer from restaurantes.marketing_campana_envio e
              where e.campana_id = k.id and e.estado = 'control' and k.decidida_at is not null
                and exists (select 1 from restaurantes.orders od where od.customer_id = e.customer_id and od.organization_id = k.organization_id and od.status <> 'cancelado'
                            and od.created_at > k.decidida_at and od.created_at <= k.decidida_at + interval '7 days')),
           coalesce((select sum(od.total) from restaurantes.orders od join restaurantes.marketing_campana_envio e on e.customer_id = od.customer_id and e.campana_id = k.id and e.estado = 'encolado'
                      where od.organization_id = k.organization_id and od.status <> 'cancelado' and k.decidida_at is not null
                        and od.created_at > k.decidida_at and od.created_at <= k.decidida_at + interval '7 days'), 0),
           (k.decidida_at is not null and now() > k.decidida_at + interval '7 days')
      from restaurantes.marketing_campana k
     where k.organization_id = p_organization_id
     order by k.creada_at desc
     limit 50;
end;
$$;
revoke all on function restaurantes.marketing_resumen_campanas(uuid) from public, anon;
grant execute on function restaurantes.marketing_resumen_campanas(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- E) Alertas al dueño sin vigilancia (autopiloto 2): umbrales, «WhatsApp silencioso» y helper de vertical
-- ---------------------------------------------------------------------------
-- Justificacion de seguridad:
--   * alertas_duenio_config: RLS; GRANT SELECT por columna a authenticated con policy owner/admin con alcance a TODA la organizacion (misma forma que
--     marketing_config); sin escritura directa: solo la funcion alertas_duenio_guardar_config (owner/admin, valida rangos, deja bitacora).
--   * whatsapp_silencio_candidatos: security definer, search_path fijo, SOLO sistema (auth.uid() is null), revoke de public/anon; solo LEE
--     conteos de whatsapp_inbound_events (sin telefono ni texto: el evento guarda un hash) y excluye la organizacion demo. No escribe nada.
--   * es_organizacion_restaurantes: security definer, solo sistema; devuelve un booleano. Permite al productor del aviso de presupuesto de IA
--     (que corre para organizaciones de cualquier vertical) emitir el aviso del dueño SOLO en restaurantes, cuyo enlace apunta a su consola.
create table restaurantes.alertas_duenio_config (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  -- «WhatsApp silencioso»: sin ningun mensaje entrante en la ventana, cuando el mismo dia y hora de las 4 semanas previas promediaron al menos
  -- `silencio_historico_min` mensajes por ventana (y hubo trafico en 3 de las 4 semanas). Valores por omision conservadores: 60 min y 3 mensajes.
  silencio_activo boolean not null default true,
  silencio_ventana_min integer not null default 60 check (silencio_ventana_min between 15 and 360),
  silencio_historico_min numeric(8, 2) not null default 3 check (silencio_historico_min between 1 and 1000),
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table restaurantes.alertas_duenio_config enable row level security;
create policy "owner/admin lee los umbrales de alertas al dueno" on restaurantes.alertas_duenio_config for select
  using (exists (select 1 from core.membership m where m.organization_id = alertas_duenio_config.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin') and m.property_ids is null));
revoke all on restaurantes.alertas_duenio_config from public, anon, authenticated, service_role;
grant select (organization_id, silencio_activo, silencio_ventana_min, silencio_historico_min, updated_by, updated_at) on restaurantes.alertas_duenio_config to authenticated;

create or replace function restaurantes.alertas_duenio_guardar_config(p_organization_id uuid, p_silencio_activo boolean, p_ventana_min integer, p_historico_min numeric)
returns void language plpgsql security definer set search_path = restaurantes, core, pg_temp as $$
begin
  if not restaurantes.marketing_es_gestor(p_organization_id) then
    raise exception 'alertas_duenio_guardar_config: requiere owner/admin de la organizacion' using errcode = '42501';
  end if;
  if p_silencio_activo is null or p_ventana_min is null or p_ventana_min not between 15 and 360 or p_historico_min is null or p_historico_min not between 1 and 1000 then
    raise exception 'alertas_duenio_guardar_config: parametros invalidos' using errcode = '22023';
  end if;
  insert into restaurantes.alertas_duenio_config (organization_id, silencio_activo, silencio_ventana_min, silencio_historico_min, updated_by, updated_at)
  values (p_organization_id, p_silencio_activo, p_ventana_min, p_historico_min, auth.uid(), now())
  on conflict (organization_id) do update
    set silencio_activo = excluded.silencio_activo, silencio_ventana_min = excluded.silencio_ventana_min, silencio_historico_min = excluded.silencio_historico_min,
        updated_by = auth.uid(), updated_at = now();
  insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
  values (p_organization_id, auth.uid(), 'alertas_duenio.config_actualizada', 'configuracion', p_organization_id, 'silencio_whatsapp', null, p_ventana_min::text || 'min/' || p_historico_min::text);
end;
$$;
revoke all on function restaurantes.alertas_duenio_guardar_config(uuid, boolean, integer, numeric) from public, anon;
grant execute on function restaurantes.alertas_duenio_guardar_config(uuid, boolean, integer, numeric) to authenticated;

-- Organizaciones con el WhatsApp en silencio inusual AHORA (solo sistema). El horario de servicio se INFIERE del historico (si a esta hora de este dia
-- de la semana suele llegar trafico, se esta en servicio); no lee branch_policy.horario. Sin historico suficiente no alerta (conservador).
create or replace function restaurantes.whatsapp_silencio_candidatos(p_now timestamptz default now())
returns table (organization_id uuid, mensajes_historico numeric, ventana_min integer)
language plpgsql security definer set search_path = restaurantes, core, pg_temp as $$
#variable_conflict use_column
declare
  v_org record;
  v_vent integer;
  v_min numeric;
  v_actual integer;
  v_total integer;
  v_semanas integer;
  v_k integer;
  v_c integer;
begin
  if auth.uid() is not null then
    raise exception 'whatsapp_silencio_candidatos: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  for v_org in
    select w.organization_id as org, coalesce(c.silencio_activo, true) as activo, coalesce(c.silencio_ventana_min, 60) as ventana, coalesce(c.silencio_historico_min, 3) as historico
      from restaurantes.whatsapp_channel_config w
      left join restaurantes.alertas_duenio_config c on c.organization_id = w.organization_id
     where not exists (select 1 from restaurantes.demo_organization d where d.organization_id = w.organization_id)
     order by w.organization_id
     limit 500
  loop
    continue when not v_org.activo;
    v_vent := v_org.ventana;
    v_min := v_org.historico;
    select count(*) into v_actual from restaurantes.whatsapp_inbound_events e
      where e.organization_id = v_org.org and e.claimed_at >= p_now - make_interval(mins => v_vent) and e.claimed_at < p_now;
    continue when v_actual > 0;
    v_total := 0;
    v_semanas := 0;
    for v_k in 1..4 loop
      select count(*) into v_c from restaurantes.whatsapp_inbound_events e
        where e.organization_id = v_org.org
          and e.claimed_at >= p_now - make_interval(mins => v_vent) - make_interval(days => 7 * v_k) and e.claimed_at < p_now - make_interval(days => 7 * v_k);
      v_total := v_total + v_c;
      if v_c > 0 then v_semanas := v_semanas + 1; end if;
    end loop;
    if v_semanas >= 3 and (v_total::numeric / 4) >= v_min then
      organization_id := v_org.org;
      mensajes_historico := round(v_total::numeric / 4, 2);
      ventana_min := v_vent;
      return next;
    end if;
  end loop;
end;
$$;
revoke all on function restaurantes.whatsapp_silencio_candidatos(timestamptz) from public, anon;
grant execute on function restaurantes.whatsapp_silencio_candidatos(timestamptz) to authenticated;

create or replace function restaurantes.es_organizacion_restaurantes(p_organization_id uuid)
returns boolean language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'es_organizacion_restaurantes: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  return exists (select 1 from core.organization o where o.id = p_organization_id and o.vertical = 'restaurantes');
end;
$$;
revoke all on function restaurantes.es_organizacion_restaurantes(uuid) from public, anon;
grant execute on function restaurantes.es_organizacion_restaurantes(uuid) to authenticated;

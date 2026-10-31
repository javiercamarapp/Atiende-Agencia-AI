-- 150 (PM R23, F3 de SPEC-FUNCIONES-HISTORICO): REACTIVACION AUTOMATICA de clientes dormidos (ventana 14-21 dias) + captura conversacional de opt-in.
-- Interno 150, prefijo de supabase/migrations 20240101000417. Requiere: 052 (marketing_consentimiento, marketing_registrar_consentimiento, marketing_en_control,
-- marketing_es_gestor), 081 (cfo_renglones), 035 (voz_zona_horaria), 019 (audit_log), core 0050 (whatsapp_plantilla).
--
-- Principios (decisiones del brief, no de este archivo):
--   * SIN OPT-IN NUNCA SE ENCOLA: el universo sale SOLO de marketing_consentimiento.estado = 'otorgado'. Hoy es 0 y asi se queda hasta que haya consentimiento
--     (importar clientes jamas otorga consentimiento). Un cliente revocado (BAJA/STOP) sale al instante: marketing_revocar_por_telefono (052) ya cancela lo pendiente.
--   * TODO APAGADO POR OMISION: sin fila en reactivacion_config o con modo = 'apagado' no hay candidatos. Ademas cada SUCURSAL tiene su interruptor
--     (reactivacion_sucursal.activa, default false): sin el no se envia a clientes cuyo ultimo pedido fue en esa sucursal.
--     PUNTO DE INTEGRACION con la rama de alertas (fix/r23-alertas): reactivacion_sucursal_activa(property_id) es el UNICO sitio que consulta el interruptor;
--     si alertas trae un interruptor propio, se cambia el cuerpo de esa funcion (o se combina con AND) sin tocar nada mas.
--   * 'simulado' escribe auditoria y NO encola nada; pasar a 'real' exige owner/admin y haber corrido antes al menos 1 simulacion.
--   * Fuera de la ventana de 24 h solo hay plantilla de Meta APROBADA (core.whatsapp_plantilla): sin ella no se envia y el panel recibe el aviso
--     requiere_plantilla_aprobada (reactivacion_corrida.aviso / reactivacion_config_leer).
--   * Idempotencia: UNIQUE (organizacion, cliente, dia) en reactivacion_envio; una corrida repetida el mismo dia no duplica ni un envio.
--   * El favorito sale del propio historial (renglon mas pedido en 180 dias); nunca se inventa un descuento (la plantilla no lleva precio).
--
-- Piezas: A) tablas  B) config/interruptores (owner/admin)  C) opt-in conversacional (solo sistema)  D) candidatos y registro (solo sistema)  E) metricas (owner/admin).
--
-- Justificacion de seguridad:
--   * Tablas: RLS habilitada, revoke all a public/anon/authenticated/service_role, GRANT SELECT por columna a authenticated con policy de owner/admin de LA organizacion
--     (property_ids nulo), misma forma que la 052. Ninguna escritura directa: toda escritura pasa por funciones SECURITY DEFINER con search_path fijo.
--     reactivacion_envio / reactivacion_corrida / marketing_optin_pregunta no guardan telefono ni nombre (solo ids, conteos y el texto del favorito).
--   * Funciones de sistema (candidatos, registrar, opt-in): guard `auth.uid() is null` (42501 a un usuario logueado), revoke de public/anon y grant a authenticated
--     (el backend abre la sesion de sistema con ese rol sin usuario, igual que la 052).
--   * Funciones de owner/admin: marketing_es_gestor (alcance a TODA la organizacion); la organizacion se deriva de la fila, nunca del llamador cuando hay fila.
--
-- Compatibilidad con la base SIN migrar: el TypeScript captura 42883/42P01/42703 dentro de SAVEPOINT y degrada a «no disponible aun».
-- REVERSA: drop function (todas las reactivacion_* y marketing_optin_*) y drop table reactivacion_corrida, reactivacion_envio, marketing_optin_pregunta, reactivacion_sucursal, reactivacion_config.

-- ---------------------------------------------------------------------------
-- A) Tablas
-- ---------------------------------------------------------------------------
create table restaurantes.reactivacion_config (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  modo text not null default 'apagado' check (modo in ('apagado', 'simulado', 'real')),
  -- Pregunta de opt-in en la conversacion tras un pedido completado (bandera propia, apagada por omision).
  optin_conversacional boolean not null default false,
  -- Ventana de dias sin pedir (inclusiva): mediana de recompra de PM ~14 dias.
  dias_min smallint not null default 14 check (dias_min between 7 and 60),
  dias_max smallint not null default 21 check (dias_max between 8 and 90),
  min_dias_entre_envios smallint not null default 14 check (min_dias_entre_envios between 1 and 90),
  max_por_mes smallint not null default 2 check (max_por_mes between 1 and 10),
  hora_desde smallint not null default 10 check (hora_desde between 0 and 23),
  hora_hasta smallint not null default 20 check (hora_hasta between 1 and 24),
  tope_diario integer not null default 50 check (tope_diario between 1 and 1000),
  atribucion_dias smallint not null default 7 check (atribucion_dias between 1 and 30),
  -- Plantilla de marketing aprobada en Meta con 2 variables: {{1}} nombre (o saludo), {{2}} favorito.
  plantilla_nombre text check (plantilla_nombre is null or plantilla_nombre ~ '^[a-z0-9_]{1,255}$'),
  plantilla_idioma text not null default 'es_MX' check (plantilla_idioma ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (dias_max > dias_min),
  check (hora_hasta > hora_desde)
);

-- Interruptor (kill switch) por sucursal. Sin fila = apagada.
create table restaurantes.reactivacion_sucursal (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  activa boolean not null default false,
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- Una pregunta de opt-in por cliente (se reabre solo pasados 90 dias si no hubo SI).
create table restaurantes.marketing_optin_pregunta (
  organization_id uuid not null references core.organization(id) on delete cascade,
  customer_id uuid not null references restaurantes.customers(id) on delete cascade,
  preguntado_at timestamptz not null default now(),
  respondida_at timestamptz,
  respuesta text check (respuesta is null or respuesta in ('si', 'no')),
  primary key (organization_id, customer_id)
);

-- Auditoria + idempotencia por persona y dia. 'control' = grupo de control (no recibe mensaje; sirve para medir).
create table restaurantes.reactivacion_envio (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  customer_id uuid not null references restaurantes.customers(id) on delete cascade,
  property_id uuid references core.property(id) on delete set null,
  dia date not null,
  estado text not null check (estado in ('encolado', 'simulado', 'control')),
  plantilla_nombre text,
  favorito_texto text check (favorito_texto is null or char_length(favorito_texto) <= 80),
  outbox_id uuid references restaurantes.messaging_outbox(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (organization_id, customer_id, dia)
);
create index restaurantes_reactivacion_envio_cliente_idx on restaurantes.reactivacion_envio (customer_id, created_at desc);
create index restaurantes_reactivacion_envio_org_idx on restaurantes.reactivacion_envio (organization_id, created_at desc);

-- Una fila por corrida (sin PII): que paso y por que se bloqueo lo que se bloqueo.
create table restaurantes.reactivacion_corrida (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  corrida_at timestamptz not null default now(),
  modo text not null check (modo in ('simulado', 'real')),
  evaluados integer not null default 0 check (evaluados >= 0),
  enviados integer not null default 0 check (enviados >= 0),
  simulados integer not null default 0 check (simulados >= 0),
  controles integer not null default 0 check (controles >= 0),
  bloqueos jsonb not null default '{}'::jsonb,
  aviso text check (aviso is null or aviso ~ '^[a-z_]{1,60}$')
);
create index restaurantes_reactivacion_corrida_org_idx on restaurantes.reactivacion_corrida (organization_id, corrida_at desc);

alter table restaurantes.reactivacion_config enable row level security;
alter table restaurantes.reactivacion_sucursal enable row level security;
alter table restaurantes.marketing_optin_pregunta enable row level security;
alter table restaurantes.reactivacion_envio enable row level security;
alter table restaurantes.reactivacion_corrida enable row level security;

create policy "owner/admin lee la configuracion de reactivacion" on restaurantes.reactivacion_config for select
  using (exists (select 1 from core.membership m where m.organization_id = reactivacion_config.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin') and m.property_ids is null));
create policy "owner/admin lee los interruptores de reactivacion" on restaurantes.reactivacion_sucursal for select
  using (exists (select 1 from core.membership m where m.organization_id = reactivacion_sucursal.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin') and m.property_ids is null));
create policy "owner/admin lee las preguntas de opt-in" on restaurantes.marketing_optin_pregunta for select
  using (exists (select 1 from core.membership m where m.organization_id = marketing_optin_pregunta.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin') and m.property_ids is null));
create policy "owner/admin lee los envios de reactivacion" on restaurantes.reactivacion_envio for select
  using (exists (select 1 from core.membership m where m.organization_id = reactivacion_envio.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin') and m.property_ids is null));
create policy "owner/admin lee las corridas de reactivacion" on restaurantes.reactivacion_corrida for select
  using (exists (select 1 from core.membership m where m.organization_id = reactivacion_corrida.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin') and m.property_ids is null));

revoke all on restaurantes.reactivacion_config, restaurantes.reactivacion_sucursal, restaurantes.marketing_optin_pregunta, restaurantes.reactivacion_envio, restaurantes.reactivacion_corrida
  from public, anon, authenticated, service_role;
grant select (organization_id, modo, optin_conversacional, dias_min, dias_max, min_dias_entre_envios, max_por_mes, hora_desde, hora_hasta, tope_diario, atribucion_dias, plantilla_nombre, plantilla_idioma, updated_by, updated_at)
  on restaurantes.reactivacion_config to authenticated;
grant select (property_id, organization_id, activa, updated_by, updated_at) on restaurantes.reactivacion_sucursal to authenticated;
grant select (organization_id, customer_id, preguntado_at, respondida_at, respuesta) on restaurantes.marketing_optin_pregunta to authenticated;
grant select (id, organization_id, customer_id, property_id, dia, estado, plantilla_nombre, favorito_texto, outbox_id, created_at) on restaurantes.reactivacion_envio to authenticated;
grant select (id, organization_id, corrida_at, modo, evaluados, enviados, simulados, controles, bloqueos, aviso) on restaurantes.reactivacion_corrida to authenticated;

-- ---------------------------------------------------------------------------
-- B) Configuracion e interruptores (owner/admin)
-- ---------------------------------------------------------------------------
-- Punto de integracion del kill switch por sucursal (ver cabecera). Interna: sin EXECUTE para nadie salvo el dueno de las funciones que la invocan.
create or replace function restaurantes.reactivacion_sucursal_activa(p_property_id uuid)
returns boolean language sql stable set search_path = restaurantes, core, pg_temp as $$
  select coalesce((select s.activa from restaurantes.reactivacion_sucursal s where s.property_id = p_property_id), false);
$$;
revoke all on function restaurantes.reactivacion_sucursal_activa(uuid) from public, anon, authenticated, service_role;

create or replace function restaurantes.reactivacion_guardar_config(
  p_organization_id uuid, p_modo text, p_optin_conversacional boolean, p_dias_min integer, p_dias_max integer, p_min_dias_entre_envios integer,
  p_max_por_mes integer, p_hora_desde integer, p_hora_hasta integer, p_tope_diario integer, p_atribucion_dias integer, p_plantilla_nombre text, p_plantilla_idioma text
) returns void language plpgsql security definer set search_path = restaurantes, core, pg_temp as $$
begin
  if not restaurantes.marketing_es_gestor(p_organization_id) then
    raise exception 'reactivacion_guardar_config: requiere owner/admin de la organizacion' using errcode = '42501';
  end if;
  if p_modo is null or p_modo not in ('apagado', 'simulado', 'real') or p_optin_conversacional is null
     or p_dias_min is null or p_dias_min not between 7 and 60 or p_dias_max is null or p_dias_max not between 8 and 90 or p_dias_max <= p_dias_min
     or p_min_dias_entre_envios is null or p_min_dias_entre_envios not between 1 and 90 or p_max_por_mes is null or p_max_por_mes not between 1 and 10
     or p_hora_desde is null or p_hora_desde not between 0 and 23 or p_hora_hasta is null or p_hora_hasta not between 1 and 24 or p_hora_hasta <= p_hora_desde
     or p_tope_diario is null or p_tope_diario not between 1 and 1000 or p_atribucion_dias is null or p_atribucion_dias not between 1 and 30
     or (p_plantilla_nombre is not null and p_plantilla_nombre !~ '^[a-z0-9_]{1,255}$') or p_plantilla_idioma is null or p_plantilla_idioma !~ '^[a-z]{2,3}(_[A-Z]{2})?$' then
    raise exception 'reactivacion_guardar_config: parametros invalidos' using errcode = '22023';
  end if;
  -- Pasar a 'real' exige haber corrido al menos 1 simulacion (el dueno vio antes lo que se mandaria).
  if p_modo = 'real' and not exists (select 1 from restaurantes.reactivacion_corrida k where k.organization_id = p_organization_id and k.modo = 'simulado') then
    raise exception 'requiere_simulacion_previa' using errcode = 'P0001';
  end if;
  insert into restaurantes.reactivacion_config (organization_id, modo, optin_conversacional, dias_min, dias_max, min_dias_entre_envios, max_por_mes, hora_desde, hora_hasta, tope_diario,
                                                atribucion_dias, plantilla_nombre, plantilla_idioma, updated_by, updated_at)
  values (p_organization_id, p_modo, p_optin_conversacional, p_dias_min, p_dias_max, p_min_dias_entre_envios, p_max_por_mes, p_hora_desde, p_hora_hasta, p_tope_diario,
          p_atribucion_dias, p_plantilla_nombre, p_plantilla_idioma, auth.uid(), now())
  on conflict (organization_id) do update
    set modo = excluded.modo, optin_conversacional = excluded.optin_conversacional, dias_min = excluded.dias_min, dias_max = excluded.dias_max,
        min_dias_entre_envios = excluded.min_dias_entre_envios, max_por_mes = excluded.max_por_mes, hora_desde = excluded.hora_desde, hora_hasta = excluded.hora_hasta,
        tope_diario = excluded.tope_diario, atribucion_dias = excluded.atribucion_dias, plantilla_nombre = excluded.plantilla_nombre, plantilla_idioma = excluded.plantilla_idioma,
        updated_by = auth.uid(), updated_at = now();
  insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
  values (p_organization_id, auth.uid(), 'reactivacion.config_actualizada', 'configuracion', p_organization_id, 'modo', null, p_modo);
end;
$$;
revoke all on function restaurantes.reactivacion_guardar_config(uuid, text, boolean, integer, integer, integer, integer, integer, integer, integer, integer, text, text) from public, anon;
grant execute on function restaurantes.reactivacion_guardar_config(uuid, text, boolean, integer, integer, integer, integer, integer, integer, integer, integer, text, text) to authenticated;

-- Interruptor por sucursal. La organizacion se deriva de la sucursal (una sucursal ajena responde igual que una inexistente: 42501).
create or replace function restaurantes.reactivacion_set_sucursal(p_property_id uuid, p_activa boolean)
returns void language plpgsql security definer set search_path = restaurantes, core, pg_temp as $$
declare
  v_org uuid;
begin
  select p.organization_id into v_org from core.property p where p.id = p_property_id;
  if v_org is null or not restaurantes.marketing_es_gestor(v_org) then
    raise exception 'reactivacion_set_sucursal: sucursal inexistente o sin acceso' using errcode = '42501';
  end if;
  if p_activa is null then
    raise exception 'reactivacion_set_sucursal: parametros invalidos' using errcode = '22023';
  end if;
  insert into restaurantes.reactivacion_sucursal (property_id, organization_id, activa, updated_by, updated_at)
  values (p_property_id, v_org, p_activa, auth.uid(), now())
  on conflict (property_id) do update set activa = excluded.activa, updated_by = auth.uid(), updated_at = now();
  insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo, antes, despues)
  values (v_org, auth.uid(), 'reactivacion.sucursal_interruptor', 'configuracion', p_property_id, 'activa', null, p_activa::text);
end;
$$;
revoke all on function restaurantes.reactivacion_set_sucursal(uuid, boolean) from public, anon;
grant execute on function restaurantes.reactivacion_set_sucursal(uuid, boolean) to authenticated;

-- Lectura con los requisitos (estado honesto para el panel: «0 elegibles: falta opt-in», «requiere plantilla aprobada»).
create or replace function restaurantes.reactivacion_config_leer(p_organization_id uuid)
returns table (modo text, optin_conversacional boolean, dias_min integer, dias_max integer, min_dias_entre_envios integer, max_por_mes integer, hora_desde integer, hora_hasta integer,
               tope_diario integer, atribucion_dias integer, plantilla_nombre text, plantilla_idioma text, plantilla_aprobada boolean, whatsapp_conectado boolean,
               optins_vigentes bigint, sucursales_activas bigint, simulaciones bigint)
language plpgsql stable security definer set search_path = restaurantes, core, pg_temp as $$
#variable_conflict use_column
declare
  v_cfg restaurantes.reactivacion_config%rowtype;
begin
  if not restaurantes.marketing_es_gestor(p_organization_id) then
    raise exception 'reactivacion_config_leer: requiere owner/admin de la organizacion' using errcode = '42501';
  end if;
  select * into v_cfg from restaurantes.reactivacion_config c where c.organization_id = p_organization_id;
  modo := coalesce(v_cfg.modo, 'apagado');
  optin_conversacional := coalesce(v_cfg.optin_conversacional, false);
  dias_min := coalesce(v_cfg.dias_min, 14);
  dias_max := coalesce(v_cfg.dias_max, 21);
  min_dias_entre_envios := coalesce(v_cfg.min_dias_entre_envios, 14);
  max_por_mes := coalesce(v_cfg.max_por_mes, 2);
  hora_desde := coalesce(v_cfg.hora_desde, 10);
  hora_hasta := coalesce(v_cfg.hora_hasta, 20);
  tope_diario := coalesce(v_cfg.tope_diario, 50);
  atribucion_dias := coalesce(v_cfg.atribucion_dias, 7);
  plantilla_nombre := v_cfg.plantilla_nombre;
  plantilla_idioma := coalesce(v_cfg.plantilla_idioma, 'es_MX');
  plantilla_aprobada := v_cfg.plantilla_nombre is not null and exists (
    select 1 from core.whatsapp_plantilla w where w.organization_id = p_organization_id and w.nombre = v_cfg.plantilla_nombre and w.estado = 'aprobada');
  whatsapp_conectado := exists (select 1 from restaurantes.whatsapp_channel_config w where w.organization_id = p_organization_id);
  optins_vigentes := (select count(*) from restaurantes.marketing_consentimiento mc where mc.organization_id = p_organization_id and mc.canal = 'whatsapp' and mc.estado = 'otorgado');
  sucursales_activas := (select count(*) from restaurantes.reactivacion_sucursal s where s.organization_id = p_organization_id and s.activa);
  simulaciones := (select count(*) from restaurantes.reactivacion_corrida k where k.organization_id = p_organization_id and k.modo = 'simulado');
  return next;
end;
$$;
revoke all on function restaurantes.reactivacion_config_leer(uuid) from public, anon;
grant execute on function restaurantes.reactivacion_config_leer(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- C) Opt-in conversacional (solo sistema)
-- ---------------------------------------------------------------------------
-- Contexto para decidir si preguntar / si un SI-NO responde a una pregunta abierta. Sin fila = no hay cliente con ese telefono en la organizacion.
-- puede_preguntar es false si: bandera apagada, ya otorgo, ya REVOCO (BAJA: jamas se vuelve a preguntar), queja reciente (pedido en 'problema' en 30 dias),
-- ya dijo SI, o ya se pregunto hace menos de 90 dias.
create or replace function restaurantes.reactivacion_optin_contexto(p_organization_id uuid, p_telefono text, p_now timestamptz default now())
returns table (customer_id uuid, habilitado boolean, pregunta_abierta boolean, puede_preguntar boolean)
language plpgsql stable security definer set search_path = restaurantes, core, pg_temp as $$
#variable_conflict use_column
declare
  v_digitos text := regexp_replace(coalesce(p_telefono, ''), '[^0-9]', '', 'g');
  v_cli uuid;
  v_hab boolean;
  v_cons text;
  v_preg restaurantes.marketing_optin_pregunta%rowtype;
  v_queja boolean;
begin
  if auth.uid() is not null then
    raise exception 'reactivacion_optin_contexto: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  if length(v_digitos) < 8 then
    raise exception 'reactivacion_optin_contexto: telefono invalido' using errcode = '22023';
  end if;
  select c.id into v_cli from restaurantes.customers c
    where c.organization_id = p_organization_id and regexp_replace(c.phone, '[^0-9]', '', 'g') = v_digitos order by c.created_at, c.id limit 1;
  if v_cli is null then
    return;
  end if;
  v_hab := coalesce((select rc.optin_conversacional from restaurantes.reactivacion_config rc where rc.organization_id = p_organization_id), false);
  select mc.estado into v_cons from restaurantes.marketing_consentimiento mc where mc.organization_id = p_organization_id and mc.customer_id = v_cli and mc.canal = 'whatsapp';
  select * into v_preg from restaurantes.marketing_optin_pregunta q where q.organization_id = p_organization_id and q.customer_id = v_cli;
  v_queja := exists (select 1 from restaurantes.orders o where o.customer_id = v_cli and o.status = 'problema' and o.created_at > p_now - interval '30 days');
  customer_id := v_cli;
  habilitado := v_hab;
  pregunta_abierta := v_hab and v_preg.customer_id is not null and v_preg.respondida_at is null and v_preg.preguntado_at > p_now - interval '3 days';
  puede_preguntar := v_hab and v_cons is null and not v_queja
    and (v_preg.customer_id is null or (coalesce(v_preg.respuesta, '') <> 'si' and v_preg.preguntado_at < p_now - interval '90 days'));
  return next;
end;
$$;
revoke all on function restaurantes.reactivacion_optin_contexto(uuid, text, timestamptz) from public, anon;
grant execute on function restaurantes.reactivacion_optin_contexto(uuid, text, timestamptz) to authenticated;

-- Marca que la pregunta SE HIZO (se llama en el mismo turno que la agrega a la respuesta). Reabre (respuesta nula) solo si ya pasaron 90 dias.
create or replace function restaurantes.reactivacion_optin_marcar(p_organization_id uuid, p_customer_id uuid, p_now timestamptz default now())
returns boolean language plpgsql security definer set search_path = restaurantes, core, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'reactivacion_optin_marcar: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  if not exists (select 1 from restaurantes.customers c where c.id = p_customer_id and c.organization_id = p_organization_id) then
    raise exception 'reactivacion_optin_marcar: el cliente no pertenece a la organizacion' using errcode = '42501';
  end if;
  insert into restaurantes.marketing_optin_pregunta (organization_id, customer_id, preguntado_at, respondida_at, respuesta)
  values (p_organization_id, p_customer_id, p_now, null, null)
  on conflict (organization_id, customer_id) do update set preguntado_at = excluded.preguntado_at, respondida_at = null, respuesta = null
    where restaurantes.marketing_optin_pregunta.preguntado_at < p_now - interval '90 days';
  return found;
end;
$$;
revoke all on function restaurantes.reactivacion_optin_marcar(uuid, uuid, timestamptz) from public, anon;
grant execute on function restaurantes.reactivacion_optin_marcar(uuid, uuid, timestamptz) to authenticated;

-- Registra la respuesta SI/NO a una pregunta ABIERTA (<= 3 dias). Solo un SI explicito otorga consentimiento (fuente agente_whatsapp). Devuelve
-- 'otorgado' | 'rechazado' | 'sin_pregunta' (no hay pregunta abierta: el mensaje sigue su camino normal con el agente).
create or replace function restaurantes.reactivacion_optin_responder(p_organization_id uuid, p_telefono text, p_si boolean, p_now timestamptz default now())
returns text language plpgsql security definer set search_path = restaurantes, core, pg_temp as $$
declare
  v_digitos text := regexp_replace(coalesce(p_telefono, ''), '[^0-9]', '', 'g');
  v_cli uuid;
  v_hab boolean;
begin
  if auth.uid() is not null then
    raise exception 'reactivacion_optin_responder: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  if length(v_digitos) < 8 or p_si is null then
    raise exception 'reactivacion_optin_responder: parametros invalidos' using errcode = '22023';
  end if;
  select c.id into v_cli from restaurantes.customers c
    where c.organization_id = p_organization_id and regexp_replace(c.phone, '[^0-9]', '', 'g') = v_digitos
      and exists (select 1 from restaurantes.marketing_optin_pregunta q where q.organization_id = p_organization_id and q.customer_id = c.id and q.respondida_at is null and q.preguntado_at > p_now - interval '3 days')
    order by c.created_at, c.id limit 1;
  v_hab := coalesce((select rc.optin_conversacional from restaurantes.reactivacion_config rc where rc.organization_id = p_organization_id), false);
  if v_cli is null or not v_hab then
    return 'sin_pregunta';
  end if;
  update restaurantes.marketing_optin_pregunta q set respondida_at = p_now, respuesta = case when p_si then 'si' else 'no' end
   where q.organization_id = p_organization_id and q.customer_id = v_cli;
  if p_si then
    perform restaurantes.marketing_registrar_consentimiento(p_organization_id, v_cli, 'whatsapp', true, 'agente_whatsapp');
    return 'otorgado';
  end if;
  return 'rechazado';
end;
$$;
revoke all on function restaurantes.reactivacion_optin_responder(uuid, text, boolean, timestamptz) from public, anon;
grant execute on function restaurantes.reactivacion_optin_responder(uuid, text, boolean, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- D) Candidatos, contexto de corrida y registro (solo sistema)
-- ---------------------------------------------------------------------------
-- Organizaciones con reactivacion encendida (modo <> 'apagado').
create or replace function restaurantes.reactivacion_organizaciones(p_now timestamptz default now())
returns table (organization_id uuid)
language plpgsql stable security definer set search_path = restaurantes, core, pg_temp as $$
#variable_conflict use_column
begin
  if auth.uid() is not null then
    raise exception 'reactivacion_organizaciones: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  return query select c.organization_id from restaurantes.reactivacion_config c where c.modo <> 'apagado' order by c.organization_id;
end;
$$;
revoke all on function restaurantes.reactivacion_organizaciones(timestamptz) from public, anon;
grant execute on function restaurantes.reactivacion_organizaciones(timestamptz) to authenticated;

-- Contexto de una organizacion para la corrida: config + plantilla + canal + zona horaria de la sucursal principal. Sin fila = apagado.
create or replace function restaurantes.reactivacion_contexto(p_organization_id uuid)
returns table (modo text, dias_min integer, dias_max integer, min_dias_entre_envios integer, max_por_mes integer, hora_desde integer, hora_hasta integer, tope_diario integer,
               plantilla_nombre text, plantilla_idioma text, plantilla_aprobada boolean, phone_number_id text, zona_horaria text, enviados_hoy integer)
language plpgsql stable security definer set search_path = restaurantes, core, pg_temp as $$
#variable_conflict use_column
declare
  v_cfg restaurantes.reactivacion_config%rowtype;
  v_zona text;
begin
  if auth.uid() is not null then
    raise exception 'reactivacion_contexto: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  select * into v_cfg from restaurantes.reactivacion_config c where c.organization_id = p_organization_id and c.modo <> 'apagado';
  if not found then
    return;
  end if;
  v_zona := restaurantes.voz_zona_horaria((select bd.property_id from restaurantes.branch_detail bd where bd.organization_id = p_organization_id order by bd.display_order, bd.property_id limit 1));
  modo := v_cfg.modo; dias_min := v_cfg.dias_min; dias_max := v_cfg.dias_max; min_dias_entre_envios := v_cfg.min_dias_entre_envios; max_por_mes := v_cfg.max_por_mes;
  hora_desde := v_cfg.hora_desde; hora_hasta := v_cfg.hora_hasta; tope_diario := v_cfg.tope_diario;
  plantilla_nombre := v_cfg.plantilla_nombre; plantilla_idioma := v_cfg.plantilla_idioma;
  plantilla_aprobada := v_cfg.plantilla_nombre is not null and exists (
    select 1 from core.whatsapp_plantilla w where w.organization_id = p_organization_id and w.nombre = v_cfg.plantilla_nombre and w.estado = 'aprobada');
  phone_number_id := (select w.phone_number_id from restaurantes.whatsapp_channel_config w where w.organization_id = p_organization_id);
  zona_horaria := v_zona;
  enviados_hoy := (select count(*) from restaurantes.reactivacion_envio e
                    where e.organization_id = p_organization_id and e.estado in ('encolado', 'simulado') and (e.created_at at time zone v_zona)::date = (now() at time zone v_zona)::date);
  return next;
end;
$$;
revoke all on function restaurantes.reactivacion_contexto(uuid) from public, anon;
grant execute on function restaurantes.reactivacion_contexto(uuid) to authenticated;

-- Candidatos: SOLO clientes con consentimiento 'otorgado' (filtro duro aqui; el TypeScript lo vuelve a verificar) cuyo ultimo pedido cae en la ventana
-- [dias_min, dias_max] de dias completos. Tope de 1000 por llamada. Devuelve telefono (lo necesita el envio) pero ninguna otra PII.
create or replace function restaurantes.reactivacion_candidatos(p_organization_id uuid, p_now timestamptz default now())
returns table (customer_id uuid, telefono text, nombre text, property_id uuid, dias_sin_pedir integer, favorito text, ultimo_mensaje_cliente_at timestamptz,
               optin_estado text, envios_en_intervalo integer, envios_en_mes integer, queja_reciente boolean, sucursal_activa boolean, control boolean)
language plpgsql stable security definer set search_path = restaurantes, core, pg_temp as $$
#variable_conflict use_column
declare
  v_cfg restaurantes.reactivacion_config%rowtype;
  v_zona text;
  v_mes_inicio timestamptz;
begin
  if auth.uid() is not null then
    raise exception 'reactivacion_candidatos: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  select * into v_cfg from restaurantes.reactivacion_config c where c.organization_id = p_organization_id and c.modo <> 'apagado';
  if not found then
    return;
  end if;
  v_zona := restaurantes.voz_zona_horaria((select bd.property_id from restaurantes.branch_detail bd where bd.organization_id = p_organization_id order by bd.display_order, bd.property_id limit 1));
  v_mes_inicio := date_trunc('month', p_now at time zone v_zona) at time zone v_zona;
  return query
    select c.id, c.phone, c.name, lo.property_id,
           floor(extract(epoch from (p_now - c.last_order_at)) / 86400)::integer,
           fav.nombre,
           (select max(case when (m.value ->> 'at') ~ '^\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:?\d{2})$' then (m.value ->> 'at')::timestamptz end)
              from restaurantes.whatsapp_conversations wc cross join lateral jsonb_array_elements(case when jsonb_typeof(wc.messages) = 'array' then wc.messages else '[]'::jsonb end) as m(value)
             where wc.organization_id = p_organization_id and wc.phone = c.phone and (m.value ->> 'role') = 'user'),
           mc.estado,
           (select count(*)::integer from restaurantes.reactivacion_envio e where e.customer_id = c.id and e.estado = 'encolado' and e.created_at > p_now - make_interval(days => v_cfg.min_dias_entre_envios)),
           (select count(*)::integer from restaurantes.reactivacion_envio e where e.customer_id = c.id and e.estado = 'encolado' and e.created_at >= v_mes_inicio),
           exists (select 1 from restaurantes.orders o where o.customer_id = c.id and o.status = 'problema' and o.created_at > p_now - interval '30 days'),
           restaurantes.reactivacion_sucursal_activa(lo.property_id),
           restaurantes.marketing_en_control(c.phone)
      from restaurantes.customers c
      join restaurantes.marketing_consentimiento mc on mc.organization_id = c.organization_id and mc.customer_id = c.id and mc.canal = 'whatsapp' and mc.estado = 'otorgado'
      cross join lateral (select o.property_id from restaurantes.orders o where o.customer_id = c.id and o.status <> 'cancelado' order by o.created_at desc, o.id limit 1) lo
      left join lateral (
        select r.nombre from restaurantes.orders o cross join lateral restaurantes.cfo_renglones(o.items) r
         where o.customer_id = c.id and o.organization_id = p_organization_id and o.status <> 'cancelado' and r.nombre is not null and o.created_at > p_now - interval '180 days'
         group by r.nombre order by sum(r.cantidad) desc, max(o.created_at) desc, r.nombre limit 1
      ) fav on true
     where c.organization_id = p_organization_id
       and c.phone is not null and btrim(c.phone) <> ''
       and c.last_order_at is not null
       and c.last_order_at <= p_now - make_interval(days => v_cfg.dias_min)
       and c.last_order_at > p_now - make_interval(days => v_cfg.dias_max + 1)
     order by c.id
     limit 1000;
end;
$$;
revoke all on function restaurantes.reactivacion_candidatos(uuid, timestamptz) from public, anon;
grant execute on function restaurantes.reactivacion_candidatos(uuid, timestamptz) to authenticated;

-- Registro idempotente de un envio (true = nuevo; false = ya existia ese cliente ese dia: no se duplica).
create or replace function restaurantes.reactivacion_registrar_envio(
  p_organization_id uuid, p_customer_id uuid, p_property_id uuid, p_dia date, p_estado text, p_plantilla text, p_favorito text, p_outbox_id uuid
) returns boolean language plpgsql security definer set search_path = restaurantes, core, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'reactivacion_registrar_envio: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  if p_estado is null or p_estado not in ('encolado', 'simulado', 'control') or p_dia is null then
    raise exception 'reactivacion_registrar_envio: parametros invalidos' using errcode = '22023';
  end if;
  if not exists (select 1 from restaurantes.customers c where c.id = p_customer_id and c.organization_id = p_organization_id) then
    raise exception 'reactivacion_registrar_envio: el cliente no pertenece a la organizacion' using errcode = '42501';
  end if;
  insert into restaurantes.reactivacion_envio (organization_id, customer_id, property_id, dia, estado, plantilla_nombre, favorito_texto, outbox_id)
  values (p_organization_id, p_customer_id, p_property_id, p_dia, p_estado, p_plantilla, left(p_favorito, 80), p_outbox_id)
  on conflict (organization_id, customer_id, dia) do nothing;
  return found;
end;
$$;
revoke all on function restaurantes.reactivacion_registrar_envio(uuid, uuid, uuid, date, text, text, text, uuid) from public, anon;
grant execute on function restaurantes.reactivacion_registrar_envio(uuid, uuid, uuid, date, text, text, text, uuid) to authenticated;

create or replace function restaurantes.reactivacion_registrar_corrida(
  p_organization_id uuid, p_modo text, p_evaluados integer, p_enviados integer, p_simulados integer, p_controles integer, p_bloqueos jsonb, p_aviso text
) returns uuid language plpgsql security definer set search_path = restaurantes, core, pg_temp as $$
declare
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'reactivacion_registrar_corrida: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  if p_modo is null or p_modo not in ('simulado', 'real') or least(p_evaluados, p_enviados, p_simulados, p_controles) < 0 or jsonb_typeof(coalesce(p_bloqueos, '{}'::jsonb)) <> 'object' then
    raise exception 'reactivacion_registrar_corrida: parametros invalidos' using errcode = '22023';
  end if;
  insert into restaurantes.reactivacion_corrida (organization_id, modo, evaluados, enviados, simulados, controles, bloqueos, aviso)
  values (p_organization_id, p_modo, p_evaluados, p_enviados, p_simulados, p_controles, coalesce(p_bloqueos, '{}'::jsonb), p_aviso)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function restaurantes.reactivacion_registrar_corrida(uuid, text, integer, integer, integer, integer, jsonb, text) from public, anon;
grant execute on function restaurantes.reactivacion_registrar_corrida(uuid, text, integer, integer, integer, integer, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- E) Metricas (owner/admin): enviados, respondieron, recompraron en N dias, bajas, y el grupo de control.
-- ---------------------------------------------------------------------------
-- Una fila. «respondieron» = el cliente escribio dentro de las 24 h siguientes al envio. «recompraron» = pedido no cancelado dentro de atribucion_dias
-- (config) despues del envio. «bajas» = BAJA/STOP (consentimiento revocado por baja_whatsapp) dentro de esos mismos dias. El control (10 % determinista) no recibe
-- mensaje: su tasa de recompra es la base para el incremental. Solo cuenta envios cuya ventana ya cerro para recompra/bajas? No: cuenta lo ocurrido hasta ahora.
create or replace function restaurantes.reactivacion_metricas(p_organization_id uuid, p_desde timestamptz, p_hasta timestamptz)
returns table (enviados bigint, simulados bigint, controles bigint, respondieron bigint, recompraron bigint, recompraron_control bigint, bajas bigint, atribucion_dias integer)
language plpgsql stable security definer set search_path = restaurantes, core, pg_temp as $$
#variable_conflict use_column
declare
  v_n integer;
begin
  if not restaurantes.marketing_es_gestor(p_organization_id) then
    raise exception 'reactivacion_metricas: requiere owner/admin de la organizacion' using errcode = '42501';
  end if;
  if p_desde is null or p_hasta is null or p_hasta <= p_desde then
    raise exception 'reactivacion_metricas: rango invalido' using errcode = '22023';
  end if;
  v_n := coalesce((select rc.atribucion_dias from restaurantes.reactivacion_config rc where rc.organization_id = p_organization_id), 7);
  atribucion_dias := v_n;
  select count(*) filter (where e.estado = 'encolado'), count(*) filter (where e.estado = 'simulado'), count(*) filter (where e.estado = 'control')
    into enviados, simulados, controles
    from restaurantes.reactivacion_envio e where e.organization_id = p_organization_id and e.created_at >= p_desde and e.created_at < p_hasta;
  respondieron := (
    select count(*) from restaurantes.reactivacion_envio e join restaurantes.customers c on c.id = e.customer_id
     where e.organization_id = p_organization_id and e.estado = 'encolado' and e.created_at >= p_desde and e.created_at < p_hasta
       and exists (
         select 1 from restaurantes.whatsapp_conversations wc cross join lateral jsonb_array_elements(case when jsonb_typeof(wc.messages) = 'array' then wc.messages else '[]'::jsonb end) as m(value)
          where wc.organization_id = e.organization_id and wc.phone = c.phone and (m.value ->> 'role') = 'user'
            and (m.value ->> 'at') ~ '^\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:?\d{2})$'
            and (case when (m.value ->> 'at') ~ '^\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:?\d{2})$' then (m.value ->> 'at')::timestamptz end) > e.created_at
            and (case when (m.value ->> 'at') ~ '^\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:?\d{2})$' then (m.value ->> 'at')::timestamptz end) <= e.created_at + interval '24 hours'));
  recompraron := (
    select count(*) from restaurantes.reactivacion_envio e
     where e.organization_id = p_organization_id and e.estado = 'encolado' and e.created_at >= p_desde and e.created_at < p_hasta
       and exists (select 1 from restaurantes.orders o where o.customer_id = e.customer_id and o.status <> 'cancelado' and o.created_at > e.created_at and o.created_at <= e.created_at + make_interval(days => v_n)));
  recompraron_control := (
    select count(*) from restaurantes.reactivacion_envio e
     where e.organization_id = p_organization_id and e.estado = 'control' and e.created_at >= p_desde and e.created_at < p_hasta
       and exists (select 1 from restaurantes.orders o where o.customer_id = e.customer_id and o.status <> 'cancelado' and o.created_at > e.created_at and o.created_at <= e.created_at + make_interval(days => v_n)));
  bajas := (
    select count(*) from restaurantes.reactivacion_envio e
     where e.organization_id = p_organization_id and e.estado = 'encolado' and e.created_at >= p_desde and e.created_at < p_hasta
       and exists (select 1 from restaurantes.marketing_consentimiento_evento ev where ev.organization_id = e.organization_id and ev.customer_id = e.customer_id
                    and ev.estado = 'revocado' and ev.fuente = 'baja_whatsapp' and ev.ocurrido_at > e.created_at and ev.ocurrido_at <= e.created_at + make_interval(days => v_n)));
  return next;
end;
$$;
revoke all on function restaurantes.reactivacion_metricas(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function restaurantes.reactivacion_metricas(uuid, timestamptz, timestamptz) to authenticated;

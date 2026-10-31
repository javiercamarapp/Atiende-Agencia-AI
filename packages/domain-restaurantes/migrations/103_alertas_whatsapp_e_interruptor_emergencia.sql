-- 103 (PM PR-3 / PR-6): alertas de WhatsApp al gerente por sucursal e interruptor de emergencia unificado (WhatsApp + voz).
--
--  1) restaurantes.alerta_sucursal_config -- UNA fila por sucursal con los datos que el dueno debe aportar: si las alertas estan encendidas, el numero de
--     WhatsApp REMITENTE de los avisos (phone_number_id), la plantilla de Meta (nombre, idioma y si ya esta aprobada), los destinatarios (telefonos del
--     gerente/encargado), el horario y la zona horaria en que se permite avisar por WhatsApp y los minutos sin respuesta que disparan el aviso de "cliente
--     esperando". Sin fila, o con `activa = false`, no se envia nada (la campana del panel sigue como hasta hoy).
--  2) restaurantes.alerta_whatsapp_registro -- una fila por decision tomada sobre una alerta (encolada / degradada al panel / omitida) con el MOTIVO. Su
--     indice unico (tipo, clave, destino_hash) es el dedupe: la misma escalacion no avisa dos veces al mismo destino aunque el barrido corra mil veces.
--  3) restaurantes.alertas_candidatas -- solo sistema: devuelve las tomas pendientes (aviso inmediato de escalacion), las tomas pendientes que ya pasaron N
--     minutos y las conversaciones de WhatsApp cuyo ULTIMO mensaje es del cliente y lleva N minutos sin respuesta, solo de sucursales con alertas activas.
--  4) restaurantes.interruptor_emergencia (+ _historial) -- interruptor UNIFICADO: una fila por organizacion (property_id null = apaga TODAS las sucursales) o
--     por sucursal. Apagado = el agente de WhatsApp no llama al modelo (texto fijo + toma de handoff para una persona) y el agente de voz no abre sesion
--     (saludo pregrabado + callback). Es independiente de whatsapp_sucursal_control (053): cualquiera de los dos apaga el canal de WhatsApp.
--
-- Justificacion de seguridad (cada tabla, GRANT, policy y funcion):
--  * alerta_sucursal_config: contiene telefonos de personas. RLS: SELECT solo para gestores de la sucursal (owner/admin dentro de su alcance, via
--    handoff_actor_en_sucursal(..., true), que tambien valida que la sucursal sea de la organizacion) o sesion de sistema (auth.uid() is null, el barrido
--    de alertas). INSERT/UPDATE solo gestores; GRANT por COLUMNA: organization_id/property_id solo en INSERT (una fila no cambia de tenant ni de sucursal).
--    `anon` sin ningun privilegio. Sin DELETE para authenticated (se apaga con activa = false).
--  * alerta_whatsapp_registro: SELECT de gestores de la sucursal; NINGUN DML para authenticated: la unica escritura es alerta_registrar (solo sistema).
--  * alerta_registrar / alertas_candidatas: solo sistema (auth.uid() is null, un usuario recibe 42501), security definer con search_path fijo, revoke
--    de public y anon. alerta_registrar valida que la sucursal sea de la organizacion declarada; alertas_candidatas solo devuelve identificadores, fechas
--    y minutos (nunca texto de mensajes ni telefonos).
--  * interruptor_emergencia: SELECT para miembros de la organizacion o sistema (el webhook y el worker de voz lo leen sin usuario); SIN DML directo para
--    authenticated: la unica escritura es interruptor_fijar, que exige gestor de la sucursal (o owner/admin SIN acotar para el interruptor de toda la
--    organizacion), deja historial con el actor y el motivo, y devuelve el valor anterior para avisar solo cuando cambia.
--  * interruptor_apagado: security definer, STABLE; sesion de sistema o miembro de la organizacion; devuelve solo un booleano.
--
-- Compatibilidad con la base sin esta migracion: el TypeScript captura 42883/42P01/42703 con SAVEPOINT; sin alertas no se envia nada y sin interruptor los
-- canales siguen como hasta hoy (encendidos); nunca un 500.
-- REVERSA: drop function if exists restaurantes.interruptor_apagado(uuid, uuid), restaurantes.interruptor_fijar(uuid, uuid, boolean, text),
--   restaurantes.alertas_candidatas(timestamptz, integer), restaurantes.alerta_registrar(uuid, uuid, text, text, text, text, text);
--   drop table if exists restaurantes.interruptor_emergencia_historial, restaurantes.interruptor_emergencia, restaurantes.alerta_whatsapp_registro,
--   restaurantes.alerta_sucursal_config;

-- ---------------------------------------------------------------------------
-- 1) Configuracion de alertas por sucursal
-- ---------------------------------------------------------------------------
create table restaurantes.alerta_sucursal_config (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  activa boolean not null default false,
  -- Numero de WhatsApp Business REMITENTE de los avisos al personal (id de Meta, no el telefono). Null = degrada al panel.
  phone_number_id_aviso text check (phone_number_id_aviso is null or phone_number_id_aviso ~ '^[0-9]{5,30}$'),
  -- Plantilla de Meta (categoria utilidad) con 3 variables: {{1}} tipo de aviso, {{2}} sucursal, {{3}} minutos. Null o no aprobada = degrada al panel.
  plantilla_nombre text check (plantilla_nombre is null or (char_length(plantilla_nombre) between 1 and 512 and plantilla_nombre ~ '^[a-z0-9_]+$')),
  plantilla_idioma text not null default 'es_MX' check (plantilla_idioma ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  plantilla_aprobada boolean not null default false,
  zona_horaria text not null default 'America/Merida' check (char_length(zona_horaria) between 3 and 64),
  -- [{"dias":[0..6],"desde":"HH:MM","hasta":"HH:MM"}]; null = a cualquier hora. Lo valida el TypeScript (horario ilegible = a cualquier hora, nunca silencio).
  horario jsonb check (horario is null or (jsonb_typeof(horario) = 'array' and jsonb_array_length(horario) <= 14)),
  minutos_sin_respuesta integer not null default 10 check (minutos_sin_respuesta between 1 and 240),
  -- [{"telefono":"5219991234567","nombre":"Gerente","rol":"gerente"}], hasta 10.
  destinatarios jsonb not null default '[]'::jsonb check (jsonb_typeof(destinatarios) = 'array' and jsonb_array_length(destinatarios) <= 10),
  actualizado_por uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now()
);
create index alerta_sucursal_config_org_idx on restaurantes.alerta_sucursal_config (organization_id) where activa;

alter table restaurantes.alerta_sucursal_config enable row level security;

create policy "gestor o sistema lee la config de alertas" on restaurantes.alerta_sucursal_config for select
  using (auth.uid() is null or restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true));
create policy "gestor crea la config de alertas" on restaurantes.alerta_sucursal_config for insert
  with check (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true));
create policy "gestor actualiza la config de alertas" on restaurantes.alerta_sucursal_config for update
  using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true))
  with check (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true));

revoke all on restaurantes.alerta_sucursal_config from public, anon, authenticated;
grant select on restaurantes.alerta_sucursal_config to authenticated;
grant insert (property_id, organization_id, activa, phone_number_id_aviso, plantilla_nombre, plantilla_idioma, plantilla_aprobada, zona_horaria, horario, minutos_sin_respuesta, destinatarios, actualizado_por, updated_at)
  on restaurantes.alerta_sucursal_config to authenticated;
grant update (activa, phone_number_id_aviso, plantilla_nombre, plantilla_idioma, plantilla_aprobada, zona_horaria, horario, minutos_sin_respuesta, destinatarios, actualizado_por, updated_at)
  on restaurantes.alerta_sucursal_config to authenticated;
grant select, insert, update, delete on restaurantes.alerta_sucursal_config to service_role;

-- ---------------------------------------------------------------------------
-- 2) Registro (dedupe + motivo) de cada alerta
-- ---------------------------------------------------------------------------
create table restaurantes.alerta_whatsapp_registro (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  tipo text not null check (tipo in ('escalada', 'sin_respuesta')),
  clave text not null check (char_length(clave) between 1 and 160),
  -- Hash del telefono destino ('' = decision sobre la alerta completa, p. ej. degradada al panel). Nunca el telefono.
  destino_hash text not null default '' check (char_length(destino_hash) <= 64),
  estado text not null check (estado in ('encolada', 'degradada_panel', 'omitida')),
  motivo text check (motivo is null or char_length(motivo) <= 200),
  created_at timestamptz not null default now()
);
create unique index alerta_whatsapp_registro_dedupe_uidx on restaurantes.alerta_whatsapp_registro (tipo, clave, destino_hash);
create index alerta_whatsapp_registro_prop_idx on restaurantes.alerta_whatsapp_registro (organization_id, property_id, created_at desc);

alter table restaurantes.alerta_whatsapp_registro enable row level security;
create policy "gestor lee el registro de alertas" on restaurantes.alerta_whatsapp_registro for select
  using (restaurantes.handoff_actor_en_sucursal(organization_id, property_id, true));
revoke all on restaurantes.alerta_whatsapp_registro from public, anon, authenticated;
grant select on restaurantes.alerta_whatsapp_registro to authenticated, service_role;

create or replace function restaurantes.alerta_registrar(
  p_organization_id uuid,
  p_property_id uuid,
  p_tipo text,
  p_clave text,
  p_destino_hash text,
  p_estado text,
  p_motivo text
) returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_n integer;
begin
  if auth.uid() is not null then
    raise exception 'alerta_registrar es solo de sistema' using errcode = '42501';
  end if;
  if not exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id) then
    raise exception 'alerta_registrar: la sucursal no es de la organizacion' using errcode = '42501';
  end if;
  insert into restaurantes.alerta_whatsapp_registro (organization_id, property_id, tipo, clave, destino_hash, estado, motivo)
  values (p_organization_id, p_property_id, p_tipo, p_clave, coalesce(p_destino_hash, ''), p_estado, left(p_motivo, 200))
  on conflict (tipo, clave, destino_hash) do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0; -- false = ya existia (otro barrido o reintento): quien llama NO vuelve a enviar
end;
$$;
revoke all on function restaurantes.alerta_registrar(uuid, uuid, text, text, text, text, text) from public, anon;
grant execute on function restaurantes.alerta_registrar(uuid, uuid, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Candidatas del barrido (solo sistema)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.alertas_candidatas(p_ahora timestamptz, p_limite integer)
returns table (
  tipo text,
  clave text,
  entidad_id uuid,
  organization_id uuid,
  property_id uuid,
  desde timestamptz,
  minutos integer
)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'alertas_candidatas es solo de sistema' using errcode = '42501';
  end if;
  return query
  select x.tipo, x.clave, x.entidad_id, x.organization_id, x.property_id, x.desde, x.minutos
  from (
    -- (a) aviso inmediato: una toma PENDIENTE (el agente o una persona pidio atencion humana) de los ultimos 2 dias
    select 'escalada'::text as tipo, h.id::text as clave, h.id as entidad_id, h.organization_id, h.property_id, h.solicitada_at as desde,
           greatest(0, floor(extract(epoch from (p_ahora - h.solicitada_at)) / 60))::integer as minutos
    from restaurantes.conversation_handoff h
    join restaurantes.alerta_sucursal_config c on c.property_id = h.property_id and c.organization_id = h.organization_id and c.activa
    where h.estado = 'pendiente' and h.solicitada_at > p_ahora - interval '2 days' and h.solicitada_at <= p_ahora
    union all
    -- (b) esa misma toma sigue sin atenderse pasados N minutos
    select 'sin_respuesta'::text, 'h:' || h.id::text, h.id, h.organization_id, h.property_id, h.solicitada_at,
           greatest(0, floor(extract(epoch from (p_ahora - h.solicitada_at)) / 60))::integer
    from restaurantes.conversation_handoff h
    join restaurantes.alerta_sucursal_config c on c.property_id = h.property_id and c.organization_id = h.organization_id and c.activa
    where h.estado = 'pendiente' and h.solicitada_at > p_ahora - interval '2 days'
      and h.solicitada_at <= p_ahora - make_interval(mins => c.minutos_sin_respuesta)
    union all
    -- (c) el ULTIMO mensaje del hilo es del cliente y nadie (ni el agente ni una persona) contesto en N minutos (dentro de su ventana de 24 h)
    select 'sin_respuesta'::text, 'c:' || w.id::text || ':' || to_char(w.updated_at at time zone 'UTC', 'YYYYMMDDHH24MISS'), w.id, w.organization_id, w.property_id, w.updated_at,
           greatest(0, floor(extract(epoch from (p_ahora - w.updated_at)) / 60))::integer
    from restaurantes.whatsapp_conversations w
    join restaurantes.alerta_sucursal_config c on c.property_id = w.property_id and c.organization_id = w.organization_id and c.activa
    where w.property_id is not null
      and jsonb_typeof(w.messages) = 'array' and jsonb_array_length(w.messages) > 0
      and (w.messages -> (jsonb_array_length(w.messages) - 1)) ->> 'role' = 'user'
      and w.updated_at <= p_ahora - make_interval(mins => c.minutos_sin_respuesta)
      and w.updated_at > p_ahora - interval '24 hours'
      and not exists (
        select 1 from restaurantes.conversation_handoff hh
        where hh.canal = 'whatsapp' and hh.conversation_id = w.id and hh.estado = 'pendiente'
      )
  ) x
  order by x.desde asc
  limit greatest(1, least(coalesce(p_limite, 50), 200));
end;
$$;
revoke all on function restaurantes.alertas_candidatas(timestamptz, integer) from public, anon;
grant execute on function restaurantes.alertas_candidatas(timestamptz, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Interruptor de emergencia unificado
-- ---------------------------------------------------------------------------
create table restaurantes.interruptor_emergencia (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- null = TODAS las sucursales de la organizacion
  property_id uuid references core.property(id) on delete cascade,
  apagado boolean not null default false,
  motivo text check (motivo is null or char_length(motivo) <= 300),
  actualizado_por uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now()
);
create unique index interruptor_emergencia_alcance_uidx
  on restaurantes.interruptor_emergencia (organization_id, coalesce(property_id, '00000000-0000-0000-0000-000000000000'::uuid));

alter table restaurantes.interruptor_emergencia enable row level security;
create policy "miembro o sistema lee el interruptor de emergencia" on restaurantes.interruptor_emergencia for select
  using (
    auth.uid() is null
    or exists (
      select 1 from core.membership m
      where m.organization_id = interruptor_emergencia.organization_id and m.user_id = auth.uid()
    )
  );
revoke all on restaurantes.interruptor_emergencia from public, anon, authenticated;
grant select on restaurantes.interruptor_emergencia to authenticated;
grant select, insert, update, delete on restaurantes.interruptor_emergencia to service_role;

create table restaurantes.interruptor_emergencia_historial (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid references core.property(id) on delete cascade,
  apagado boolean not null,
  motivo text check (motivo is null or char_length(motivo) <= 300),
  actor_id uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
create index interruptor_emergencia_historial_idx on restaurantes.interruptor_emergencia_historial (organization_id, created_at desc);
alter table restaurantes.interruptor_emergencia_historial enable row level security;
create policy "gestor lee el historial del interruptor" on restaurantes.interruptor_emergencia_historial for select
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = interruptor_emergencia_historial.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );
revoke all on restaurantes.interruptor_emergencia_historial from public, anon, authenticated;
grant select on restaurantes.interruptor_emergencia_historial to authenticated, service_role;

create or replace function restaurantes.interruptor_fijar(
  p_organization_id uuid,
  p_property_id uuid,
  p_apagado boolean,
  p_motivo text
) returns boolean
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_motivo text := nullif(btrim(p_motivo), '');
  v_previo boolean;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'interruptor_fijar: requiere usuario' using errcode = '42501';
  end if;
  if p_apagado is null then
    raise exception 'interruptor_fijar: apagado requerido' using errcode = '22023';
  end if;
  if v_motivo is not null and char_length(v_motivo) > 300 then
    raise exception 'interruptor_fijar: motivo demasiado largo' using errcode = '22023';
  end if;
  if p_property_id is null then
    -- Interruptor de TODA la organizacion: owner/admin sin acotar a sucursales.
    if not exists (
      select 1 from core.membership m
      where m.user_id = v_uid and m.organization_id = p_organization_id and m.vertical_role in ('owner', 'admin') and m.property_ids is null
    ) then
      raise exception 'interruptor_fijar: sin acceso a la organizacion' using errcode = '42501';
    end if;
  elsif not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, true) then
    raise exception 'interruptor_fijar: sin acceso a la sucursal' using errcode = '42501';
  end if;

  select i.id, i.apagado into v_id, v_previo from restaurantes.interruptor_emergencia i
    where i.organization_id = p_organization_id and i.property_id is not distinct from p_property_id
    for update;
  if v_id is null then
    insert into restaurantes.interruptor_emergencia (organization_id, property_id, apagado, motivo, actualizado_por)
    values (p_organization_id, p_property_id, p_apagado, v_motivo, v_uid);
    v_previo := false;
  else
    update restaurantes.interruptor_emergencia
       set apagado = p_apagado, motivo = v_motivo, actualizado_por = v_uid, updated_at = now()
     where id = v_id;
  end if;
  insert into restaurantes.interruptor_emergencia_historial (organization_id, property_id, apagado, motivo, actor_id)
  values (p_organization_id, p_property_id, p_apagado, v_motivo, v_uid);
  return coalesce(v_previo, false); -- el valor ANTERIOR: la ruta avisa solo cuando cambia
end;
$$;
revoke all on function restaurantes.interruptor_fijar(uuid, uuid, boolean, text) from public, anon;
grant execute on function restaurantes.interruptor_fijar(uuid, uuid, boolean, text) to authenticated;

create or replace function restaurantes.interruptor_apagado(p_organization_id uuid, p_property_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null and not exists (
    select 1 from core.membership m where m.organization_id = p_organization_id and m.user_id = auth.uid()
  ) then
    raise exception 'interruptor_apagado: sin acceso a la organizacion' using errcode = '42501';
  end if;
  return exists (
    select 1 from restaurantes.interruptor_emergencia i
    where i.organization_id = p_organization_id and i.apagado and (i.property_id is null or i.property_id = p_property_id)
  );
end;
$$;
revoke all on function restaurantes.interruptor_apagado(uuid, uuid) from public, anon;
grant execute on function restaurantes.interruptor_apagado(uuid, uuid) to authenticated;

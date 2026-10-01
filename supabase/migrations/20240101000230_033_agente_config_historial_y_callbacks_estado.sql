-- R-10 (editor del agente de WhatsApp) + R-12 (bandeja de callbacks con estado/asignacion/SLA) de restaurantes.
-- Prefijo de supabase/migrations asignado para esta tanda: 20240101000230 (interno 033).
--
-- Decision de diseno: SOLO agrega columnas opcionales, una tabla de historial NUEVA y funciones NUEVAS (mas un
-- `create or replace` de `callback_registrar_intento`, misma firma). Nada se borra ni se renombra. El codigo
-- TypeScript que lee/escribe estas columnas degrada con SAVEPOINT al comportamiento anterior (029/028) cuando la
-- base todavia no tiene esta migracion (SQLSTATE 42703/42P01/42883/42501): nada de esto se aplica al mergear.
--
-- ===== PARTE A -- R-10: editor del agente de WhatsApp =====
--
-- El prompt del agente vive en el codigo (versionado y probado). Aqui solo se guardan los textos cortos que el
-- negocio puede cambiar sin tocar las reglas duras: saludo, salsas incluidas, promociones listadas y los motivos
-- de escalacion que se DESACTIVAN. Los motivos de seguridad (queja, alergia, cliente lo pide, falla, etc.) no
-- caben en la lista de desactivables por CHECK: ni un owner ni SQL directo pueden apagarlos.
--
-- Justificacion de seguridad de cada cambio (uno por uno):
--  * Columnas nuevas de `whatsapp_agent_config`: se amplian los GRANT por COLUMNA de INSERT/UPDATE a SOLO esas
--    columnas (+ `version`). Las policies de 029 (owner/admin) siguen siendo las que protegen la escritura; los
--    CHECK acotan la longitud del texto que termina dentro del prompt (superficie de texto libre minima).
--  * `whatsapp_agent_config_history`: append-only. RLS habilitado, `revoke all ... from public, anon, authenticated`
--    y despues SELECT + INSERT por columna solo para `authenticated`; NO hay GRANT ni policy de UPDATE/DELETE
--    (deny-by-default: el historial no se reescribe). SELECT e INSERT solo owner/admin de la organizacion (la
--    personalidad del agente es mas sensible que precios). El `with check` del INSERT exige `actor_id = auth.uid()`
--    (nadie firma un cambio como otro usuario) y que `property_id`, si existe, pertenezca a la organizacion
--    declarada (cross-tenant). `anon` sin ningun privilegio. `service_role` solo SELECT/INSERT.
--  * Indices unicos (organizacion[, sucursal], version): dos escrituras concurrentes con la misma version no
--    pueden convivir (la segunda recibe 23505 y el codigo la devuelve como conflicto).
alter table restaurantes.whatsapp_agent_config
  add column greeting_text text check (greeting_text is null or char_length(greeting_text) between 1 and 80),
  add column salsas_text text check (salsas_text is null or char_length(salsas_text) between 1 and 300),
  add column promos_text text check (promos_text is null or char_length(promos_text) between 1 and 300),
  add column escalation_reasons_off text[] not null default '{}'
    check (escalation_reasons_off <@ array['pedido_grande', 'zona_ambigua', 'producto_agotado', 'no_entiende']::text[]),
  add column version integer not null default 1 check (version >= 1);

grant insert (greeting_text, salsas_text, promos_text, escalation_reasons_off, version) on restaurantes.whatsapp_agent_config to authenticated;
grant update (greeting_text, salsas_text, promos_text, escalation_reasons_off, version) on restaurantes.whatsapp_agent_config to authenticated;

create table restaurantes.whatsapp_agent_config_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid references core.property(id) on delete cascade,
  version integer not null check (version >= 1),
  accion text not null check (accion in ('actualizado', 'restablecido')),
  -- Foto de los campos editables antes y despues del cambio (sin PII: solo los textos de configuracion).
  anterior jsonb,
  nuevo jsonb not null,
  actor_id uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index whatsapp_agent_config_history_org_uidx on restaurantes.whatsapp_agent_config_history (organization_id, version) where property_id is null;
create unique index whatsapp_agent_config_history_property_uidx on restaurantes.whatsapp_agent_config_history (organization_id, property_id, version) where property_id is not null;
create index whatsapp_agent_config_history_lookup_idx on restaurantes.whatsapp_agent_config_history (organization_id, property_id, created_at desc);

alter table restaurantes.whatsapp_agent_config_history enable row level security;

create policy "owner/admin lee el historial del agente de whatsapp" on restaurantes.whatsapp_agent_config_history for select
  using (
    exists (
      select 1 from core.membership m
      where m.organization_id = whatsapp_agent_config_history.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
  );

create policy "owner/admin registra el historial del agente de whatsapp" on restaurantes.whatsapp_agent_config_history for insert
  with check (
    whatsapp_agent_config_history.actor_id = auth.uid()
    and exists (
      select 1 from core.membership m
      where m.organization_id = whatsapp_agent_config_history.organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
    and (
      whatsapp_agent_config_history.property_id is null
      or exists (
        select 1 from core.property p
        where p.id = whatsapp_agent_config_history.property_id and p.organization_id = whatsapp_agent_config_history.organization_id
      )
    )
  );

revoke all on restaurantes.whatsapp_agent_config_history from public, anon, authenticated;
grant select on restaurantes.whatsapp_agent_config_history to authenticated;
grant insert (organization_id, property_id, version, accion, anterior, nuevo, actor_id) on restaurantes.whatsapp_agent_config_history to authenticated;
grant select, insert on restaurantes.whatsapp_agent_config_history to service_role;

-- ===== PARTE B -- R-12: callbacks con estado, asignacion y SLA =====
--
-- La bandeja de callbacks YA existe (028: `callbacks_sucursal`, `callback_registrar_intento`, pestana
-- "Callbacks" de Conversaciones). Esta parte solo agrega el estado de trabajo (nuevo / en_curso / resuelto) y la
-- asignacion; el SLA se calcula en el dominio a partir de `created_at`/`taken_at`/`resolved_at` (sin columna).
--
-- Justificacion de seguridad:
--  * Columnas nuevas de `callback_requests`: SIN GRANT nuevo. `authenticated` sigue con SELECT (policy de 001) y
--    ninguna escritura directa: toda mutacion pasa por funciones `security definer` (deny-by-default).
--  * trigger `callback_requests_sync_status`: mantiene `resolved` (columna historica que otras funciones y la
--    lectura de 028 usan) coherente con `status`; no es definer y no concede nada.
--  * callback_actualizar -- `security definer`, `set search_path` fijo, `revoke ... from public, anon`. Exige
--    `auth.uid()` no nulo y `handoff_actor_en_sucursal` (mismo umbral que registrar un intento: owner/admin/staff
--    con alcance a la sucursal; el repartidor nunca). Bloquea la fila `for update` y la busca por
--    (id, organizacion): un id de otra organizacion responde 42501 igual que uno inexistente (no sondea). Asignar
--    a OTRA persona, liberar la de otro y reabrir son solo de owner/admin; la persona asignada debe tener
--    membership en la MISMA organizacion con acceso a la sucursal (`turno_miembro_valido`: sin esto un owner
--    podria asignar a un usuario de otra organizacion). Tomar una ya tomada por otra persona da 55006 (no pisa).
--  * callbacks_sucursal_estado -- lectura `security definer` con la misma regla de acceso que `callbacks_sucursal`.
--    Solo devuelve nombres del personal (full_name) de la misma organizacion; sin telefonos de terceros nuevos.
alter table restaurantes.callback_requests
  add column status text not null default 'nuevo' check (status in ('nuevo', 'en_curso', 'resuelto')),
  add column assigned_to uuid references core.staff_user(id) on delete set null,
  add column assigned_at timestamptz,
  add column taken_at timestamptz,
  add column resolved_at timestamptz,
  add column resolved_by uuid references core.staff_user(id) on delete set null,
  add column resolution_note text check (resolution_note is null or char_length(resolution_note) <= 1000);

-- Los ya resueltos conservan su estado (resolved_at queda null: no se inventa una hora que no se guardo).
update restaurantes.callback_requests set status = 'resuelto' where resolved = true;

create index callback_requests_estado_idx on restaurantes.callback_requests (organization_id, property_id, status, created_at);

create or replace function restaurantes.callback_requests_sync_status() returns trigger
language plpgsql
set search_path = pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.resolved then new.status := 'resuelto'; end if;
  elsif new.status is not distinct from old.status and new.resolved is distinct from old.resolved then
    -- Escritor historico que solo cambio `resolved`: se traduce al estado.
    new.status := case when new.resolved then 'resuelto' else 'nuevo' end;
  end if;
  if new.status = 'resuelto' then
    new.resolved_at := coalesce(new.resolved_at, now());
  end if;
  new.resolved := (new.status = 'resuelto');
  return new;
end;
$$;

create trigger callback_requests_sync_status
  before insert or update on restaurantes.callback_requests
  for each row execute function restaurantes.callback_requests_sync_status();

-- Mismo cuerpo que 028; ademas mueve el estado: contactado / numero invalido resuelven, cualquier otro
-- resultado pasa un callback `nuevo` a `en_curso` y lo deja asignado a quien lo intento.
create or replace function restaurantes.callback_registrar_intento(
  p_organization_id uuid,
  p_callback_id uuid,
  p_resultado text,
  p_nota text,
  p_proximo_intento_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_cb restaurantes.callback_requests;
  v_id uuid;
begin
  select * into v_cb from restaurantes.callback_requests cb
    where cb.id = p_callback_id and cb.organization_id = p_organization_id for update;
  if not found or auth.uid() is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, v_cb.property_id, false) then
    raise exception 'callback_registrar_intento: inexistente o sin acceso' using errcode = '42501';
  end if;
  insert into restaurantes.callback_attempt (organization_id, property_id, callback_request_id, resultado, nota, proximo_intento_at, autor_id)
    values (p_organization_id, v_cb.property_id, p_callback_id, p_resultado, nullif(btrim(coalesce(p_nota, '')), ''), p_proximo_intento_at, auth.uid())
    returning id into v_id;
  if p_resultado in ('contactado', 'numero_invalido') then
    update restaurantes.callback_requests
      set status = 'resuelto', resolved_by = auth.uid(), resolved_at = coalesce(resolved_at, now()),
          taken_at = coalesce(taken_at, now()), assigned_to = coalesce(assigned_to, auth.uid()), assigned_at = coalesce(assigned_at, now())
      where id = p_callback_id;
  elsif v_cb.status = 'nuevo' then
    update restaurantes.callback_requests
      set status = 'en_curso', taken_at = coalesce(taken_at, now()), assigned_to = coalesce(assigned_to, auth.uid()), assigned_at = coalesce(assigned_at, now())
      where id = p_callback_id;
  end if;
  return v_id;
end;
$$;

create or replace function restaurantes.callback_actualizar(
  p_organization_id uuid,
  p_callback_id uuid,
  p_accion text,
  p_asignado_a uuid,
  p_nota text
) returns text
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_cb restaurantes.callback_requests;
  v_uid uuid := auth.uid();
  v_gestor boolean;
begin
  select * into v_cb from restaurantes.callback_requests cb
    where cb.id = p_callback_id and cb.organization_id = p_organization_id for update;
  if not found or v_uid is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, v_cb.property_id, false) then
    raise exception 'callback_actualizar: inexistente o sin acceso' using errcode = '42501';
  end if;
  v_gestor := restaurantes.handoff_actor_en_sucursal(p_organization_id, v_cb.property_id, true);

  if p_accion = 'tomar' then
    if v_cb.status = 'resuelto' then
      raise exception 'callback_actualizar: ya esta resuelto' using errcode = '55000';
    end if;
    if v_cb.assigned_to is not null and v_cb.assigned_to <> v_uid then
      raise exception 'callback_actualizar: ya lo tiene otra persona' using errcode = '55006';
    end if;
    update restaurantes.callback_requests
      set status = 'en_curso', assigned_to = v_uid, assigned_at = coalesce(assigned_at, now()), taken_at = coalesce(taken_at, now())
      where id = p_callback_id;
  elsif p_accion = 'asignar' then
    if not v_gestor then
      raise exception 'callback_actualizar: asignar es de owner/admin' using errcode = '42501';
    end if;
    if v_cb.status = 'resuelto' then
      raise exception 'callback_actualizar: ya esta resuelto' using errcode = '55000';
    end if;
    if p_asignado_a is null or not restaurantes.turno_miembro_valido(p_organization_id, v_cb.property_id, p_asignado_a) then
      raise exception 'callback_actualizar: la persona asignada no pertenece a esta sucursal' using errcode = '42501';
    end if;
    update restaurantes.callback_requests
      set status = 'en_curso', assigned_to = p_asignado_a, assigned_at = now(), taken_at = coalesce(taken_at, now())
      where id = p_callback_id;
  elsif p_accion = 'liberar' then
    if v_cb.status = 'resuelto' then
      raise exception 'callback_actualizar: ya esta resuelto' using errcode = '55000';
    end if;
    if v_cb.assigned_to is distinct from v_uid and not v_gestor then
      raise exception 'callback_actualizar: solo quien lo tiene (u owner/admin) lo libera' using errcode = '42501';
    end if;
    update restaurantes.callback_requests
      set status = 'nuevo', assigned_to = null, assigned_at = null
      where id = p_callback_id;
  elsif p_accion = 'resolver' then
    if v_cb.status = 'resuelto' then
      raise exception 'callback_actualizar: ya esta resuelto' using errcode = '55000';
    end if;
    if v_cb.assigned_to is not null and v_cb.assigned_to <> v_uid and not v_gestor then
      raise exception 'callback_actualizar: lo tiene otra persona' using errcode = '55006';
    end if;
    update restaurantes.callback_requests
      set status = 'resuelto', resolved_by = v_uid, resolved_at = now(),
          resolution_note = nullif(btrim(coalesce(p_nota, '')), ''),
          taken_at = coalesce(taken_at, now()), assigned_to = coalesce(assigned_to, v_uid), assigned_at = coalesce(assigned_at, now())
      where id = p_callback_id;
  elsif p_accion = 'reabrir' then
    if not v_gestor then
      raise exception 'callback_actualizar: reabrir es de owner/admin' using errcode = '42501';
    end if;
    if v_cb.status <> 'resuelto' then
      raise exception 'callback_actualizar: no esta resuelto' using errcode = '55000';
    end if;
    update restaurantes.callback_requests
      set status = 'nuevo', resolved_by = null, resolved_at = null, resolution_note = null, assigned_to = null, assigned_at = null, taken_at = null
      where id = p_callback_id;
  else
    raise exception 'callback_actualizar: accion invalida' using errcode = '22023';
  end if;
  return (select cb.status from restaurantes.callback_requests cb where cb.id = p_callback_id);
end;
$$;

create or replace function restaurantes.callbacks_sucursal_estado(
  p_organization_id uuid,
  p_property_id uuid,
  p_solo_abiertos boolean,
  p_limit integer
) returns table (
  id uuid, property_id uuid, customer_name text, customer_phone text, reason text, message text,
  source text, resolved boolean, created_at timestamptz, intentos jsonb,
  status text, assigned_to uuid, assigned_to_nombre text, assigned_at timestamptz, taken_at timestamptz,
  resolved_at timestamptz, resolved_by_nombre text, resolution_note text
)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, false) then
    raise exception 'callbacks_sucursal_estado: sin acceso a la sucursal' using errcode = '42501';
  end if;
  return query
  select cb.id, cb.property_id, cb.customer_name, cb.customer_phone, cb.reason, cb.message, cb.source, cb.resolved, cb.created_at,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'id', a.id, 'resultado', a.resultado, 'nota', a.nota, 'proximoIntentoAt', a.proximo_intento_at,
                    'autor', (select su.full_name from core.staff_user su where su.id = a.autor_id), 'creadoAt', a.created_at
                  ) order by a.created_at desc)
             from restaurantes.callback_attempt a where a.callback_request_id = cb.id
         ), '[]'::jsonb),
         cb.status, cb.assigned_to, (select su.full_name from core.staff_user su where su.id = cb.assigned_to),
         cb.assigned_at, cb.taken_at, cb.resolved_at, (select su.full_name from core.staff_user su where su.id = cb.resolved_by), cb.resolution_note
    from restaurantes.callback_requests cb
    where cb.organization_id = p_organization_id
      and (cb.property_id = p_property_id or (cb.property_id is null and restaurantes.handoff_actor_en_sucursal(p_organization_id, null, false)))
      and (not coalesce(p_solo_abiertos, false) or cb.status <> 'resuelto')
    order by (cb.status = 'resuelto'), cb.created_at, cb.id
    limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

revoke all on function restaurantes.callback_actualizar(uuid, uuid, text, uuid, text) from public, anon;
revoke all on function restaurantes.callbacks_sucursal_estado(uuid, uuid, boolean, integer) from public, anon;
grant execute on function restaurantes.callback_actualizar(uuid, uuid, text, uuid, text) to authenticated, service_role;
grant execute on function restaurantes.callbacks_sucursal_estado(uuid, uuid, boolean, integer) to authenticated, service_role;

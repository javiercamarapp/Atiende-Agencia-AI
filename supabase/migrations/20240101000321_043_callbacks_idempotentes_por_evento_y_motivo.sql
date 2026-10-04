-- rescate-orig-restaurantes-1 §2 (X37, T-HO10): el aviso al equipo (`escalar_a_humano` / `registrar_contacto`, WhatsApp y voz) es
-- IDEMPOTENTE por mensaje y por motivo. Antes cada mensaje repetido creaba otro `callback_requests`: Meta reenvia el mismo id (entrega
-- at-least-once) y el cliente insiste ("quiero hablar con una persona" x3) y la bandeja se llenaba de duplicados del mismo caso.
--
-- Diseno (todo ADITIVO; nada existente cambia ni se renombra):
--   * `callback_requests.source_event_id`: id del mensaje de Meta o de la llamada (+ motivo) que origino el aviso. Indice UNICO PARCIAL
--     (organization_id, source_event_id): el mismo evento nunca crea dos avisos, ni con dos reintentos concurrentes (el INSERT ... ON
--     CONFLICT DO NOTHING lo resuelve en la base, no en el codigo).
--   * Dedupe por (organizacion, canal, telefono, motivo) mientras haya un aviso ABIERTO (`status` nuevo o en_curso; la 033 no tiene
--     `pendiente`/`tomada`, esos son los estados del handoff de conversaciones) creado en la ventana (por defecto 2 h): el segundo aviso
--     agrega una nota al existente (`message` + `avisos_repetidos`) en vez de crear otro. Dos motivos distintos son dos avisos.
--   * `eventos_agrupados`: ids de los eventos que ya se agregaron como nota, para que un reenvio de ese mismo evento no repita la nota.
--   * `callback_registrar_agente(...)`: UNICA via de escritura del agente con estas reglas.
--
-- Justificacion de seguridad (cada columna, indice y funcion):
--  * Columnas e indices nuevos: SIN GRANT nuevo. `authenticated` conserva solo SELECT por la policy de 001 (staff de la organizacion;
--    los ids de evento y las notas viven en filas que ya ve) y ninguna escritura directa; `anon` no tiene acceso a la tabla.
--    `source_event_id` es un identificador opaco (id del mensaje / llamada), sin telefono ni texto del cliente.
--  * callback_registrar_agente -- `security definer` con `set search_path` fijo. Es de SOLO SISTEMA: exige `auth.uid() is null`
--    (el agente corre sin usuario); un staff autenticado recibe 42501 y no puede inyectar avisos a nombre del agente. Valida que la
--    sucursal pertenezca a la organizacion declarada (cross-tenant -> 42501) y que el canal sea `voice` o `whatsapp`. Serializa los
--    avisos del mismo (organizacion, canal, telefono, motivo) con un advisory lock transaccional, de modo que dos mensajes simultaneos no
--    creen dos avisos. `revoke ... from public, anon`; EXECUTE a `authenticated`/`service_role` igual que `handoff_solicitar` (028): la
--    sesion de sistema es la que la llama y la propia funcion rechaza a quien tenga `auth.uid()`.
--  * El texto que se agrega a `message` es el resumen que el agente ya guardaba (tope de 500 por nota y de 4000 en total): nada nuevo
--    sobre el cliente se persiste.
alter table restaurantes.callback_requests
  add column source_event_id text check (source_event_id is null or char_length(source_event_id) between 1 and 255),
  add column eventos_agrupados text[] not null default '{}',
  add column avisos_repetidos integer not null default 0 check (avisos_repetidos >= 0);

create unique index callback_requests_source_event_uidx
  on restaurantes.callback_requests (organization_id, source_event_id)
  where source_event_id is not null;

create index callback_requests_abiertos_telefono_idx
  on restaurantes.callback_requests (organization_id, customer_phone, created_at desc)
  where status in ('nuevo', 'en_curso');

create or replace function restaurantes.callback_registrar_agente(
  p_organization_id uuid,
  p_property_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_reason text,
  p_message text,
  p_source text,
  p_source_event_id text,
  p_ventana_minutos integer default 120
) returns table (callback_id uuid, resuelto boolean, creado_at timestamptz, registro text)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_cb restaurantes.callback_requests;
  v_nota text;
begin
  if auth.uid() is not null then
    raise exception 'callback_registrar_agente es solo de sistema' using errcode = '42501';
  end if;
  if p_source is null or p_source not in ('voice', 'whatsapp') then
    raise exception 'callback_registrar_agente: canal invalido' using errcode = '22023';
  end if;
  if p_ventana_minutos is null or p_ventana_minutos < 1 or p_ventana_minutos > 1440 then
    raise exception 'callback_registrar_agente: ventana invalida' using errcode = '22023';
  end if;
  if p_property_id is not null
     and not exists (select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id) then
    raise exception 'callback_registrar_agente: la sucursal no pertenece a la organizacion' using errcode = '42501';
  end if;

  -- Un solo aviso a la vez por (organizacion, canal, telefono, motivo): sin esto dos mensajes simultaneos podrian ver "no hay abierto".
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text || '|' || p_source || '|' || p_customer_phone || '|' || coalesce(p_reason, ''), 0));

  -- 1) El MISMO evento (id de mensaje / llamada) ya registrado, como aviso propio o agregado como nota: no se repite nada.
  if p_source_event_id is not null then
    select * into v_cb from restaurantes.callback_requests cb
      where cb.organization_id = p_organization_id and cb.customer_phone = p_customer_phone
        and (cb.source_event_id = p_source_event_id or p_source_event_id = any (cb.eventos_agrupados))
      limit 1;
    if found then
      return query select v_cb.id, v_cb.resolved, v_cb.created_at, 'evento_repetido'::text;
      return;
    end if;
  end if;

  -- 2) Mismo canal, telefono y motivo con un aviso ABIERTO reciente: se agrega una nota al existente.
  select * into v_cb from restaurantes.callback_requests cb
    where cb.organization_id = p_organization_id and cb.source = p_source and cb.customer_phone = p_customer_phone
      and cb.reason is not distinct from p_reason
      and cb.status in ('nuevo', 'en_curso')
      and cb.created_at > now() - make_interval(mins => p_ventana_minutos)
    order by cb.created_at desc
    limit 1
    for update;
  if found then
    v_nota := E'\n— Aviso repetido (' || to_char(now() at time zone 'America/Merida', 'DD/MM HH24:MI') || '): '
              || left(coalesce(nullif(btrim(p_message), ''), 'sin detalle'), 500);
    update restaurantes.callback_requests cb
      set avisos_repetidos = cb.avisos_repetidos + 1,
          message = case when char_length(coalesce(cb.message, '')) + char_length(v_nota) <= 4000 then coalesce(cb.message, '') || v_nota else cb.message end,
          eventos_agrupados = case when p_source_event_id is null then cb.eventos_agrupados else array_append(cb.eventos_agrupados, p_source_event_id) end
      where cb.id = v_cb.id
      returning * into v_cb;
    return query select v_cb.id, v_cb.resolved, v_cb.created_at, 'nota_agregada'::text;
    return;
  end if;

  -- 3) Aviso nuevo. El indice unico parcial es la red de seguridad si dos eventos iguales llegaran por rutas distintas a la vez.
  insert into restaurantes.callback_requests (organization_id, property_id, customer_name, customer_phone, reason, message, source, source_event_id)
    values (p_organization_id, p_property_id, p_customer_name, p_customer_phone, p_reason, p_message, p_source, p_source_event_id)
    on conflict (organization_id, source_event_id) where source_event_id is not null do nothing
    returning * into v_cb;
  if v_cb.id is null then
    select * into v_cb from restaurantes.callback_requests cb
      where cb.organization_id = p_organization_id and cb.source_event_id = p_source_event_id;
    return query select v_cb.id, v_cb.resolved, v_cb.created_at, 'evento_repetido'::text;
    return;
  end if;
  return query select v_cb.id, v_cb.resolved, v_cb.created_at, 'nuevo'::text;
end;
$$;

revoke all on function restaurantes.callback_registrar_agente(uuid, uuid, text, text, text, text, text, text, integer) from public, anon;
grant execute on function restaurantes.callback_registrar_agente(uuid, uuid, text, text, text, text, text, text, integer) to authenticated, service_role;

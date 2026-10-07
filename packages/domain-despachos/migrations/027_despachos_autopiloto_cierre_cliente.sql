-- paridad3 D-31 + D-P3-19 + D-P3-15 + D-P3-21 -- documentos pedidos al cliente, estatus SAT a escala, cierre mensual en piloto
-- automatico y entrega de reportes al cliente.
--
-- Modelo:
--   * `invoice` (ALTER)                  -- 4 columnas nuevas (todas nullable) con lo que el SAT responde y antes se descartaba:
--                                           `es_cancelable`, `estatus_cancelacion` ("En proceso" = el receptor tiene 72 h para
--                                           aceptar), `codigo_estatus` y `validacion_efos`.
--   * `cliente_automatizacion`           -- una fila por cliente: correo de contacto (NO existia en ningun lado), opt-in de envio de
--                                           reportes al cerrar (apagado por omision), dia de la solicitud mensual y plantilla.
--   * `solicitud_documentos` + `_renglon` -- checklist por cliente y periodo (estados de cuenta por cuenta, XML emitidos/recibidos,
--                                           nomina, otros). Un renglon queda `recibido` cuando el staff acepta el documento que el
--                                           cliente subio al portal para ese renglon.
--   * `periodo_cierre` (ALTER)           -- cierre forzado: bandera + motivo (el motivo vive aqui y no en la bitacora).
--   * `cierre_entrega` + `_archivo`      -- PDF de impuestos, DIOT y balanza generados al cerrar y publicados en el portal.
--
-- Seguridad (cada punto lo ejerce scripts/verify-despachos-autopiloto-cierre-cliente/assertions.sql):
--   1. Tablas nuevas: RLS habilitado, REVOKE de todo a public/anon/authenticated y despues SOLO `select` a `authenticated` con
--      policy `core.has_property_access(auth.uid(), property_id)` -- el staff lista lo de SUS clientes y nada mas. Ninguna escritura
--      directa (ni insert/update/delete a nadie): todo cambio pasa por funciones definer. `cierre_entrega_archivo.contenido` (bytea)
--      queda fuera del GRANT de columnas. No hay `using (true)` ni GRANT a anon.
--   2. Funciones de STAFF (`invoice_estado_sat_detalle_registrar`, `cliente_automatizacion_guardar`, `solicitud_*`, `cierre_entrega_*`, `periodo_cierre_forzar`): security
--      definer con `set search_path` fijo, `revoke ... from public, anon`, EXECUTE solo a `authenticated`. Exigen `auth.uid()` no nulo
--      y `despachos.cartera_puede_escribir(property)` (acceso a la property + rol admin/contador de ESA organizacion); la property
--      debe ser de vertical despachos. Una property o un renglon ajeno responde 42501/P0002 sin confirmar que existe.
--   3. Funciones de SOLO SISTEMA (`system_*`): exigen `auth.uid() is null` (42501 si no), EXECUTE solo a `authenticated` (la sesion
--      de sistema de los crons usa ese rol sin claim `sub`; mismo patron que 014, 020 y 022). Un staff autenticado NO puede
--      invocarlas. Devuelven solo lo que el job necesita (ids, conteos, el correo de contacto para el outbox) y topes duros de filas.
--   4. `cierre_estado_modulos`: definer, admite sesion de sistema o staff con acceso a la property; devuelve solo agregados
--      numericos (sin RFC, nombres ni montos por CFDI). Es la unica fuente del estado de los modulos: el cliente HTTP ya no lo manda.
--   5. Portal (`portal_cliente_solicitudes`, `portal_cliente_solicitud_vincular`, `portal_cliente_reportes`,
--      `portal_cliente_reporte_contenido`): SOLO SISTEMA, reciben el HASH del token, validan enlace vigente con
--      `portal_cliente_enlace_resolver` y derivan la property de ahi; un token invalido produce el mismo error (P0002
--      `enlace_no_valido`). El cliente solo puede vincular un documento SUYO (subido por ese mismo enlace) a un renglon de SU property.
--   6. Trigger `portal_cliente_documento_marca_renglon`: definer, solo reacciona al cambio de `estado` de un documento ya
--      vinculado; no abre ninguna superficie nueva (los privilegios del trigger son los de su dueno, fijos).
--   7. Correo de contacto: dato personal. Solo lo leen el staff de la property (select) y el job de sistema para encolar el correo;
--      nunca se escribe en notificaciones, bitacora ni logs. Los PDF de entrega solo salen por el portal con token vigente.
--
-- Compatibilidad con la base sin migrar: el TypeScript que consume esto captura 42883/42P01/42703 dentro de SAVEPOINT
-- (runWithSavepointFallback) y cae al camino anterior (barrido SAT de 2 argumentos, cierre sin validaciones derivadas, solicitudes y
-- entrega "no disponibles aun"); nunca un 500. Se puede aplicar antes o despues del codigo.

-- ---------------------------------------------------------------------------
-- D-P3-19 -- columnas de cancelacion SAT.
-- ---------------------------------------------------------------------------
alter table despachos.invoice
  add column if not exists es_cancelable text check (es_cancelable is null or char_length(es_cancelable) <= 80),
  add column if not exists estatus_cancelacion text check (estatus_cancelacion is null or char_length(estatus_cancelacion) <= 80),
  add column if not exists codigo_estatus text check (codigo_estatus is null or char_length(codigo_estatus) <= 200),
  add column if not exists validacion_efos text check (validacion_efos is null or char_length(validacion_efos) <= 80);
create index if not exists invoice_estatus_cancelacion_idx on despachos.invoice (estado_sat_intentado_en) where estatus_cancelacion is not null and estado_sat <> 'cancelado';

-- Barrido diario priorizado y con tope por property. Prioridad: 0 nunca consultados, 1 cancelacion "En proceso" (se reconsulta cada
-- ~20 h hasta que se resuelva), 2 recientes (90 dias), 3 vigentes dentro de la ventana de ejercicios (el en curso y los anteriores).
-- Fuera de la ventana solo se consulta lo que nunca se consulto: despues ya no se reconsulta (salvo a pedido por la ruta de staff).
create or replace function despachos.system_cfdi_pendientes_estatus_sat(p_limit integer, p_reintento_dias integer, p_ventana_ejercicios integer, p_por_property integer)
returns table (
  out_invoice_id uuid,
  out_organization_id uuid,
  out_property_id uuid,
  out_folio_fiscal text,
  out_rfc_emisor text,
  out_rfc_receptor text,
  out_total numeric,
  out_estado_sat text,
  out_prioridad smallint
)
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_desde date;
begin
  if auth.uid() is not null then
    raise exception 'system_cfdi_pendientes_estatus_sat es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_reintento_dias is null or p_reintento_dias < 0 or p_reintento_dias > 365
     or p_ventana_ejercicios is null or p_ventana_ejercicios < 1 or p_ventana_ejercicios > 5
     or p_por_property is null or p_por_property < 1 or p_por_property > 500 then
    raise exception 'system_cfdi_pendientes_estatus_sat: límites o ventana inválidos' using errcode = '22023';
  end if;
  v_desde := make_date(extract(year from now())::int - (p_ventana_ejercicios - 1), 1, 1);
  return query
    with candidatos as (
      select i.id, i.organization_id, i.property_id, i.folio_fiscal::text as folio, i.rfc_emisor, i.rfc_receptor, i.total, i.estado_sat,
             i.estado_sat_intentado_en, i.created_at,
             (case
                when i.estado_sat_intentado_en is null then 0
                when i.estatus_cancelacion ilike 'en proceso%' then 1
                when i.fecha >= current_date - 90 then 2
                else 3
              end)::smallint as prio
      from despachos.invoice i
      join core.property p on p.id = i.property_id and p.status = 'active'
      where i.estado_sat <> 'cancelado'
        and (
          i.estado_sat_intentado_en is null
          or (i.estatus_cancelacion ilike 'en proceso%' and i.estado_sat_intentado_en < now() - interval '20 hours')
          or (i.fecha >= v_desde and i.estado_sat_intentado_en < now() - make_interval(days => p_reintento_dias))
        )
    ), ordenados as (
      select c.*, row_number() over (partition by c.property_id order by c.prio, coalesce(c.estado_sat_intentado_en, 'epoch'::timestamptz), c.created_at, c.id) as rn
      from candidatos c
    )
    select o.id, o.organization_id, o.property_id, o.folio, o.rfc_emisor, o.rfc_receptor, o.total, o.estado_sat, o.prio
    from ordenados o
    where o.rn <= p_por_property
    order by o.prio, coalesce(o.estado_sat_intentado_en, 'epoch'::timestamptz), o.created_at, o.id
    limit least(p_limit, 500);
end;
$$;
revoke all on function despachos.system_cfdi_pendientes_estatus_sat(integer, integer, integer, integer) from public, anon;
grant execute on function despachos.system_cfdi_pendientes_estatus_sat(integer, integer, integer, integer) to authenticated;

-- Registro de UNA consulta con el detalle de cancelacion. Mismas reglas que la version de 2 argumentos (022): 'cancelado' es
-- terminal; 'pendiente' (consulta que no concluyo) solo anota el intento y NUNCA pisa un estado ya verificado.
create or replace function despachos.system_cfdi_registrar_estatus_sat(p_invoice_id uuid, p_estado text, p_es_cancelable text, p_estatus_cancelacion text, p_codigo_estatus text, p_validacion_efos text)
returns table (
  out_organization_id uuid,
  out_property_id uuid,
  out_estado_anterior text,
  out_estado_nuevo text,
  out_cambio_a_cancelado boolean,
  out_cancelacion_en_proceso_nueva boolean
)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_prop uuid;
  v_actual text;
  v_cancel_prev text;
  v_nuevo text;
  v_es text := nullif(left(btrim(coalesce(p_es_cancelable, '')), 80), '');
  v_estatus text := nullif(left(btrim(coalesce(p_estatus_cancelacion, '')), 80), '');
  v_codigo text := nullif(left(btrim(coalesce(p_codigo_estatus, '')), 200), '');
  v_efos text := nullif(left(btrim(coalesce(p_validacion_efos, '')), 80), '');
  v_nueva boolean := false;
begin
  if auth.uid() is not null then
    raise exception 'system_cfdi_registrar_estatus_sat es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_estado is null or p_estado not in ('pendiente', 'vigente', 'cancelado', 'no_encontrado') then
    raise exception 'system_cfdi_registrar_estatus_sat: estado inválido' using errcode = '22023';
  end if;
  select i.organization_id, i.property_id, i.estado_sat, i.estatus_cancelacion into v_org, v_prop, v_actual, v_cancel_prev
    from despachos.invoice i where i.id = p_invoice_id for update;
  if v_actual is null then
    raise exception 'system_cfdi_registrar_estatus_sat: CFDI no encontrado' using errcode = 'P0002';
  end if;
  if p_estado = 'pendiente' or v_actual = 'cancelado' then
    update despachos.invoice set estado_sat_intentado_en = now() where id = p_invoice_id;
    v_nuevo := v_actual;
  else
    update despachos.invoice
       set estado_sat = p_estado, estado_sat_verificado_en = now(), estado_sat_intentado_en = now(),
           es_cancelable = v_es, estatus_cancelacion = v_estatus, codigo_estatus = v_codigo, validacion_efos = v_efos
     where id = p_invoice_id;
    v_nuevo := p_estado;
    v_nueva := v_estatus ilike 'en proceso%' and not coalesce(v_cancel_prev ilike 'en proceso%', false);
  end if;
  return query select v_org, v_prop, v_actual, v_nuevo, (v_actual <> 'cancelado' and v_nuevo = 'cancelado'), v_nueva;
end;
$$;
revoke all on function despachos.system_cfdi_registrar_estatus_sat(uuid, text, text, text, text, text) from public, anon;
grant execute on function despachos.system_cfdi_registrar_estatus_sat(uuid, text, text, text, text, text) to authenticated;

-- STAFF: verificacion manual de UN CFDI (boton «Verificar en el SAT») con el mismo detalle de cancelacion. Mismas reglas que
-- `invoice_estado_sat_registrar` (018): rol admin/contador + acceso a la property, el CFDI debe ser de esa property (P0002), un
-- CFDI cancelado no cambia de estado (22023). Devuelve si la cancelacion «En proceso» aparece por primera vez (para avisar una sola vez).
create or replace function despachos.invoice_estado_sat_detalle_registrar(
  p_property_id uuid, p_invoice_id uuid, p_estado text, p_es_cancelable text, p_estatus_cancelacion text, p_codigo_estatus text, p_validacion_efos text
)
returns table (out_cancelacion_en_proceso_nueva boolean)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_actual text;
  v_cancel_prev text;
  v_estatus text := nullif(left(btrim(coalesce(p_estatus_cancelacion, '')), 80), '');
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'invoice_estado_sat_detalle_registrar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  if p_estado is null or p_estado not in ('pendiente', 'vigente', 'cancelado', 'no_encontrado') then
    raise exception 'invoice_estado_sat_detalle_registrar: estado inválido' using errcode = '22023';
  end if;
  select i.estado_sat, i.estatus_cancelacion into v_actual, v_cancel_prev from despachos.invoice i where i.id = p_invoice_id and i.property_id = p_property_id for update;
  if v_actual is null then
    raise exception 'invoice_estado_sat_detalle_registrar: CFDI no encontrado' using errcode = 'P0002';
  end if;
  if v_actual = 'cancelado' and p_estado <> 'cancelado' then
    raise exception 'invoice_estado_sat_detalle_registrar: un CFDI cancelado no cambia de estado' using errcode = '22023';
  end if;
  update despachos.invoice
     set estado_sat = p_estado, estado_sat_verificado_en = now(), estado_sat_intentado_en = now(),
         es_cancelable = nullif(left(btrim(coalesce(p_es_cancelable, '')), 80), ''), estatus_cancelacion = v_estatus,
         codigo_estatus = nullif(left(btrim(coalesce(p_codigo_estatus, '')), 200), ''), validacion_efos = nullif(left(btrim(coalesce(p_validacion_efos, '')), 80), '')
   where id = p_invoice_id;
  return query select (v_estatus ilike 'en proceso%' and not coalesce(v_cancel_prev ilike 'en proceso%', false));
end;
$$;
revoke all on function despachos.invoice_estado_sat_detalle_registrar(uuid, uuid, text, text, text, text, text) from public, anon;
grant execute on function despachos.invoice_estado_sat_detalle_registrar(uuid, uuid, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Automatizacion por cliente: contacto, opt-in de entrega, dia y plantilla de la solicitud.
-- ---------------------------------------------------------------------------
create table despachos.cliente_automatizacion (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  contacto_correo text check (contacto_correo is null or (char_length(contacto_correo) <= 254 and contacto_correo ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')),
  envio_reportes_cierre boolean not null default false,
  solicitud_activa boolean not null default true,
  solicitud_dia smallint not null default 1 check (solicitud_dia between 1 and 28),
  plantilla jsonb not null default '{}'::jsonb check (jsonb_typeof(plantilla) = 'object' and octet_length(plantilla::text) <= 2048),
  actualizado_por uuid references core.staff_user(id) on delete set null,
  actualizado_en timestamptz not null default now(),
  check (not envio_reportes_cierre or contacto_correo is not null)
);
create index cliente_automatizacion_org_idx on despachos.cliente_automatizacion (organization_id);

alter table despachos.cliente_automatizacion enable row level security;
revoke all on despachos.cliente_automatizacion from public, anon, authenticated;
create policy "staff ve la automatizacion de sus clientes" on despachos.cliente_automatizacion for select
  using (core.has_property_access(auth.uid(), property_id));
grant select on despachos.cliente_automatizacion to authenticated;
grant select, insert, update, delete on despachos.cliente_automatizacion to service_role;

create or replace function despachos.cliente_automatizacion_guardar(
  p_property_id uuid,
  p_contacto_correo text,
  p_envio_reportes_cierre boolean,
  p_solicitud_activa boolean,
  p_solicitud_dia integer,
  p_plantilla jsonb
)
returns void
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_correo text := nullif(lower(btrim(coalesce(p_contacto_correo, ''))), '');
  v_plantilla jsonb := coalesce(p_plantilla, '{}'::jsonb);
  v_clave text;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'cliente_automatizacion_guardar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select f.organization_id into v_org from despachos.cliente_ficha f where f.property_id = p_property_id;
  if v_org is null then
    raise exception 'cliente_automatizacion_guardar: el cliente no tiene ficha' using errcode = '22023';
  end if;
  if v_correo is not null and (char_length(v_correo) > 254 or v_correo !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$') then
    raise exception 'cliente_automatizacion_guardar: correo de contacto inválido' using errcode = '22023';
  end if;
  if coalesce(p_envio_reportes_cierre, false) and v_correo is null then
    raise exception 'cliente_automatizacion_guardar: para enviar reportes al cerrar captura un correo de contacto' using errcode = '22023';
  end if;
  if p_solicitud_dia is null or p_solicitud_dia < 1 or p_solicitud_dia > 28 then
    raise exception 'cliente_automatizacion_guardar: el día de la solicitud va de 1 a 28' using errcode = '22023';
  end if;
  if jsonb_typeof(v_plantilla) <> 'object' or octet_length(v_plantilla::text) > 2048 then
    raise exception 'cliente_automatizacion_guardar: plantilla inválida' using errcode = '22023';
  end if;
  for v_clave in select k from jsonb_object_keys(v_plantilla) as k loop
    if v_clave not in ('xml_emitidos', 'xml_recibidos', 'nomina', 'otros', 'estados_cuenta') then
      raise exception 'cliente_automatizacion_guardar: la plantilla no admite la clave %', v_clave using errcode = '22023';
    end if;
    if v_clave = 'estados_cuenta' then
      if jsonb_typeof(v_plantilla -> v_clave) <> 'array' or jsonb_array_length(v_plantilla -> v_clave) > 10
         or exists (select 1 from jsonb_array_elements(v_plantilla -> v_clave) e where jsonb_typeof(e) <> 'string' or char_length(e #>> '{}') not between 1 and 40) then
        raise exception 'cliente_automatizacion_guardar: estados_cuenta debe ser una lista de hasta 10 cuentas de 1 a 40 caracteres' using errcode = '22023';
      end if;
    elsif jsonb_typeof(v_plantilla -> v_clave) <> 'boolean' then
      raise exception 'cliente_automatizacion_guardar: % debe ser verdadero o falso', v_clave using errcode = '22023';
    end if;
  end loop;
  insert into despachos.cliente_automatizacion as a (property_id, organization_id, contacto_correo, envio_reportes_cierre, solicitud_activa, solicitud_dia, plantilla, actualizado_por, actualizado_en)
  values (p_property_id, v_org, v_correo, coalesce(p_envio_reportes_cierre, false), coalesce(p_solicitud_activa, true), p_solicitud_dia, v_plantilla, auth.uid(), now())
  on conflict (property_id) do update
    set contacto_correo = excluded.contacto_correo, envio_reportes_cierre = excluded.envio_reportes_cierre, solicitud_activa = excluded.solicitud_activa,
        solicitud_dia = excluded.solicitud_dia, plantilla = excluded.plantilla, actualizado_por = excluded.actualizado_por, actualizado_en = now();
end;
$$;
revoke all on function despachos.cliente_automatizacion_guardar(uuid, text, boolean, boolean, integer, jsonb) from public, anon;
grant execute on function despachos.cliente_automatizacion_guardar(uuid, text, boolean, boolean, integer, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- D-31 -- solicitudes de documentos por cliente y periodo.
-- ---------------------------------------------------------------------------
create table despachos.solicitud_documentos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  ejercicio integer not null check (ejercicio between 2014 and 2099),
  mes integer not null check (mes between 1 and 12),
  estado text not null default 'abierta' check (estado in ('abierta', 'completa')),
  ultimo_recordatorio_nivel smallint not null default 0 check (ultimo_recordatorio_nivel between 0 and 3),
  ultimo_recordatorio_en timestamptz,
  creada_en timestamptz not null default now(),
  completada_en timestamptz,
  unique (id, organization_id, property_id),
  unique (property_id, ejercicio, mes),
  check ((estado = 'completa') = (completada_en is not null))
);
create index solicitud_documentos_abiertas_idx on despachos.solicitud_documentos (creada_en) where estado = 'abierta';

create table despachos.solicitud_documentos_renglon (
  id uuid primary key default gen_random_uuid(),
  solicitud_id uuid not null,
  organization_id uuid not null,
  property_id uuid not null,
  tipo text not null check (tipo in ('estado_cuenta', 'xml_emitidos', 'xml_recibidos', 'nomina', 'otros')),
  clave text not null check (char_length(clave) between 1 and 60),
  etiqueta text not null check (char_length(etiqueta) between 1 and 120),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'en_revision', 'recibido', 'no_aplica')),
  motivo_no_aplica text check (motivo_no_aplica is null or char_length(motivo_no_aplica) between 3 and 300),
  documento_id uuid references despachos.portal_cliente_documento(id) on delete set null,
  resuelto_en timestamptz,
  resuelto_por uuid references core.staff_user(id) on delete set null,
  unique (solicitud_id, clave),
  foreign key (solicitud_id, organization_id, property_id) references despachos.solicitud_documentos (id, organization_id, property_id) on delete cascade,
  check ((estado = 'no_aplica') = (motivo_no_aplica is not null)),
  check ((estado in ('recibido', 'no_aplica')) = (resuelto_en is not null))
);
create index solicitud_renglon_documento_idx on despachos.solicitud_documentos_renglon (documento_id) where documento_id is not null;
create index solicitud_renglon_property_idx on despachos.solicitud_documentos_renglon (property_id, solicitud_id);

alter table despachos.solicitud_documentos enable row level security;
alter table despachos.solicitud_documentos_renglon enable row level security;
revoke all on despachos.solicitud_documentos, despachos.solicitud_documentos_renglon from public, anon, authenticated;
create policy "staff ve las solicitudes de documentos de sus clientes" on despachos.solicitud_documentos for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve los renglones de solicitud de sus clientes" on despachos.solicitud_documentos_renglon for select
  using (core.has_property_access(auth.uid(), property_id));
grant select on despachos.solicitud_documentos, despachos.solicitud_documentos_renglon to authenticated;
grant select, insert, update, delete on despachos.solicitud_documentos, despachos.solicitud_documentos_renglon to service_role;

-- Marca la solicitud completa (todo recibido o no aplica) o la reabre. Interna: nadie la ejecuta directamente.
create or replace function despachos.solicitud_recomputar(p_solicitud_id uuid)
returns void
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
begin
  if exists (select 1 from despachos.solicitud_documentos_renglon r where r.solicitud_id = p_solicitud_id and r.estado in ('pendiente', 'en_revision')) then
    update despachos.solicitud_documentos set estado = 'abierta', completada_en = null where id = p_solicitud_id and estado <> 'abierta';
  else
    update despachos.solicitud_documentos set estado = 'completa', completada_en = now() where id = p_solicitud_id and estado <> 'completa';
  end if;
end;
$$;
revoke all on function despachos.solicitud_recomputar(uuid) from public, anon, authenticated;

-- Crea la solicitud del periodo (idempotente) con los renglones de la plantilla del cliente. Interna.
create or replace function despachos.solicitud_crear_interna(p_organization_id uuid, p_property_id uuid, p_ejercicio integer, p_mes integer)
returns table (out_id uuid, out_creada boolean)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_id uuid;
  v_plantilla jsonb;
  v_cuentas text[];
  v_cuenta text;
  v_inicio date := make_date(p_ejercicio, p_mes, 1);
begin
  insert into despachos.solicitud_documentos (organization_id, property_id, ejercicio, mes)
  values (p_organization_id, p_property_id, p_ejercicio, p_mes)
  on conflict (property_id, ejercicio, mes) do nothing
  returning id into v_id;
  if v_id is null then
    select s.id into v_id from despachos.solicitud_documentos s where s.property_id = p_property_id and s.ejercicio = p_ejercicio and s.mes = p_mes;
    return query select v_id, false;
    return;
  end if;
  select coalesce(a.plantilla, '{}'::jsonb) into v_plantilla from despachos.cliente_automatizacion a where a.property_id = p_property_id;
  v_plantilla := coalesce(v_plantilla, '{}'::jsonb);

  if v_plantilla ? 'estados_cuenta' then
    select coalesce(array_agg(e), '{}') into v_cuentas from jsonb_array_elements_text(v_plantilla -> 'estados_cuenta') e;
  else
    select coalesce(array_agg(c.cuenta order by c.cuenta), '{}') into v_cuentas
    from (select distinct m.cuenta from despachos.estado_cuenta_movimiento m
          where m.property_id = p_property_id and m.cuenta is not null
            and m.fecha >= (v_inicio - interval '4 months')::date and m.fecha < (v_inicio + interval '1 month')::date
          order by m.cuenta limit 10) c;
  end if;
  if cardinality(v_cuentas) = 0 then
    insert into despachos.solicitud_documentos_renglon (solicitud_id, organization_id, property_id, tipo, clave, etiqueta)
    values (v_id, p_organization_id, p_property_id, 'estado_cuenta', 'estado_cuenta', 'Estado de cuenta bancario');
  else
    foreach v_cuenta in array v_cuentas loop
      insert into despachos.solicitud_documentos_renglon (solicitud_id, organization_id, property_id, tipo, clave, etiqueta)
      values (v_id, p_organization_id, p_property_id, 'estado_cuenta', left('estado_cuenta:' || v_cuenta, 60),
              left('Estado de cuenta ' || case when char_length(v_cuenta) > 4 and v_cuenta ~ '^[0-9]+$' then '****' || right(v_cuenta, 4) else v_cuenta end, 120))
      on conflict (solicitud_id, clave) do nothing;
    end loop;
  end if;
  if coalesce((v_plantilla ->> 'xml_emitidos')::boolean, true) then
    insert into despachos.solicitud_documentos_renglon (solicitud_id, organization_id, property_id, tipo, clave, etiqueta)
    values (v_id, p_organization_id, p_property_id, 'xml_emitidos', 'xml_emitidos', 'CFDI emitidos del mes (XML)');
  end if;
  if coalesce((v_plantilla ->> 'xml_recibidos')::boolean, true) then
    insert into despachos.solicitud_documentos_renglon (solicitud_id, organization_id, property_id, tipo, clave, etiqueta)
    values (v_id, p_organization_id, p_property_id, 'xml_recibidos', 'xml_recibidos', 'CFDI recibidos del mes (XML)');
  end if;
  if coalesce((v_plantilla ->> 'nomina')::boolean, false) then
    insert into despachos.solicitud_documentos_renglon (solicitud_id, organization_id, property_id, tipo, clave, etiqueta)
    values (v_id, p_organization_id, p_property_id, 'nomina', 'nomina', 'Nómina del mes');
  end if;
  if coalesce((v_plantilla ->> 'otros')::boolean, false) then
    insert into despachos.solicitud_documentos_renglon (solicitud_id, organization_id, property_id, tipo, clave, etiqueta)
    values (v_id, p_organization_id, p_property_id, 'otros', 'otros', 'Otros documentos del mes');
  end if;
  return query select v_id, true;
end;
$$;
revoke all on function despachos.solicitud_crear_interna(uuid, uuid, integer, integer) from public, anon, authenticated;

-- STAFF: pedir los documentos de un periodo ahora (idempotente).
create or replace function despachos.solicitud_documentos_crear(p_property_id uuid, p_ejercicio integer, p_mes integer)
returns table (out_id uuid, out_creada boolean)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'solicitud_documentos_crear: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'despachos';
  if v_org is null then
    raise exception 'solicitud_documentos_crear: la property no es de despachos' using errcode = '42501';
  end if;
  if p_ejercicio is null or p_ejercicio not between 2014 and 2099 or p_mes is null or p_mes not between 1 and 12 then
    raise exception 'solicitud_documentos_crear: periodo inválido' using errcode = '22023';
  end if;
  return query select * from despachos.solicitud_crear_interna(v_org, p_property_id, p_ejercicio, p_mes);
end;
$$;
revoke all on function despachos.solicitud_documentos_crear(uuid, integer, integer) from public, anon;
grant execute on function despachos.solicitud_documentos_crear(uuid, integer, integer) to authenticated;

-- STAFF: «no aplica» con motivo obligatorio.
create or replace function despachos.solicitud_renglon_no_aplica(p_property_id uuid, p_renglon_id uuid, p_motivo text)
returns boolean
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_motivo text := btrim(coalesce(p_motivo, ''));
  v_solicitud uuid;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'solicitud_renglon_no_aplica: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  if char_length(v_motivo) < 3 or char_length(v_motivo) > 300 then
    raise exception 'solicitud_renglon_no_aplica: el motivo debe tener de 3 a 300 caracteres' using errcode = '22023';
  end if;
  update despachos.solicitud_documentos_renglon
     set estado = 'no_aplica', motivo_no_aplica = v_motivo, resuelto_en = now(), resuelto_por = auth.uid()
   where id = p_renglon_id and property_id = p_property_id and estado in ('pendiente', 'en_revision')
   returning solicitud_id into v_solicitud;
  if v_solicitud is null then
    return false;
  end if;
  perform despachos.solicitud_recomputar(v_solicitud);
  return true;
end;
$$;
revoke all on function despachos.solicitud_renglon_no_aplica(uuid, uuid, text) from public, anon;
grant execute on function despachos.solicitud_renglon_no_aplica(uuid, uuid, text) to authenticated;

-- STAFF: reabrir un renglon marcado «no aplica».
create or replace function despachos.solicitud_renglon_reabrir(p_property_id uuid, p_renglon_id uuid)
returns boolean
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_solicitud uuid;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'solicitud_renglon_reabrir: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  update despachos.solicitud_documentos_renglon
     set estado = 'pendiente', motivo_no_aplica = null, resuelto_en = null, resuelto_por = null
   where id = p_renglon_id and property_id = p_property_id and estado = 'no_aplica'
   returning solicitud_id into v_solicitud;
  if v_solicitud is null then
    return false;
  end if;
  perform despachos.solicitud_recomputar(v_solicitud);
  return true;
end;
$$;
revoke all on function despachos.solicitud_renglon_reabrir(uuid, uuid) from public, anon;
grant execute on function despachos.solicitud_renglon_reabrir(uuid, uuid) to authenticated;

-- STAFF: ligar a un renglon un documento YA presente en el portal de ese mismo cliente (aceptado = recibido; en bandeja = en revision).
create or replace function despachos.solicitud_renglon_vincular_staff(p_property_id uuid, p_renglon_id uuid, p_documento_id uuid)
returns text
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_estado_doc text;
  v_nuevo text;
  v_solicitud uuid;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'solicitud_renglon_vincular_staff: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select d.estado into v_estado_doc from despachos.portal_cliente_documento d where d.id = p_documento_id and d.property_id = p_property_id;
  if v_estado_doc is null then
    raise exception 'solicitud_renglon_vincular_staff: documento no encontrado' using errcode = 'P0002';
  end if;
  if v_estado_doc = 'rechazado' then
    raise exception 'solicitud_renglon_vincular_staff: un documento rechazado no cubre un renglón' using errcode = '22023';
  end if;
  v_nuevo := case when v_estado_doc = 'aceptado' then 'recibido' else 'en_revision' end;
  update despachos.solicitud_documentos_renglon
     set estado = v_nuevo, documento_id = p_documento_id, motivo_no_aplica = null,
         resuelto_en = case when v_nuevo = 'recibido' then now() else null end,
         resuelto_por = case when v_nuevo = 'recibido' then auth.uid() else null end
   where id = p_renglon_id and property_id = p_property_id and estado in ('pendiente', 'en_revision', 'no_aplica')
   returning solicitud_id into v_solicitud;
  if v_solicitud is null then
    raise exception 'solicitud_renglon_vincular_staff: renglón no encontrado o ya recibido' using errcode = 'P0002';
  end if;
  perform despachos.solicitud_recomputar(v_solicitud);
  return v_nuevo;
end;
$$;
revoke all on function despachos.solicitud_renglon_vincular_staff(uuid, uuid, uuid) from public, anon;
grant execute on function despachos.solicitud_renglon_vincular_staff(uuid, uuid, uuid) to authenticated;

-- Trigger: el staff acepta (o rechaza) el documento en el portal -> el renglon ligado se marca solo.
create or replace function despachos.portal_cliente_documento_marca_renglon()
returns trigger
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_solicitud uuid;
begin
  if new.estado is not distinct from old.estado then
    return new;
  end if;
  if new.estado = 'aceptado' then
    for v_solicitud in
      update despachos.solicitud_documentos_renglon
         set estado = 'recibido', resuelto_en = now(), resuelto_por = new.resuelto_por
       where documento_id = new.id and estado in ('pendiente', 'en_revision')
       returning solicitud_id
    loop
      perform despachos.solicitud_recomputar(v_solicitud);
    end loop;
  elsif new.estado = 'rechazado' then
    for v_solicitud in
      update despachos.solicitud_documentos_renglon
         set estado = 'pendiente', documento_id = null, resuelto_en = null, resuelto_por = null
       where documento_id = new.id and estado in ('en_revision', 'recibido')
       returning solicitud_id
    loop
      perform despachos.solicitud_recomputar(v_solicitud);
    end loop;
  end if;
  return new;
end;
$$;
revoke all on function despachos.portal_cliente_documento_marca_renglon() from public, anon, authenticated;
create trigger portal_cliente_documento_marca_renglon after update of estado on despachos.portal_cliente_documento
  for each row execute function despachos.portal_cliente_documento_marca_renglon();

-- SISTEMA: clientes a los que toca crear la solicitud del mes anterior (ya paso su dia configurado y aun no existe).
create or replace function despachos.system_solicitudes_por_crear(p_hoy date, p_limit integer)
returns table (out_organization_id uuid, out_property_id uuid, out_ejercicio integer, out_mes integer)
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_periodo date;
begin
  if auth.uid() is not null then
    raise exception 'system_solicitudes_por_crear es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_hoy is null or p_limit is null or p_limit < 1 then
    raise exception 'system_solicitudes_por_crear: fecha o límite inválidos' using errcode = '22023';
  end if;
  v_periodo := (date_trunc('month', p_hoy) - interval '1 month')::date;
  return query
    select f.organization_id, f.property_id, extract(year from v_periodo)::int, extract(month from v_periodo)::int
    from despachos.cliente_ficha f
    join core.property p on p.id = f.property_id and p.status = 'active'
    join core.organization o on o.id = f.organization_id and o.status = 'active'
    left join despachos.cliente_automatizacion a on a.property_id = f.property_id
    where coalesce(a.solicitud_activa, true)
      and extract(day from p_hoy) >= coalesce(a.solicitud_dia, 1)
      and not exists (
        select 1 from despachos.solicitud_documentos s
        where s.property_id = f.property_id and s.ejercicio = extract(year from v_periodo)::int and s.mes = extract(month from v_periodo)::int)
    order by f.property_id
    limit least(p_limit, 1000);
end;
$$;
revoke all on function despachos.system_solicitudes_por_crear(date, integer) from public, anon;
grant execute on function despachos.system_solicitudes_por_crear(date, integer) to authenticated;

-- SISTEMA: crea la solicitud de un cliente y devuelve lo necesario para avisar (correo de contacto, nombre del cliente).
create or replace function despachos.system_solicitud_crear(p_property_id uuid, p_ejercicio integer, p_mes integer)
returns table (out_id uuid, out_creada boolean, out_organization_id uuid, out_contacto_correo text, out_cliente text, out_renglones integer)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_id uuid;
  v_creada boolean;
  v_nombre text;
begin
  if auth.uid() is not null then
    raise exception 'system_solicitud_crear es solo para la sesión de sistema' using errcode = '42501';
  end if;
  select f.organization_id, f.razon_social into v_org, v_nombre from despachos.cliente_ficha f where f.property_id = p_property_id;
  if v_org is null then
    raise exception 'system_solicitud_crear: la property no tiene ficha de cliente' using errcode = '22023';
  end if;
  if p_ejercicio is null or p_ejercicio not between 2014 and 2099 or p_mes is null or p_mes not between 1 and 12 then
    raise exception 'system_solicitud_crear: periodo inválido' using errcode = '22023';
  end if;
  select s.out_id, s.out_creada into v_id, v_creada from despachos.solicitud_crear_interna(v_org, p_property_id, p_ejercicio, p_mes) s;
  return query
    select v_id, v_creada, v_org, a.contacto_correo, v_nombre,
           (select count(*)::int from despachos.solicitud_documentos_renglon r where r.solicitud_id = v_id)
    from (select 1) x left join despachos.cliente_automatizacion a on a.property_id = p_property_id;
end;
$$;
revoke all on function despachos.system_solicitud_crear(uuid, integer, integer) from public, anon;
grant execute on function despachos.system_solicitud_crear(uuid, integer, integer) to authenticated;

-- SISTEMA: enlace de portal para el aviso al cliente (el token solo se guarda como hash; lo genera la API).
-- `creado_por` es obligatorio en el enlace: se atribuye al responsable de la ficha o, si no tiene, a un admin de la organizacion.
-- Revoca los enlaces automaticos previos con la misma etiqueta y respeta el tope de 20 vigentes retirando los automaticos mas viejos.
create or replace function despachos.system_portal_enlace_crear(p_property_id uuid, p_token_hash text, p_etiqueta text, p_dias integer)
returns table (out_id uuid, out_expira_en timestamptz)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_creador uuid;
  v_id uuid;
  v_expira timestamptz;
begin
  if auth.uid() is not null then
    raise exception 'system_portal_enlace_crear es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'system_portal_enlace_crear: hash inválido' using errcode = '22023';
  end if;
  if p_etiqueta is null or p_etiqueta !~ '^(Solicitud|Reportes) [0-9]{4}-[0-9]{2}$' then
    raise exception 'system_portal_enlace_crear: etiqueta inválida' using errcode = '22023';
  end if;
  if p_dias is null or p_dias < 1 or p_dias > 60 then
    raise exception 'system_portal_enlace_crear: vigencia de 1 a 60 días' using errcode = '22023';
  end if;
  select f.organization_id, f.responsable_id into v_org, v_creador from despachos.cliente_ficha f where f.property_id = p_property_id;
  if v_org is null then
    raise exception 'system_portal_enlace_crear: la property no tiene ficha de cliente' using errcode = '22023';
  end if;
  if v_creador is null or not exists (select 1 from core.membership m where m.user_id = v_creador and m.organization_id = v_org) then
    select m.user_id into v_creador from core.membership m
     where m.organization_id = v_org and m.vertical_role = 'admin' and m.user_id is not null
     order by m.user_id limit 1;
  end if;
  if v_creador is null then
    raise exception 'system_portal_enlace_crear: la organización no tiene un admin al que atribuir el enlace' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('despachos.portal_cliente_enlace:' || p_property_id::text, 0));
  update despachos.portal_cliente_enlace set revocado_en = now()
   where property_id = p_property_id and etiqueta = p_etiqueta and revocado_en is null;
  update despachos.portal_cliente_enlace set revocado_en = now()
   where id in (
     select e.id from despachos.portal_cliente_enlace e
      where e.property_id = p_property_id and e.revocado_en is null and e.expira_en > now() and e.etiqueta ~ '^(Solicitud|Reportes) [0-9]{4}-[0-9]{2}$'
      order by e.creado_en asc
      limit greatest(0, (select count(*) from despachos.portal_cliente_enlace x where x.property_id = p_property_id and x.revocado_en is null and x.expira_en > now()) - 19));
  if (select count(*) from despachos.portal_cliente_enlace e where e.property_id = p_property_id and e.revocado_en is null and e.expira_en > now()) >= 20 then
    raise exception 'system_portal_enlace_crear: máximo 20 enlaces vigentes por cliente' using errcode = '54000';
  end if;
  v_expira := now() + make_interval(days => p_dias);
  insert into despachos.portal_cliente_enlace (organization_id, property_id, token_hash, etiqueta, creado_por, expira_en)
  values (v_org, p_property_id, p_token_hash, p_etiqueta, v_creador, v_expira)
  returning id into v_id;
  return query select v_id, v_expira;
end;
$$;
revoke all on function despachos.system_portal_enlace_crear(uuid, text, text, integer) from public, anon;
grant execute on function despachos.system_portal_enlace_crear(uuid, text, text, integer) to authenticated;

-- SISTEMA: solicitudes abiertas a las que toca recordatorio (3, 7 y 10 dias desde su creacion) mientras falten documentos del cliente.
create or replace function despachos.system_solicitudes_para_recordatorio(p_hoy date, p_limit integer)
returns table (
  out_id uuid, out_organization_id uuid, out_property_id uuid, out_ejercicio integer, out_mes integer,
  out_nivel integer, out_pendientes integer, out_dias integer, out_contacto_correo text, out_cliente text
)
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'system_solicitudes_para_recordatorio es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_hoy is null or p_limit is null or p_limit < 1 then
    raise exception 'system_solicitudes_para_recordatorio: fecha o límite inválidos' using errcode = '22023';
  end if;
  return query
    select x.id, x.organization_id, x.property_id, x.ejercicio, x.mes, x.nivel, x.pendientes, x.dias, x.contacto_correo, x.razon_social
    from (
      select s.id, s.organization_id, s.property_id, s.ejercicio, s.mes,
             (case when (p_hoy - (s.creada_en at time zone 'UTC')::date) >= 10 then 3 when (p_hoy - (s.creada_en at time zone 'UTC')::date) >= 7 then 2
                   when (p_hoy - (s.creada_en at time zone 'UTC')::date) >= 3 then 1 else 0 end)::int as nivel,
             (select count(*)::int from despachos.solicitud_documentos_renglon r where r.solicitud_id = s.id and r.estado = 'pendiente') as pendientes,
             (p_hoy - (s.creada_en at time zone 'UTC')::date)::int as dias,
             a.contacto_correo, f.razon_social, s.ultimo_recordatorio_nivel, s.creada_en
      from despachos.solicitud_documentos s
      join despachos.cliente_ficha f on f.property_id = s.property_id
      join core.property p on p.id = s.property_id and p.status = 'active'
      left join despachos.cliente_automatizacion a on a.property_id = s.property_id
      where s.estado = 'abierta'
    ) x
    where x.pendientes > 0 and x.nivel > x.ultimo_recordatorio_nivel
    order by x.creada_en
    limit least(p_limit, 1000);
end;
$$;
revoke all on function despachos.system_solicitudes_para_recordatorio(date, integer) from public, anon;
grant execute on function despachos.system_solicitudes_para_recordatorio(date, integer) to authenticated;

create or replace function despachos.system_solicitud_recordatorio_marcar(p_solicitud_id uuid, p_nivel integer)
returns boolean
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_n integer;
begin
  if auth.uid() is not null then
    raise exception 'system_solicitud_recordatorio_marcar es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_nivel is null or p_nivel not between 1 and 3 then
    raise exception 'system_solicitud_recordatorio_marcar: nivel inválido' using errcode = '22023';
  end if;
  update despachos.solicitud_documentos set ultimo_recordatorio_nivel = p_nivel, ultimo_recordatorio_en = now()
   where id = p_solicitud_id and estado = 'abierta' and ultimo_recordatorio_nivel < p_nivel;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;
revoke all on function despachos.system_solicitud_recordatorio_marcar(uuid, integer) from public, anon;
grant execute on function despachos.system_solicitud_recordatorio_marcar(uuid, integer) to authenticated;

-- PORTAL (sistema): las solicitudes recientes del cliente de ESTE enlace con sus renglones.
create or replace function despachos.portal_cliente_solicitudes(p_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
declare
  v despachos.portal_cliente_enlace;
begin
  if auth.uid() is not null then
    raise exception 'portal_cliente_solicitudes: solo alcanzable desde sesión de sistema' using errcode = '42501';
  end if;
  v := despachos.portal_cliente_enlace_resolver(p_token_hash);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'ejercicio', s.ejercicio, 'mes', s.mes, 'estado', s.estado,
             'renglones', coalesce((
               select jsonb_agg(jsonb_build_object('id', r.id, 'tipo', r.tipo, 'etiqueta', r.etiqueta, 'estado', r.estado, 'motivo', r.motivo_no_aplica) order by r.tipo, r.etiqueta)
               from despachos.solicitud_documentos_renglon r where r.solicitud_id = s.id), '[]'::jsonb))
           order by s.ejercicio desc, s.mes desc)
    from (select * from despachos.solicitud_documentos x where x.property_id = v.property_id order by x.ejercicio desc, x.mes desc limit 3) s
  ), '[]'::jsonb);
end;
$$;
revoke all on function despachos.portal_cliente_solicitudes(text) from public, anon;
grant execute on function despachos.portal_cliente_solicitudes(text) to authenticated;

-- PORTAL (sistema): el cliente liga un documento que EL subio por este mismo enlace a un renglon de su solicitud.
create or replace function despachos.portal_cliente_solicitud_vincular(p_token_hash text, p_documento_id uuid, p_renglon_id uuid)
returns text
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v despachos.portal_cliente_enlace;
  v_estado_doc text;
  v_nuevo text;
  v_solicitud uuid;
begin
  if auth.uid() is not null then
    raise exception 'portal_cliente_solicitud_vincular: solo alcanzable desde sesión de sistema' using errcode = '42501';
  end if;
  v := despachos.portal_cliente_enlace_resolver(p_token_hash);
  select d.estado into v_estado_doc from despachos.portal_cliente_documento d
   where d.id = p_documento_id and d.property_id = v.property_id and d.enlace_id = v.id;
  if v_estado_doc is null or v_estado_doc = 'rechazado' then
    raise exception 'solicitud_no_valida' using errcode = 'P0002';
  end if;
  v_nuevo := case when v_estado_doc = 'aceptado' then 'recibido' else 'en_revision' end;
  update despachos.solicitud_documentos_renglon
     set estado = v_nuevo, documento_id = p_documento_id,
         resuelto_en = case when v_nuevo = 'recibido' then now() else null end
   where id = p_renglon_id and property_id = v.property_id and estado in ('pendiente', 'en_revision')
   returning solicitud_id into v_solicitud;
  if v_solicitud is null then
    raise exception 'solicitud_no_valida' using errcode = 'P0002';
  end if;
  perform despachos.solicitud_recomputar(v_solicitud);
  return v_nuevo;
end;
$$;
revoke all on function despachos.portal_cliente_solicitud_vincular(text, uuid, uuid) from public, anon;
grant execute on function despachos.portal_cliente_solicitud_vincular(text, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- D-P3-15 -- estado de los modulos calculado en el servidor desde datos persistidos.
-- ---------------------------------------------------------------------------
create or replace function despachos.cierre_estado_modulos(p_property_id uuid, p_ejercicio integer, p_mes integer)
returns table (
  out_debe_centavos bigint,
  out_haber_centavos bigint,
  out_polizas integer,
  out_polizas_descuadradas integer,
  out_cfdi_total integer,
  out_cfdi_sin_poliza integer,
  out_cfdi_invalidos integer,
  out_conciliacion_sesiones integer,
  out_conciliacion_abiertas integer,
  out_movimientos integer,
  out_movimientos_conciliados integer,
  out_pagos_provisionales integer,
  out_solicitud_estado text,
  out_solicitud_pendientes integer
)
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_inicio date;
  v_fin date;
  v_periodo text;
begin
  if auth.uid() is not null and not core.has_property_access(auth.uid(), p_property_id) then
    raise exception 'cierre_estado_modulos: sin acceso a la property' using errcode = '42501';
  end if;
  if p_ejercicio is null or p_ejercicio not between 2014 and 2099 or p_mes is null or p_mes not between 1 and 12 then
    raise exception 'cierre_estado_modulos: periodo inválido' using errcode = '22023';
  end if;
  v_inicio := make_date(p_ejercicio, p_mes, 1);
  v_fin := (v_inicio + interval '1 month')::date;
  v_periodo := to_char(v_inicio, 'YYYY-MM');
  return query
    select
      coalesce((select sum(m.debe_centavos) from despachos.libro_movimiento m join despachos.libro_poliza p on p.id = m.poliza_id
                where p.property_id = p_property_id and p.ejercicio = p_ejercicio and p.mes = p_mes), 0)::bigint,
      coalesce((select sum(m.haber_centavos) from despachos.libro_movimiento m join despachos.libro_poliza p on p.id = m.poliza_id
                where p.property_id = p_property_id and p.ejercicio = p_ejercicio and p.mes = p_mes), 0)::bigint,
      (select count(*)::int from despachos.libro_poliza p where p.property_id = p_property_id and p.ejercicio = p_ejercicio and p.mes = p_mes),
      (select count(*)::int from (
         select p.id from despachos.libro_poliza p join despachos.libro_movimiento m on m.poliza_id = p.id
          where p.property_id = p_property_id and p.ejercicio = p_ejercicio and p.mes = p_mes
          group by p.id having sum(m.debe_centavos) <> sum(m.haber_centavos)) d),
      (select count(*)::int from despachos.invoice i
        where i.property_id = p_property_id and i.fecha >= v_inicio and i.fecha < v_fin and i.tipo in ('I', 'E') and i.estado_sat <> 'cancelado'),
      (select count(*)::int from despachos.invoice i
        where i.property_id = p_property_id and i.fecha >= v_inicio and i.fecha < v_fin and i.tipo in ('I', 'E') and i.estado_sat <> 'cancelado'
          and not exists (select 1 from despachos.libro_poliza p where p.property_id = p_property_id and p.invoice_id = i.id and not p.reversada)),
      (select count(*)::int from despachos.invoice i
        where i.property_id = p_property_id and i.fecha >= v_inicio and i.fecha < v_fin and not i.valido),
      (select count(*)::int from despachos.conciliacion_sesion s where s.property_id = p_property_id and s.periodo = v_periodo),
      (select count(*)::int from despachos.conciliacion_sesion s where s.property_id = p_property_id and s.periodo = v_periodo and s.estado = 'abierta'),
      (select count(*)::int from despachos.estado_cuenta_movimiento e where e.property_id = p_property_id and e.fecha >= v_inicio and e.fecha < v_fin),
      (select count(*)::int from despachos.estado_cuenta_movimiento e where e.property_id = p_property_id and e.fecha >= v_inicio and e.fecha < v_fin
          and exists (select 1 from despachos.conciliacion_match c where c.movimiento_id = e.id and c.deshecho_en is null)),
      (select count(*)::int from despachos.pago_provisional g where g.property_id = p_property_id and g.ejercicio = p_ejercicio and g.mes = p_mes),
      (select s.estado from despachos.solicitud_documentos s where s.property_id = p_property_id and s.ejercicio = p_ejercicio and s.mes = p_mes),
      (select count(*)::int from despachos.solicitud_documentos s join despachos.solicitud_documentos_renglon r on r.solicitud_id = s.id
        where s.property_id = p_property_id and s.ejercicio = p_ejercicio and s.mes = p_mes and r.estado in ('pendiente', 'en_revision'));
end;
$$;
revoke all on function despachos.cierre_estado_modulos(uuid, integer, integer) from public, anon;
grant execute on function despachos.cierre_estado_modulos(uuid, integer, integer) to authenticated;

-- SISTEMA: periodos de cierre abiertos de clientes activos (para el auto-check diario).
create or replace function despachos.system_periodos_cierre_abiertos(p_limit integer)
returns table (out_periodo_id uuid, out_organization_id uuid, out_property_id uuid, out_anio integer, out_mes integer)
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'system_periodos_cierre_abiertos es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'system_periodos_cierre_abiertos: límite inválido' using errcode = '22023';
  end if;
  return query
    select c.id, c.organization_id, c.property_id, c.anio, c.mes
    from despachos.periodo_cierre c
    join core.property p on p.id = c.property_id and p.status = 'active'
    where c.status in ('open', 'overdue')
    order by c.opened_at, c.id
    limit least(p_limit, 1000);
end;
$$;
revoke all on function despachos.system_periodos_cierre_abiertos(integer) from public, anon;
grant execute on function despachos.system_periodos_cierre_abiertos(integer) to authenticated;

-- SISTEMA: completa tareas con auto-check (nunca una tarea manual) y desbloquea a sus dependientes. Atribuye `sistema`.
create or replace function despachos.system_cierre_tareas_autocompletar(p_periodo_id uuid, p_tarea_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_n integer;
begin
  if auth.uid() is not null then
    raise exception 'system_cierre_tareas_autocompletar es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_tarea_ids is null or cardinality(p_tarea_ids) > 100 then
    raise exception 'system_cierre_tareas_autocompletar: lista inválida' using errcode = '22023';
  end if;
  if not exists (select 1 from despachos.periodo_cierre c where c.id = p_periodo_id and c.status in ('open', 'overdue')) then
    return 0;
  end if;
  update despachos.periodo_cierre_tarea t
     set status = 'done', completed_at = now(), completed_by = 'sistema'
   where t.periodo_cierre_id = p_periodo_id and t.id = any (p_tarea_ids)
     and t.auto_check_query is not null and t.status in ('pending', 'in_progress', 'blocked');
  get diagnostics v_n = row_count;
  update despachos.periodo_cierre_tarea t
     set status = 'pending'
   where t.periodo_cierre_id = p_periodo_id and t.status = 'blocked'
     and not exists (select 1 from unnest(t.depends_on) d where not exists (select 1 from despachos.periodo_cierre_tarea x where x.id = d and x.status = 'done'));
  return v_n;
end;
$$;
revoke all on function despachos.system_cierre_tareas_autocompletar(uuid, uuid[]) from public, anon;
grant execute on function despachos.system_cierre_tareas_autocompletar(uuid, uuid[]) to authenticated;

-- Cierre forzado: queda constancia (bandera + motivo) en el propio periodo.
alter table despachos.periodo_cierre
  add column if not exists cierre_forzado boolean not null default false,
  add column if not exists cierre_forzado_motivo text check (cierre_forzado_motivo is null or char_length(cierre_forzado_motivo) between 10 and 500),
  add column if not exists cierre_forzado_validaciones text[],
  add constraint periodo_cierre_forzado_coherente check (cierre_forzado = (cierre_forzado_motivo is not null));

-- STAFF (solo admin): registra el motivo ANTES de cerrar de forma forzada. Solo sobre un periodo no cerrado.
create or replace function despachos.periodo_cierre_forzar(p_property_id uuid, p_periodo_id uuid, p_motivo text, p_validaciones text[])
returns boolean
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_motivo text := btrim(coalesce(p_motivo, ''));
  v_n integer;
begin
  if auth.uid() is null or not core.has_property_access(auth.uid(), p_property_id)
     or not exists (select 1 from core.property p join core.membership m on m.organization_id = p.organization_id and m.user_id = auth.uid()
                     where p.id = p_property_id and p.vertical = 'despachos' and m.vertical_role = 'admin') then
    raise exception 'periodo_cierre_forzar: solo un admin del despacho puede forzar el cierre' using errcode = '42501';
  end if;
  if char_length(v_motivo) < 10 or char_length(v_motivo) > 500 then
    raise exception 'periodo_cierre_forzar: el motivo debe tener de 10 a 500 caracteres' using errcode = '22023';
  end if;
  if p_validaciones is not null and (cardinality(p_validaciones) > 20 or array_position(p_validaciones, null) is not null) then
    raise exception 'periodo_cierre_forzar: lista de validaciones inválida' using errcode = '22023';
  end if;
  update despachos.periodo_cierre
     set cierre_forzado = true, cierre_forzado_motivo = v_motivo, cierre_forzado_validaciones = p_validaciones
   where id = p_periodo_id and property_id = p_property_id and status <> 'closed';
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;
revoke all on function despachos.periodo_cierre_forzar(uuid, uuid, text, text[]) from public, anon;
grant execute on function despachos.periodo_cierre_forzar(uuid, uuid, text, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- D-P3-21 -- entrega de reportes al cliente al cerrar.
-- ---------------------------------------------------------------------------
create table despachos.cierre_entrega (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  periodo_cierre_id uuid not null references despachos.periodo_cierre(id) on delete cascade,
  creada_en timestamptz not null default now(),
  creada_por uuid references core.staff_user(id) on delete set null,
  correo_encolado_en timestamptz,
  unique (id, organization_id, property_id),
  unique (periodo_cierre_id)
);
create table despachos.cierre_entrega_archivo (
  id uuid primary key default gen_random_uuid(),
  entrega_id uuid not null,
  organization_id uuid not null,
  property_id uuid not null,
  tipo text not null check (tipo in ('impuestos', 'diot', 'balanza')),
  nombre_archivo text not null check (char_length(nombre_archivo) between 1 and 120 and nombre_archivo !~ '[/\\<>:"|?*[:cntrl:]]'),
  tamano_bytes integer not null check (tamano_bytes between 1 and 5242880),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  contenido bytea not null,
  creado_en timestamptz not null default now(),
  unique (entrega_id, tipo),
  foreign key (entrega_id, organization_id, property_id) references despachos.cierre_entrega (id, organization_id, property_id) on delete cascade
);
alter table despachos.cierre_entrega enable row level security;
alter table despachos.cierre_entrega_archivo enable row level security;
revoke all on despachos.cierre_entrega, despachos.cierre_entrega_archivo from public, anon, authenticated;
create policy "staff ve las entregas de cierre de sus clientes" on despachos.cierre_entrega for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff ve los archivos de entrega de sus clientes" on despachos.cierre_entrega_archivo for select
  using (core.has_property_access(auth.uid(), property_id));
grant select on despachos.cierre_entrega to authenticated;
-- Sin `contenido`: el PDF solo sale por el portal (con token vigente) o por la funcion de staff de abajo.
grant select (id, entrega_id, organization_id, property_id, tipo, nombre_archivo, tamano_bytes, sha256, creado_en) on despachos.cierre_entrega_archivo to authenticated;
grant select, insert, update, delete on despachos.cierre_entrega, despachos.cierre_entrega_archivo to service_role;

-- STAFF: abre (idempotente) la entrega de un periodo CERRADO de un cliente con opt-in y correo de contacto.
create or replace function despachos.cierre_entrega_crear(p_property_id uuid, p_periodo_id uuid)
returns table (out_id uuid, out_creada boolean, out_contacto_correo text, out_anio integer, out_mes integer)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_anio integer;
  v_mes integer;
  v_correo text;
  v_optin boolean;
  v_id uuid;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'cierre_entrega_crear: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select c.organization_id, c.anio, c.mes into v_org, v_anio, v_mes
    from despachos.periodo_cierre c where c.id = p_periodo_id and c.property_id = p_property_id and c.status = 'closed';
  if v_org is null then
    raise exception 'cierre_entrega_crear: el periodo no existe o no está cerrado' using errcode = 'P0002';
  end if;
  select a.contacto_correo, a.envio_reportes_cierre into v_correo, v_optin from despachos.cliente_automatizacion a where a.property_id = p_property_id;
  if not coalesce(v_optin, false) or v_correo is null then
    raise exception 'cierre_entrega_crear: el cliente no tiene activado el envío de reportes' using errcode = '22023';
  end if;
  insert into despachos.cierre_entrega (organization_id, property_id, periodo_cierre_id, creada_por)
  values (v_org, p_property_id, p_periodo_id, auth.uid())
  on conflict (periodo_cierre_id) do nothing
  returning id into v_id;
  if v_id is not null then
    return query select v_id, true, v_correo, v_anio, v_mes;
  else
    select e.id into v_id from despachos.cierre_entrega e where e.periodo_cierre_id = p_periodo_id;
    return query select v_id, false, v_correo, v_anio, v_mes;
  end if;
end;
$$;
revoke all on function despachos.cierre_entrega_crear(uuid, uuid) from public, anon;
grant execute on function despachos.cierre_entrega_crear(uuid, uuid) to authenticated;

create or replace function despachos.cierre_entrega_archivo_agregar(p_property_id uuid, p_entrega_id uuid, p_tipo text, p_nombre text, p_contenido bytea)
returns boolean
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_n integer;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'cierre_entrega_archivo_agregar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select e.organization_id into v_org from despachos.cierre_entrega e where e.id = p_entrega_id and e.property_id = p_property_id;
  if v_org is null then
    raise exception 'cierre_entrega_archivo_agregar: entrega no encontrada' using errcode = 'P0002';
  end if;
  if p_contenido is null or octet_length(p_contenido) < 5 or octet_length(p_contenido) > 5242880 or substring(p_contenido from 1 for 5) <> '\x255044462d'::bytea then
    raise exception 'cierre_entrega_archivo_agregar: se esperaba un PDF de hasta 5 MiB' using errcode = '22023';
  end if;
  insert into despachos.cierre_entrega_archivo (entrega_id, organization_id, property_id, tipo, nombre_archivo, tamano_bytes, sha256, contenido)
  values (p_entrega_id, v_org, p_property_id, p_tipo, p_nombre, octet_length(p_contenido), encode(sha256(p_contenido), 'hex'), p_contenido)
  on conflict (entrega_id, tipo) do nothing;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;
revoke all on function despachos.cierre_entrega_archivo_agregar(uuid, uuid, text, text, bytea) from public, anon;
grant execute on function despachos.cierre_entrega_archivo_agregar(uuid, uuid, text, text, bytea) to authenticated;

-- STAFF: marca que el correo de la entrega ya se encolo (idempotencia del envio).
create or replace function despachos.cierre_entrega_marcar_correo(p_property_id uuid, p_entrega_id uuid)
returns boolean
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_n integer;
begin
  if auth.uid() is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'cierre_entrega_marcar_correo: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  update despachos.cierre_entrega set correo_encolado_en = now()
   where id = p_entrega_id and property_id = p_property_id and correo_encolado_en is null;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;
revoke all on function despachos.cierre_entrega_marcar_correo(uuid, uuid) from public, anon;
grant execute on function despachos.cierre_entrega_marcar_correo(uuid, uuid) to authenticated;

-- PORTAL (sistema): entregas publicadas para el cliente de ESTE enlace.
create or replace function despachos.portal_cliente_reportes(p_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
declare
  v despachos.portal_cliente_enlace;
begin
  if auth.uid() is not null then
    raise exception 'portal_cliente_reportes: solo alcanzable desde sesión de sistema' using errcode = '42501';
  end if;
  v := despachos.portal_cliente_enlace_resolver(p_token_hash);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'anio', c.anio, 'mes', c.mes, 'publicada_en', e.creada_en,
             'archivos', coalesce((
               select jsonb_agg(jsonb_build_object('id', a.id, 'tipo', a.tipo, 'nombre_archivo', a.nombre_archivo, 'tamano_bytes', a.tamano_bytes) order by a.tipo)
               from despachos.cierre_entrega_archivo a where a.entrega_id = e.id), '[]'::jsonb))
           order by c.anio desc, c.mes desc)
    from (select * from despachos.cierre_entrega x where x.property_id = v.property_id order by x.creada_en desc limit 12) e
    join despachos.periodo_cierre c on c.id = e.periodo_cierre_id
  ), '[]'::jsonb);
end;
$$;
revoke all on function despachos.portal_cliente_reportes(text) from public, anon;
grant execute on function despachos.portal_cliente_reportes(text) to authenticated;

create or replace function despachos.portal_cliente_reporte_contenido(p_token_hash text, p_archivo_id uuid)
returns table (out_nombre_archivo text, out_contenido bytea)
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
declare
  v despachos.portal_cliente_enlace;
begin
  if auth.uid() is not null then
    raise exception 'portal_cliente_reporte_contenido: solo alcanzable desde sesión de sistema' using errcode = '42501';
  end if;
  v := despachos.portal_cliente_enlace_resolver(p_token_hash);
  return query select a.nombre_archivo, a.contenido from despachos.cierre_entrega_archivo a where a.id = p_archivo_id and a.property_id = v.property_id;
  if not found then
    raise exception 'archivo_no_valido' using errcode = 'P0002';
  end if;
end;
$$;
revoke all on function despachos.portal_cliente_reporte_contenido(text, uuid) from public, anon;
grant execute on function despachos.portal_cliente_reporte_contenido(text, uuid) to authenticated;

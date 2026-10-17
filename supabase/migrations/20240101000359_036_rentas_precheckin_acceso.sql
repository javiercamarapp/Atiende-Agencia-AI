-- Rn-P3-08 / Rn-P3-09 (P1) -- pre-check-in publico por reserva y entrega manual de los accesos omitidos.
--
-- Contexto. Las reservas de Airbnb, Booking y Vrbo llegan por iCal SIN correo del huesped, asi que la liberacion automatica
-- de acceso (025/028) las omite con 'omitida_sin_contacto' y nadie recibe el codigo. Esta migracion agrega:
--   A) rentas.precheckin_config: reglamento de la casa por property (texto que el huesped acepta al capturar).
--   B) rentas.precheckin_captura: WhatsApp opcional y evidencia de aceptacion (aviso de privacidad y reglamento) por reserva.
--      El correo NO se duplica: se guarda en rentas.guest_minimo.contacto, que es lo que la liberacion de acceso ya lee.
--   C) rentas.precheckin_intento / rentas.precheckin_token: defensa contra abuso del formulario publico (bloqueo tras 5
--      intentos fallidos por codigo durante 1 h) y token de un solo uso entre la verificacion y la captura.
--   D) Dos eventos nuevos de bitacora de acceso ('entregada_manual', 'precheckin_capturado') y la via de liberacion 'manual'.
--   E) Funciones de SOLO-SISTEMA (auth.uid() is null) para el formulario publico y una de staff para marcar la entrega manual.
--   F) La purga de retencion de rentas_huesped_pii tambien pone en NULL el WhatsApp capturado (cuerpo vigente de 035 + un bloque).
--
-- Aditiva: tablas y funciones nuevas; solo se reescriben dos CHECK (se AMPLIAN, nunca se restringen) y la funcion de purga
-- (create or replace con el cuerpo vigente de 035). El codigo TypeScript que la usa cae a "no disponible aun" si la base todavia no
-- la tiene (SQLSTATE 42883/42P01/42703), nunca a un 500.
-- Requiere: 025 (acceso_*), 028 (retencion), 035 (rentas.ocupacion.codigo_confirmacion / telefono_ultimos4).
--
-- Decision de diseno (se declara en el PR): el reglamento NO va en rentas.property_config porque esa tabla es solo-lectura para el
-- staff (no tiene GRANT de escritura); una tabla propia con RLS de can_manage_acceso evita abrir escritura sobre property_config.

-- ---------------------------------------------------------------------------
-- A) Reglamento de la casa por property.
-- ---------------------------------------------------------------------------
create table rentas.precheckin_config (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- NULL = la property no pide aceptar reglamento. Se versiona: cada cambio de texto sube la version, y la captura guarda la
  -- version que el huesped acepto.
  reglamento text check (reglamento is null or (btrim(reglamento) <> '' and char_length(reglamento) <= 4000)),
  reglamento_version integer not null default 1 check (reglamento_version >= 1),
  updated_at timestamptz not null default now(),
  updated_by uuid references core.staff_user(id) on delete set null
);

alter table rentas.precheckin_config enable row level security;

-- Seguridad (RLS): solo can_manage_acceso (admin_gestora / operador:acceso_total) de la property lee y escribe. El with check
-- amarra la property a la organizacion declarada. Sin DELETE para authenticated. El huesped NO lee esta tabla: el formulario
-- publico la lee por rentas.precheckin_info (funcion de sistema que devuelve solo el reglamento).
create policy "admin ve el reglamento de su property" on rentas.precheckin_config for select
  using (rentas.can_manage_acceso(property_id));
create policy "admin crea el reglamento de su property" on rentas.precheckin_config for insert
  with check (rentas.can_manage_acceso(property_id) and updated_by = auth.uid()
    and exists (select 1 from core.property p where p.id = precheckin_config.property_id and p.organization_id = precheckin_config.organization_id));
create policy "admin edita el reglamento de su property" on rentas.precheckin_config for update
  using (rentas.can_manage_acceso(property_id))
  with check (rentas.can_manage_acceso(property_id) and updated_by = auth.uid());

revoke all on rentas.precheckin_config from public, anon;
grant select on rentas.precheckin_config to authenticated;
-- GRANT por columna: property_id/organization_id son inmutables para el staff.
grant insert (property_id, organization_id, reglamento, reglamento_version, updated_by) on rentas.precheckin_config to authenticated;
grant update (reglamento, reglamento_version, updated_at, updated_by) on rentas.precheckin_config to authenticated;
grant select, insert, update, delete on rentas.precheckin_config to service_role;

-- ---------------------------------------------------------------------------
-- B) Captura del pre-check-in (WhatsApp opcional + evidencia de aceptacion).
-- ---------------------------------------------------------------------------
create table rentas.precheckin_captura (
  ocupacion_id uuid primary key references rentas.ocupacion(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  -- Solo digitos con lada (10 a 15). Dato personal de la clase de retencion rentas_huesped_pii: se pone en NULL por la purga (F).
  whatsapp text check (whatsapp is null or whatsapp ~ '^[0-9]{10,15}$'),
  acepto_privacidad_en timestamptz not null,
  aviso_version text not null check (aviso_version ~ '^[A-Za-z0-9._-]{1,40}$'),
  acepto_reglamento_en timestamptz,
  reglamento_version integer check (reglamento_version is null or reglamento_version >= 1),
  capturado_en timestamptz not null default now(),
  constraint precheckin_captura_reglamento_coherente check ((acepto_reglamento_en is null) = (reglamento_version is null))
);
create index precheckin_captura_property_idx on rentas.precheckin_captura (property_id);

alter table rentas.precheckin_captura enable row level security;

-- Seguridad: el staff con can_manage_acceso solo LEE (para saber que la reserva ya capturo y que acepto). No hay GRANT de
-- escritura para authenticated: la unica forma de escribir es rentas.precheckin_capturar (sistema), que valida un token de un
-- solo uso. Asi nadie fabrica una "aceptacion" con un INSERT directo.
create policy "admin ve las capturas de pre-check-in de su property" on rentas.precheckin_captura for select
  using (rentas.can_manage_acceso(property_id));

revoke all on rentas.precheckin_captura from public, anon;
grant select on rentas.precheckin_captura to authenticated;
grant select, insert, update, delete on rentas.precheckin_captura to service_role;

-- ---------------------------------------------------------------------------
-- C) Defensa contra abuso: intentos fallidos y token de un solo uso.
-- ---------------------------------------------------------------------------
-- Los intentos se cuentan por (property, hash del codigo), exista o no la reserva: asi un codigo inexistente y uno real se
-- comportan igual (sin oraculo de existencia). clave_hash = sha256(property || ':' || codigo normalizado) calculado por la
-- aplicacion; la base nunca guarda el codigo ni el telefono de un intento.
create table rentas.precheckin_intento (
  property_id uuid not null references core.property(id) on delete cascade,
  clave_hash text not null check (clave_hash ~ '^[0-9a-f]{64}$'),
  fallos integer not null default 0 check (fallos >= 0),
  ventana_inicio timestamptz not null default now(),
  bloqueado_hasta timestamptz,
  primary key (property_id, clave_hash)
);
create index precheckin_intento_ventana_idx on rentas.precheckin_intento (property_id, ventana_inicio);

-- Token entre "verifique" y "capture": la aplicacion genera 32 bytes aleatorios, entrega el token al huesped y guarda solo su
-- sha256. Vigencia corta y un solo uso (usado_en).
create table rentas.precheckin_token (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  ocupacion_id uuid not null references rentas.ocupacion(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  expira_en timestamptz not null,
  usado_en timestamptz,
  creado_en timestamptz not null default now()
);
create index precheckin_token_property_idx on rentas.precheckin_token (property_id, expira_en);

alter table rentas.precheckin_intento enable row level security;
alter table rentas.precheckin_token enable row level security;

-- Seguridad: RLS activa SIN politicas y sin GRANT a authenticated/anon -> ningun rol de la aplicacion las lee ni las escribe
-- directamente; solo las funciones security definer de (E) (y service_role).
revoke all on rentas.precheckin_intento, rentas.precheckin_token from public, anon, authenticated;
grant select, insert, update, delete on rentas.precheckin_intento, rentas.precheckin_token to service_role;

-- ---------------------------------------------------------------------------
-- D) Eventos de bitacora de acceso y via de liberacion 'manual'.
-- ---------------------------------------------------------------------------
-- Se AMPLIAN los CHECK existentes (025); los eventos viejos siguen siendo validos.
alter table rentas.acceso_bitacora drop constraint acceso_bitacora_evento_check;
alter table rentas.acceso_bitacora add constraint acceso_bitacora_evento_check
  check (evento in ('liberada', 'omitida_sin_contacto', 'omitida_sin_instrucciones', 'error_envio', 'entregada_manual', 'precheckin_capturado'));
alter table rentas.acceso_reserva drop constraint acceso_reserva_liberado_via_check;
alter table rentas.acceso_reserva add constraint acceso_reserva_liberado_via_check
  check (liberado_via is null or liberado_via in ('email', 'manual'));

-- ---------------------------------------------------------------------------
-- E1) Datos publicos del formulario (SOLO SISTEMA).
-- ---------------------------------------------------------------------------
-- Seguridad: security definer con search_path fijo; exige auth.uid() is null (la sesion de sistema de la API publica) y rechaza
-- con 42501 a cualquier usuario autenticado; EXECUTE revocado a public/anon. Devuelve solo nombres y el reglamento de UNA
-- property de rentas activa (nunca datos de huespedes). Property inexistente o de otro vertical: cero filas.
create function rentas.precheckin_info(p_property_id uuid)
returns table (propiedad_nombre text, organizacion_nombre text, reglamento text, reglamento_version integer)
language plpgsql
stable
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'rentas.precheckin_info: solo la sesion de sistema (auth.uid() es NULL).' using errcode = '42501';
  end if;
  return query
  select p.name, org.name, pc.reglamento, coalesce(pc.reglamento_version, 1)
  from core.property p
  join core.organization org on org.id = p.organization_id
  left join rentas.precheckin_config pc on pc.property_id = p.id
  where p.id = p_property_id and p.vertical = 'rentas' and p.status = 'active';
end;
$$;
revoke all on function rentas.precheckin_info(uuid) from public, anon;
grant execute on function rentas.precheckin_info(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- E2) Verificar codigo + ultimos 4 digitos (SOLO SISTEMA).
-- ---------------------------------------------------------------------------
-- Seguridad: security definer, search_path fijo, auth.uid() is null, EXECUTE solo authenticated (rol de la sesion de sistema)
-- y service_role. NUNCA lanza por un intento incorrecto (las excepciones revertirian el conteo de fallos): devuelve un
-- resultado. Resultados:
--   'ok'        -> coincide con una reserva CONFIRMADA de ESTA property cuya salida aun no ocurrio; se emitio un token.
--   'invalido'  -> no coincide (codigo inexistente, telefono distinto, reserva pasada/cancelada, otra property): mismo
--                  resultado para todos los casos, sin oraculo de existencia; suma un fallo.
--   'bloqueado' -> 5 fallos con ese codigo en la ultima hora: bloqueado 1 h (aplica por igual a codigos que no existen).
-- La property de la URL acota la busqueda: un codigo de otra property (o de otra organizacion) nunca coincide.
create function rentas.precheckin_verificar(p_property_id uuid, p_codigo text, p_ultimos4 text, p_clave_hash text, p_token_hash text)
returns table (resultado text, ocupacion_id uuid, propiedad_nombre text, unidad_nombre text, check_in date, check_out date, ya_capturado boolean, token_expira_en timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_codigo text := upper(btrim(coalesce(p_codigo, '')));
  v_org uuid;
  v_prop_nombre text;
  v_zona text;
  v_bloqueado timestamptz;
  v_occ uuid;
  v_unidad text;
  v_in date;
  v_out date;
  v_expira timestamptz := now() + interval '15 minutes';
begin
  if auth.uid() is not null then
    raise exception 'rentas.precheckin_verificar: solo la sesion de sistema (auth.uid() es NULL).' using errcode = '42501';
  end if;
  if v_codigo !~ '^[A-Z0-9]{1,40}$' or coalesce(p_ultimos4, '') !~ '^[0-9]{4}$' or coalesce(p_clave_hash, '') !~ '^[0-9a-f]{64}$' or coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'rentas.precheckin_verificar: parametros con forma invalida.' using errcode = '22023';
  end if;

  select p.organization_id, p.name, pc.zona_horaria into v_org, v_prop_nombre, v_zona
  from core.property p join rentas.property_config pc on pc.property_id = p.id
  where p.id = p_property_id and p.vertical = 'rentas' and p.status = 'active';
  if v_org is null then
    return query select 'invalido'::text, null::uuid, null::text, null::text, null::date, null::date, false, null::timestamptz;
    return;
  end if;

  -- Limpieza oportunista y acotada a la property (los intentos de mas de 1 dia y los tokens vencidos hace mas de 1 dia).
  delete from rentas.precheckin_intento i where i.property_id = p_property_id and i.ventana_inicio < now() - interval '1 day' and (i.bloqueado_hasta is null or i.bloqueado_hasta < now());
  delete from rentas.precheckin_token t where t.property_id = p_property_id and t.expira_en < now() - interval '1 day';

  select i.bloqueado_hasta into v_bloqueado from rentas.precheckin_intento i where i.property_id = p_property_id and i.clave_hash = p_clave_hash for update;
  if v_bloqueado is not null and v_bloqueado > now() then
    return query select 'bloqueado'::text, null::uuid, null::text, null::text, null::date, null::date, false, null::timestamptz;
    return;
  end if;

  select o.id, u.name, lower(o.rango), upper(o.rango) into v_occ, v_unidad, v_in, v_out
  from rentas.ocupacion o
  join rentas.unidad u on u.id = o.unidad_id
  where o.property_id = p_property_id and o.capa = 'reserva' and o.estado = 'confirmado'
    and upper(o.codigo_confirmacion) = v_codigo and o.telefono_ultimos4 = p_ultimos4
    and upper(o.rango) > (now() at time zone v_zona)::date
  order by lower(o.rango), o.id
  limit 1;

  if v_occ is null then
    insert into rentas.precheckin_intento as i (property_id, clave_hash, fallos, ventana_inicio, bloqueado_hasta)
    values (p_property_id, p_clave_hash, 1, now(), null)
    on conflict (property_id, clave_hash) do update set
      fallos = case when i.ventana_inicio < now() - interval '1 hour' then 1 else i.fallos + 1 end,
      ventana_inicio = case when i.ventana_inicio < now() - interval '1 hour' then now() else i.ventana_inicio end,
      bloqueado_hasta = case when (case when i.ventana_inicio < now() - interval '1 hour' then 1 else i.fallos + 1 end) >= 5 then now() + interval '1 hour' else null end;
    return query select 'invalido'::text, null::uuid, null::text, null::text, null::date, null::date, false, null::timestamptz;
    return;
  end if;

  delete from rentas.precheckin_intento i where i.property_id = p_property_id and i.clave_hash = p_clave_hash;
  insert into rentas.precheckin_token (token_hash, ocupacion_id, organization_id, property_id, expira_en)
  values (p_token_hash, v_occ, v_org, p_property_id, v_expira);

  return query select 'ok'::text, v_occ, v_prop_nombre, v_unidad, v_in, v_out, exists (select 1 from rentas.precheckin_captura c where c.ocupacion_id = v_occ), v_expira;
end;
$$;
revoke all on function rentas.precheckin_verificar(uuid, text, text, text, text) from public, anon;
grant execute on function rentas.precheckin_verificar(uuid, text, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- E3) Capturar contacto con el token de un solo uso (SOLO SISTEMA).
-- ---------------------------------------------------------------------------
-- Seguridad: security definer, search_path fijo, auth.uid() is null. Property y organizacion se derivan SIEMPRE del token (nunca
-- de parametros). El token se consume al capturar (un solo uso) y vence a los 15 min. Resultados:
--   'ok'                    -> correo (y WhatsApp) guardados, aceptaciones registradas, bitacora 'precheckin_capturado'.
--   'token_invalido'        -> token inexistente, usado, vencido o su reserva ya no es elegible.
--   'privacidad_requerida'  -> no acepto el aviso de privacidad (el token NO se consume: puede reintentar).
--   'reglamento_requerido'  -> la property tiene reglamento y no lo acepto (el token NO se consume).
--   'ya_capturado'          -> la reserva ya tenia una captura: NO se sobrescribe (evita redirigir el acceso a otro correo);
--                              el token se consume.
-- El correo se guarda en rentas.guest_minimo.contacto SOLO si la reserva no tenia un correo valido (nunca pisa uno del staff).
-- Un dato con forma invalida lanza 22023 (la transaccion revierte y el token NO se consume).
create function rentas.precheckin_capturar(p_token_hash text, p_correo text, p_whatsapp text, p_acepta_privacidad boolean, p_aviso_version text, p_acepta_reglamento boolean)
returns table (resultado text, ocupacion_id uuid, correo_guardado boolean)
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_correo text := btrim(coalesce(p_correo, ''));
  v_tok rentas.precheckin_token%rowtype;
  v_occ rentas.ocupacion%rowtype;
  v_reglamento text;
  v_reg_version integer;
  v_zona text;
  v_guest uuid;
  v_contacto text;
  v_guardado boolean := false;
begin
  if auth.uid() is not null then
    raise exception 'rentas.precheckin_capturar: solo la sesion de sistema (auth.uid() es NULL).' using errcode = '42501';
  end if;
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'rentas.precheckin_capturar: token con forma invalida.' using errcode = '22023';
  end if;
  if char_length(v_correo) > 254 or v_correo !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'rentas.precheckin_capturar: correo con forma invalida.' using errcode = '22023';
  end if;
  if p_whatsapp is not null and p_whatsapp !~ '^[0-9]{10,15}$' then
    raise exception 'rentas.precheckin_capturar: whatsapp con forma invalida.' using errcode = '22023';
  end if;
  if coalesce(p_aviso_version, '') !~ '^[A-Za-z0-9._-]{1,40}$' then
    raise exception 'rentas.precheckin_capturar: version del aviso con forma invalida.' using errcode = '22023';
  end if;

  select * into v_tok from rentas.precheckin_token t where t.token_hash = p_token_hash and t.usado_en is null and t.expira_en > now() for update;
  if not found then
    return query select 'token_invalido'::text, null::uuid, false;
    return;
  end if;

  if not coalesce(p_acepta_privacidad, false) then
    return query select 'privacidad_requerida'::text, null::uuid, false;
    return;
  end if;
  select c.reglamento, c.reglamento_version into v_reglamento, v_reg_version from rentas.precheckin_config c where c.property_id = v_tok.property_id;
  if v_reglamento is not null and not coalesce(p_acepta_reglamento, false) then
    return query select 'reglamento_requerido'::text, null::uuid, false;
    return;
  end if;

  select o.* into v_occ from rentas.ocupacion o where o.id = v_tok.ocupacion_id and o.capa = 'reserva' and o.estado = 'confirmado';
  select pc.zona_horaria into v_zona from rentas.property_config pc where pc.property_id = v_tok.property_id;
  if v_occ.id is null or v_zona is null or upper(v_occ.rango) <= (now() at time zone v_zona)::date then
    update rentas.precheckin_token set usado_en = now() where token_hash = p_token_hash;
    return query select 'token_invalido'::text, null::uuid, false;
    return;
  end if;

  update rentas.precheckin_token set usado_en = now() where token_hash = p_token_hash;

  if exists (select 1 from rentas.precheckin_captura c where c.ocupacion_id = v_occ.id) then
    return query select 'ya_capturado'::text, v_occ.id, false;
    return;
  end if;

  v_guest := v_occ.huesped_minimo_id;
  if v_guest is null then
    insert into rentas.guest_minimo (organization_id, property_id, nombre, contacto) values (v_occ.organization_id, v_occ.property_id, null, v_correo) returning id into v_guest;
    update rentas.ocupacion set huesped_minimo_id = v_guest, updated_at = now() where id = v_occ.id;
    v_guardado := true;
  else
    select g.contacto into v_contacto from rentas.guest_minimo g where g.id = v_guest;
    if v_contacto is null or v_contacto !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
      update rentas.guest_minimo set contacto = v_correo where id = v_guest;
      v_guardado := true;
    end if;
  end if;

  insert into rentas.precheckin_captura (ocupacion_id, organization_id, property_id, whatsapp, acepto_privacidad_en, aviso_version, acepto_reglamento_en, reglamento_version)
  values (v_occ.id, v_occ.organization_id, v_occ.property_id, p_whatsapp, now(), p_aviso_version,
          case when v_reglamento is not null then now() else null end,
          case when v_reglamento is not null then v_reg_version else null end);
  insert into rentas.acceso_bitacora (organization_id, property_id, ocupacion_id, evento, canal)
  values (v_occ.organization_id, v_occ.property_id, v_occ.id, 'precheckin_capturado', null);

  return query select 'ok'::text, v_occ.id, v_guardado;
end;
$$;
revoke all on function rentas.precheckin_capturar(text, text, text, boolean, text, boolean) from public, anon;
grant execute on function rentas.precheckin_capturar(text, text, text, boolean, text, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- E4) Marcar un acceso como entregado a mano por la OTA (STAFF).
-- ---------------------------------------------------------------------------
-- Seguridad: security definer con search_path fijo; exige un actor real (auth.uid() no nulo), property resuelta DESDE la ocupacion
-- (nunca de un parametro) y can_manage_acceso de esa property. La bitacora de acceso no guarda actor (igual que 025). P0002 si la
-- reserva no existe o no es accesible (no distingue "no existe" de "no es tuya": sin oraculo cross-tenant). Idempotente: devuelve true solo la primera vez. Despues de marcarla, la liberacion automatica ya no la toma.
create function rentas.acceso_marcar_entregada_manual(p_ocupacion_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_org uuid;
  v_prop uuid;
  v_nueva boolean;
begin
  if auth.uid() is null then
    raise exception 'rentas.acceso_marcar_entregada_manual: requiere un usuario autenticado.' using errcode = '42501';
  end if;
  select o.organization_id, o.property_id into v_org, v_prop
  from rentas.ocupacion o
  where o.id = p_ocupacion_id and o.capa = 'reserva' and o.estado = 'confirmado';
  if v_prop is null or not rentas.can_manage_acceso(v_prop) then
    raise exception 'rentas.acceso_marcar_entregada_manual: reserva no encontrada.' using errcode = 'P0002';
  end if;

  insert into rentas.acceso_reserva (ocupacion_id, organization_id, property_id, liberado_en, liberado_via)
  values (p_ocupacion_id, v_org, v_prop, now(), 'manual')
  on conflict (ocupacion_id) do update
    set liberado_en = now(), liberado_via = 'manual'
    where rentas.acceso_reserva.liberado_en is null
  returning true into v_nueva;

  if coalesce(v_nueva, false) then
    insert into rentas.acceso_bitacora (organization_id, property_id, ocupacion_id, evento, canal)
    values (v_org, v_prop, p_ocupacion_id, 'entregada_manual', null);
  end if;
  return coalesce(v_nueva, false);
end;
$$;
revoke all on function rentas.acceso_marcar_entregada_manual(uuid) from public, anon;
grant execute on function rentas.acceso_marcar_entregada_manual(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- F) Purga de retencion: cuerpo vigente de 035 + bloque del WhatsApp capturado.
-- ---------------------------------------------------------------------------
-- Sin cambios de permisos respecto de 035 (solo la invoca core.system_run_retention_purge; ningun rol de la aplicacion).
create or replace function rentas.system_purge_retencion(p_org uuid, p_class text, p_cutoff timestamptz, p_dry boolean, p_limit integer)
returns table (out_afectadas integer, out_anonimizadas integer, out_protegidas integer)
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_dia_corte date := (p_cutoff at time zone 'UTC')::date;
  v_afectadas integer := 0;
  v_anon integer := 0;
  v_prot integer := 0;
  v_tel integer := 0;
  v_wa integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'rentas.system_purge_retencion: solo la sesion de sistema (auth.uid() es NULL).' using errcode = '42501';
  end if;
  if p_class = 'rentas_huesped_pii' then
    -- Elegible: huesped con datos, creado antes del corte y sin estancia que termine en o despues del dia de corte.
    -- Protegido (se conserva): coincide por contacto o nombre con una solicitud ARCO abierta de la organizacion.
    select count(*) into v_prot
      from rentas.guest_minimo g
     where g.organization_id = p_org and (g.nombre is not null or g.contacto is not null) and g.created_at < p_cutoff
       and not exists (select 1 from rentas.ocupacion o where o.huesped_minimo_id = g.id and upper(o.rango) >= v_dia_corte)
       and exists (
         select 1 from rentas.arco_solicitud r
          where r.organization_id = g.organization_id and r.estado in ('recibida', 'en_proceso', 'bloqueada')
            and (lower(btrim(r.solicitante_contacto)) = lower(btrim(coalesce(g.contacto, '')))
                 or lower(btrim(r.solicitante_nombre)) = lower(btrim(coalesce(g.nombre, ''))))
       );
    if p_dry then
      select count(*) into v_afectadas from (
        select 1 from rentas.guest_minimo g
         where g.organization_id = p_org and (g.nombre is not null or g.contacto is not null) and g.created_at < p_cutoff
           and not exists (select 1 from rentas.ocupacion o where o.huesped_minimo_id = g.id and upper(o.rango) >= v_dia_corte)
           and not exists (
             select 1 from rentas.arco_solicitud r
              where r.organization_id = g.organization_id and r.estado in ('recibida', 'en_proceso', 'bloqueada')
                and (lower(btrim(r.solicitante_contacto)) = lower(btrim(coalesce(g.contacto, '')))
                     or lower(btrim(r.solicitante_nombre)) = lower(btrim(coalesce(g.nombre, ''))))
           )
         order by g.created_at limit v_limit
      ) s;
    else
      with victimas as (
        select g.id from rentas.guest_minimo g
         where g.organization_id = p_org and (g.nombre is not null or g.contacto is not null) and g.created_at < p_cutoff
           and not exists (select 1 from rentas.ocupacion o where o.huesped_minimo_id = g.id and upper(o.rango) >= v_dia_corte)
           and not exists (
             select 1 from rentas.arco_solicitud r
              where r.organization_id = g.organization_id and r.estado in ('recibida', 'en_proceso', 'bloqueada')
                and (lower(btrim(r.solicitante_contacto)) = lower(btrim(coalesce(g.contacto, '')))
                     or lower(btrim(r.solicitante_nombre)) = lower(btrim(coalesce(g.nombre, ''))))
           )
         order by g.created_at limit v_limit
      ), anonimizados as (
        update rentas.guest_minimo g set nombre = null, contacto = null from victimas v where g.id = v.id returning 1
      )
      select count(*) into v_afectadas from anonimizados;
    end if;
    -- Rn-P3-05 (035): ultimos 4 digitos del telefono que el feed iCal trae por reserva (rentas.ocupacion.telefono_ultimos4).
    -- Elegible: reserva cuya salida es anterior al dia de corte. Se pone en NULL el dato; la reserva y sus montos se conservan.
    if p_dry then
      select count(*) into v_tel from (
        select 1 from rentas.ocupacion o
         where o.organization_id = p_org and o.telefono_ultimos4 is not null and upper(o.rango) < v_dia_corte
         order by o.updated_at limit v_limit
      ) s;
    else
      with victimas as (
        select o.id from rentas.ocupacion o
         where o.organization_id = p_org and o.telefono_ultimos4 is not null and upper(o.rango) < v_dia_corte
         order by o.updated_at limit v_limit
      ), limpiados as (
        update rentas.ocupacion o set telefono_ultimos4 = null from victimas v where o.id = v.id returning 1
      )
      select count(*) into v_tel from limpiados;
    end if;
    -- Rn-P3-08 (036): WhatsApp capturado en el pre-check-in. Elegible: reserva cuya salida es anterior al dia de corte. Se pone en
    -- NULL el dato; la evidencia de aceptacion (fechas y versiones) se conserva sin datos personales.
    if p_dry then
      select count(*) into v_wa from (
        select 1 from rentas.precheckin_captura c join rentas.ocupacion o on o.id = c.ocupacion_id
         where c.organization_id = p_org and c.whatsapp is not null and upper(o.rango) < v_dia_corte
         order by c.capturado_en limit v_limit
      ) s;
    else
      with victimas as (
        select c.ocupacion_id from rentas.precheckin_captura c join rentas.ocupacion o on o.id = c.ocupacion_id
         where c.organization_id = p_org and c.whatsapp is not null and upper(o.rango) < v_dia_corte
         order by c.capturado_en limit v_limit
      ), limpiados as (
        update rentas.precheckin_captura c set whatsapp = null from victimas v where c.ocupacion_id = v.ocupacion_id returning 1
      )
      select count(*) into v_wa from limpiados;
    end if;
    v_afectadas := v_afectadas + v_tel + v_wa;
    v_anon := v_afectadas;
  elsif p_class = 'rentas_acceso_instrucciones' then
    -- Elegible: instrucciones sin tocar desde antes del corte y unidad sin reserva (no cancelada) que termine en o
    -- despues del dia de corte (nada vigente ni futuro ni reciente). No son datos de un titular: sin proteccion ARCO.
    if p_dry then
      select count(*) into v_afectadas from (
        select 1 from rentas.acceso_instruccion ai
         where ai.organization_id = p_org and ai.updated_at < p_cutoff
           and not exists (select 1 from rentas.ocupacion o where o.unidad_id = ai.unidad_id and o.capa = 'reserva' and o.estado <> 'cancelado' and upper(o.rango) >= v_dia_corte)
         order by ai.updated_at limit v_limit
      ) s;
    else
      with victimas as (
        select ai.unidad_id from rentas.acceso_instruccion ai
         where ai.organization_id = p_org and ai.updated_at < p_cutoff
           and not exists (select 1 from rentas.ocupacion o where o.unidad_id = ai.unidad_id and o.capa = 'reserva' and o.estado <> 'cancelado' and upper(o.rango) >= v_dia_corte)
         order by ai.updated_at limit v_limit
      ), borradas as (
        delete from rentas.acceso_instruccion ai using victimas v where ai.unidad_id = v.unidad_id
        returning ai.organization_id, ai.property_id, ai.unidad_id
      ), bitacora as (
        insert into rentas.acceso_instruccion_bitacora (organization_id, property_id, unidad_id, evento, actor_id)
        select b.organization_id, b.property_id, b.unidad_id, 'purga_retencion', null from borradas b returning 1
      )
      select count(*) into v_afectadas from borradas;
    end if;
  else
    raise exception 'rentas.system_purge_retencion: clase no soportada.' using errcode = '22023';
  end if;
  return query select v_afectadas, v_anon, v_prot;
end;
$$;
revoke all on function rentas.system_purge_retencion(uuid, text, timestamptz, boolean, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- G) Lectura de guest_minimo bajo la sesion de sistema (cron de recordatorios).
-- ---------------------------------------------------------------------------
-- Problema: el cron /internal/rentas/checkin-recordatorio corre con `set local role authenticated` y sub vacio (auth.uid() is null). La unica
-- policy SELECT de rentas.guest_minimo exigia core.has_property_access(auth.uid(), ...), siempre falsa con auth.uid() null, asi que el cron
-- no veia el correo del huesped: la lista de candidatas del recordatorio horario salia vacia y findOcupacionParaCorreo dejaba el contacto en NULL
-- (la reserva salia como sin_correo aunque el pre-check-in hubiera capturado el correo).
-- Solucion: el mismo escape `auth.uid() is null or ...` que 015 ya aplico a rentas.ocupacion, unidad y property_config.
-- Seguridad: (1) solo SELECT; el GRANT a authenticated no cambia (select, insert) y anon sigue sin ningun privilegio sobre la tabla;
-- (2) `auth.uid() is null` no es alcanzable desde un navegador: PostgREST/RLS siempre llevan el sub del JWT, y solo las sesiones de sistema del
-- backend (withAppSession({ userId: null })) lo tienen vacio; (3) con un usuario real la regla es la misma de antes (has_property_access);
-- (4) la policy de INSERT no se toca (no hay escape de escritura).
alter policy "staff ve huéspedes mínimos de su property" on rentas.guest_minimo
  using (auth.uid() is null or core.has_property_access(auth.uid(), property_id));

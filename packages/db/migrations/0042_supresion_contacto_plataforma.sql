-- SA-L-46: lista de supresion de PLATAFORMA (core.supresion_contacto).
--
-- Hoy el opt-out solo existe por vertical (licitaciones.whatsapp_opt_out*, migracion 030). Esta lista es
-- de plataforma: la consultan los despachadores de avisos proactivos de todas las verticales y se
-- alimenta con BAJA/STOP, rebotes, quejas, solicitudes ARCO y "no contactar" manual del superadmin.
--
-- Nunca se guarda el valor en claro: solo `valor_hash` = SHA-256 en hex de
--   'atiende:supresion:v1:<tipo>:<valor normalizado>'
-- (el prefijo separa el dominio del hash). La normalizacion la hace el API (telefono en E.164 con lada MX
-- por defecto; correo en minusculas y sin espacios), NO esta migracion: la base solo recibe el hash.
--
-- HUECO DECLARADO (fuerza bruta): el espacio de telefonos mexicanos es chico (10 digitos), asi que un
-- SHA-256 simple con prefijo fijo se puede invertir por enumeracion SI alguien obtiene la tabla. La
-- mitigacion hoy es de acceso (RLS sin policies, sin GRANT a ningun rol de la aplicacion, lectura solo por
-- funciones definer). La mejora pendiente es un HMAC con llave propia de plataforma (`v2`), que exige
-- rehashear la lista al migrar.
--
-- Modelo de acceso (mismo patron de 0033/0036): RLS habilitado SIN policies y REVOKE ALL a public, anon y
-- authenticated; todo pasa por funciones security definer con `set search_path` fijo.
--
-- Justificacion de seguridad (cada tabla/funcion/GRANT trae su razon):
--   * core.supresion_contacto: sin policy y sin GRANT => ningun rol de la app lee ni escribe directo; ni
--     siquiera un superadmin puede listar hashes por RPC (solo conteos). organization_id es informativo
--     (organizacion de origen del evento); la supresion es GLOBAL por contacto (si pidio no ser
--     contactado por Atiende, no se le envian avisos proactivos de ninguna organizacion).
--   * core.registrar_supresion: solo-sistema (auth.uid() is null, 42501 si no). Razon: la llaman los
--     webhooks entrantes y los despachadores, que corren sin sesion de usuario; una sesion de staff con
--     auth.uid() real nunca debe poder fabricar ni inundar supresiones de contactos ajenos. Idempotente
--     (unique por tipo+hash+motivo, on conflict do nothing). GRANT solo a `authenticated` (rol bajo el que
--     corre withAppSession, con o sin auth.uid()); nada a anon.
--   * core.esta_suprimido: solo-sistema por la misma razon (la consultan los despachadores). Devuelve solo
--     boolean: no revela motivo, origen ni organizacion. GRANT solo a `authenticated`.
--   * core.list_supresiones_for_superadmin: caller-binding (auth.uid() = p_caller_id) y superadmin real via
--     core.superadmin_require_caller (delega en core.platform_superadmin). Devuelve conteos por tipo,
--     motivo y origen, NUNCA hashes ni valores. GRANT solo a `authenticated`.
--   * core.agregar_no_contactar_for_superadmin: mismo guard de superadmin; registra motivo 'no_contactar'
--     con origen 'superadmin' y el actor. La ruta del API ademas exige step-up MFA. GRANT solo a
--     `authenticated`.
--
-- Orden de despliegue: CUALQUIER ORDEN. El codigo TypeScript captura SQLSTATE 42883/42P01/42703 (migracion
-- pendiente): los despachadores siguen enviando con un aviso `supresion_no_migrada` en el log (ver
-- docs/SUPRESION.md); BAJA/STOP cae al comportamiento anterior y la pagina del superadmin muestra
-- "no disponible aun". Cualquier OTRO error de lectura bloquea el envio (fail-closed).

create table core.supresion_contacto (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('telefono', 'correo')),
  valor_hash text not null check (valor_hash ~ '^[0-9a-f]{64}$'),
  motivo text not null check (motivo in ('baja', 'queja', 'rebote', 'solicitud_arco', 'no_contactar')),
  origen text not null check (origen ~ '^[a-z0-9_.:-]{1,60}$'),
  organization_id uuid references core.organization(id) on delete set null,
  creado_por uuid references core.staff_user(id) on delete set null,
  creado_en timestamptz not null default now(),
  unique (tipo, valor_hash, motivo)
);

-- La consulta caliente de los despachadores es por (tipo, valor_hash): el unique ya la sirve (prefijo).
create index supresion_contacto_motivo_origen_idx on core.supresion_contacto (motivo, origen);

alter table core.supresion_contacto enable row level security;
revoke all on core.supresion_contacto from public, anon, authenticated;

-- Insumo interno compartido (NO expuesto): valida y escribe. Solo lo invocan, como DUENO, las dos
-- funciones definer de abajo.
create or replace function core.supresion_insertar(
  p_tipo text, p_valor_hash text, p_motivo text, p_origen text, p_organization_id uuid, p_creado_por uuid
)
returns boolean language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_filas integer;
begin
  if p_tipo is null or p_tipo not in ('telefono', 'correo') then
    raise exception 'supresion: tipo invalido' using errcode = '22023';
  end if;
  if p_valor_hash is null or p_valor_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'supresion: valor_hash debe ser SHA-256 en hex (64 caracteres)' using errcode = '22023';
  end if;
  if p_motivo is null or p_motivo not in ('baja', 'queja', 'rebote', 'solicitud_arco', 'no_contactar') then
    raise exception 'supresion: motivo invalido' using errcode = '22023';
  end if;
  if p_origen is null or p_origen !~ '^[a-z0-9_.:-]{1,60}$' then
    raise exception 'supresion: origen invalido' using errcode = '22023';
  end if;
  insert into core.supresion_contacto (tipo, valor_hash, motivo, origen, organization_id, creado_por)
  values (p_tipo, p_valor_hash, p_motivo, p_origen, p_organization_id, p_creado_por)
  on conflict (tipo, valor_hash, motivo) do nothing;
  get diagnostics v_filas = row_count;
  return v_filas > 0;
end;
$$;
revoke all on function core.supresion_insertar(text, text, text, text, uuid, uuid) from public, anon, authenticated;

-- Solo sistema, idempotente. Devuelve true si la fila es nueva, false si ya existia (el llamador usa esto
-- para confirmar la baja UNA sola vez).
create or replace function core.registrar_supresion(
  p_tipo text, p_valor_hash text, p_motivo text, p_origen text, p_organization_id uuid default null
)
returns boolean language plpgsql security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'registrar_supresion: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  return core.supresion_insertar(p_tipo, p_valor_hash, p_motivo, p_origen, p_organization_id, null);
end;
$$;
revoke all on function core.registrar_supresion(text, text, text, text, uuid) from public, anon;
grant execute on function core.registrar_supresion(text, text, text, text, uuid) to authenticated;

-- Solo sistema. Boolean puro: no revela motivo ni origen.
create or replace function core.esta_suprimido(p_tipo text, p_valor_hash text)
returns boolean language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'esta_suprimido: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  if p_tipo is null or p_tipo not in ('telefono', 'correo') or p_valor_hash is null or p_valor_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'esta_suprimido: parametros invalidos' using errcode = '22023';
  end if;
  return exists (select 1 from core.supresion_contacto s where s.tipo = p_tipo and s.valor_hash = p_valor_hash);
end;
$$;
revoke all on function core.esta_suprimido(text, text) from public, anon;
grant execute on function core.esta_suprimido(text, text) to authenticated;

-- Superadmin, solo lectura agregada: conteos sin valores ni hashes.
create or replace function core.list_supresiones_for_superadmin(p_caller_id uuid)
returns table (tipo text, motivo text, origen text, total bigint, ultimo_en timestamptz)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  perform core.superadmin_require_caller(p_caller_id, 'list_supresiones_for_superadmin');
  return query
    select s.tipo, s.motivo, s.origen, count(*)::bigint, max(s.creado_en)
    from core.supresion_contacto s
    group by s.tipo, s.motivo, s.origen
    order by count(*) desc, s.motivo, s.origen, s.tipo;
end;
$$;
revoke all on function core.list_supresiones_for_superadmin(uuid) from public, anon;
grant execute on function core.list_supresiones_for_superadmin(uuid) to authenticated;

-- Superadmin: "no contactar" manual. Idempotente (devuelve false si ya estaba).
create or replace function core.agregar_no_contactar_for_superadmin(p_caller_id uuid, p_tipo text, p_valor_hash text)
returns boolean language plpgsql security definer set search_path = core, pg_temp as $$
begin
  perform core.superadmin_require_caller(p_caller_id, 'agregar_no_contactar_for_superadmin');
  return core.supresion_insertar(p_tipo, p_valor_hash, 'no_contactar', 'superadmin', null, p_caller_id);
end;
$$;
revoke all on function core.agregar_no_contactar_for_superadmin(uuid, text, text) from public, anon;
grant execute on function core.agregar_no_contactar_for_superadmin(uuid, text, text) to authenticated;

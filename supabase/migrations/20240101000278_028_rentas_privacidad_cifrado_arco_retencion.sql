-- Rn-29 / Rn-30 / Rn-07 (P1) -- privacidad de rentas: cifrado en reposo del acceso al huesped,
-- retencion de plataforma (PL-13) y solicitudes ARCO propias de rentas.
--
-- Una sola migracion (un solo prefijo de supabase/migrations asignado a esta tarea), en TRES bloques
-- independientes entre si; cada bloque es aditivo y el codigo TypeScript que lo usa cae a "no
-- disponible aun" (42883 / 42P01 / 42703) contra una base sin migrar, nunca a un 500:
--   A) Rn-29  cifrado en reposo de rentas.acceso_instruccion (direccion exacta, codigo, indicaciones).
--   B) Rn-30  clases de retencion de rentas y su purga dentro de core.system_run_retention_purge.
--   C) Rn-07  tabla ARCO de rentas y su union en core._arco_union().
-- Requiere: rentas 025 (acceso_*), core 0036 (retention_class, purge_run_log, _arco_union).
--
-- ===========================================================================================
-- A) Rn-29 -- cifrado en reposo del acceso al huesped
-- ===========================================================================================
-- Antes: direccion_exacta / codigo_acceso / instrucciones eran texto plano protegido solo por RLS
-- (025). Ahora la APLICACION cifra con AES-256-GCM (llave RENTAS_ACCESS_KEY solo en el entorno de la
-- API; patron de la boveda de hoteles, hoteles 031) y la base guarda unicamente el sobre
-- `v<version>.<iv>.<tag>.<ciphertext>`. La base NUNCA ve la llave.
--
-- Migracion de datos existentes (sin perdida): las columnas nuevas conviven con las de texto plano.
-- Un barrido idempotente de la API (/internal/rentas/acceso-cifrar) lee las filas con texto plano y sin
-- sobre, cifra, verifica el ida y vuelta y llama a rentas.acceso_instruccion_aplicar_cifrado, que guarda
-- el sobre y SOLO ENTONCES anula la columna en claro (en la misma sentencia, nunca antes).
alter table rentas.acceso_instruccion
  add column direccion_cifrada text,
  add column codigo_cifrado text,
  add column instrucciones_cifradas text,
  add column key_version smallint;

-- El texto plano pasa a ser legado: ya no es obligatorio (se anula tras cifrar).
alter table rentas.acceso_instruccion alter column direccion_exacta drop not null;

alter table rentas.acceso_instruccion
  add constraint acceso_instruccion_sobres_formato check (
    (direccion_cifrada is null or (length(direccion_cifrada) <= 4096 and direccion_cifrada ~ '^v[0-9]{1,3}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{4,}$'))
    and (codigo_cifrado is null or (length(codigo_cifrado) <= 4096 and codigo_cifrado ~ '^v[0-9]{1,3}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{4,}$'))
    and (instrucciones_cifradas is null or (length(instrucciones_cifradas) <= 8192 and instrucciones_cifradas ~ '^v[0-9]{1,3}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{4,}$'))
  ),
  add constraint acceso_instruccion_version_llave check (
    (direccion_cifrada is null and codigo_cifrado is null and instrucciones_cifradas is null) or (key_version is not null and key_version > 0)
  ),
  -- Toda fila guarda la direccion de una de las dos formas (sobre o, mientras no se barra, texto plano heredado).
  add constraint acceso_instruccion_direccion_presente check (direccion_cifrada is not null or direccion_exacta is not null);

-- Seguridad: la unica forma de escribir es cifrada. Un INSERT no puede traer texto plano y un UPDATE solo
-- puede conservarlo igual (fila heredada) o ANULARLO; nunca fijar un valor nuevo en claro. Trigger de
-- seguridad invoker (aplica a authenticated y a service_role por igual), con search_path fijo.
create function rentas.acceso_instruccion_solo_cifrado()
returns trigger
language plpgsql
set search_path = pg_catalog, rentas, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.direccion_exacta is not null or new.codigo_acceso is not null or new.instrucciones is not null then
      raise exception 'rentas.acceso_instruccion: no se acepta texto plano; la aplicacion debe cifrar antes de guardar.' using errcode = '22023';
    end if;
  else
    if (new.direccion_exacta is not null and new.direccion_exacta is distinct from old.direccion_exacta)
       or (new.codigo_acceso is not null and new.codigo_acceso is distinct from old.codigo_acceso)
       or (new.instrucciones is not null and new.instrucciones is distinct from old.instrucciones) then
      raise exception 'rentas.acceso_instruccion: no se acepta texto plano; la aplicacion debe cifrar antes de guardar.' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
create trigger acceso_instruccion_solo_cifrado_trg
  before insert or update on rentas.acceso_instruccion
  for each row execute function rentas.acceso_instruccion_solo_cifrado();

-- GRANT por columna: el staff escribe los sobres (y puede anular el texto heredado al reescribir, ya
-- concedido en 025); lo demas sigue inmutable.
grant insert (direccion_cifrada, codigo_cifrado, instrucciones_cifradas, key_version) on rentas.acceso_instruccion to authenticated;
grant update (direccion_cifrada, codigo_cifrado, instrucciones_cifradas, key_version) on rentas.acceso_instruccion to authenticated;

-- ---------------------------------------------------------------------------
-- Bitacora de acceso a las instrucciones (append-only, SIN el contenido ni PII).
-- ---------------------------------------------------------------------------
-- Guarda QUIEN leyo/escribio/cifro las instrucciones de QUE unidad y cuando; nunca la direccion ni el codigo.
create table rentas.acceso_instruccion_bitacora (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  unidad_id uuid not null references rentas.unidad(id) on delete cascade,
  evento text not null check (evento in ('lectura_admin', 'escritura_admin', 'cifrado_inicial')),
  actor_id uuid references core.staff_user(id) on delete set null,
  creado_en timestamptz not null default now()
);
create index acceso_instruccion_bitacora_prop_idx on rentas.acceso_instruccion_bitacora (property_id, creado_en desc);
alter table rentas.acceso_instruccion_bitacora enable row level security;

-- Seguridad: lectura solo para can_manage_acceso de la property; sin INSERT/UPDATE/DELETE para
-- authenticated (append-only: se escribe solo por las funciones de abajo).
create policy "admin ve la bitacora de instrucciones de su property" on rentas.acceso_instruccion_bitacora for select
  using (rentas.can_manage_acceso(property_id));
revoke all on rentas.acceso_instruccion_bitacora from public, anon;
grant select on rentas.acceso_instruccion_bitacora to authenticated;
grant select, insert on rentas.acceso_instruccion_bitacora to service_role;

-- Registrar una lectura/escritura de instrucciones por un admin autorizado. Seguridad: security definer
-- con search_path fijo; exige auth.uid() no nulo y can_manage_acceso de la property de la UNIDAD (property
-- y organizacion se derivan de la unidad, nunca de parametros); atribuye siempre a auth.uid(). P0002 si la
-- unidad no existe o no es accesible (sin oraculo cross-tenant).
create function rentas.acceso_instruccion_registrar(p_unidad_id uuid, p_evento text)
returns void
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_org uuid;
  v_prop uuid;
begin
  if auth.uid() is null then
    raise exception 'rentas.acceso_instruccion_registrar: requiere un usuario autenticado.' using errcode = '42501';
  end if;
  if p_evento not in ('lectura_admin', 'escritura_admin') then
    raise exception 'rentas.acceso_instruccion_registrar: evento no permitido.' using errcode = '22023';
  end if;
  select u.organization_id, u.property_id into v_org, v_prop from rentas.unidad u where u.id = p_unidad_id;
  if v_prop is null or not rentas.can_manage_acceso(v_prop) then
    raise exception 'rentas.acceso_instruccion_registrar: unidad no encontrada.' using errcode = 'P0002';
  end if;
  insert into rentas.acceso_instruccion_bitacora (organization_id, property_id, unidad_id, evento, actor_id)
  values (v_org, v_prop, p_unidad_id, p_evento, auth.uid());
end;
$$;
revoke all on function rentas.acceso_instruccion_registrar(uuid, text) from public, anon;
grant execute on function rentas.acceso_instruccion_registrar(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Liberacion al huesped leyendo el sobre (SOLO SISTEMA).
-- ---------------------------------------------------------------------------
-- Misma decision de ventana/pago que rentas.acceso_siguiente_liberacion (025), pero devuelve los SOBRES
-- (y el texto heredado mientras no se haya barrido). Funcion NUEVA y no un cambio de la de 025 para que
-- el codigo desplegado contra una base sin esta migracion siga usando la anterior. Seguridad: security
-- definer con search_path fijo, auth.uid() is null (sesion de sistema del cron), EXECUTE revocado a
-- public/anon.
create function rentas.acceso_siguiente_liberacion_cifrada(p_excluir uuid[] default '{}', p_ahora timestamptz default now())
returns table (
  ocupacion_id uuid,
  organization_id uuid,
  property_id uuid,
  unidad_id uuid,
  check_in date,
  check_out date,
  unidad_nombre text,
  tenant_nombre text,
  huesped_nombre text,
  huesped_contacto text,
  tiene_instrucciones boolean,
  direccion_exacta text,
  codigo_acceso text,
  instrucciones text,
  direccion_cifrada text,
  codigo_cifrado text,
  instrucciones_cifradas text,
  key_version smallint
)
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'rentas.acceso_siguiente_liberacion_cifrada: solo la sesion de sistema (auth.uid() es NULL) libera accesos.' using errcode = '42501';
  end if;

  return query
  select o.id, o.organization_id, o.property_id, o.unidad_id, lower(o.rango), upper(o.rango),
         u.name, org.name, g.nombre, g.contacto,
         (ai.unidad_id is not null),
         ai.direccion_exacta, ai.codigo_acceso, ai.instrucciones,
         ai.direccion_cifrada, ai.codigo_cifrado, ai.instrucciones_cifradas, ai.key_version
  from rentas.ocupacion o
  join rentas.acceso_politica ap on ap.property_id = o.property_id and ap.activo
  join rentas.property_config pc on pc.property_id = o.property_id
  join rentas.unidad u on u.id = o.unidad_id
  join core.organization org on org.id = o.organization_id
  left join rentas.canal c on c.id = o.canal_origen_id
  left join rentas.acceso_reserva ar on ar.ocupacion_id = o.id
  left join rentas.guest_minimo g on g.id = o.huesped_minimo_id
  left join rentas.acceso_instruccion ai on ai.unidad_id = o.unidad_id
  where o.capa = 'reserva'
    and o.estado = 'confirmado'
    and ar.liberado_en is null
    and not (o.id = any(coalesce(p_excluir, '{}')))
    and p_ahora >= ((lower(o.rango) + ap.hora_checkin) at time zone pc.zona_horaria) - make_interval(hours => ap.horas_antes_checkin)
    and p_ahora < (upper(o.rango)::timestamp at time zone pc.zona_horaria)
    and (
      not ap.exigir_pago
      or ar.pago_confirmado_en is not null
      or (ap.ota_cuenta_como_pagada and c.codigo in ('airbnb', 'vrbo', 'booking'))
    )
  order by lower(o.rango), o.id
  limit 1
  for update of o skip locked;
end;
$$;
revoke all on function rentas.acceso_siguiente_liberacion_cifrada(uuid[], timestamptz) from public, anon;
grant execute on function rentas.acceso_siguiente_liberacion_cifrada(uuid[], timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Barrido de cifrado de los datos existentes (SOLO SISTEMA, idempotente).
-- ---------------------------------------------------------------------------
-- 1) Filas con texto plano y sin sobre. Devuelve el texto (solo a la sesion de sistema) para que la
--    aplicacion lo cifre; la aplicacion verifica el ida y vuelta ANTES de llamar a (2).
create function rentas.acceso_instruccion_pendientes_cifrar(p_limite integer default 50)
returns table (unidad_id uuid, property_id uuid, direccion_exacta text, codigo_acceso text, instrucciones text)
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'rentas.acceso_instruccion_pendientes_cifrar: solo la sesion de sistema (auth.uid() es NULL).' using errcode = '42501';
  end if;
  return query
  select ai.unidad_id, ai.property_id, ai.direccion_exacta, ai.codigo_acceso, ai.instrucciones
  from rentas.acceso_instruccion ai
  where ai.direccion_cifrada is null and ai.direccion_exacta is not null
  order by ai.unidad_id
  limit least(greatest(coalesce(p_limite, 50), 1), 200)
  for update of ai skip locked;
end;
$$;
revoke all on function rentas.acceso_instruccion_pendientes_cifrar(integer) from public, anon;
grant execute on function rentas.acceso_instruccion_pendientes_cifrar(integer) to authenticated, service_role;

-- 2) Guarda los sobres y anula el texto plano en la MISMA sentencia (solo si la fila sigue sin sobre:
--    idempotente y sin pisar una reescritura posterior del staff). Registra el evento sin contenido.
create function rentas.acceso_instruccion_aplicar_cifrado(p_unidad_id uuid, p_direccion_cifrada text, p_codigo_cifrado text, p_instrucciones_cifradas text, p_key_version integer)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_org uuid;
  v_prop uuid;
begin
  if auth.uid() is not null then
    raise exception 'rentas.acceso_instruccion_aplicar_cifrado: solo la sesion de sistema (auth.uid() es NULL).' using errcode = '42501';
  end if;
  if p_direccion_cifrada is null or p_key_version is null or p_key_version < 1 then
    raise exception 'rentas.acceso_instruccion_aplicar_cifrado: falta el sobre de la direccion o la version de llave.' using errcode = '22023';
  end if;
  update rentas.acceso_instruccion ai
     set direccion_cifrada = p_direccion_cifrada,
         codigo_cifrado = p_codigo_cifrado,
         instrucciones_cifradas = p_instrucciones_cifradas,
         key_version = p_key_version,
         direccion_exacta = null,
         codigo_acceso = null,
         instrucciones = null
   where ai.unidad_id = p_unidad_id and ai.direccion_cifrada is null
  returning ai.organization_id, ai.property_id into v_org, v_prop;
  if v_prop is null then
    return false;
  end if;
  insert into rentas.acceso_instruccion_bitacora (organization_id, property_id, unidad_id, evento, actor_id)
  values (v_org, v_prop, p_unidad_id, 'cifrado_inicial', null);
  return true;
end;
$$;
revoke all on function rentas.acceso_instruccion_aplicar_cifrado(uuid, text, text, text, integer) from public, anon;
grant execute on function rentas.acceso_instruccion_aplicar_cifrado(uuid, text, text, text, integer) to authenticated, service_role;

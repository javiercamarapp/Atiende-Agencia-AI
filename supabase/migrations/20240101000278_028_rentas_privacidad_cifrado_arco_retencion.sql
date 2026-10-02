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
    (direccion_cifrada is null or (length(direccion_cifrada) <= 4096 and direccion_cifrada ~ '^v[0-9]{1,3}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]*$'))
    and (codigo_cifrado is null or (length(codigo_cifrado) <= 4096 and codigo_cifrado ~ '^v[0-9]{1,3}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]*$'))
    and (instrucciones_cifradas is null or (length(instrucciones_cifradas) <= 8192 and instrucciones_cifradas ~ '^v[0-9]{1,3}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]*$'))
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
  evento text not null check (evento in ('lectura_admin', 'escritura_admin', 'cifrado_inicial', 'purga_retencion')),
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

-- ===========================================================================================
-- C) Rn-07 -- solicitudes ARCO propias de rentas (acceso, rectificacion, cancelacion, oposicion)
-- ===========================================================================================
-- El titular (huesped, propietario o quien sea) pide el ejercicio de un derecho por correo, telefono o
-- en persona; el admin de la gestora lo REGISTRA aqui (no hay canal publico de alta en este PR) y lo
-- mueve de estado. Plazos de referencia de la plataforma (docs/PRIVACIDAD-PLATAFORMA.md): 20 dias para
-- responder y 15 mas para ejecutar, de calendario, contados desde la fecha de recepcion. Documentacion
-- operativa, NO asesoria legal. Alcance: la ORGANIZACION (la gestora), no la propiedad.
create table rentas.arco_solicitud (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  organization_id uuid not null references core.organization(id) on delete restrict,
  derecho text not null check (derecho in ('acceso', 'rectificacion', 'cancelacion', 'oposicion')),
  canal text not null check (canal in ('correo', 'telefono', 'presencial', 'otro')),
  estado text not null default 'recibida' check (estado in ('recibida', 'en_proceso', 'bloqueada', 'resuelta', 'rechazada')),
  solicitante_nombre text not null check (btrim(solicitante_nombre) <> '' and char_length(solicitante_nombre) <= 120),
  solicitante_contacto text not null check (btrim(solicitante_contacto) <> '' and char_length(solicitante_contacto) <= 160),
  detalle text check (detalle is null or char_length(detalle) <= 500),
  recibida_en timestamptz not null default now(),
  respuesta_vence_en timestamptz not null,
  ejecucion_vence_en timestamptz not null,
  resuelta_en timestamptz,
  nota_resolucion text check (nota_resolucion is null or char_length(nota_resolucion) <= 1000),
  atendida_por uuid references core.staff_user(id) on delete set null,
  registrada_por uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint arco_solicitud_cierre_coherente check ((estado in ('resuelta', 'rechazada')) = (resuelta_en is not null)),
  constraint arco_solicitud_plazos_coherentes check (respuesta_vence_en >= recibida_en and ejecucion_vence_en >= respuesta_vence_en)
);
-- Idempotencia: una sola solicitud ABIERTA por (organizacion, contacto, derecho) (doble clic, reintento).
create unique index arco_solicitud_abierta_uniq on rentas.arco_solicitud (organization_id, lower(btrim(solicitante_contacto)), derecho)
  where estado in ('recibida', 'en_proceso', 'bloqueada');
create index arco_solicitud_org_idx on rentas.arco_solicitud (organization_id, seq desc);

create table rentas.arco_evento (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  solicitud_id uuid not null references rentas.arco_solicitud(id) on delete cascade,
  evento text not null check (evento in ('registrada', 'cambio_estado')),
  desde_estado text,
  hacia_estado text not null,
  nota text check (nota is null or char_length(nota) <= 1000),
  actor_id uuid references core.staff_user(id) on delete set null,
  creado_en timestamptz not null default now()
);
create index arco_evento_solicitud_idx on rentas.arco_evento (solicitud_id, creado_en);

-- Bitacora append-only: ni siquiera el service_role puede reescribirla (trigger invoker, search_path fijo).
create function rentas.arco_evento_inmutable()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception 'rentas.arco_evento es append-only: % no esta permitido.', tg_op using errcode = '0A000';
end;
$$;
create trigger arco_evento_no_update_trg before update on rentas.arco_evento for each row execute function rentas.arco_evento_inmutable();
create trigger arco_evento_no_delete_trg before delete on rentas.arco_evento for each row execute function rentas.arco_evento_inmutable();

-- Autoridad: solo el admin de la gestora con alcance de TODA la organizacion (property_ids nulo) ve y
-- atiende datos de titulares. security definer con search_path fijo (lee core.membership), revocada a public/anon.
create function rentas.can_manage_privacidad(_org uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, core, rentas, pg_temp
as $$
  select auth.uid() is not null and _org is not null and exists (
    select 1 from core.membership m
    where m.user_id = auth.uid() and m.organization_id = _org
      and m.property_ids is null and m.vertical_role = 'admin_gestora'
  )
$$;
revoke all on function rentas.can_manage_privacidad(uuid) from public, anon;
grant execute on function rentas.can_manage_privacidad(uuid) to authenticated, service_role;

alter table rentas.arco_solicitud enable row level security;
alter table rentas.arco_evento enable row level security;
-- Seguridad (RLS): solo lectura para el admin de la organizacion; NO hay GRANT de escritura a authenticated
-- (se escribe unicamente por rentas.arco_registrar / rentas.arco_cambiar_estado, que validan rol, org y transicion).
create policy "admin ve las solicitudes ARCO de su organizacion" on rentas.arco_solicitud for select
  using (rentas.can_manage_privacidad(organization_id));
create policy "admin ve la bitacora ARCO de su organizacion" on rentas.arco_evento for select
  using (rentas.can_manage_privacidad(organization_id));
revoke all on rentas.arco_solicitud, rentas.arco_evento from public, anon;
grant select on rentas.arco_solicitud, rentas.arco_evento to authenticated;
grant select, insert, update on rentas.arco_solicitud to service_role;
grant select, insert on rentas.arco_evento to service_role;

-- Registrar una solicitud. Seguridad: security definer, search_path fijo, exige usuario autenticado y
-- can_manage_privacidad de la organizacion indicada (P0002 si no, sin oraculo cross-tenant); atribuye a
-- auth.uid(); los plazos los calcula la base (nunca llegan por parametro); la fecha de recepcion no puede
-- ser futura ni anterior a 60 dias. Devuelve el id (o el de la ya abierta, idempotente).
create function rentas.arco_registrar(p_org uuid, p_derecho text, p_canal text, p_nombre text, p_contacto text, p_detalle text default null, p_recibida_en timestamptz default null)
returns table (out_id uuid, out_creada boolean)
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_recibida timestamptz := coalesce(p_recibida_en, now());
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'rentas.arco_registrar: requiere un usuario autenticado.' using errcode = '42501';
  end if;
  if not rentas.can_manage_privacidad(p_org) then
    raise exception 'rentas.arco_registrar: organizacion no encontrada.' using errcode = 'P0002';
  end if;
  if v_recibida > now() + interval '5 minutes' or v_recibida < now() - interval '60 days' then
    raise exception 'rentas.arco_registrar: la fecha de recepcion debe estar entre hace 60 dias y ahora.' using errcode = '22023';
  end if;
  select s.id into v_id from rentas.arco_solicitud s
   where s.organization_id = p_org and lower(btrim(s.solicitante_contacto)) = lower(btrim(coalesce(p_contacto, '')))
     and s.derecho = p_derecho and s.estado in ('recibida', 'en_proceso', 'bloqueada');
  if v_id is not null then
    return query select v_id, false;
    return;
  end if;
  insert into rentas.arco_solicitud (organization_id, derecho, canal, solicitante_nombre, solicitante_contacto, detalle, recibida_en, respuesta_vence_en, ejecucion_vence_en, registrada_por)
  values (p_org, p_derecho, p_canal, btrim(coalesce(p_nombre, '')), btrim(coalesce(p_contacto, '')), nullif(btrim(coalesce(p_detalle, '')), ''), v_recibida,
          v_recibida + interval '20 days', v_recibida + interval '35 days', auth.uid())
  returning id into v_id;
  insert into rentas.arco_evento (organization_id, solicitud_id, evento, desde_estado, hacia_estado, actor_id)
  values (p_org, v_id, 'registrada', null, 'recibida', auth.uid());
  return query select v_id, true;
end;
$$;
revoke all on function rentas.arco_registrar(uuid, text, text, text, text, text, timestamptz) from public, anon;
grant execute on function rentas.arco_registrar(uuid, text, text, text, text, text, timestamptz) to authenticated, service_role;

-- Cambiar el estado. Transiciones: recibida -> en_proceso | bloqueada | resuelta | rechazada;
-- en_proceso <-> bloqueada; en_proceso | bloqueada -> resuelta | rechazada; resuelta y rechazada son
-- terminales (55000). Rechazar exige una nota. Misma seguridad que arco_registrar; la solicitud se
-- busca POR organizacion (P0002 si es de otra).
create function rentas.arco_cambiar_estado(p_org uuid, p_id uuid, p_estado text, p_nota text default null)
returns text
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_actual text;
  v_nota text := nullif(btrim(coalesce(p_nota, '')), '');
begin
  if auth.uid() is null then
    raise exception 'rentas.arco_cambiar_estado: requiere un usuario autenticado.' using errcode = '42501';
  end if;
  if not rentas.can_manage_privacidad(p_org) then
    raise exception 'rentas.arco_cambiar_estado: solicitud no encontrada.' using errcode = 'P0002';
  end if;
  if p_estado not in ('en_proceso', 'bloqueada', 'resuelta', 'rechazada') or (v_nota is not null and char_length(v_nota) > 1000) then
    raise exception 'rentas.arco_cambiar_estado: estado o nota invalidos.' using errcode = '22023';
  end if;
  if p_estado = 'rechazada' and v_nota is null then
    raise exception 'rentas.arco_cambiar_estado: rechazar exige indicar el motivo.' using errcode = '22023';
  end if;
  select s.estado into v_actual from rentas.arco_solicitud s where s.id = p_id and s.organization_id = p_org for update;
  if v_actual is null then
    raise exception 'rentas.arco_cambiar_estado: solicitud no encontrada.' using errcode = 'P0002';
  end if;
  if v_actual in ('resuelta', 'rechazada') or v_actual = p_estado then
    raise exception 'rentas.arco_cambiar_estado: transicion no permitida.' using errcode = '55000';
  end if;
  update rentas.arco_solicitud
     set estado = p_estado,
         atendida_por = auth.uid(),
         nota_resolucion = case when p_estado in ('resuelta', 'rechazada') then v_nota else nota_resolucion end,
         resuelta_en = case when p_estado in ('resuelta', 'rechazada') then now() else null end,
         updated_at = now()
   where id = p_id;
  insert into rentas.arco_evento (organization_id, solicitud_id, evento, desde_estado, hacia_estado, nota, actor_id)
  values (p_org, p_id, 'cambio_estado', v_actual, p_estado, v_nota, auth.uid());
  return p_estado;
end;
$$;
revoke all on function rentas.arco_cambiar_estado(uuid, uuid, text, text) from public, anon;
grant execute on function rentas.arco_cambiar_estado(uuid, uuid, text, text) to authenticated, service_role;

-- ===========================================================================================
-- B) Rn-30 -- clases de retencion de rentas (PL-13) y su purga
-- ===========================================================================================
-- Dos clases nuevas con ejecutor 'plataforma': core.system_run_retention_purge las corre con la politica de la
-- organizacion (defecto > config), respeta el bloqueo legal y las registra SIN PII en core.purge_run_log.
-- Modo simulacion por defecto: el endpoint interno solo borra con POST ?ejecutar=1 y el cron NO se agenda.
insert into core.retention_class (data_class, vertical, description, default_days, min_days, max_days, executor) values
  ('rentas_huesped_pii', 'rentas', 'Nombre y contacto del huesped (rentas.guest_minimo) una vez cerrada su ultima estancia; al vencer se anonimizan y se conservan la reserva y sus montos. Se conservan los de quien tenga una solicitud ARCO abierta.', 90, 30, 730, 'plataforma'),
  ('rentas_acceso_instrucciones', 'rentas', 'Sobres cifrados de acceso (direccion, codigo, indicaciones) de unidades sin reservas vigentes ni cerradas dentro de la ventana; al vencer se eliminan y el admin puede volver a capturarlos.', 90, 30, 730, 'plataforma');

-- Purga del vertical. Seguridad: security definer, search_path fijo, guard auth.uid() is null (solo sesion de
-- sistema) y EXECUTE solo para el dueno: la invoca core.system_run_retention_purge, que es definer del mismo dueno;
-- ningun rol de la aplicacion (anon, authenticated) la puede llamar. Limite acotado por llamada. Devuelve conteos,
-- nunca contenido. p_dry cuenta sin tocar nada.
create function rentas.system_purge_retencion(p_org uuid, p_class text, p_cutoff timestamptz, p_dry boolean, p_limit integer)
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
-- Cambios a funciones de core (PL-13, definidas en packages/db 0036). Solo se agregan las ramas de rentas;
-- el resto del cuerpo es identico al de 0036 y conserva su seguridad (definer, search_path fijo, auth.uid() is null).
-- Dependen de que 0036 y la tabla rentas.arco_solicitud de arriba ya existan (el prefijo de supabase/migrations de
-- esta migracion es posterior al de 0036).
-- ---------------------------------------------------------------------------
-- ---- core._arco_union
create or replace function core._arco_union()
returns table (
  organization_id uuid, vertical text, request_id uuid, right_type text, channel text,
  native_status text, status_bucket text, opened_at timestamptz,
  response_due_at timestamptz, execution_due_at timestamptz, due_at timestamptz,
  resolved_at timestamptz, is_open boolean, is_overdue boolean
)
language sql stable security definer set search_path = core, citas, restaurantes, hoteles, rentas, pg_temp as $$
  with u as (
    select r.organization_id, 'citas'::text as vertical, r.id as request_id, r.right_type, r.channel,
           r.status as native_status,
           case r.status when 'pendiente_confirmacion' then 'por_confirmar' when 'recibida' then 'abierta'
             when 'en_proceso' then 'en_proceso' when 'bloqueada' then 'bloqueada' when 'resuelta' then 'resuelta'
             when 'rechazada' then 'rechazada' else 'cerrada' end as status_bucket,
           r.requested_at as opened_at, r.response_due_at, r.execution_due_at, r.resolved_at
      from citas.data_rights_requests r
    union all
    select r.organization_id, 'restaurantes', r.id, r.right_type, r.channel, r.status,
           case r.status when 'pendiente_confirmacion' then 'por_confirmar' when 'recibida' then 'abierta'
             when 'en_proceso' then 'en_proceso' when 'bloqueada' then 'bloqueada' when 'resuelta' then 'resuelta'
             when 'rechazada' then 'rechazada' else 'cerrada' end,
           r.requested_at, r.response_due_at, r.execution_due_at, r.resolved_at
      from restaurantes.data_rights_requests r
    union all
    select a.organization_id, 'hoteles', a.id, a.right_type, a.channel, a.status,
           case a.status when 'pendiente_verificacion' then 'por_confirmar' when 'recibida' then 'abierta' when 'en_revision' then 'en_proceso'
             when 'procedente' then 'en_proceso' when 'improcedente' then 'rechazada' else 'resuelta' end,
           a.created_at, a.response_due_on::timestamp at time zone 'UTC',
           a.execution_due_on::timestamp at time zone 'UTC', a.executed_at
      from hoteles.arco_request a
    union all
    select s.organization_id, 'rentas', s.id, s.derecho, s.canal, s.estado,
           case s.estado when 'recibida' then 'abierta' when 'en_proceso' then 'en_proceso' when 'bloqueada' then 'bloqueada'
             when 'resuelta' then 'resuelta' else 'rechazada' end,
           s.recibida_en, s.respuesta_vence_en, s.ejecucion_vence_en, s.resuelta_en
      from rentas.arco_solicitud s
  )
  select u.organization_id, u.vertical, u.request_id, u.right_type, u.channel, u.native_status, u.status_bucket,
         u.opened_at, u.response_due_at, u.execution_due_at,
         case when u.status_bucket = 'abierta' then u.response_due_at else coalesce(u.execution_due_at, u.response_due_at) end,
         u.resolved_at,
         u.status_bucket in ('abierta', 'en_proceso', 'bloqueada'),
         u.status_bucket in ('abierta', 'en_proceso', 'bloqueada')
           and case when u.status_bucket = 'abierta' then u.response_due_at else coalesce(u.execution_due_at, u.response_due_at) end < now()
    from u;
$$;
revoke all on function core._arco_union() from public, anon, authenticated;
-- ---- core.system_run_retention_purge
create or replace function core.system_run_retention_purge(p_org uuid, p_data_class text, p_dry_run boolean default false, p_limit integer default 500)
returns table (out_run_id uuid, out_status text, out_retention_days integer, out_rows_affected integer, out_rows_anonymized integer, out_rows_protected integer)
language plpgsql security definer set search_path = core, restaurantes, pg_temp as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_dry boolean := coalesce(p_dry_run, false);
  v_class core.retention_class%rowtype;
  v_days integer;
  v_cutoff timestamptz;
  v_affected integer := 0;
  v_anon integer := 0;
  v_protected integer := 0;
  v_status text;
  v_blocked text;
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'system_run_retention_purge: solo para la sesion de sistema' using errcode = '42501';
  end if;
  if not exists (select 1 from core.organization o where o.id = p_org) then
    raise exception 'system_run_retention_purge: la organizacion no existe' using errcode = '22023';
  end if;
  select * into v_class from core.retention_class c where c.data_class = p_data_class;
  if not found then
    raise exception 'system_run_retention_purge: clase de dato desconocida' using errcode = '22023';
  end if;

  select e.out_days into v_days from core._retention_effective(p_org, p_data_class) e;
  v_cutoff := now() - make_interval(days => v_days);

  if v_class.executor <> 'plataforma' then
    v_status := 'sin_ejecutor';
  elsif exists (
    select 1 from core.purge_hold h
     where h.organization_id = p_org and h.released_at is null and (h.data_class is null or h.data_class = p_data_class)
  ) then
    v_status := 'bloqueada';
    v_blocked := 'retencion_legal_activa';
  elsif p_data_class = 'restaurantes_whatsapp_conversaciones' then
    select count(*) into v_protected
      from restaurantes.whatsapp_conversations w
     where w.organization_id = p_org and w.messages <> '[]'::jsonb and w.updated_at < v_cutoff
       and exists (
         select 1 from restaurantes.data_rights_requests r
          where r.organization_id = w.organization_id and r.customer_phone = w.phone and r.status in ('recibida', 'en_proceso', 'bloqueada')
       );
    if v_dry then
      select count(*) into v_affected from (
        select 1 from restaurantes.whatsapp_conversations w
         where w.organization_id = p_org and w.messages <> '[]'::jsonb and w.updated_at < v_cutoff
           and not exists (
             select 1 from restaurantes.data_rights_requests r
              where r.organization_id = w.organization_id and r.customer_phone = w.phone and r.status in ('recibida', 'en_proceso', 'bloqueada')
           )
         order by w.updated_at limit v_limit
      ) s;
    else
      with victims as (
        select w.id from restaurantes.whatsapp_conversations w
         where w.organization_id = p_org and w.messages <> '[]'::jsonb and w.updated_at < v_cutoff
           and not exists (
             select 1 from restaurantes.data_rights_requests r
              where r.organization_id = w.organization_id and r.customer_phone = w.phone and r.status in ('recibida', 'en_proceso', 'bloqueada')
           )
         order by w.updated_at limit v_limit
      ), cleared as (
        update restaurantes.whatsapp_conversations w set messages = '[]'::jsonb from victims v where w.id = v.id returning 1
      )
      select count(*) into v_affected from cleared;
    end if;
    v_status := case when v_dry then 'simulacion' else 'ok' end;
  elsif p_data_class = 'restaurantes_voz_transcripciones' then
    select count(*) into v_protected
      from restaurantes.voice_conversation c
     where c.organization_id = p_org and (c.ended_at is not null or c.started_at < now() - interval '1 day') and c.started_at < v_cutoff
       and (exists (select 1 from restaurantes.voice_turn t where t.conversation_id = c.id) or c.caller_hash is not null)
       and exists (
         select 1 from restaurantes.data_rights_requests r
          where r.organization_id = c.organization_id and r.status in ('recibida', 'en_proceso', 'bloqueada')
            and c.caller_hash = encode(sha256(convert_to(regexp_replace(r.customer_phone, '\D', '', 'g'), 'UTF8')), 'hex')
       );
    if v_dry then
      select count(*), count(*) filter (where s.has_hash) into v_affected, v_anon from (
        select c.caller_hash is not null as has_hash
          from restaurantes.voice_conversation c
         where c.organization_id = p_org and (c.ended_at is not null or c.started_at < now() - interval '1 day') and c.started_at < v_cutoff
           and (exists (select 1 from restaurantes.voice_turn t where t.conversation_id = c.id) or c.caller_hash is not null)
           and not exists (
             select 1 from restaurantes.data_rights_requests r
              where r.organization_id = c.organization_id and r.status in ('recibida', 'en_proceso', 'bloqueada')
                and c.caller_hash = encode(sha256(convert_to(regexp_replace(r.customer_phone, '\D', '', 'g'), 'UTF8')), 'hex')
           )
         order by c.started_at limit v_limit
      ) s;
      -- En simulacion rows_affected cuenta llamadas candidatas (no turnos): se documenta en el catalogo.
    else
      with old_calls as (
        select c.id from restaurantes.voice_conversation c
         where c.organization_id = p_org and (c.ended_at is not null or c.started_at < now() - interval '1 day') and c.started_at < v_cutoff
           and (exists (select 1 from restaurantes.voice_turn t where t.conversation_id = c.id) or c.caller_hash is not null)
           and not exists (
             select 1 from restaurantes.data_rights_requests r
              where r.organization_id = c.organization_id and r.status in ('recibida', 'en_proceso', 'bloqueada')
                and c.caller_hash = encode(sha256(convert_to(regexp_replace(r.customer_phone, '\D', '', 'g'), 'UTF8')), 'hex')
           )
         order by c.started_at limit v_limit
      ), del_turns as (
        delete from restaurantes.voice_turn t using old_calls o where t.conversation_id = o.id returning 1
      ), anon as (
        update restaurantes.voice_conversation c set caller_hash = null from old_calls o where c.id = o.id and c.caller_hash is not null returning 1
      )
      select (select count(*) from del_turns), (select count(*) from anon) into v_affected, v_anon;
    end if;
    v_status := case when v_dry then 'simulacion' else 'ok' end;
  elsif v_class.vertical = 'rentas' and p_data_class in ('rentas_huesped_pii', 'rentas_acceso_instrucciones') then
    -- Rn-30: la purga la implementa el vertical (rentas.system_purge_retencion); aqui solo se decide
    -- el bloqueo, los dias efectivos y el registro, igual que para las clases de restaurantes.
    select r.out_afectadas, r.out_anonimizadas, r.out_protegidas into v_affected, v_anon, v_protected
      from rentas.system_purge_retencion(p_org, p_data_class, v_cutoff, v_dry, v_limit) r;
    v_status := case when v_dry then 'simulacion' else 'ok' end;
  else
    v_status := 'sin_ejecutor';
  end if;

  insert into core.purge_run_log (organization_id, data_class, status, retention_days, cutoff_at, rows_affected, rows_anonymized, rows_protected, blocked_reason)
  values (p_org, p_data_class, v_status, v_days, v_cutoff, v_affected, v_anon, v_protected, v_blocked)
  returning id into v_id;

  return query select v_id, v_status, v_days, v_affected, v_anon, v_protected;
end;
$$;
revoke all on function core.system_run_retention_purge(uuid, text, boolean, integer) from public, anon;
grant execute on function core.system_run_retention_purge(uuid, text, boolean, integer) to authenticated;

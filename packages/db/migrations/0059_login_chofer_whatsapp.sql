-- Login del REPARTIDOR (chofer) con celular + codigo de 6 digitos por WhatsApp.
--
-- Alcance (decision del dueno): SOLO cuentas cuyo unico rol es `repartidor` de restaurantes. Encargado, cajero, administradores, owners y
-- superadmin siguen entrando con correo y NO pueden entrar por esta via aunque tengan un telefono registrado (la elegibilidad se evalua en la
-- base, en cada paso, no solo en TypeScript). Modelo de amenazas y orden de despliegue: docs/LOGIN-CHOFER-WHATSAPP.md.
--
-- Que agrega:
--   * core.chofer_login_telefono   telefono E.164 mexicano del repartidor (lo registra el encargado/admin). Una fila por membresia: si la
--                                  membresia se da de baja (core.remove_membership) la fila se borra en cascada y el chofer pierde el acceso.
--   * core.chofer_login_codigo     codigos emitidos: SOLO hash con sal (HMAC calculado en la API), expira en 5 min, un solo uso, maximo 5 intentos.
--                                  Un indice unico parcial garantiza UN solo codigo pendiente por usuario (emitir uno nuevo invalida el anterior).
--   * core.chofer_login_evento     auditoria + contadores de limite/bloqueo. Guarda SOLO hashes (HMAC) del telefono y de la IP, nunca el numero.
--   * Funciones security definer (search_path fijo, revoke de public/anon, grant a authenticated: el login corre ANTES de que exista auth.uid(),
--     mismo patron que core.consume_auth_exchange_code). Las de login son SOLO-SISTEMA (auth.uid() is null, si no 42501); las de gestion del
--     telefono exigen un caller autenticado con autoridad sobre la organizacion.
--
-- Justificacion de seguridad por objeto:
--   * Las 3 tablas: RLS habilitado y SIN policies + revoke all a public/anon/authenticated = denegacion total a cualquier query cruda. El unico
--     camino son las funciones de abajo, que validan todo dentro de la base.
--   * core.chofer_login_es_elegible: unica fuente de verdad de "quien puede entrar por esta via". Exige membresia `repartidor` en una organizacion
--     de restaurantes activa/en prueba, que esa sea la UNICA membresia del usuario (ninguna otra organizacion, rol ni vertical) y que NO sea
--     superadmin de plataforma. Se reevalua al reservar el intento y al consumir el codigo, asi que una baja entre ambos pasos corta el acceso.
--     No se concede a nadie (solo la llaman las demas funciones).
--   * core.chofer_login_puede_solicitar: serializa por telefono (advisory lock), cuenta TODA solicitud (exista o no la cuenta, para que la respuesta
--     sea indistinguible) y aplica limite por telefono, por IP y bloqueo temporal tras abuso. Solo-sistema.
--   * core.chofer_login_reservar_intento: incrementa el contador ANTES de que la API compare (los intentos en paralelo tambien cuentan) y devuelve
--     hash+sal solo mientras el codigo siga pendiente, vigente y con intentos disponibles. Solo-sistema.
--   * core.chofer_login_consumir: pendiente -> usado de forma atomica (un solo ganador si hay dos verificaciones simultaneas) y reevalua la
--     elegibilidad. Devuelve la fila de core.staff_user como las demas funciones de login. Solo-sistema.
--   * core.chofer_login_telefono_guardar/quitar/listar: exigen auth.uid() real con autoridad (owner/admin de la organizacion o encargado
--     `staff` de restaurantes), el objetivo debe ser un repartidor de ESA organizacion y no superadmin. El telefono ya usado por otra cuenta
--     se rechaza con un mensaje generico. listar devuelve solo el telefono enmascarado.
--
-- Orden de despliegue: la API (con la bandera apagada por omision) captura 42883/42P01/42703 y responde "no disponible aun" mientras esta
-- migracion no este aplicada; aplicarla antes o despues del codigo es seguro. Nada se activa hasta encender LOGIN_CHOFER_WHATSAPP.
--
-- Reversa (sin perdida de datos de negocio; solo credenciales de este canal):
--   drop function if exists core.chofer_login_telefono_listar(uuid), core.chofer_login_telefono_quitar(uuid, uuid), core.chofer_login_telefono_guardar(uuid, uuid, text),
--     core.chofer_login_plantilla_disponible(), core.chofer_login_plantilla(uuid), core.chofer_login_fallo(uuid), core.chofer_login_consumir(uuid),
--     core.chofer_login_reservar_intento(text), core.chofer_login_emitir(uuid, uuid, text, text, int), core.chofer_login_resolver(text),
--     core.chofer_login_registrar_evento(text, text, text, uuid, uuid), core.chofer_login_puede_solicitar(text, text, int, int, int, int),
--     core.chofer_login_puede_gestionar(uuid), core.chofer_login_es_elegible(uuid, uuid);
--   drop table if exists core.chofer_login_evento, core.chofer_login_codigo, core.chofer_login_telefono;

-- ---------------------------------------------------------------------------------------------------------------
-- Telefono de acceso del repartidor
-- ---------------------------------------------------------------------------------------------------------------
create table core.chofer_login_telefono (
  user_id uuid not null,
  organization_id uuid not null,
  -- Mexico: +52 y 10 digitos (sin el 1 de movil de la numeracion anterior; la API normaliza antes de guardar).
  telefono_e164 text not null check (telefono_e164 ~ '^\+52[1-9][0-9]{9}$'),
  registrado_por uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, organization_id),
  -- La baja de la membresia borra el telefono: un chofer dado de baja pierde el acceso en el mismo instante.
  foreign key (user_id, organization_id) references core.membership (user_id, organization_id) on delete cascade
);
-- Un telefono identifica a UNA cuenta: es lo que permite resolver el login sin ambiguedad.
create unique index chofer_login_telefono_unico on core.chofer_login_telefono (telefono_e164);

-- ---------------------------------------------------------------------------------------------------------------
-- Codigos de un solo uso
-- ---------------------------------------------------------------------------------------------------------------
create table core.chofer_login_codigo (
  id uuid primary key default gen_random_uuid(),
  staff_user_id uuid not null references core.staff_user(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- HMAC-SHA256 hex(sal || codigo) con una llave de servidor; el codigo en claro nunca se guarda aqui.
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  code_salt text not null check (code_salt ~ '^[0-9a-f]{32}$'),
  intentos smallint not null default 0 check (intentos between 0 and 6),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'usado', 'invalidado', 'expirado')),
  motivo_cierre text check (motivo_cierre is null or motivo_cierre in ('reemplazado', 'intentos', 'expirado', 'no_elegible', 'telefono_cambiado')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
-- Invalida codigos previos por construccion: no puede haber dos pendientes del mismo usuario.
create unique index chofer_login_codigo_un_pendiente on core.chofer_login_codigo (staff_user_id) where estado = 'pendiente';
create index chofer_login_codigo_creado_idx on core.chofer_login_codigo (created_at);

-- ---------------------------------------------------------------------------------------------------------------
-- Auditoria sin PII + contadores
-- ---------------------------------------------------------------------------------------------------------------
create table core.chofer_login_evento (
  id bigint generated always as identity primary key,
  tipo text not null check (tipo in (
    'solicitud', 'solicitud_limitada', 'solicitud_bloqueada', 'cuenta_no_elegible', 'plantilla_no_disponible', 'codigo_encolado',
    'verificacion_ok', 'verificacion_fallo', 'codigo_agotado', 'verificacion_limitada'
  )),
  telefono_hash text not null check (telefono_hash ~ '^[0-9a-f]{64}$'),
  ip_hash text check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$'),
  staff_user_id uuid,
  organization_id uuid,
  created_at timestamptz not null default now()
);
create index chofer_login_evento_tel_idx on core.chofer_login_evento (telefono_hash, tipo, created_at);
create index chofer_login_evento_ip_idx on core.chofer_login_evento (ip_hash, tipo, created_at);
create index chofer_login_evento_creado_idx on core.chofer_login_evento (created_at);

alter table core.chofer_login_telefono enable row level security;
alter table core.chofer_login_codigo enable row level security;
alter table core.chofer_login_evento enable row level security;
revoke all on core.chofer_login_telefono from public, anon, authenticated;
revoke all on core.chofer_login_codigo from public, anon, authenticated;
revoke all on core.chofer_login_evento from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Elegibilidad: SOLO repartidores
-- ---------------------------------------------------------------------------------------------------------------
create or replace function core.chofer_login_es_elegible(p_user_id uuid, p_organization_id uuid)
returns boolean
language sql stable security definer set search_path = core, pg_temp
as $$
  select exists (
      select 1
      from core.membership m
      join core.organization o on o.id = m.organization_id
      where m.user_id = p_user_id
        and m.organization_id = p_organization_id
        and m.vertical_role = 'repartidor'
        and o.vertical = 'restaurantes'
        and o.status in ('trial', 'active')
    )
    -- La UNICA membresia del usuario es esta: ninguna otra organizacion (ni de otra vertical ni de otro tenant) ni otro rol. Asi un administrador de
    -- la organizacion B no puede registrar su celular para un usuario que tambien es repartidor en A y quedarse con su sesion.
    and not exists (
      select 1 from core.membership m2
      where m2.user_id = p_user_id and m2.organization_id <> p_organization_id
    )
    and not exists (select 1 from core.platform_superadmin s where s.staff_user_id = p_user_id);
$$;
revoke all on function core.chofer_login_es_elegible(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Limites y bloqueo (solo sistema)
-- ---------------------------------------------------------------------------------------------------------------
-- Cuenta TODA solicitud (la cuenta exista o no). Devuelve false si el telefono o la IP superaron el limite de la ventana, o si el telefono
-- esta en bloqueo temporal por abuso (>= 2 codigos agotados en la ventana de bloqueo). Si permite, registra la solicitud.
-- Devuelve 'ok', 'limitado' (la API responde 429 igual para cualquier numero) o 'bloqueado' (la API responde como si todo hubiera salido bien
-- y no envia nada: un bloqueo solo existe para telefonos con cuenta, asi que nunca debe distinguirse desde fuera).
create or replace function core.chofer_login_puede_solicitar(
  p_telefono_hash text, p_ip_hash text, p_max_telefono int, p_max_ip int, p_ventana_segundos int, p_bloqueo_segundos int
) returns text
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_tel int;
  v_ip int;
  v_agotados int;
begin
  if auth.uid() is not null then
    raise exception 'chofer_login_puede_solicitar: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  if p_max_telefono < 1 or p_max_ip < 1 or p_ventana_segundos < 1 or p_bloqueo_segundos < 1 then
    raise exception 'parametros de limite invalidos' using errcode = '22023';
  end if;
  -- Higiene acotada: purga como maximo 50 eventos de mas de 30 dias por llamada.
  delete from core.chofer_login_evento where id in (select id from core.chofer_login_evento where created_at < now() - interval '30 days' limit 50);
  perform pg_advisory_xact_lock(hashtextextended(p_telefono_hash, 0));

  select count(*) into v_agotados from core.chofer_login_evento
    where telefono_hash = p_telefono_hash and tipo = 'codigo_agotado' and created_at > now() - make_interval(secs => p_bloqueo_segundos);
  if v_agotados >= 2 then
    insert into core.chofer_login_evento (tipo, telefono_hash, ip_hash) values ('solicitud_bloqueada', p_telefono_hash, p_ip_hash);
    return 'bloqueado';
  end if;

  select count(*) into v_tel from core.chofer_login_evento
    where telefono_hash = p_telefono_hash and tipo = 'solicitud' and created_at > now() - make_interval(secs => p_ventana_segundos);
  if p_ip_hash is not null then
    select count(*) into v_ip from core.chofer_login_evento
      where ip_hash = p_ip_hash and tipo = 'solicitud' and created_at > now() - make_interval(secs => p_ventana_segundos);
  else
    v_ip := 0;
  end if;
  if v_tel >= p_max_telefono or v_ip >= p_max_ip then
    insert into core.chofer_login_evento (tipo, telefono_hash, ip_hash) values ('solicitud_limitada', p_telefono_hash, p_ip_hash);
    return 'limitado';
  end if;

  insert into core.chofer_login_evento (tipo, telefono_hash, ip_hash) values ('solicitud', p_telefono_hash, p_ip_hash);
  return 'ok';
end;
$$;
revoke all on function core.chofer_login_puede_solicitar(text, text, int, int, int, int) from public, anon;
grant execute on function core.chofer_login_puede_solicitar(text, text, int, int, int, int) to authenticated;

create or replace function core.chofer_login_registrar_evento(p_tipo text, p_telefono_hash text, p_ip_hash text, p_staff_user_id uuid, p_organization_id uuid)
returns void
language plpgsql security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'chofer_login_registrar_evento: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  insert into core.chofer_login_evento (tipo, telefono_hash, ip_hash, staff_user_id, organization_id)
  values (p_tipo, p_telefono_hash, p_ip_hash, p_staff_user_id, p_organization_id);
end;
$$;
revoke all on function core.chofer_login_registrar_evento(text, text, text, uuid, uuid) from public, anon;
grant execute on function core.chofer_login_registrar_evento(text, text, text, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Resolver, emitir, reservar intento, consumir (solo sistema)
-- ---------------------------------------------------------------------------------------------------------------
-- La cuenta de repartidor elegible dueña de ese telefono, o ninguna fila.
create or replace function core.chofer_login_resolver(p_telefono text)
returns table (user_id uuid, organization_id uuid, full_name text, property_ids uuid[])
language plpgsql stable security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'chofer_login_resolver: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  return query
    select t.user_id, t.organization_id, su.full_name, m.property_ids
    from core.chofer_login_telefono t
    join core.staff_user su on su.id = t.user_id
    join core.membership m on m.user_id = t.user_id and m.organization_id = t.organization_id
    where t.telefono_e164 = p_telefono
      and core.chofer_login_es_elegible(t.user_id, t.organization_id);
end;
$$;
revoke all on function core.chofer_login_resolver(text) from public, anon;
grant execute on function core.chofer_login_resolver(text) to authenticated;

-- Emite un codigo nuevo e invalida el pendiente anterior en la misma transaccion. Devuelve null si la cuenta ya no es elegible.
create or replace function core.chofer_login_emitir(p_user_id uuid, p_organization_id uuid, p_code_hash text, p_code_salt text, p_ttl_segundos int)
returns uuid
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'chofer_login_emitir: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  if not core.chofer_login_es_elegible(p_user_id, p_organization_id) then return null; end if;
  -- La vigencia se calcula AQUI con el reloj de la base (no con el de la API): un desfase de reloj no puede rechazar ni alargar un codigo.
  if p_ttl_segundos is null or p_ttl_segundos < 1 or p_ttl_segundos > 600 then
    raise exception 'chofer_login_emitir: vigencia entre 1 segundo y 10 minutos' using errcode = '22023';
  end if;
  update core.chofer_login_codigo set estado = 'invalidado', motivo_cierre = 'reemplazado'
    where staff_user_id = p_user_id and estado = 'pendiente';
  insert into core.chofer_login_codigo (staff_user_id, organization_id, code_hash, code_salt, expires_at)
  values (p_user_id, p_organization_id, p_code_hash, p_code_salt, now() + make_interval(secs => p_ttl_segundos))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function core.chofer_login_emitir(uuid, uuid, text, text, int) from public, anon;
grant execute on function core.chofer_login_emitir(uuid, uuid, text, text, int) to authenticated;

-- Reserva UN intento: el contador sube antes de que la API compare. Devuelve el codigo solo si sigue pendiente, vigente y con intento disponible.
create or replace function core.chofer_login_reservar_intento(p_telefono text)
returns table (codigo_id uuid, user_id uuid, organization_id uuid, code_hash text, code_salt text, intentos smallint)
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_user uuid;
  v_org uuid;
  v_c core.chofer_login_codigo;
begin
  if auth.uid() is not null then
    raise exception 'chofer_login_reservar_intento: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  select r.user_id, r.organization_id into v_user, v_org from core.chofer_login_resolver(p_telefono) r;
  if v_user is null then return; end if;

  -- Un solo UPDATE condicional: el incremento y la comprobacion de "quedan intentos" son atomicos aun con verificaciones simultaneas.
  update core.chofer_login_codigo cc set intentos = cc.intentos + 1
    where cc.staff_user_id = v_user and cc.estado = 'pendiente' and cc.expires_at > now() and cc.intentos < 5
    returning cc.* into v_c;
  if not found then
    -- Sin intento disponible: se cierra lo vencido o agotado para que no quede pendiente.
    update core.chofer_login_codigo cc set estado = 'expirado', motivo_cierre = 'expirado'
      where cc.staff_user_id = v_user and cc.estado = 'pendiente' and cc.expires_at <= now();
    update core.chofer_login_codigo cc set estado = 'invalidado', motivo_cierre = 'intentos'
      where cc.staff_user_id = v_user and cc.estado = 'pendiente' and cc.intentos >= 5;
    return;
  end if;
  return query select v_c.id, v_c.staff_user_id, v_c.organization_id, v_c.code_hash, v_c.code_salt, v_c.intentos;
end;
$$;
revoke all on function core.chofer_login_reservar_intento(text) from public, anon;
grant execute on function core.chofer_login_reservar_intento(text) to authenticated;

-- Despues de una comparacion fallida: con el quinto intento gastado el codigo se invalida.
create or replace function core.chofer_login_fallo(p_codigo_id uuid)
returns boolean
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_cerrado boolean := false;
begin
  if auth.uid() is not null then
    raise exception 'chofer_login_fallo: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  update core.chofer_login_codigo set estado = 'invalidado', motivo_cierre = 'intentos'
    where id = p_codigo_id and estado = 'pendiente' and intentos >= 5;
  v_cerrado := found;
  return v_cerrado;
end;
$$;
revoke all on function core.chofer_login_fallo(uuid) from public, anon;
grant execute on function core.chofer_login_fallo(uuid) to authenticated;

-- Consumo atomico de un solo uso, con la elegibilidad reevaluada.
create or replace function core.chofer_login_consumir(p_codigo_id uuid)
returns setof core.staff_user
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_user uuid;
begin
  if auth.uid() is not null then
    raise exception 'chofer_login_consumir: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  update core.chofer_login_codigo c set estado = 'usado', used_at = now()
    where c.id = p_codigo_id and c.estado = 'pendiente' and c.expires_at > now()
      and core.chofer_login_es_elegible(c.staff_user_id, c.organization_id)
    returning c.staff_user_id into v_user;
  if v_user is null then return; end if;
  return query select su.* from core.staff_user su where su.id = v_user;
end;
$$;
revoke all on function core.chofer_login_consumir(uuid) from public, anon;
grant execute on function core.chofer_login_consumir(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Plantilla de WhatsApp `codigo_acceso` (catalogo core.whatsapp_plantilla, 0050), solo sistema
-- ---------------------------------------------------------------------------------------------------------------
-- La plantilla APROBADA de la organizacion para el evento 'auth.codigo_acceso' con el nombre exacto `codigo_acceso`.
create or replace function core.chofer_login_plantilla(p_organization_id uuid)
returns table (nombre text, idioma text)
language plpgsql stable security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'chofer_login_plantilla: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  return query
    select p.nombre, p.idioma from core.whatsapp_plantilla p
    where p.organization_id = p_organization_id and p.vertical = 'restaurantes' and p.evento = 'auth.codigo_acceso'
      and p.nombre = 'codigo_acceso' and p.estado = 'aprobada'
    limit 1;
end;
$$;
revoke all on function core.chofer_login_plantilla(uuid) from public, anon;
grant execute on function core.chofer_login_plantilla(uuid) to authenticated;

-- Disponibilidad GLOBAL (no depende de ninguna cuenta): hay al menos una organizacion con la plantilla aprobada. Es lo unico que la API
-- usa para decir "no disponible aun" sin revelar si un telefono existe.
create or replace function core.chofer_login_plantilla_disponible()
returns boolean
language plpgsql stable security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'chofer_login_plantilla_disponible: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  return exists (
    select 1 from core.whatsapp_plantilla p
    where p.vertical = 'restaurantes' and p.evento = 'auth.codigo_acceso' and p.nombre = 'codigo_acceso' and p.estado = 'aprobada'
  );
end;
$$;
revoke all on function core.chofer_login_plantilla_disponible() from public, anon;
grant execute on function core.chofer_login_plantilla_disponible() to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Gestion del telefono (caller autenticado: encargado/admin)
-- ---------------------------------------------------------------------------------------------------------------
-- Autoridad: owner/admin de la organizacion, o encargado (`staff`) de restaurantes. Si la base ya tiene core.membership.perfil_operativo
-- (migracion 090 de restaurantes), un `staff` con perfil 'cajero' NO califica; sin esa columna se conserva la regla por rol.
create or replace function core.chofer_login_puede_gestionar(p_organization_id uuid)
returns boolean
language plpgsql stable security definer set search_path = core, pg_temp
as $$
declare
  v_platform text;
  v_vertical_role text;
  v_org_vertical text;
  v_perfil text := null;
begin
  if auth.uid() is null then return false; end if;
  select o.vertical into v_org_vertical from core.organization o where o.id = p_organization_id;
  if v_org_vertical is distinct from 'restaurantes' then return false; end if;
  select m.platform_role, m.vertical_role into v_platform, v_vertical_role
    from core.membership m where m.organization_id = p_organization_id and m.user_id = auth.uid();
  if v_platform is null then return false; end if;
  if v_platform in ('owner', 'admin') then return true; end if;
  if v_vertical_role <> 'staff' then return false; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'core' and table_name = 'membership' and column_name = 'perfil_operativo') then
    execute 'select perfil_operativo from core.membership where organization_id = $1 and user_id = $2' into v_perfil using p_organization_id, auth.uid();
    return coalesce(v_perfil, 'encargado') = 'encargado';
  end if;
  return true;
end;
$$;
revoke all on function core.chofer_login_puede_gestionar(uuid) from public, anon;
grant execute on function core.chofer_login_puede_gestionar(uuid) to authenticated;

create or replace function core.chofer_login_telefono_guardar(p_organization_id uuid, p_target_user_id uuid, p_telefono text)
returns void
language plpgsql security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'chofer_login_telefono_guardar: requiere sesion autenticada' using errcode = '42501';
  end if;
  if not core.chofer_login_puede_gestionar(p_organization_id) then
    raise exception 'tu rol no alcanza para registrar el telefono de acceso de un repartidor' using errcode = 'P0001';
  end if;
  -- Solo cuentas de repartidor (y que nunca sean otra cosa): el encargado no puede dar acceso por celular a un administrador.
  if not core.chofer_login_es_elegible(p_target_user_id, p_organization_id) then
    raise exception 'el telefono de acceso solo aplica a cuentas de repartidor' using errcode = 'P0001';
  end if;
  begin
    insert into core.chofer_login_telefono (user_id, organization_id, telefono_e164, registrado_por)
    values (p_target_user_id, p_organization_id, p_telefono, auth.uid())
    on conflict (user_id, organization_id) do update
      set telefono_e164 = excluded.telefono_e164, registrado_por = excluded.registrado_por, updated_at = now();
  exception when unique_violation then
    -- Mensaje generico a proposito: no revela a quien pertenece el numero (posiblemente de otra organizacion).
    raise exception 'no se pudo registrar ese telefono' using errcode = 'P0001';
  end;
  -- Cambiar el telefono invalida cualquier codigo pendiente emitido para el numero anterior.
  update core.chofer_login_codigo set estado = 'invalidado', motivo_cierre = 'telefono_cambiado'
    where staff_user_id = p_target_user_id and estado = 'pendiente';
end;
$$;
revoke all on function core.chofer_login_telefono_guardar(uuid, uuid, text) from public, anon;
grant execute on function core.chofer_login_telefono_guardar(uuid, uuid, text) to authenticated;

create or replace function core.chofer_login_telefono_quitar(p_organization_id uuid, p_target_user_id uuid)
returns boolean
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_borrado boolean;
begin
  if auth.uid() is null then
    raise exception 'chofer_login_telefono_quitar: requiere sesion autenticada' using errcode = '42501';
  end if;
  if not core.chofer_login_puede_gestionar(p_organization_id) then
    raise exception 'tu rol no alcanza para quitar el telefono de acceso de un repartidor' using errcode = 'P0001';
  end if;
  delete from core.chofer_login_telefono where user_id = p_target_user_id and organization_id = p_organization_id;
  v_borrado := found;
  update core.chofer_login_codigo set estado = 'invalidado', motivo_cierre = 'telefono_cambiado'
    where staff_user_id = p_target_user_id and estado = 'pendiente';
  return v_borrado;
end;
$$;
revoke all on function core.chofer_login_telefono_quitar(uuid, uuid) from public, anon;
grant execute on function core.chofer_login_telefono_quitar(uuid, uuid) to authenticated;

-- Lista (solo telefono enmascarado) para la pantalla del encargado.
create or replace function core.chofer_login_telefono_listar(p_organization_id uuid)
returns table (user_id uuid, telefono_enmascarado text)
language plpgsql stable security definer set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'chofer_login_telefono_listar: requiere sesion autenticada' using errcode = '42501';
  end if;
  if not core.chofer_login_puede_gestionar(p_organization_id) then
    raise exception 'tu rol no alcanza para ver los telefonos de acceso' using errcode = 'P0001';
  end if;
  return query
    select t.user_id, '******' || right(t.telefono_e164, 4)
    from core.chofer_login_telefono t where t.organization_id = p_organization_id;
end;
$$;
revoke all on function core.chofer_login_telefono_listar(uuid) from public, anon;
grant execute on function core.chofer_login_telefono_listar(uuid) to authenticated;

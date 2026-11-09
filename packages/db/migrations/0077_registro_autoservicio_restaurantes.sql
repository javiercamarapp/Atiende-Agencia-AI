-- Alta autoservicio de restaurantes: un restaurante se registra solo (correo verificado o Google) y nace en prueba de 14 dias con su
-- primera sucursal INACTIVA. Hasta hoy el alta de organizaciones de restaurantes la hacia el superadmin con doble firma (0038) y solo
-- rentas tenia registro propio (rentas.register_tenant_onboarding, 016), con contraseña.
--
-- Flujo (dos pasos, nunca una cuenta sin correo verificado):
--   1) POST /auth/registro/restaurantes/iniciar (publica, con topes por IP y por correo en la API) llama A: guarda la SOLICITUD (datos del
--      negocio + hash del token) y la API manda el enlace por correo (metodo 'correo') o arma el `state` firmado de Google con el token
--      (metodo 'google'). Ninguna organizacion se crea en este paso.
--   2) Al abrir el enlace (POST /auth/registro/restaurantes/confirmar) o al volver de Google con `email_verified`, la API llama B con el
--      hash del token: B consume la solicitud UNA sola vez y crea, en la misma transaccion, organizacion (vertical restaurantes, status
--      'trial', trial_ends_at = now() + 14 dias), cuenta de staff con el correo ya verificado (sin contraseña: entra por enlace o Google),
--      membresia owner/owner con alcance de toda la organizacion y la primera sucursal con core.crear_propiedad_interna (0071): nace
--      INACTIVA y solo se activa con core.activar_propiedad_organizacion cuando tenga menu, horario y cobertura.
--
-- Que agrega (aditivo, schema core):
--   S) core.registro_autoservicio_solicitud: solicitudes pendientes/consumidas. Guarda el correo (PII) y un HMAC de la IP (nunca la IP).
--      Retencion: A borra las filas de mas de 30 dias en cada alta (sin cron nuevo: la plataforma esta en 40 de 40).
--   A) core.registro_autoservicio_solicitar(...): crea la solicitud. Topes en la base (defensa en profundidad sobre los de la API):
--        * 3 solicitudes vigentes por correo;
--        * 10 solicitudes por origen (HMAC de IP) en 24 h y 3 organizaciones creadas por origen en 24 h;
--        * 300 solicitudes por hora en toda la plataforma (cortacircuitos ante una rafaga automatizada).
--      Rebasar cualquiera: 54000.
--   B) core.registro_autoservicio_completar(p_token_hash, p_correo_verificado): consume la solicitud y crea todo. Token inexistente,
--      consumido o vencido: P0002. Correo de Google que no coincide con el de la solicitud o falta de correo: 22023. Ya existe una cuenta
--      con ese correo: 23505 (la API manda a iniciar sesion; nunca crea una segunda cuenta ni toca la existente).
--
-- Justificacion de seguridad:
--   * S: RLS habilitada SIN policies y `revoke all from public, anon, authenticated`: nadie la lee ni la escribe directo; solo A y B.
--   * A y B: security definer, `set search_path = core, pg_temp`, tablas calificadas, sin SQL dinamico, `revoke all from public, anon` y
--     EXECUTE a authenticated porque la sesion de sistema de la API corre con ese rol sin claim. SOLO-SISTEMA: exigen auth.uid() is null
--     (un usuario con sesion no registra organizaciones por aqui: 42501). Nunca reciben ni guardan el token en claro: solo su hash (el
--     token plano solo viaja en el correo o dentro del `state` firmado de Google).
--   * B fija el actor de la bitacora de la sucursal (core.propiedad_alta_log) a la cuenta recien creada, con origen 'dueno'. La fila de la
--     solicitud se bloquea (for update) para que dos clics simultaneos no creen dos organizaciones.
--   * El slug de la organizacion se deriva del nombre (minusculas sin acentos, [a-z0-9-], sin '-' al inicio ni al final), evita las rutas
--     publicas fijas de /restaurantes/* (login, registro, ...) y se desambigua con sufijo numerico; nunca lo elige el navegador.
--
-- Rollback: scripts/rollback/migraciones/0077_registro_autoservicio_restaurantes.down.sql (borra A, B y S; las organizaciones ya creadas
-- se quedan: son organizaciones normales en prueba).

-- ═══════════════════════════════════════════════════════════════════════════
-- S) Solicitudes
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists core.registro_autoservicio_solicitud (
  id               uuid primary key default gen_random_uuid(),
  vertical         text not null check (vertical in ('restaurantes')),
  metodo           text not null check (metodo in ('correo', 'google')),
  correo           text,
  nombre_negocio   text not null check (char_length(nombre_negocio) between 2 and 120),
  nombre_sucursal  text not null check (char_length(nombre_sucursal) between 2 and 120),
  nombre_completo  text not null check (char_length(nombre_completo) between 2 and 120),
  zona_horaria     text,
  token_hash       text not null unique,
  origen_hash      text not null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  consumed_at      timestamptz,
  organization_id  uuid references core.organization(id) on delete set null,
  constraint registro_autoservicio_correo_metodo check (metodo = 'google' or correo is not null)
);
create index if not exists registro_autoservicio_correo_idx on core.registro_autoservicio_solicitud (correo, expires_at);
create index if not exists registro_autoservicio_origen_idx on core.registro_autoservicio_solicitud (origen_hash, created_at desc);
create index if not exists registro_autoservicio_created_idx on core.registro_autoservicio_solicitud (created_at);
alter table core.registro_autoservicio_solicitud enable row level security;
revoke all on core.registro_autoservicio_solicitud from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Crear la solicitud (solo sistema)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.registro_autoservicio_solicitar(
  p_vertical text,
  p_metodo text,
  p_correo text,
  p_nombre_negocio text,
  p_nombre_sucursal text,
  p_nombre_completo text,
  p_zona_horaria text,
  p_token_hash text,
  p_origen_hash text,
  p_ttl_minutos integer
)
returns uuid
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_correo text := nullif(lower(btrim(coalesce(p_correo, ''))), '');
  v_zona text := nullif(btrim(coalesce(p_zona_horaria, '')), '');
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'registro_autoservicio_solicitar: solo la sesion de sistema' using errcode = '42501';
  end if;
  if p_vertical is distinct from 'restaurantes' then
    raise exception 'registro_autoservicio_solicitar: vertical no soportada' using errcode = '22023';
  end if;
  if p_metodo is null or p_metodo not in ('correo', 'google') then
    raise exception 'registro_autoservicio_solicitar: metodo invalido' using errcode = '22023';
  end if;
  if p_metodo = 'correo' and (v_correo is null or v_correo !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$') then
    raise exception 'registro_autoservicio_solicitar: correo invalido' using errcode = '22023';
  end if;
  if p_metodo = 'google' then
    v_correo := null;
  end if;
  if char_length(btrim(coalesce(p_nombre_negocio, ''))) not between 2 and 120
     or char_length(btrim(coalesce(p_nombre_sucursal, ''))) not between 2 and 120
     or char_length(btrim(coalesce(p_nombre_completo, ''))) not between 2 and 120 then
    raise exception 'registro_autoservicio_solicitar: los nombres deben tener entre 2 y 120 caracteres' using errcode = '22023';
  end if;
  if v_zona is not null and not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = v_zona) then
    raise exception 'registro_autoservicio_solicitar: zona horaria IANA invalida' using errcode = '22023';
  end if;
  if p_token_hash is null or char_length(p_token_hash) < 32 or p_origen_hash is null or char_length(p_origen_hash) < 16 then
    raise exception 'registro_autoservicio_solicitar: token u origen invalido' using errcode = '22023';
  end if;
  if p_ttl_minutos is null or p_ttl_minutos < 5 or p_ttl_minutos > 60 then
    raise exception 'registro_autoservicio_solicitar: vigencia fuera de rango' using errcode = '22023';
  end if;

  -- Un solo candado para los topes (volumen bajo: un alta es un evento raro).
  perform pg_advisory_xact_lock(hashtextextended('core.registro_autoservicio', 0));

  -- Retencion: el correo es PII; nada se guarda mas de 30 dias.
  delete from core.registro_autoservicio_solicitud s where s.created_at < now() - interval '30 days';

  if (select count(*) from core.registro_autoservicio_solicitud s where s.created_at > now() - interval '1 hour') >= 300 then
    raise exception 'registro_autoservicio_solicitar: demasiados registros en la plataforma; intenta mas tarde' using errcode = '54000';
  end if;
  if (select count(*) from core.registro_autoservicio_solicitud s
       where s.origen_hash = p_origen_hash and s.created_at > now() - interval '24 hours') >= 10
     or (select count(*) from core.registro_autoservicio_solicitud s
       where s.origen_hash = p_origen_hash and s.organization_id is not null and s.consumed_at > now() - interval '24 hours') >= 3 then
    raise exception 'registro_autoservicio_solicitar: demasiados registros desde esta conexion' using errcode = '54000';
  end if;
  if v_correo is not null and (select count(*) from core.registro_autoservicio_solicitud s
       where s.correo = v_correo and s.consumed_at is null and s.expires_at > now()) >= 3 then
    raise exception 'registro_autoservicio_solicitar: ya hay enlaces vigentes para este correo' using errcode = '54000';
  end if;

  insert into core.registro_autoservicio_solicitud
    (vertical, metodo, correo, nombre_negocio, nombre_sucursal, nombre_completo, zona_horaria, token_hash, origen_hash, expires_at)
  values
    (p_vertical, p_metodo, v_correo, btrim(p_nombre_negocio), btrim(p_nombre_sucursal), btrim(p_nombre_completo), v_zona, p_token_hash,
     p_origen_hash, now() + make_interval(mins => p_ttl_minutos))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function core.registro_autoservicio_solicitar(text, text, text, text, text, text, text, text, text, integer) from public, anon;
grant execute on function core.registro_autoservicio_solicitar(text, text, text, text, text, text, text, text, text, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Completar: consume la solicitud y crea organizacion + cuenta + membresia + primera sucursal (solo sistema)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.registro_autoservicio_completar(p_token_hash text, p_correo_verificado text)
returns table (out_organization_id uuid, out_org_slug text, out_staff_id uuid, out_property_id uuid, out_branch_slug text, out_trial_ends_at timestamptz)
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_sol core.registro_autoservicio_solicitud%rowtype;
  v_correo_verificado text := nullif(lower(btrim(coalesce(p_correo_verificado, ''))), '');
  v_correo text;
  v_base text;
  v_slug text;
  v_n integer := 1;
  v_org uuid;
  v_staff uuid;
  v_trial timestamptz := now() + interval '14 days';
  v_prop uuid;
  v_branch_slug text;
begin
  if auth.uid() is not null then
    raise exception 'registro_autoservicio_completar: solo la sesion de sistema' using errcode = '42501';
  end if;
  select * into v_sol from core.registro_autoservicio_solicitud s where s.token_hash = p_token_hash for update;
  if v_sol.id is null or v_sol.consumed_at is not null or v_sol.expires_at <= now() then
    raise exception 'registro_autoservicio_completar: enlace invalido o vencido' using errcode = 'P0002';
  end if;

  if v_sol.metodo = 'google' then
    if v_correo_verificado is null then
      raise exception 'registro_autoservicio_completar: falta el correo verificado por Google' using errcode = '22023';
    end if;
    v_correo := v_correo_verificado;
  else
    if v_correo_verificado is not null and v_correo_verificado <> v_sol.correo then
      raise exception 'registro_autoservicio_completar: el correo no coincide con el de la solicitud' using errcode = '22023';
    end if;
    v_correo := v_sol.correo;
  end if;

  if exists (select 1 from core.staff_user u where lower(u.email) = v_correo) then
    raise exception 'registro_autoservicio_completar: ya existe una cuenta con ese correo' using errcode = '23505';
  end if;

  -- Slug de la organizacion: mismo criterio que el de sucursal (0071), unico en la plataforma.
  v_base := btrim(left(btrim(regexp_replace(lower(translate(v_sol.nombre_negocio, 'ÁÉÍÓÚÜÑáéíóúüñ', 'aeiouunaeiouun')), '[^a-z0-9]+', '-', 'g'), '-'), 60), '-');
  if v_base is null or v_base = '' then
    v_base := 'restaurante';
  end if;
  -- Rutas publicas fijas de /restaurantes/* en la SPA: un slug asi quedaria tapado por la ruta.
  if v_base in ('login', 'registro', 'auth', 'acceso-repartidor', 'restablecer-contrasena', 'verificar-correo', 'demo') then
    v_base := v_base || '-restaurante';
  end if;
  v_slug := v_base;
  while exists (select 1 from core.organization o where o.slug = v_slug) loop
    v_n := v_n + 1;
    if v_n > 200 then
      raise exception 'registro_autoservicio_completar: no se pudo derivar un slug libre' using errcode = 'P0003';
    end if;
    v_slug := v_base || '-' || v_n;
  end loop;

  insert into core.organization (vertical, name, slug, status, trial_ends_at)
  values ('restaurantes', v_sol.nombre_negocio, v_slug, 'trial', v_trial)
  returning id into v_org;

  insert into core.staff_user (email, password_hash, full_name, created_via, email_verified_at)
  values (v_correo, null, v_sol.nombre_completo, case when v_sol.metodo = 'google' then 'google' else 'registro_autoservicio' end, now())
  returning id into v_staff;

  insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role)
  values (v_staff, v_org, null, 'owner', 'owner');

  select c.out_property_id, c.out_slug into v_prop, v_branch_slug
  from core.crear_propiedad_interna(v_org, v_sol.nombre_sucursal, v_sol.zona_horaria, v_staff, 'dueno', null) c;

  update core.registro_autoservicio_solicitud s
     set consumed_at = now(), organization_id = v_org, correo = v_correo
   where s.id = v_sol.id;

  return query select v_org, v_slug, v_staff, v_prop, v_branch_slug, v_trial;
end;
$$;
revoke all on function core.registro_autoservicio_completar(text, text) from public, anon;
grant execute on function core.registro_autoservicio_completar(text, text) to authenticated;

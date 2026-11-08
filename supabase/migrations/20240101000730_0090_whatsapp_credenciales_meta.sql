-- 0090 -- Credenciales de Meta (WhatsApp Cloud API) por organizacion: varias apps de Meta a la vez.
--
-- Hasta hoy la plataforma tiene UN solo token (WHATSAPP_ACCESS_TOKEN) y UN solo secreto de app (WHATSAPP_APP_SECRET), y por
-- sucursal solo guarda el `phone_number_id` (restaurantes.whatsapp_branch_channel, 023). Un negocio que registra sus numeros en
-- SU propio portafolio de Meta (WABA + app tipo Business propias: p. ej. Los Taquitos de PM mientras Atiende no esta verificado)
-- trae su propio token de usuario de sistema y su propio secreto de app. Esta migracion guarda esas credenciales por organizacion
-- y asigna a cada numero la credencial con la que se envia y con la que se verifica su webhook.
--
-- Nada cambia si no se registra ninguna credencial: el envio y la firma siguen con las variables de plataforma (el codigo cae a
-- ellas para todo numero sin asignacion). Base sin migrar: el TypeScript captura 42P01/42883/42703 y conserva el camino anterior.
--
-- Cifrado: el token y el secreto de app se cifran en la API (AES-256-GCM, llave WHATSAPP_CREDENTIALS_KEY que vive SOLO en el
-- entorno de la API; misma forma de sobre `v<version>.<iv>.<tag>.<ciphertext>` que la boveda de hoteles y el acceso de rentas,
-- con AAD que ata cada sobre a (credencial, organizacion, campo)). La base nunca ve el texto claro. El verify token del webhook
-- se guarda como SHA-256 (solo se compara).
--
-- Justificacion de seguridad, una por una:
--
--   * core.whatsapp_meta_credencial / core.whatsapp_meta_numero / core.whatsapp_meta_evento
--     - RLS habilitado SIN ninguna policy y `revoke all` a public, anon, authenticated y service_role: ningun cliente (ni con la
--       llave de servicio por PostgREST) lee ni escribe estas tablas directo. Toda lectura y escritura pasa por las funciones
--       `security definer` de abajo, que corren como el dueno.
--     - La credencial guarda sobres cifrados, nunca texto claro; aun asi no hay GRANT de SELECT a nadie.
--     - `app_id` y `waba_id` activos son UNICOS en toda la plataforma: una app o WABA no puede quedar atada a dos organizaciones.
--     - `core.whatsapp_meta_numero` exige (credencial, organizacion) con llave foranea compuesta: un numero nunca apunta a la
--       credencial de otra organizacion.
--     - La bitacora `core.whatsapp_meta_evento` es append-only (UPDATE/DELETE/TRUNCATE bloqueados con 0A000) y no guarda
--       secretos: solo ids de Meta, nombres de campos rotados y el motivo de una revocacion.
--
--   * Funciones de SUPERADMIN (registrar, rotar, revocar, asignar numero, listar): `security definer`, `set search_path` fijo,
--     `revoke all ... from public, anon` y `grant execute ... to authenticated`. Las de escritura llaman a
--     core.superadmin_require_caller (caller-binding `auth.uid() = p_caller_id`, superadmin vigente y NO restringido al rol de solo
--     lectura `finanzas`, ver 0034); las de lectura devuelven cero filas a quien no es el superadmin autenticado. Ninguna devuelve
--     un sobre cifrado ni un hash: solo metadatos y banderas (`tiene_verify_token`).
--
--   * core.whatsapp_meta_credenciales_para_sistema(): la UNICA que devuelve los sobres cifrados (y el hash del verify token).
--     Solo para la sesion de SISTEMA de la API (`auth.uid() is null`, mismo criterio que el resto de funciones de sistema): con un
--     usuario autenticado lanza 42501. `grant execute` a authenticated porque la sesion de sistema de la API corre con ese rol y
--     `request.jwt.claim.sub` vacio; un JWT real siempre trae `sub`, asi que ningun cliente llega por esa rama. Aun si llegara,
--     sin WHATSAPP_CREDENTIALS_KEY los sobres no se pueden abrir.
--
--   * core.whatsapp_meta_asignar_numero escribe tambien restaurantes.whatsapp_branch_channel cuando se indica la sucursal: valida
--     que la sucursal sea de la organizacion y de la vertical restaurantes, y rechaza (23505) un numero que ya rutea a OTRA
--     organizacion en cualquiera de las tres tablas (ademas del trigger guard_whatsapp_phone_number_id de la 023).
--
-- Rollback (manual; solo con OK de Javier, y antes de que el codigo dependa de estas tablas -- el TypeScript ya degrada solo a las
-- variables de plataforma si faltan):
--   drop function if exists core.whatsapp_meta_credenciales_para_sistema();
--   drop function if exists core.whatsapp_meta_listar_numeros(uuid, uuid);
--   drop function if exists core.whatsapp_meta_listar_credenciales(uuid, uuid);
--   drop function if exists core.whatsapp_meta_asignar_numero(uuid, uuid, text, uuid, uuid);
--   drop function if exists core.whatsapp_meta_revocar_credencial(uuid, uuid, uuid, text);
--   drop function if exists core.whatsapp_meta_rotar_credencial(uuid, uuid, uuid, text, text, text, text, boolean);
--   drop function if exists core.whatsapp_meta_registrar_credencial(uuid, uuid, uuid, text, text, text, text, text, text);
--   drop table if exists core.whatsapp_meta_evento, core.whatsapp_meta_numero, core.whatsapp_meta_credencial;
--   drop function if exists core.whatsapp_meta_evento_bloquear_mutacion();
-- Las filas de restaurantes.whatsapp_branch_channel que haya escrito la asignacion se quedan (son el ruteo normal de la 023).

-- ---------------------------------------------------------------------------
-- 1) Credencial (una por app de Meta)
-- ---------------------------------------------------------------------------
create table core.whatsapp_meta_credencial (
  -- Lo genera la API: el id forma parte de la AAD del cifrado, asi que existe antes de cifrar.
  id uuid primary key,
  organization_id uuid not null references core.organization(id) on delete cascade,
  etiqueta text not null check (char_length(btrim(etiqueta)) between 1 and 80),
  app_id text not null check (app_id ~ '^[0-9]{5,32}$'),
  waba_id text not null check (waba_id ~ '^[0-9]{5,32}$'),
  -- Sobres AES-256-GCM (texto claro nunca). Null solo despues de revocar (se borran al revocar).
  app_secret_cifrado text check (app_secret_cifrado is null or (char_length(app_secret_cifrado) <= 4096 and app_secret_cifrado ~ '^v[0-9]{1,3}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$')),
  access_token_cifrado text check (access_token_cifrado is null or (char_length(access_token_cifrado) <= 4096 and access_token_cifrado ~ '^v[0-9]{1,3}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$')),
  -- SHA-256 en hex del verify token del webhook de ESTA app (opcional: sin el, la app usa el WHATSAPP_VERIFY_TOKEN de plataforma).
  verify_token_hash text check (verify_token_hash is null or verify_token_hash ~ '^[0-9a-f]{64}$'),
  activa boolean not null default true,
  creada_por uuid references core.staff_user(id) on delete set null,
  creada_en timestamptz not null default now(),
  secreto_rotado_en timestamptz not null default now(),
  token_rotado_en timestamptz not null default now(),
  actualizada_por uuid references core.staff_user(id) on delete set null,
  actualizada_en timestamptz not null default now(),
  revocada_en timestamptz,
  constraint whatsapp_meta_credencial_estado_check check (
    (activa and revocada_en is null and app_secret_cifrado is not null and access_token_cifrado is not null)
    or (not activa and revocada_en is not null and app_secret_cifrado is null and access_token_cifrado is null and verify_token_hash is null)
  ),
  constraint whatsapp_meta_credencial_id_org_key unique (id, organization_id)
);
create unique index whatsapp_meta_credencial_app_activa_uidx on core.whatsapp_meta_credencial (app_id) where activa;
create unique index whatsapp_meta_credencial_waba_activa_uidx on core.whatsapp_meta_credencial (waba_id) where activa;
create index whatsapp_meta_credencial_org_idx on core.whatsapp_meta_credencial (organization_id);

alter table core.whatsapp_meta_credencial enable row level security;
revoke all on core.whatsapp_meta_credencial from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Numero -> credencial (sin fila = el numero usa las variables de plataforma)
-- ---------------------------------------------------------------------------
create table core.whatsapp_meta_numero (
  phone_number_id text primary key check (phone_number_id ~ '^[0-9]{5,32}$'),
  organization_id uuid not null references core.organization(id) on delete cascade,
  credencial_id uuid not null,
  asignado_por uuid references core.staff_user(id) on delete set null,
  asignado_en timestamptz not null default now(),
  constraint whatsapp_meta_numero_credencial_fkey foreign key (credencial_id, organization_id)
    references core.whatsapp_meta_credencial (id, organization_id) on delete cascade
);
create index whatsapp_meta_numero_credencial_idx on core.whatsapp_meta_numero (credencial_id);
create index whatsapp_meta_numero_org_idx on core.whatsapp_meta_numero (organization_id);

alter table core.whatsapp_meta_numero enable row level security;
revoke all on core.whatsapp_meta_numero from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Bitacora append-only (sin secretos)
-- ---------------------------------------------------------------------------
create table core.whatsapp_meta_evento (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  organization_id uuid references core.organization(id) on delete set null,
  -- Sin llave foranea a proposito: el rastro sobrevive aunque la credencial se borre con su organizacion.
  credencial_id uuid,
  evento text not null check (evento in ('credencial_registrada', 'credencial_rotada', 'credencial_revocada', 'numero_asignado', 'numero_liberado')),
  actor_user_id uuid references core.staff_user(id) on delete set null,
  detalle jsonb not null default '{}'::jsonb check (octet_length(detalle::text) <= 2000),
  ocurrido_en timestamptz not null default now()
);
create index whatsapp_meta_evento_org_seq_idx on core.whatsapp_meta_evento (organization_id, seq desc);

create or replace function core.whatsapp_meta_evento_bloquear_mutacion()
returns trigger language plpgsql set search_path = core, pg_temp as $$
begin
  raise exception 'whatsapp_meta_evento es append-only: % no esta permitido', tg_op using errcode = '0A000';
end;
$$;
revoke all on function core.whatsapp_meta_evento_bloquear_mutacion() from public, anon, authenticated;
create trigger whatsapp_meta_evento_bloquear_update before update on core.whatsapp_meta_evento
  for each row execute function core.whatsapp_meta_evento_bloquear_mutacion();
create trigger whatsapp_meta_evento_bloquear_delete before delete on core.whatsapp_meta_evento
  for each row execute function core.whatsapp_meta_evento_bloquear_mutacion();
create trigger whatsapp_meta_evento_bloquear_truncate before truncate on core.whatsapp_meta_evento
  for each statement execute function core.whatsapp_meta_evento_bloquear_mutacion();

alter table core.whatsapp_meta_evento enable row level security;
revoke all on core.whatsapp_meta_evento from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4) Escritura del superadmin
-- ---------------------------------------------------------------------------

-- Registrar una credencial nueva (los sobres llegan ya cifrados por la API).
create or replace function core.whatsapp_meta_registrar_credencial(
  p_caller_id uuid, p_credencial_id uuid, p_organization_id uuid, p_etiqueta text, p_app_id text, p_waba_id text,
  p_app_secret_cifrado text, p_access_token_cifrado text, p_verify_token_hash text
) returns void language plpgsql security definer set search_path = core, pg_temp as $$
begin
  perform core.superadmin_require_caller(p_caller_id, 'whatsapp_meta_registrar_credencial');
  if p_organization_id is null or not exists (select 1 from core.organization o where o.id = p_organization_id) then
    raise exception 'whatsapp_meta_registrar_credencial: la organizacion no existe' using errcode = 'P0002';
  end if;
  if p_credencial_id is null or p_app_secret_cifrado is null or p_access_token_cifrado is null then
    raise exception 'whatsapp_meta_registrar_credencial: faltan datos de la credencial' using errcode = '22023';
  end if;
  insert into core.whatsapp_meta_credencial (id, organization_id, etiqueta, app_id, waba_id, app_secret_cifrado, access_token_cifrado, verify_token_hash, creada_por, actualizada_por)
  values (p_credencial_id, p_organization_id, btrim(p_etiqueta), p_app_id, p_waba_id, p_app_secret_cifrado, p_access_token_cifrado, p_verify_token_hash, p_caller_id, p_caller_id);
  insert into core.whatsapp_meta_evento (organization_id, credencial_id, evento, actor_user_id, detalle)
  values (p_organization_id, p_credencial_id, 'credencial_registrada', p_caller_id,
          jsonb_build_object('app_id', p_app_id, 'waba_id', p_waba_id, 'con_verify_token', p_verify_token_hash is not null));
end;
$$;
revoke all on function core.whatsapp_meta_registrar_credencial(uuid, uuid, uuid, text, text, text, text, text, text) from public, anon;
grant execute on function core.whatsapp_meta_registrar_credencial(uuid, uuid, uuid, text, text, text, text, text, text) to authenticated;

-- Rotar: cada argumento null conserva el valor actual. `p_quitar_verify_token` borra el verify token propio (vuelve al de plataforma).
create or replace function core.whatsapp_meta_rotar_credencial(
  p_caller_id uuid, p_credencial_id uuid, p_organization_id uuid, p_etiqueta text,
  p_app_secret_cifrado text, p_access_token_cifrado text, p_verify_token_hash text, p_quitar_verify_token boolean
) returns void language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_campos text[] := '{}';
begin
  perform core.superadmin_require_caller(p_caller_id, 'whatsapp_meta_rotar_credencial');
  perform 1 from core.whatsapp_meta_credencial c
   where c.id = p_credencial_id and c.organization_id = p_organization_id and c.activa
   for update;
  if not found then
    raise exception 'whatsapp_meta_rotar_credencial: la credencial no existe, es de otra organizacion o esta revocada' using errcode = 'P0002';
  end if;
  if p_etiqueta is not null then v_campos := array_append(v_campos, 'etiqueta'); end if;
  if p_app_secret_cifrado is not null then v_campos := array_append(v_campos, 'app_secret'); end if;
  if p_access_token_cifrado is not null then v_campos := array_append(v_campos, 'access_token'); end if;
  if p_verify_token_hash is not null then v_campos := array_append(v_campos, 'verify_token'); end if;
  if coalesce(p_quitar_verify_token, false) then
    if p_verify_token_hash is not null then
      raise exception 'whatsapp_meta_rotar_credencial: no se puede poner y quitar el verify token a la vez' using errcode = '22023';
    end if;
    v_campos := array_append(v_campos, 'verify_token_quitado');
  end if;
  if cardinality(v_campos) = 0 then
    raise exception 'whatsapp_meta_rotar_credencial: no hay nada que cambiar' using errcode = '22023';
  end if;
  update core.whatsapp_meta_credencial c set
    etiqueta = coalesce(btrim(p_etiqueta), c.etiqueta),
    app_secret_cifrado = coalesce(p_app_secret_cifrado, c.app_secret_cifrado),
    secreto_rotado_en = case when p_app_secret_cifrado is not null then now() else c.secreto_rotado_en end,
    access_token_cifrado = coalesce(p_access_token_cifrado, c.access_token_cifrado),
    token_rotado_en = case when p_access_token_cifrado is not null then now() else c.token_rotado_en end,
    verify_token_hash = case when coalesce(p_quitar_verify_token, false) then null else coalesce(p_verify_token_hash, c.verify_token_hash) end,
    actualizada_por = p_caller_id,
    actualizada_en = now()
  where c.id = p_credencial_id;
  insert into core.whatsapp_meta_evento (organization_id, credencial_id, evento, actor_user_id, detalle)
  values (p_organization_id, p_credencial_id, 'credencial_rotada', p_caller_id, jsonb_build_object('campos', to_jsonb(v_campos)));
end;
$$;
revoke all on function core.whatsapp_meta_rotar_credencial(uuid, uuid, uuid, text, text, text, text, boolean) from public, anon;
grant execute on function core.whatsapp_meta_rotar_credencial(uuid, uuid, uuid, text, text, text, text, boolean) to authenticated;

-- Revocar: borra los sobres y el hash, libera sus numeros (vuelven a la plataforma) y deja el rastro. Devuelve cuantos numeros libero.
create or replace function core.whatsapp_meta_revocar_credencial(p_caller_id uuid, p_credencial_id uuid, p_organization_id uuid, p_motivo text)
returns integer language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_liberados integer;
begin
  perform core.superadmin_require_caller(p_caller_id, 'whatsapp_meta_revocar_credencial');
  if p_motivo is null or char_length(btrim(p_motivo)) not between 10 and 500 then
    raise exception 'whatsapp_meta_revocar_credencial: el motivo es obligatorio (10 a 500 caracteres)' using errcode = '22023';
  end if;
  perform 1 from core.whatsapp_meta_credencial c
   where c.id = p_credencial_id and c.organization_id = p_organization_id and c.activa
   for update;
  if not found then
    raise exception 'whatsapp_meta_revocar_credencial: la credencial no existe, es de otra organizacion o ya esta revocada' using errcode = 'P0002';
  end if;
  delete from core.whatsapp_meta_numero n where n.credencial_id = p_credencial_id;
  get diagnostics v_liberados = row_count;
  update core.whatsapp_meta_credencial c set
    activa = false, revocada_en = now(), app_secret_cifrado = null, access_token_cifrado = null, verify_token_hash = null,
    actualizada_por = p_caller_id, actualizada_en = now()
  where c.id = p_credencial_id;
  insert into core.whatsapp_meta_evento (organization_id, credencial_id, evento, actor_user_id, detalle)
  values (p_organization_id, p_credencial_id, 'credencial_revocada', p_caller_id,
          jsonb_build_object('motivo', left(btrim(p_motivo), 500), 'numeros_liberados', v_liberados));
  return v_liberados;
end;
$$;
revoke all on function core.whatsapp_meta_revocar_credencial(uuid, uuid, uuid, text) from public, anon;
grant execute on function core.whatsapp_meta_revocar_credencial(uuid, uuid, uuid, text) to authenticated;

-- Asignar un numero: con `p_property_id` lo conecta a esa sucursal de restaurantes (ruteo de la 023); con `p_credencial_id` lo
-- envia y verifica con esa app; con `p_credencial_id` null lo devuelve a la plataforma.
create or replace function core.whatsapp_meta_asignar_numero(
  p_caller_id uuid, p_organization_id uuid, p_phone_number_id text, p_credencial_id uuid, p_property_id uuid
) returns void language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_vertical text;
  v_anterior text;
  v_habia boolean;
begin
  perform core.superadmin_require_caller(p_caller_id, 'whatsapp_meta_asignar_numero');
  if p_organization_id is null or not exists (select 1 from core.organization o where o.id = p_organization_id) then
    raise exception 'whatsapp_meta_asignar_numero: la organizacion no existe' using errcode = 'P0002';
  end if;
  if p_phone_number_id is null or p_phone_number_id !~ '^[0-9]{5,32}$' then
    raise exception 'whatsapp_meta_asignar_numero: phone_number_id invalido (solo digitos, 5 a 32)' using errcode = '22023';
  end if;
  -- Un numero que ya rutea a OTRA organizacion no se toca desde aqui.
  if exists (select 1 from core.whatsapp_meta_numero n where n.phone_number_id = p_phone_number_id and n.organization_id <> p_organization_id)
     or exists (select 1 from restaurantes.whatsapp_branch_channel b where b.phone_number_id = p_phone_number_id and b.organization_id <> p_organization_id)
     or exists (select 1 from restaurantes.whatsapp_channel_config w where w.phone_number_id = p_phone_number_id and w.organization_id <> p_organization_id) then
    raise exception 'whatsapp_meta_asignar_numero: el numero ya pertenece a otra organizacion' using errcode = '23505';
  end if;

  if p_property_id is not null then
    select p.vertical into v_vertical from core.property p where p.id = p_property_id and p.organization_id = p_organization_id;
    if not found then
      raise exception 'whatsapp_meta_asignar_numero: la sucursal no existe o es de otra organizacion' using errcode = 'P0002';
    end if;
    if v_vertical <> 'restaurantes' then
      raise exception 'whatsapp_meta_asignar_numero: el numero por sucursal solo existe en restaurantes' using errcode = '22023';
    end if;
    -- El numero anterior de esa sucursal deja de rutear y suelta su credencial.
    select b.phone_number_id into v_anterior from restaurantes.whatsapp_branch_channel b where b.property_id = p_property_id;
    if v_anterior is not null and v_anterior <> p_phone_number_id then
      delete from core.whatsapp_meta_numero n where n.phone_number_id = v_anterior and n.organization_id = p_organization_id;
    end if;
    delete from restaurantes.whatsapp_branch_channel b
     where b.organization_id = p_organization_id and (b.property_id = p_property_id or b.phone_number_id = p_phone_number_id);
    insert into restaurantes.whatsapp_branch_channel (phone_number_id, organization_id, property_id)
    values (p_phone_number_id, p_organization_id, p_property_id);
  end if;

  if p_credencial_id is null then
    delete from core.whatsapp_meta_numero n where n.phone_number_id = p_phone_number_id and n.organization_id = p_organization_id;
    v_habia := found;
    insert into core.whatsapp_meta_evento (organization_id, credencial_id, evento, actor_user_id, detalle)
    values (p_organization_id, null, 'numero_liberado', p_caller_id,
            jsonb_build_object('phone_number_id', p_phone_number_id, 'property_id', p_property_id, 'tenia_credencial', v_habia, 'numero_anterior', v_anterior));
    return;
  end if;

  if not exists (select 1 from core.whatsapp_meta_credencial c where c.id = p_credencial_id and c.organization_id = p_organization_id and c.activa) then
    raise exception 'whatsapp_meta_asignar_numero: la credencial no existe, es de otra organizacion o esta revocada' using errcode = 'P0002';
  end if;
  insert into core.whatsapp_meta_numero (phone_number_id, organization_id, credencial_id, asignado_por)
  values (p_phone_number_id, p_organization_id, p_credencial_id, p_caller_id)
  on conflict (phone_number_id) do update set credencial_id = excluded.credencial_id, asignado_por = excluded.asignado_por, asignado_en = now();
  insert into core.whatsapp_meta_evento (organization_id, credencial_id, evento, actor_user_id, detalle)
  values (p_organization_id, p_credencial_id, 'numero_asignado', p_caller_id,
          jsonb_build_object('phone_number_id', p_phone_number_id, 'property_id', p_property_id, 'numero_anterior', v_anterior));
end;
$$;
revoke all on function core.whatsapp_meta_asignar_numero(uuid, uuid, text, uuid, uuid) from public, anon;
grant execute on function core.whatsapp_meta_asignar_numero(uuid, uuid, text, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Lecturas del superadmin (solo metadatos; cero filas para cualquier otro)
-- ---------------------------------------------------------------------------
create or replace function core.whatsapp_meta_listar_credenciales(p_caller_id uuid, p_organization_id uuid)
returns table (
  id uuid, etiqueta text, app_id text, waba_id text, tiene_verify_token boolean, activa boolean,
  creada_en timestamptz, secreto_rotado_en timestamptz, token_rotado_en timestamptz, actualizada_en timestamptz, revocada_en timestamptz,
  numeros integer
) language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query
    select c.id, c.etiqueta, c.app_id, c.waba_id, c.verify_token_hash is not null, c.activa,
           c.creada_en, c.secreto_rotado_en, c.token_rotado_en, c.actualizada_en, c.revocada_en,
           (select count(*)::integer from core.whatsapp_meta_numero n where n.credencial_id = c.id)
    from core.whatsapp_meta_credencial c
    where c.organization_id = p_organization_id
    order by c.activa desc, c.creada_en, c.id;
end;
$$;
revoke all on function core.whatsapp_meta_listar_credenciales(uuid, uuid) from public, anon;
grant execute on function core.whatsapp_meta_listar_credenciales(uuid, uuid) to authenticated;

-- Numeros de la organizacion: cada sucursal (con o sin numero), el numero por defecto de la organizacion y cualquier numero asignado
-- a una credencial que no este en las otras dos tablas. `origen`: sucursal | organizacion | credencial.
create or replace function core.whatsapp_meta_listar_numeros(p_caller_id uuid, p_organization_id uuid)
returns table (property_id uuid, property_nombre text, property_estado text, phone_number_id text, credencial_id uuid, origen text)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query
    with numeros as (
      select b.phone_number_id, b.property_id, 'sucursal'::text as origen
        from restaurantes.whatsapp_branch_channel b where b.organization_id = p_organization_id
      union all
      select w.phone_number_id, null::uuid, 'organizacion'::text
        from restaurantes.whatsapp_channel_config w
       where w.organization_id = p_organization_id
         and not exists (select 1 from restaurantes.whatsapp_branch_channel b where b.phone_number_id = w.phone_number_id)
      union all
      select n.phone_number_id, null::uuid, 'credencial'::text
        from core.whatsapp_meta_numero n
       where n.organization_id = p_organization_id
         and not exists (select 1 from restaurantes.whatsapp_branch_channel b where b.phone_number_id = n.phone_number_id)
         and not exists (select 1 from restaurantes.whatsapp_channel_config w where w.phone_number_id = n.phone_number_id)
    )
    select p.id, p.name, p.status, nu.phone_number_id, m.credencial_id, coalesce(nu.origen, 'sucursal')
      from core.property p
      left join numeros nu on nu.property_id = p.id
      left join core.whatsapp_meta_numero m on m.phone_number_id = nu.phone_number_id
     where p.organization_id = p_organization_id
    union all
    select null::uuid, null::text, null::text, nu.phone_number_id, m.credencial_id, nu.origen
      from numeros nu
      left join core.whatsapp_meta_numero m on m.phone_number_id = nu.phone_number_id
     where nu.property_id is null
    order by 2 nulls last, 4;
end;
$$;
revoke all on function core.whatsapp_meta_listar_numeros(uuid, uuid) from public, anon;
grant execute on function core.whatsapp_meta_listar_numeros(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) Lectura de SISTEMA (envio, firma del webhook y verify token). Unica que devuelve los sobres cifrados.
-- ---------------------------------------------------------------------------
create or replace function core.whatsapp_meta_credenciales_para_sistema()
returns table (
  id uuid, organization_id uuid, app_id text, waba_id text, app_secret_cifrado text, access_token_cifrado text,
  verify_token_hash text, phone_number_ids text[]
) language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'whatsapp_meta_credenciales_para_sistema: solo la sesion de sistema de la API' using errcode = '42501';
  end if;
  return query
    select c.id, c.organization_id, c.app_id, c.waba_id, c.app_secret_cifrado, c.access_token_cifrado, c.verify_token_hash,
           coalesce((select array_agg(n.phone_number_id order by n.phone_number_id) from core.whatsapp_meta_numero n where n.credencial_id = c.id), '{}'::text[])
      from core.whatsapp_meta_credencial c
     where c.activa
     order by c.creada_en, c.id;
end;
$$;
revoke all on function core.whatsapp_meta_credenciales_para_sistema() from public, anon;
grant execute on function core.whatsapp_meta_credenciales_para_sistema() to authenticated;

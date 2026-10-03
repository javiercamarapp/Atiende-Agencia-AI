-- PL-31 + PL-32: catalogo de plantillas HSM de WhatsApp por organizacion y baja/alta (opt-out) por organizacion.
--
-- Contexto: un aviso que el NEGOCIO inicia fuera de la ventana de 24 h de Meta solo se entrega como plantilla
-- aprobada. Hasta hoy la lista de plantillas aprobadas era una variable de entorno GLOBAL; ahora cada organizacion
-- declara las suyas (la aprobacion en Meta Business Manager sigue siendo un paso externo: aqui solo se registra su
-- estado). El opt-out (BAJA/STOP) es por organizacion y canal: quien pide la baja a un negocio deja de recibir los
-- avisos proactivos de ESE negocio; la lista global de supresion (0043) sigue aparte y sigue siendo global.
--
-- Justificacion de seguridad (cada tabla/funcion/GRANT trae su razon):
--   * core.whatsapp_plantilla: RLS habilitado. Policies SOLO para owner/admin de la organizacion
--     (core.membership.platform_role in ('owner','admin')), igual que core.staff_invite (0002): un member/viewer no
--     llega a ver ni a editar plantillas. GRANT a `authenticated` a nivel COLUMNA: el INSERT solo escribe
--     organization_id, vertical, evento, nombre, idioma, variables, estado y creado_por (las marcas de tiempo las
--     pone el trigger); el UPDATE solo toca nombre, idioma, variables y estado (no se puede mover una plantilla a
--     otra organizacion ni cambiar su autor). Nada a anon. DELETE para owner/admin (descartar una plantilla).
--   * core.whatsapp_plantilla_resolver / core.whatsapp_plantilla_aprobada: solo-sistema (auth.uid() is null, 42501
--     si no). Razon: las consultan el cron de recordatorios y el despachador, que corren sin sesion de usuario; la
--     resolucion devuelve unicamente la plantilla APROBADA de la organizacion pedida (nunca de otra). GRANT solo a
--     `authenticated` (rol bajo el que corre withAppSession, con o sin auth.uid()).
--   * core.messaging_opt_out: RLS sin policies y REVOKE ALL a public, anon y authenticated; solo se toca por las
--     funciones definer de abajo. Guarda el telefono SOLO como SHA-256 (prefijo de dominio 'atiende:optout:v1:');
--     la normalizacion a E.164 la hace el API. Misma mitigacion y mismo hueco declarado que 0043 (espacio de
--     telefonos chico: invertible por enumeracion si alguien obtuviera la tabla; mejora pendiente: HMAC con llave).
--   * core.opt_out_registrar / opt_out_reactivar / opt_out_activo: solo-sistema por la misma razon que 0043: las
--     llaman el webhook entrante y el despachador; una sesion de staff con auth.uid() real nunca debe poder
--     fabricar ni borrar bajas de clientes ajenos. opt_out_activo devuelve solo boolean.
--   * citas.ultimo_mensaje_entrante: solo-sistema; devuelve solo una marca de tiempo (cuando escribio el cliente por
--     ultima vez a ESA organizacion), para decidir la ventana de 24 h de Meta. Recibe los hashes (hasta 5, variantes de formato
--     del mismo telefono) que ya guarda citas.whatsapp_inbound_events, nunca el telefono.
--
-- Orden de despliegue: CUALQUIER ORDEN. El codigo TypeScript captura 42883/42P01/42703 (migracion pendiente) con
-- SAVEPOINT y cae al comportamiento anterior (catalogo global del entorno, sin opt-out por organizacion, ventana
-- desconocida), nunca a un 500.

-- ---------------------------------------------------------------------------------------------------------------
-- Catalogo de plantillas
-- ---------------------------------------------------------------------------------------------------------------
-- Valida el arreglo de nombres de variables (un regex unico con repeticiones anidadas excede el limite de Postgres).
create or replace function core.whatsapp_variables_validas(p_variables text[])
returns boolean language sql immutable set search_path = core, pg_temp as $$
  select p_variables is not null
    and cardinality(p_variables) <= 10
    and not exists (select 1 from unnest(p_variables) v where v is null or v !~ '^[a-z][a-z0-9_]{0,39}$');
$$;

create table core.whatsapp_plantilla (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  vertical text not null check (vertical ~ '^[a-z]{3,30}$'),
  -- Evento del ciclo, p. ej. 'appointment.reminder_24h' o 'waitlist.slot_offered'.
  evento text not null check (evento ~ '^[a-z][a-z0-9_.]{0,79}$'),
  -- Nombre de la plantilla en Meta (mismo patron que el gateway: minusculas, digitos y guion bajo).
  nombre text not null check (char_length(nombre) between 1 and 512 and nombre ~ '^[a-z0-9_]+$'),
  idioma text not null default 'es_MX' check (idioma ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  -- Orden de las variables {{1}}, {{2}}...: cada elemento es el nombre de un valor que el productor sabe calcular.
  variables text[] not null default '{}' check (core.whatsapp_variables_validas(variables)),
  estado text not null default 'borrador' check (estado in ('borrador', 'enviada', 'aprobada', 'rechazada')),
  enviada_en timestamptz,
  aprobada_en timestamptz,
  creado_por uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, vertical, evento)
);
create index whatsapp_plantilla_org_estado_idx on core.whatsapp_plantilla (organization_id, estado);

create or replace function core.whatsapp_plantilla_marcas()
returns trigger language plpgsql set search_path = core, pg_temp as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    if new.estado = 'enviada' then new.enviada_en := now(); end if;
    if new.estado = 'aprobada' then new.aprobada_en := now(); end if;
  elsif new.estado is distinct from old.estado then
    if new.estado = 'enviada' then new.enviada_en := now(); end if;
    if new.estado = 'aprobada' then new.aprobada_en := now(); else new.aprobada_en := null; end if;
  end if;
  return new;
end;
$$;
create trigger whatsapp_plantilla_marcas before insert or update on core.whatsapp_plantilla
  for each row execute function core.whatsapp_plantilla_marcas();

alter table core.whatsapp_plantilla enable row level security;
revoke all on core.whatsapp_plantilla from public, anon, authenticated;

create policy "owner/admin ve plantillas de WhatsApp de su organizacion"
  on core.whatsapp_plantilla for select
  using (exists (select 1 from core.membership m where m.organization_id = core.whatsapp_plantilla.organization_id and m.user_id = auth.uid() and m.platform_role in ('owner', 'admin')));
create policy "owner/admin crea plantillas de WhatsApp de su organizacion"
  on core.whatsapp_plantilla for insert
  with check (creado_por = auth.uid() and exists (select 1 from core.membership m where m.organization_id = core.whatsapp_plantilla.organization_id and m.user_id = auth.uid() and m.platform_role in ('owner', 'admin')));
create policy "owner/admin edita plantillas de WhatsApp de su organizacion"
  on core.whatsapp_plantilla for update
  using (exists (select 1 from core.membership m where m.organization_id = core.whatsapp_plantilla.organization_id and m.user_id = auth.uid() and m.platform_role in ('owner', 'admin')))
  with check (exists (select 1 from core.membership m where m.organization_id = core.whatsapp_plantilla.organization_id and m.user_id = auth.uid() and m.platform_role in ('owner', 'admin')));
create policy "owner/admin borra plantillas de WhatsApp de su organizacion"
  on core.whatsapp_plantilla for delete
  using (exists (select 1 from core.membership m where m.organization_id = core.whatsapp_plantilla.organization_id and m.user_id = auth.uid() and m.platform_role in ('owner', 'admin')));

grant select on core.whatsapp_plantilla to authenticated;
grant insert (organization_id, vertical, evento, nombre, idioma, variables, estado, creado_por) on core.whatsapp_plantilla to authenticated;
grant update (nombre, idioma, variables, estado) on core.whatsapp_plantilla to authenticated;
grant delete on core.whatsapp_plantilla to authenticated;
grant select, insert, update, delete on core.whatsapp_plantilla to service_role;

-- Solo sistema: la plantilla APROBADA de (organizacion, evento), o ninguna fila.
create or replace function core.whatsapp_plantilla_resolver(p_organization_id uuid, p_evento text)
returns table (nombre text, idioma text, variables text[])
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'whatsapp_plantilla_resolver: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  return query
    select p.nombre, p.idioma, p.variables
    from core.whatsapp_plantilla p
    where p.organization_id = p_organization_id and p.evento = p_evento and p.estado = 'aprobada'
    order by p.aprobada_en desc nulls last, p.id
    limit 1;
end;
$$;
revoke all on function core.whatsapp_plantilla_resolver(uuid, text) from public, anon;
grant execute on function core.whatsapp_plantilla_resolver(uuid, text) to authenticated;

-- Solo sistema: `true` si la organizacion tiene una plantilla con ese nombre en estado aprobada.
create or replace function core.whatsapp_plantilla_aprobada(p_organization_id uuid, p_nombre text)
returns boolean
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'whatsapp_plantilla_aprobada: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  return exists (select 1 from core.whatsapp_plantilla p where p.organization_id = p_organization_id and p.nombre = p_nombre and p.estado = 'aprobada');
end;
$$;
revoke all on function core.whatsapp_plantilla_aprobada(uuid, text) from public, anon;
grant execute on function core.whatsapp_plantilla_aprobada(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Opt-out por organizacion y canal
-- ---------------------------------------------------------------------------------------------------------------
create table core.messaging_opt_out (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  canal text not null check (canal in ('whatsapp')),
  telefono_hash text not null check (telefono_hash ~ '^[0-9a-f]{64}$'),
  motivo text not null default 'baja' check (motivo in ('baja')),
  origen text not null check (origen ~ '^[a-z0-9_.:-]{1,60}$'),
  created_at timestamptz not null default now(),
  unique (organization_id, canal, telefono_hash)
);
alter table core.messaging_opt_out enable row level security;
revoke all on core.messaging_opt_out from public, anon, authenticated;

-- Insumo interno (NO expuesto): valida el telefono E.164 y calcula el hash de dominio.
create or replace function core.opt_out_hash(p_canal text, p_telefono text)
returns text language plpgsql immutable set search_path = core, pg_temp as $$
begin
  if p_canal is null or p_canal not in ('whatsapp') then
    raise exception 'opt_out: canal invalido' using errcode = '22023';
  end if;
  if p_telefono is null or p_telefono !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'opt_out: el telefono debe venir en E.164 normalizado' using errcode = '22023';
  end if;
  return encode(sha256(convert_to('atiende:optout:v1:' || p_canal || ':' || p_telefono, 'UTF8')), 'hex');
end;
$$;
revoke all on function core.opt_out_hash(text, text) from public, anon, authenticated;

-- Solo sistema, idempotente: true si la baja es nueva (el llamador confirma UNA sola vez).
create or replace function core.opt_out_registrar(p_organization_id uuid, p_telefono text, p_canal text, p_origen text)
returns boolean language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_filas integer;
begin
  if auth.uid() is not null then
    raise exception 'opt_out_registrar: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  if p_origen is null or p_origen !~ '^[a-z0-9_.:-]{1,60}$' then
    raise exception 'opt_out: origen invalido' using errcode = '22023';
  end if;
  insert into core.messaging_opt_out (organization_id, canal, telefono_hash, origen)
  values (p_organization_id, p_canal, core.opt_out_hash(p_canal, p_telefono), p_origen)
  on conflict (organization_id, canal, telefono_hash) do nothing;
  get diagnostics v_filas = row_count;
  return v_filas > 0;
end;
$$;
revoke all on function core.opt_out_registrar(uuid, text, text, text) from public, anon;
grant execute on function core.opt_out_registrar(uuid, text, text, text) to authenticated;

-- Solo sistema: ALTA. true si habia una baja que se quito.
create or replace function core.opt_out_reactivar(p_organization_id uuid, p_telefono text, p_canal text)
returns boolean language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_filas integer;
begin
  if auth.uid() is not null then
    raise exception 'opt_out_reactivar: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  delete from core.messaging_opt_out o
  where o.organization_id = p_organization_id and o.canal = p_canal and o.telefono_hash = core.opt_out_hash(p_canal, p_telefono);
  get diagnostics v_filas = row_count;
  return v_filas > 0;
end;
$$;
revoke all on function core.opt_out_reactivar(uuid, text, text) from public, anon;
grant execute on function core.opt_out_reactivar(uuid, text, text) to authenticated;

-- Solo sistema: boolean puro.
create or replace function core.opt_out_activo(p_organization_id uuid, p_telefono text, p_canal text)
returns boolean language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'opt_out_activo: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  return exists (select 1 from core.messaging_opt_out o where o.organization_id = p_organization_id and o.canal = p_canal and o.telefono_hash = core.opt_out_hash(p_canal, p_telefono));
end;
$$;
revoke all on function core.opt_out_activo(uuid, text, text) from public, anon;
grant execute on function core.opt_out_activo(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Ventana de 24 h de Meta (citas): ultima vez que el cliente escribio a la organizacion.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function citas.ultimo_mensaje_entrante(p_organization_id uuid, p_phone_hashes text[])
returns timestamptz language plpgsql stable security definer set search_path = citas, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'ultimo_mensaje_entrante: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  if p_phone_hashes is null or cardinality(p_phone_hashes) > 5 or exists (select 1 from unnest(p_phone_hashes) h where h is null or h !~ '^[0-9a-f]{64}$') then
    raise exception 'ultimo_mensaje_entrante: phone_hashes invalido' using errcode = '22023';
  end if;
  return (select max(e.claimed_at) from citas.whatsapp_inbound_events e where e.organization_id = p_organization_id and e.phone_hash = any (p_phone_hashes));
end;
$$;
revoke all on function citas.ultimo_mensaje_entrante(uuid, text[]) from public, anon;
grant execute on function citas.ultimo_mensaje_entrante(uuid, text[]) to authenticated;

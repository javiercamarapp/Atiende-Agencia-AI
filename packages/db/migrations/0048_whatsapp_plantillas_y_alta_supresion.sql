-- PL-31 + PL-32: catalogo de plantillas HSM de WhatsApp por organizacion, reactivacion (ALTA) de la lista de supresion de
-- plataforma y ventana de 24 h de citas.
--
-- Contexto PL-31: un aviso que el NEGOCIO inicia fuera de la ventana de 24 h de Meta solo se entrega como plantilla
-- aprobada. Hasta hoy la lista de plantillas aprobadas era una variable de entorno GLOBAL; ahora cada organizacion
-- declara las suyas (la aprobacion en Meta Business Manager sigue siendo un paso externo: aqui solo se registra su
-- estado).
--
-- Contexto PL-32: la baja (BAJA/STOP) ya vive en la lista global core.supresion_contacto (0043, SA-L-46); lo que faltaba
-- era la ALTA (reactivar). core.reactivar_supresion_baja quita SOLO las bajas voluntarias (motivo 'baja'); quejas, rebotes,
-- solicitudes ARCO y "no contactar" del superadmin NO se pueden revertir por mensaje.
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
--   * core.reactivar_supresion_baja: solo-sistema por la misma razon que core.registrar_supresion (0043): la llama el
--     webhook entrante; una sesion de staff con auth.uid() real nunca debe poder borrar bajas de clientes. Borra unicamente
--     filas con motivo 'baja' del hash pedido y devuelve solo boolean. GRANT solo a `authenticated`.
--   * citas.ultimo_mensaje_entrante: solo-sistema; devuelve solo una marca de tiempo (cuando escribio el cliente por
--     ultima vez a ESA organizacion), para decidir la ventana de 24 h de Meta. Recibe los hashes (hasta 5, variantes de
--     formato del mismo telefono) que ya guarda citas.whatsapp_inbound_events, nunca el telefono.
--
-- Orden de despliegue: CUALQUIER ORDEN. El codigo TypeScript captura 42883/42P01/42703 (migracion pendiente) con
-- SAVEPOINT y cae al comportamiento anterior (lista global de plantillas del entorno, sin ALTA, ventana desconocida),
-- nunca a un 500.

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
-- ALTA: reactivar una baja voluntaria de la lista de supresion de plataforma
-- ---------------------------------------------------------------------------------------------------------------
create or replace function core.reactivar_supresion_baja(p_tipo text, p_valor_hash text)
returns boolean language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_filas integer;
begin
  if auth.uid() is not null then
    raise exception 'reactivar_supresion_baja: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  if p_tipo is null or p_tipo not in ('telefono', 'correo') or p_valor_hash is null or p_valor_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'reactivar_supresion_baja: parametros invalidos' using errcode = '22023';
  end if;
  delete from core.supresion_contacto s where s.tipo = p_tipo and s.valor_hash = p_valor_hash and s.motivo = 'baja';
  get diagnostics v_filas = row_count;
  return v_filas > 0;
end;
$$;
revoke all on function core.reactivar_supresion_baja(text, text) from public, anon;
grant execute on function core.reactivar_supresion_baja(text, text) to authenticated;

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

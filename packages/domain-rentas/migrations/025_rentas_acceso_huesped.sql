-- Rn-04 (P1) -- liberación de instrucciones de acceso al huésped (código de cerradura,
-- dirección exacta) solo N horas antes del check-in, solo si la reserva está confirmada y
-- pagada según la política de la property, con bitácora y sin PII en la bitácora.
--
-- Contexto. Hoy el huésped recibe confirmación y recordatorio de check-in (Fase 9) pero
-- las instrucciones de acceso viajan por canales manuales: el código de la cerradura
-- queda circulando días antes, para reservas aún sin pagar. Esta migración agrega el
-- modelo para liberarlas en el momento correcto; el cron que las entrega vive en
-- apps/api (/internal/rentas/acceso-huesped) y NO se agrega a vercel.json (decisión de
-- Javier, ver docs/DEPLOY.md).
--
-- Aditiva: tablas y funciones nuevas, sin tocar ninguna existente. El código TypeScript
-- que la usa cae a "no disponible aún" (lista vacía / 409) si la base todavía no la tiene
-- (SQLSTATE 42883/42P01/42703), nunca a un 500.
--
-- Requiere: 001 (rentas.ocupacion/unidad/guest_minimo/canal/property_config), 015 (la
-- sesión de sistema del cron conecta como `authenticated` con auth.uid() NULL).
--
-- Modelo de "pagada" (decisión explícita, no inventada en silencio): rentas NO tiene un
-- libro de pagos del huésped (reserva_financiero.monto_recibido_centavos es el neto tras
-- comisión de canal, no un cobro). Por eso la política ofrece dos evidencias de pago:
--   (a) confirmación manual de pago por el staff sobre la reserva (acceso_reserva), y
--   (b) reservas de canal OTA (airbnb/vrbo/booking) que se tratan como pagadas cuando
--       `ota_cuenta_como_pagada` es true (la plataforma cobra al reservar).
-- Con `exigir_pago` false la liberación no depende del pago.

-- ---------------------------------------------------------------------------
-- 0) Autoridad: quién administra el acceso de huéspedes.
-- ---------------------------------------------------------------------------
-- Las instrucciones son el secreto físico de la propiedad: solo admin_gestora y
-- operador:acceso_total las leen/escriben. Los demás roles de staff (contador, limpieza,
-- operador de solo calendario o de calendario+mensajería) NO las ven: ven la reserva,
-- no la llave. Mismo patrón security definer que rentas.can_read_finanzas (003), con
-- search_path fijo.
create function rentas.can_manage_acceso(_property_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, core, rentas, pg_temp
as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role in ('admin_gestora', 'operador:acceso_total')
  )
$$;
revoke all on function rentas.can_manage_acceso(uuid) from public, anon;
grant execute on function rentas.can_manage_acceso(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1) Política por property.
-- ---------------------------------------------------------------------------
create table rentas.acceso_politica (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  -- Apagada por defecto: nada se libera hasta que la property la active a propósito.
  activo boolean not null default false,
  horas_antes_checkin integer not null default 24 check (horas_antes_checkin between 1 and 168),
  -- Hora local de check-in en la zona de la property (rentas.property_config.zona_horaria).
  hora_checkin time not null default '15:00',
  exigir_pago boolean not null default true,
  ota_cuenta_como_pagada boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references core.staff_user(id) on delete set null
);

alter table rentas.acceso_politica enable row level security;

-- Seguridad (RLS): la política en sí no es secreta (horas, banderas): la ve todo el staff
-- de la property. Escribirla exige can_manage_acceso. Sin DELETE para authenticated.
create policy "staff ve la politica de acceso de su property" on rentas.acceso_politica for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "admin crea la politica de acceso de su property" on rentas.acceso_politica for insert
  with check (rentas.can_manage_acceso(property_id) and updated_by = auth.uid()
    and exists (select 1 from core.property p where p.id = acceso_politica.property_id and p.organization_id = acceso_politica.organization_id));
create policy "admin edita la politica de acceso de su property" on rentas.acceso_politica for update
  using (rentas.can_manage_acceso(property_id))
  with check (rentas.can_manage_acceso(property_id) and updated_by = auth.uid());

revoke all on rentas.acceso_politica from public, anon;
grant select on rentas.acceso_politica to authenticated;
grant insert (property_id, organization_id, activo, horas_antes_checkin, hora_checkin, exigir_pago, ota_cuenta_como_pagada, updated_by) on rentas.acceso_politica to authenticated;
grant update (activo, horas_antes_checkin, hora_checkin, exigir_pago, ota_cuenta_como_pagada, updated_at, updated_by) on rentas.acceso_politica to authenticated;
grant select, insert, update, delete on rentas.acceso_politica to service_role;

-- ---------------------------------------------------------------------------
-- 2) Instrucciones por unidad (el secreto).
-- ---------------------------------------------------------------------------
create table rentas.acceso_instruccion (
  unidad_id uuid primary key references rentas.unidad(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  direccion_exacta text not null check (btrim(direccion_exacta) <> '' and char_length(direccion_exacta) <= 500),
  codigo_acceso text check (codigo_acceso is null or char_length(codigo_acceso) <= 100),
  instrucciones text check (instrucciones is null or char_length(instrucciones) <= 2000),
  updated_at timestamptz not null default now(),
  updated_by uuid references core.staff_user(id) on delete set null
);
create index acceso_instruccion_property_idx on rentas.acceso_instruccion (property_id);

alter table rentas.acceso_instruccion enable row level security;

-- Seguridad (RLS): lectura y escritura SOLO para can_manage_acceso (admin_gestora /
-- operador:acceso_total) de la property. El with check amarra la unidad a la property y
-- organización declaradas (nadie escribe instrucciones de una unidad ajena, ni con un
-- property_id propio y un unidad_id de otro tenant). Sin DELETE para authenticated.
create policy "admin ve instrucciones de acceso de su property" on rentas.acceso_instruccion for select
  using (rentas.can_manage_acceso(property_id));
create policy "admin crea instrucciones de acceso de su property" on rentas.acceso_instruccion for insert
  with check (rentas.can_manage_acceso(property_id) and updated_by = auth.uid()
    and exists (select 1 from rentas.unidad u where u.id = acceso_instruccion.unidad_id and u.property_id = acceso_instruccion.property_id and u.organization_id = acceso_instruccion.organization_id));
create policy "admin edita instrucciones de acceso de su property" on rentas.acceso_instruccion for update
  using (rentas.can_manage_acceso(property_id))
  with check (rentas.can_manage_acceso(property_id) and updated_by = auth.uid());

revoke all on rentas.acceso_instruccion from public, anon;
grant select on rentas.acceso_instruccion to authenticated;
grant insert (unidad_id, organization_id, property_id, direccion_exacta, codigo_acceso, instrucciones, updated_by) on rentas.acceso_instruccion to authenticated;
-- UPDATE por columna: unidad_id/organization_id/property_id son inmutables para el staff.
grant update (direccion_exacta, codigo_acceso, instrucciones, updated_at, updated_by) on rentas.acceso_instruccion to authenticated;
grant select, insert, update, delete on rentas.acceso_instruccion to service_role;

-- ---------------------------------------------------------------------------
-- 3) Estado por reserva: pago confirmado (staff) y liberación (sistema).
-- ---------------------------------------------------------------------------
create table rentas.acceso_reserva (
  ocupacion_id uuid primary key references rentas.ocupacion(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  pago_confirmado_en timestamptz,
  pago_confirmado_por uuid references core.staff_user(id) on delete set null,
  liberado_en timestamptz,
  liberado_via text check (liberado_via is null or liberado_via in ('email')),
  constraint acceso_reserva_pago_coherente check (pago_confirmado_por is null or pago_confirmado_en is not null),
  constraint acceso_reserva_liberacion_coherente check ((liberado_en is null) = (liberado_via is null))
);
create index acceso_reserva_property_idx on rentas.acceso_reserva (property_id);

alter table rentas.acceso_reserva enable row level security;

-- Seguridad: el staff solo LEE su estado (can_manage_acceso). No hay GRANT de escritura
-- para authenticated: el pago se confirma por rentas.confirmar_pago_reserva (valida
-- property/rol/estado y se atribuye a auth.uid()) y la liberación solo la escribe la
-- sesión de sistema por rentas.acceso_marcar_liberada. Así nadie puede fabricar un
-- "liberado" ni un "pago confirmado a nombre de otro" con un UPDATE directo.
create policy "admin ve el estado de acceso de reservas de su property" on rentas.acceso_reserva for select
  using (rentas.can_manage_acceso(property_id));

revoke all on rentas.acceso_reserva from public, anon;
grant select on rentas.acceso_reserva to authenticated;
grant select, insert, update, delete on rentas.acceso_reserva to service_role;

-- ---------------------------------------------------------------------------
-- 4) Bitácora de liberaciones (append-only, sin PII).
-- ---------------------------------------------------------------------------
-- Guarda QUÉ pasó con QUÉ reserva, nunca el correo/teléfono del huésped ni el código.
create table rentas.acceso_bitacora (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  ocupacion_id uuid not null references rentas.ocupacion(id) on delete cascade,
  evento text not null check (evento in ('liberada', 'omitida_sin_contacto', 'omitida_sin_instrucciones', 'error_envio')),
  canal text check (canal is null or canal in ('email')),
  creado_en timestamptz not null default now()
);
create index acceso_bitacora_property_creado_idx on rentas.acceso_bitacora (property_id, creado_en desc);
create index acceso_bitacora_ocupacion_idx on rentas.acceso_bitacora (ocupacion_id, evento, creado_en desc);

alter table rentas.acceso_bitacora enable row level security;

-- Seguridad: lectura solo para can_manage_acceso; sin INSERT/UPDATE/DELETE para
-- authenticated (append-only: se escribe únicamente por las funciones de sistema de abajo).
create policy "admin ve la bitacora de acceso de su property" on rentas.acceso_bitacora for select
  using (rentas.can_manage_acceso(property_id));

revoke all on rentas.acceso_bitacora from public, anon;
grant select on rentas.acceso_bitacora to authenticated;
grant select, insert, update, delete on rentas.acceso_bitacora to service_role;

-- ---------------------------------------------------------------------------
-- 5) Confirmar (o revocar) el pago de una reserva -- staff.
-- ---------------------------------------------------------------------------
-- Seguridad: security definer con search_path fijo; exige un actor real (auth.uid() no
-- nulo), property resuelta DESDE la ocupación (nunca de un parámetro), can_manage_acceso
-- de esa property, y que sea una reserva (capa 'reserva') no cancelada. Atribuye siempre
-- a auth.uid(). Devuelve la fecha de confirmación o NULL si se revocó. P0002 si la reserva
-- no existe o no es accesible (no distingue "no existe" de "no es tuya": sin oráculo
-- cross-tenant).
create function rentas.confirmar_pago_reserva(p_ocupacion_id uuid, p_confirmado boolean default true)
returns timestamptz
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
declare
  v_org uuid;
  v_prop uuid;
  v_en timestamptz;
begin
  if auth.uid() is null then
    raise exception 'rentas.confirmar_pago_reserva: requiere un usuario autenticado.' using errcode = '42501';
  end if;

  select o.organization_id, o.property_id into v_org, v_prop
  from rentas.ocupacion o
  where o.id = p_ocupacion_id and o.capa = 'reserva' and o.estado <> 'cancelado';

  if v_prop is null or not rentas.can_manage_acceso(v_prop) then
    raise exception 'rentas.confirmar_pago_reserva: reserva no encontrada.' using errcode = 'P0002';
  end if;

  v_en := case when coalesce(p_confirmado, true) then now() else null end;
  insert into rentas.acceso_reserva (ocupacion_id, organization_id, property_id, pago_confirmado_en, pago_confirmado_por)
  values (p_ocupacion_id, v_org, v_prop, v_en, case when v_en is null then null else auth.uid() end)
  on conflict (ocupacion_id) do update
    set pago_confirmado_en = excluded.pago_confirmado_en,
        pago_confirmado_por = excluded.pago_confirmado_por;
  return v_en;
end;
$$;
revoke all on function rentas.confirmar_pago_reserva(uuid, boolean) from public, anon;
grant execute on function rentas.confirmar_pago_reserva(uuid, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6) Funciones de SOLO-SISTEMA (cron): siguiente liberación, marcar, registrar.
-- ---------------------------------------------------------------------------
-- Las tres exigen auth.uid() is null (la sesión de sistema del cron, ver 015) y rechazan
-- con 42501 a cualquier staff autenticado; search_path fijo; EXECUTE revocado a
-- public/anon y concedido a authenticated (el rol de la sesión de sistema) y service_role.

-- 6a) La siguiente reserva cuyas instrucciones toca liberar AHORA.
-- La decisión (ventana + pago) vive AQUÍ, en una sola fuente, con la zona real de la
-- property resuelta por Postgres:
--   * política activa de la property y reserva confirmada de capa 'reserva' (nunca
--     bloqueos, nunca provisional/conflicto_pendiente/cancelada);
--   * ya no liberada;
--   * ventana: desde (check-in a hora_checkin en zona de la property) menos
--     horas_antes_checkin, hasta el inicio del día de check-out en esa zona (excluido);
--   * pago: no se exige, o está confirmado por el staff, o es de canal OTA y la política
--     lo acepta.
-- `for update of o skip locked`: dos instancias del cron nunca toman la misma reserva.
-- Devuelve los datos para armar el correo (incluye el secreto): solo la sesión de
-- sistema, que corre una transacción por reserva, puede llamarla. p_excluir permite al
-- cron saltar reservas que ya intentó y no pudo entregar en esta corrida.
create function rentas.acceso_siguiente_liberacion(p_excluir uuid[] default '{}', p_ahora timestamptz default now())
returns table (
  ocupacion_id uuid,
  organization_id uuid,
  property_id uuid,
  check_in date,
  check_out date,
  unidad_nombre text,
  tenant_nombre text,
  huesped_nombre text,
  huesped_contacto text,
  tiene_instrucciones boolean,
  direccion_exacta text,
  codigo_acceso text,
  instrucciones text
)
language plpgsql
security definer
set search_path = pg_catalog, rentas, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'rentas.acceso_siguiente_liberacion: solo la sesion de sistema (auth.uid() es NULL) libera accesos.' using errcode = '42501';
  end if;

  return query
  select o.id, o.organization_id, o.property_id, lower(o.rango), upper(o.rango),
         u.name, org.name, g.nombre, g.contacto,
         (ai.unidad_id is not null),
         ai.direccion_exacta, ai.codigo_acceso, ai.instrucciones
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
revoke all on function rentas.acceso_siguiente_liberacion(uuid[], timestamptz) from public, anon;
grant execute on function rentas.acceso_siguiente_liberacion(uuid[], timestamptz) to authenticated, service_role;

-- 6b) Marcar la reserva como liberada (idempotente) y escribir la bitácora 'liberada'.
-- organization/property se derivan SIEMPRE de la ocupación. Devuelve true solo la primera
-- vez (la segunda llamada no duplica ni la marca ni la bitácora).
create function rentas.acceso_marcar_liberada(p_ocupacion_id uuid, p_canal text default 'email')
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
  if auth.uid() is not null then
    raise exception 'rentas.acceso_marcar_liberada: solo la sesion de sistema (auth.uid() es NULL) marca liberaciones.' using errcode = '42501';
  end if;
  if p_canal is distinct from 'email' then
    raise exception 'rentas.acceso_marcar_liberada: canal no soportado.' using errcode = '22023';
  end if;

  select o.organization_id, o.property_id into v_org, v_prop from rentas.ocupacion o where o.id = p_ocupacion_id and o.capa = 'reserva';
  if v_prop is null then
    raise exception 'rentas.acceso_marcar_liberada: la reserva % no existe.', p_ocupacion_id using errcode = 'P0002';
  end if;

  insert into rentas.acceso_reserva (ocupacion_id, organization_id, property_id, liberado_en, liberado_via)
  values (p_ocupacion_id, v_org, v_prop, now(), p_canal)
  on conflict (ocupacion_id) do update
    set liberado_en = now(), liberado_via = p_canal
    where rentas.acceso_reserva.liberado_en is null
  returning true into v_nueva;

  if coalesce(v_nueva, false) then
    insert into rentas.acceso_bitacora (organization_id, property_id, ocupacion_id, evento, canal)
    values (v_org, v_prop, p_ocupacion_id, 'liberada', p_canal);
  end if;
  return coalesce(v_nueva, false);
end;
$$;
revoke all on function rentas.acceso_marcar_liberada(uuid, text) from public, anon;
grant execute on function rentas.acceso_marcar_liberada(uuid, text) to authenticated, service_role;

-- 6c) Registrar un evento omitido o fallido, con tope: el mismo (reserva, evento) no se
-- repite dentro de 24 h (con un cron frecuente serían decenas de filas iguales).
create function rentas.acceso_registrar_evento(p_ocupacion_id uuid, p_evento text, p_canal text default null)
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
    raise exception 'rentas.acceso_registrar_evento: solo la sesion de sistema (auth.uid() es NULL) escribe la bitacora de acceso.' using errcode = '42501';
  end if;
  if p_evento not in ('omitida_sin_contacto', 'omitida_sin_instrucciones', 'error_envio') then
    raise exception 'rentas.acceso_registrar_evento: evento no permitido (la liberacion se registra con acceso_marcar_liberada).' using errcode = '22023';
  end if;

  select o.organization_id, o.property_id into v_org, v_prop from rentas.ocupacion o where o.id = p_ocupacion_id and o.capa = 'reserva';
  if v_prop is null then
    raise exception 'rentas.acceso_registrar_evento: la reserva % no existe.', p_ocupacion_id using errcode = 'P0002';
  end if;

  if exists (select 1 from rentas.acceso_bitacora b where b.ocupacion_id = p_ocupacion_id and b.evento = p_evento and b.creado_en > now() - interval '24 hours') then
    return false;
  end if;

  insert into rentas.acceso_bitacora (organization_id, property_id, ocupacion_id, evento, canal)
  values (v_org, v_prop, p_ocupacion_id, p_evento, p_canal);
  return true;
end;
$$;
revoke all on function rentas.acceso_registrar_evento(uuid, text, text) from public, anon;
grant execute on function rentas.acceso_registrar_evento(uuid, text, text) to authenticated, service_role;

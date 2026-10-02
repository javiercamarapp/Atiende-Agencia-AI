-- H-26 + H-29 hoteles -- HOUSEKEEPING RESIDUAL y CONFIGURACION DEL CANAL.
--
-- H-26 (housekeeping residual, extiende 033 sin duplicarla):
--   * hoteles.housekeeping_config        configuracion por property (asignacion automatica, minutos
--                                        por tipo de tarea, jornada, fotos de inspeccion obligatorias).
--   * hoteles.housekeeping_task_photo    fotos de una tarea de limpieza (evidencia de inspeccion).
--   * hoteles.linen_count                conteo de blancos por dia y articulo.
--   * hoteles.cleaning_opt_out           huesped que NO quiere servicio de limpieza un dia (sin datos
--                                        del huesped: solo habitacion y fecha, compatible con H-02/ARCO).
-- H-29 (configuracion editable del canal, mensajeria):
--   * hoteles.whatsapp_channel_config    hoy solo SELECT para el cliente; se agrega edicion acotada
--                                        (numero de Meta + habilitado) por owner/gm.
--   * hoteles.voice_agent_config         la policy `for all` dejaba LEER y ESCRIBIR el secreto de voz a
--                                        cualquier staff con acceso a la property, y el GRANT de UPDATE era
--                                        de tabla completa; se cierra a owner/gm y a columnas.
--
-- Requiere: 001 (hoteles.room, core.*), 004 (voice_agent_config, whatsapp_channel_config),
-- 018 (insert grant de voice_agent_config), 033 (housekeeping_task, helpers de rol y
-- hoteles.housekeeping_derive_org()).
--
-- Reparto de autoridad (igual que 033): RLS = pertenencia a la property + helper SQL por rol fino;
-- apps/api filtra ademas por accion (assertVerticalRole). Si el espejo de la app se desincroniza la
-- peor consecuencia es un 403 de mas, nunca un acceso de mas.

-- ---------------------------------------------------------------------------
-- 0) Llave unica (id, property_id) en housekeeping_task: permite que la foto referencie a la tarea Y a su
--    property con una sola FK compuesta (una foto nunca apunta a una tarea de OTRA property). `id` ya es
--    PK, asi que la unicidad es trivialmente cierta.
-- ---------------------------------------------------------------------------
alter table hoteles.housekeeping_task add constraint housekeeping_task_id_property_unique unique (id, property_id);

-- ---------------------------------------------------------------------------
-- 1) Helper de rol: can_configure_property = owner, gm. Justificacion de seguridad: el rol sale de
--    core.membership (autoridad unica, nunca de un parametro del cliente); security definer con
--    search_path fijo porque core.membership/core.property no son legibles por el rol del cliente;
--    EXECUTE revocado a public/anon. Misma forma que hoteles.can_manage_catalog() (018) pero con su
--    propio nombre: configurar la property no es lo mismo que editar el catalogo y los dos pueden
--    divergir sin arrastrarse.
-- ---------------------------------------------------------------------------
create or replace function hoteles.can_configure_property(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role in ('owner', 'gm')
  )
$$;
revoke all on function hoteles.can_configure_property(uuid) from public, anon;
grant execute on function hoteles.can_configure_property(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Configuracion de housekeeping por property (una fila por property; sin fila = valores por defecto
--    de la aplicacion, que son los mismos DEFAULT de abajo).
-- ---------------------------------------------------------------------------
create table hoteles.housekeeping_config (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete restrict,
  auto_assign_enabled boolean not null default false,
  max_tasks_per_camarista integer not null default 14 check (max_tasks_per_camarista between 1 and 60),
  shift_minutes integer not null default 480 check (shift_minutes between 60 and 720),
  minutes_salida integer not null default 40 check (minutes_salida between 5 and 240),
  minutes_estancia integer not null default 20 check (minutes_estancia between 5 and 240),
  minutes_profunda integer not null default 90 check (minutes_profunda between 5 and 240),
  minutes_repaso integer not null default 10 check (minutes_repaso between 5 and 240),
  photos_required_on_inspection boolean not null default false,
  max_photos_per_task integer not null default 6 check (max_photos_per_task between 1 and 10),
  updated_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3) Fotos de inspeccion. Los bytes viven en la tabla (no hay Storage en este monorepo): tope duro de
--    1.5 MB y solo jpeg/png/webp; el servidor valida la firma real del archivo (magic bytes), esta
--    tabla valida tipo y tamano declarados contra el tamano real (octet_length). Como maximo
--    max_photos_per_task por tarea (trigger, con candado de asesoria para que dos subidas simultaneas no
--    rebasen el tope).
--    Privacidad: la foto es de la HABITACION; no se guarda ningun dato del huesped. Quien la subio queda
--    en taken_by (staff). Borrado permitido a quien trabaja housekeeping: si una foto capta por error
--    un objeto personal, debe poder retirarse (la fila hija tambien cae con la tarea o la property).
-- ---------------------------------------------------------------------------
create table hoteles.housekeeping_task_photo (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  task_id uuid not null,
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size integer not null check (byte_size between 1 and 1572864),
  image_data bytea not null,
  caption text check (caption is null or length(caption) <= 200),
  taken_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint housekeeping_task_photo_task_fk foreign key (task_id, property_id) references hoteles.housekeeping_task(id, property_id) on delete cascade,
  constraint housekeeping_task_photo_size_matches check (octet_length(image_data) = byte_size)
);
create index housekeeping_task_photo_task_idx on hoteles.housekeeping_task_photo (task_id, created_at);

-- ---------------------------------------------------------------------------
-- 4) Conteo de blancos: un renglon por (property, dia, articulo). Lista cerrada de articulos (evita
--    basura libre en el reporte). Cantidades >= 0 por estado fisico del articulo.
-- ---------------------------------------------------------------------------
create table hoteles.linen_count (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  count_date date not null,
  item text not null check (item in ('sabanas', 'fundas', 'toallas_bano', 'toallas_mano', 'toallas_piso', 'cobertores', 'albornoces')),
  qty_clean integer not null default 0 check (qty_clean between 0 and 100000),
  qty_dirty integer not null default 0 check (qty_dirty between 0 and 100000),
  qty_laundry integer not null default 0 check (qty_laundry between 0 and 100000),
  qty_damaged integer not null default 0 check (qty_damaged between 0 and 100000),
  counted_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, count_date, item)
);
create index linen_count_property_date_idx on hoteles.linen_count (property_id, count_date desc);

-- ---------------------------------------------------------------------------
-- 5) Opt-out de limpieza: el huesped declina el servicio de ESE dia. Solo habitacion + fecha + origen;
--    nunca nombre, telefono ni reserva (H-02/ARCO: nada que anonimizar ni purgar). Efecto en la
--    aplicacion: no se generan ni se crean a mano tareas `estancia`/`repaso` de ese dia para la
--    habitacion; la limpieza de salida y la profunda NO se omiten. Una activa por (habitacion, dia).
-- ---------------------------------------------------------------------------
create table hoteles.cleaning_opt_out (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  room_id uuid not null,
  opt_out_date date not null,
  source text not null default 'recepcion' check (source in ('huesped', 'recepcion', 'whatsapp')),
  note text check (note is null or length(note) <= 200),
  status text not null default 'activo' check (status in ('activo', 'revertido')),
  created_by uuid references core.staff_user(id) on delete set null,
  reverted_by uuid references core.staff_user(id) on delete set null,
  reverted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint cleaning_opt_out_room_fk foreign key (room_id, property_id) references hoteles.room(id, property_id) on delete cascade,
  constraint cleaning_opt_out_reverted_consistency check ((status = 'revertido') = (reverted_at is not null))
);
create unique index cleaning_opt_out_one_active_idx on hoteles.cleaning_opt_out (room_id, opt_out_date) where status = 'activo';
create index cleaning_opt_out_property_date_idx on hoteles.cleaning_opt_out (property_id, opt_out_date);

-- ---------------------------------------------------------------------------
-- 6) Triggers de integridad. organization_id se DERIVA de core.property (misma funcion de 033): ninguna
--    fila puede quedar con la organizacion de otro tenant aunque un GRANT futuro o service_role lo
--    intentara. Foto: tope por tarea con candado de asesoria; la tarea cancelada ya no recibe fotos.
-- ---------------------------------------------------------------------------
create trigger housekeeping_config_derive_org before insert or update of property_id on hoteles.housekeeping_config
  for each row execute function hoteles.housekeeping_derive_org();
create trigger housekeeping_task_photo_derive_org before insert on hoteles.housekeeping_task_photo
  for each row execute function hoteles.housekeeping_derive_org();
create trigger linen_count_derive_org before insert on hoteles.linen_count
  for each row execute function hoteles.housekeeping_derive_org();
create trigger cleaning_opt_out_derive_org before insert on hoteles.cleaning_opt_out
  for each row execute function hoteles.housekeeping_derive_org();

create or replace function hoteles.housekeeping_task_photo_check_limit()
returns trigger language plpgsql security definer set search_path = core, hoteles as $$
declare
  v_max integer;
  v_count integer;
  v_status text;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.task_id::text, 0));
  select status into v_status from hoteles.housekeeping_task where id = new.task_id and property_id = new.property_id;
  if v_status is null then
    raise exception 'tarea inexistente en esta property' using errcode = '23503';
  end if;
  if v_status = 'cancelada' then
    raise exception 'una tarea cancelada no recibe fotos' using errcode = '23514';
  end if;
  select coalesce((select max_photos_per_task from hoteles.housekeeping_config where property_id = new.property_id), 6) into v_max;
  select count(*) into v_count from hoteles.housekeeping_task_photo where task_id = new.task_id;
  if v_count >= v_max then
    raise exception 'la tarea ya tiene el maximo de fotos (%)', v_max using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function hoteles.housekeeping_task_photo_check_limit() from public, anon;
create trigger housekeeping_task_photo_check_limit before insert on hoteles.housekeeping_task_photo
  for each row execute function hoteles.housekeeping_task_photo_check_limit();

-- ---------------------------------------------------------------------------
-- 7) RLS + GRANTs. Sin `using (true)`, sin GRANT a anon. GRANT por COLUMNA solo de lo que las rutas
--    reales escriben; organization_id/property_id/ids de relacion quedan inmutables para el cliente.
--    - config: lectura a todo el staff de la property (la app la usa para mostrar limites), escritura
--      owner/gm.
--    - foto: lectura al staff de la property; alta/baja a quien trabaja housekeeping (033); sin UPDATE
--      (una foto no se edita, se retira y se sube otra).
--    - conteo: lectura al staff; alta/edicion a quien trabaja housekeeping; sin DELETE (se corrige).
--    - opt-out: lectura al staff; alta/reversion a quien trabaja housekeeping; sin DELETE (historial).
-- ---------------------------------------------------------------------------
alter table hoteles.housekeeping_config enable row level security;
alter table hoteles.housekeeping_task_photo enable row level security;
alter table hoteles.linen_count enable row level security;
alter table hoteles.cleaning_opt_out enable row level security;

create policy "staff ve la config de housekeeping de su property" on hoteles.housekeeping_config for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "housekeeping config: owner/gm crea" on hoteles.housekeeping_config for insert
  with check (hoteles.can_configure_property(property_id));
create policy "housekeeping config: owner/gm edita" on hoteles.housekeeping_config for update
  using (hoteles.can_configure_property(property_id)) with check (hoteles.can_configure_property(property_id));

create policy "staff ve fotos de inspeccion de su property" on hoteles.housekeeping_task_photo for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "fotos de inspeccion: staff autorizado sube" on hoteles.housekeeping_task_photo for insert
  with check (hoteles.can_work_housekeeping(property_id));
create policy "fotos de inspeccion: staff autorizado retira" on hoteles.housekeeping_task_photo for delete
  using (hoteles.can_work_housekeeping(property_id));

create policy "staff ve el conteo de blancos de su property" on hoteles.linen_count for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "blancos: staff autorizado registra" on hoteles.linen_count for insert
  with check (hoteles.can_work_housekeeping(property_id));
create policy "blancos: staff autorizado corrige" on hoteles.linen_count for update
  using (hoteles.can_work_housekeeping(property_id)) with check (hoteles.can_work_housekeeping(property_id));

create policy "staff ve los opt-out de limpieza de su property" on hoteles.cleaning_opt_out for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "opt-out de limpieza: staff autorizado registra" on hoteles.cleaning_opt_out for insert
  with check (hoteles.can_work_housekeeping(property_id));
create policy "opt-out de limpieza: staff autorizado revierte" on hoteles.cleaning_opt_out for update
  using (hoteles.can_work_housekeeping(property_id)) with check (hoteles.can_work_housekeeping(property_id));

revoke all on hoteles.housekeeping_config, hoteles.housekeeping_task_photo, hoteles.linen_count, hoteles.cleaning_opt_out from public, anon;
grant select on hoteles.housekeeping_config, hoteles.housekeeping_task_photo, hoteles.linen_count, hoteles.cleaning_opt_out to authenticated;
grant insert (property_id, auto_assign_enabled, max_tasks_per_camarista, shift_minutes, minutes_salida, minutes_estancia, minutes_profunda, minutes_repaso, photos_required_on_inspection, max_photos_per_task, updated_by)
  on hoteles.housekeeping_config to authenticated;
grant update (auto_assign_enabled, max_tasks_per_camarista, shift_minutes, minutes_salida, minutes_estancia, minutes_profunda, minutes_repaso, photos_required_on_inspection, max_photos_per_task, updated_by, updated_at)
  on hoteles.housekeeping_config to authenticated;
grant insert (property_id, task_id, content_type, byte_size, image_data, caption, taken_by) on hoteles.housekeeping_task_photo to authenticated;
grant delete on hoteles.housekeeping_task_photo to authenticated;
grant insert (property_id, count_date, item, qty_clean, qty_dirty, qty_laundry, qty_damaged, counted_by) on hoteles.linen_count to authenticated;
grant update (qty_clean, qty_dirty, qty_laundry, qty_damaged, counted_by, updated_at) on hoteles.linen_count to authenticated;
grant insert (property_id, room_id, opt_out_date, source, note, created_by) on hoteles.cleaning_opt_out to authenticated;
grant update (status, reverted_by, reverted_at) on hoteles.cleaning_opt_out to authenticated;
grant select, insert, update, delete on hoteles.housekeeping_config, hoteles.housekeeping_task_photo, hoteles.linen_count, hoteles.cleaning_opt_out to service_role;

-- ---------------------------------------------------------------------------
-- 8) H-29 -- hoteles.whatsapp_channel_config editable por owner/gm.
--    * updated_at/updated_by: quien cambio el canal y cuando (trazabilidad).
--    * CHECK del numero de Meta (solo digitos, 5-20) NOT VALID: se exige en filas nuevas o editadas sin
--      reescribir ni fallar sobre datos historicos.
--    * organization_id se deriva de core.property (trigger de 033): el cliente no lo manda.
--    * INSERT/UPDATE solo owner/gm y solo las columnas de edicion; el unico (phone_number_id) de 004
--      impide que dos properties reclamen el mismo numero.
--    Riesgo conocido y declarado: la plataforma usa UNA Meta App compartida; esta migracion no verifica
--    que el numero pertenezca realmente al hotel (eso exige llamar a la API de Meta con el token de
--    envio). Defensa en profundidad: solo owner/gm, trazabilidad y unico por numero.
-- ---------------------------------------------------------------------------
alter table hoteles.whatsapp_channel_config add column updated_at timestamptz not null default now();
alter table hoteles.whatsapp_channel_config add column updated_by uuid references core.staff_user(id) on delete set null;
alter table hoteles.whatsapp_channel_config add constraint whatsapp_channel_config_phone_number_id_format check (phone_number_id ~ '^[0-9]{5,20}$') not valid;

create trigger whatsapp_channel_config_derive_org before insert on hoteles.whatsapp_channel_config
  for each row execute function hoteles.housekeeping_derive_org();

create policy "canal whatsapp: owner/gm lo da de alta" on hoteles.whatsapp_channel_config for insert
  with check (hoteles.can_configure_property(property_id));
create policy "canal whatsapp: owner/gm lo edita" on hoteles.whatsapp_channel_config for update
  using (hoteles.can_configure_property(property_id)) with check (hoteles.can_configure_property(property_id));

grant insert (property_id, phone_number_id, enabled, updated_by) on hoteles.whatsapp_channel_config to authenticated;
grant update (phone_number_id, enabled, updated_by, updated_at) on hoteles.whatsapp_channel_config to authenticated;

-- ---------------------------------------------------------------------------
-- 9) H-29 -- hoteles.voice_agent_config: cerrar a owner/gm y a columnas.
--    Antes (004/018): policy `for all` con solo has_property_access => CUALQUIER staff de la property
--    (camarista, mesero) podia leer y reescribir `tool_webhook_secret` por PostgREST, y el GRANT de
--    UPDATE era de tabla (incluia property_id/organization_id). Ahora:
--      - SELECT/INSERT/UPDATE solo owner/gm (can_configure_property);
--      - el secreto NO es legible por el cliente en ningun caso (el panel solo lo ve UNA vez, al
--        rotarlo, porque lo genera el servidor); lo lee solo la sesion de sistema via
--        hoteles.system_find_voice_agent_config (022, security definer, exclusivo de sistema);
--      - UPDATE solo de (tool_webhook_secret, enabled, updated_at).
--    La sesion de sistema y service_role no cambian.
-- ---------------------------------------------------------------------------
drop policy if exists "staff admin ve/gestiona el secreto de voz de su property" on hoteles.voice_agent_config;
create policy "voz: owner/gm ve el estado de voz de su property" on hoteles.voice_agent_config for select
  using (hoteles.can_configure_property(property_id));
create policy "voz: owner/gm da de alta la voz de su property" on hoteles.voice_agent_config for insert
  with check (hoteles.can_configure_property(property_id));
create policy "voz: owner/gm edita la voz de su property" on hoteles.voice_agent_config for update
  using (hoteles.can_configure_property(property_id)) with check (hoteles.can_configure_property(property_id));

--    organization_id se deriva de core.property (trigger de 033): el INSERT del cliente ya no puede
--    sellar la fila con la organizacion de otro tenant. INSERT tambien por columna (018 lo daba de tabla).
create trigger voice_agent_config_derive_org before insert or update of property_id on hoteles.voice_agent_config
  for each row execute function hoteles.housekeeping_derive_org();

revoke select, insert, update on hoteles.voice_agent_config from authenticated;
grant select (property_id, organization_id, enabled, created_at, updated_at) on hoteles.voice_agent_config to authenticated;
grant insert (property_id, organization_id, tool_webhook_secret, enabled) on hoteles.voice_agent_config to authenticated;
grant update (tool_webhook_secret, enabled, updated_at) on hoteles.voice_agent_config to authenticated;

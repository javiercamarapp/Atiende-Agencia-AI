-- Infraestructura de notificaciones REAL, genérica para las 6 verticales +
-- superadmin -- a diferencia de `restaurantes.notification_reads` (referencia
-- externa, atiende-restaurantes, ver la investigación adjunta a esta fase: 7
-- categorías DURAS de un solo negocio -- "recibidos"/"entregados"/"reclamos"/etc,
-- todas específicas de pedidos de restaurante), este esquema no conoce ninguna
-- categoría de negocio: cada fila de `core.notification` ya trae su propio
-- `titulo`/`cuerpo` armados por quien la generó (un cron, una ruta de dominio, un
-- job de plataforma) -- el mismo mecanismo sirve para "tu reserva de hoy" en
-- hoteles, "vence una licitación" en licitaciones, o una alerta cruzada del
-- back office de superadmin, sin volver a tocar `core`.
--
-- Mismo criterio de acceso EXACTO que el resto del back office de plataforma ya
-- corrigió en esta misma sesión (`0011_login_lookup_security_definer.sql`/
-- `0012_superadmin_prospectos.sql`, leídas primero como plantilla): RLS
-- habilitado en las dos tablas, SIN policy basada en `auth.uid()` a secas (un
-- staff NO es "dueño" de su fila por sesión -- login/lectura de notificaciones
-- puede correr en sesión de sistema igual que el resto de `core`) y SIN GRANT
-- directo a `authenticated` -- todo acceso exclusivamente vía funciones
-- `security definer` que reciben el id del caller (`p_staff_id`) como parámetro
-- EXPLÍCITO y nunca confían en `auth.uid()` (mismo hallazgo crítico que
-- `0011`: una policy `staff_user_id = auth.uid()` bloquea la lectura desde
-- sesión de sistema, y un GRANT directo sin validación adentro es un hueco
-- real). Autorización real: cada función solo puede leer/escribir la fila del
-- `p_staff_id` que se le pasó -- el caller TS (`ProductionCoreRepository`,
-- mismo patrón `withAppSession({ userId: null }, ...)` que login/
-- `isPlatformSuperadmin`) siempre pasa el `userId` de la sesión JWT ya
-- verificada por `authMiddleware`, nunca un id arbitrario del body/query de la
-- ruta HTTP -- ver `apps/api/src/routes/notifications.ts`.

create table core.notification (
  id uuid primary key default gen_random_uuid(),
  staff_user_id uuid not null references core.staff_user(id) on delete cascade,
  -- Opaco para `core` a propósito (mismo criterio que `core.membership.vertical_role`):
  -- cada dominio decide su propio valor ('hoteles'/'restaurantes'/... o null para una
  -- notificación de plataforma que no pertenece a ninguna vertical concreta, ej. una
  -- alerta de superadmin). Sin CHECK -- a diferencia de `core.prospecto.vertical`
  -- (donde las 6 verticales son un enum cerrado real), aquí una fila de superadmin
  -- puede no tener vertical en absoluto.
  vertical text,
  titulo text not null,
  cuerpo text,
  -- Referencia opaca de vuelta a la fila de dominio que generó esta notificación (ej.
  -- entidad_tipo='reserva', entidad_id=<uuid de hoteles.reservation>) -- `core` nunca
  -- valida que apunte a algo real (no hay FK cruzada entre schemas), el consumidor de
  -- la UI decide qué hacer con ella (deep-link, o simplemente mostrarla).
  entidad_tipo text,
  entidad_id uuid,
  created_at timestamptz not null default now()
);

create index notification_staff_user_created_at_idx
  on core.notification (staff_user_id, created_at desc);

alter table core.notification enable row level security;
revoke all on core.notification from public, anon, authenticated;

-- "Leído" es un hecho aparte de la notificación misma (mismo criterio que
-- `restaurantes.notification_reads` de la referencia: "abrir un pedido debe limpiar
-- su badge sin cambiar su estado operativo") -- fila propia en vez de una columna
-- `read_at` en `core.notification`, para que "marcar todas como leídas" sea un solo
-- INSERT masivo idempotente (`on conflict do nothing`) sin tener que tocar/journalear
-- la fila original de la notificación.
create table core.notification_read (
  staff_user_id uuid not null references core.staff_user(id) on delete cascade,
  notification_id uuid not null references core.notification(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (staff_user_id, notification_id)
);

alter table core.notification_read enable row level security;
revoke all on core.notification_read from public, anon, authenticated;

-- Últimas 50 notificaciones del staff, con `read_at` (null = no leída) resuelto vía
-- LEFT JOIN a `core.notification_read` -- una sola llamada le basta al frontend para
-- pintar la lista completa del dropdown de la campana sin una segunda query.
create or replace function core.list_notifications_for_staff(p_staff_id uuid)
returns table (
  id uuid,
  vertical text,
  titulo text,
  cuerpo text,
  entidad_tipo text,
  entidad_id uuid,
  created_at timestamptz,
  read_at timestamptz
)
language sql stable security definer set search_path = core, pg_temp
as $$
  select n.id, n.vertical, n.titulo, n.cuerpo, n.entidad_tipo, n.entidad_id, n.created_at, nr.read_at
  from core.notification n
  left join core.notification_read nr on nr.notification_id = n.id and nr.staff_user_id = p_staff_id
  where n.staff_user_id = p_staff_id
  order by n.created_at desc
  limit 50;
$$;

revoke all on function core.list_notifications_for_staff(uuid) from public;
grant execute on function core.list_notifications_for_staff(uuid) to authenticated;

-- Conteo real para el badge de la campana -- mismo criterio que
-- `restaurantes.notification_unread_count` de la referencia: fuente de verdad única
-- en Postgres, el frontend nunca calcula "no leídas" restando arreglos en cliente.
create or replace function core.count_unread_notifications_for_staff(p_staff_id uuid)
returns integer
language sql stable security definer set search_path = core, pg_temp
as $$
  select count(*)::integer
  from core.notification n
  where n.staff_user_id = p_staff_id
    and not exists (
      select 1 from core.notification_read nr
      where nr.notification_id = n.id and nr.staff_user_id = p_staff_id
    );
$$;

revoke all on function core.count_unread_notifications_for_staff(uuid) from public;
grant execute on function core.count_unread_notifications_for_staff(uuid) to authenticated;

-- Marcar UNA leída -- UPSERT idempotente (mismo criterio que la referencia: "clics
-- repetidos y pestañas concurrentes deben ser idempotentes"). Lanza si la
-- notificación no existe o pertenece a OTRO staff -- nunca marca leída una fila
-- ajena aunque el caller adivine un id real.
create or replace function core.mark_notification_read(p_staff_id uuid, p_notification_id uuid)
returns void
language plpgsql security definer set search_path = core, pg_temp
as $$
begin
  if not exists (
    select 1 from core.notification where id = p_notification_id and staff_user_id = p_staff_id
  ) then
    raise exception 'notification not found' using errcode = 'P0002';
  end if;

  insert into core.notification_read (staff_user_id, notification_id)
  values (p_staff_id, p_notification_id)
  on conflict (staff_user_id, notification_id) do nothing;
end;
$$;

revoke all on function core.mark_notification_read(uuid, uuid) from public;
grant execute on function core.mark_notification_read(uuid, uuid) to authenticated;

-- Marcar TODAS leídas -- mismo criterio que
-- `restaurantes.mark_all_notifications_read` de la referencia: un solo INSERT
-- masivo evaluado en Postgres (nunca N llamadas desde el cliente), `on conflict do
-- nothing` para que reintentar/una pestaña concurrente no falle. Devuelve cuántas
-- filas quedaron marcadas leídas en ESTA llamada (0 si ya no había pendientes).
create or replace function core.mark_all_notifications_read(p_staff_id uuid)
returns integer
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_affected integer;
begin
  insert into core.notification_read (staff_user_id, notification_id)
  select p_staff_id, n.id
  from core.notification n
  where n.staff_user_id = p_staff_id
  on conflict (staff_user_id, notification_id) do nothing;

  get diagnostics v_affected = row_count;
  return coalesce(v_affected, 0);
end;
$$;

revoke all on function core.mark_all_notifications_read(uuid) from public;
grant execute on function core.mark_all_notifications_read(uuid) to authenticated;

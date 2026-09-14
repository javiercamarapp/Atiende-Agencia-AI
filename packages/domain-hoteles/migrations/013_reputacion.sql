-- Fase 11 hoteles (REQ-CRM-002/003, P1/F) — reputación/CRM: clasificación automática
-- de reseñas/encuestas por tema y sentimiento, disparando la acción correspondiente
-- (ticket de mantenimiento, mensaje proactivo, compensación reglada), + inbox
-- unificado + índice de reputación agregado. Espejo de base de datos de
-- `packages/domain-hoteles/src/reputacion/clasificador.ts` (mismo patrón que
-- 011_revenue_engine_gate.sql / revenueEngineGate.ts).
--
-- Gap real verificado contra el código de main antes de esta migración: ningún
-- archivo bajo `packages/domain-hoteles` mencionaba reputación/reseñas/CRM, y
-- `packages/domain-hoteles/README.md` listaba "reputación" explícitamente fuera de
-- Fase 1, sin que ninguna fase posterior la retomara. Port del modelo de datos de
-- `hoteles/packages/db/migrations/0097_guest_review_reputacion.sql`, adaptado al
-- esquema real de atiende-fusion (`organization_id`/`property_id` sobre
-- `core.organization`/`core.property`, no `tenant_id`/`hotel_id` sobre
-- `public.org`/`public.hotel`).
--
-- Dos tablas:
--   `hoteles.guest_review`        -- la reseña/encuesta + su clasificación
--                                    (temas/sentimiento), YA calculada por
--                                    `clasificarResena()` antes del insert.
--   `hoteles.guest_review_action` -- cada acción que la clasificación disparó.
--
-- IMPORTANTE -- alcance real de ESTA migración (solo el modelo de datos, nunca la
-- orquestación):
--   1. Ingesta automática real desde Google/Booking/TripAdvisor (REQ-CRM-001 en el
--      origen) sigue "pendiente-credenciales" -- fuera de alcance de esta fase por
--      no tener acceso a esas APIs. `source`/`external_id` quedan listos para
--      cuando exista un conector real (mismo criterio que documentaba el origen),
--      pero hoy esta tabla se alimenta de captura MANUAL (encuesta propia del staff,
--      o una reseña pública copiada/pegada) o de un futuro webhook -- ninguno de los
--      dos requiere credenciales que este repo no tenga.
--   2. Esta migración NO agrega ninguna ruta HTTP en `apps/api` (a diferencia del
--      origen, que sí montaba `apps/api/src/routes/reputacion.ts`): el patrón de
--      esta fase es el mismo que Fase 9 (revenue) -- domain-hoteles construye el
--      dominio puro + el modelo de datos completo, y la orquestación (leer/escribir
--      estas tablas desde una ruta real, ejecutar el ticket de mantenimiento contra
--      `hoteles.maintenance_ticket`, enviar el mensaje proactivo, aplicar la
--      compensación) queda para una fase futura de `apps/api` -- ver
--      `packages/domain-hoteles/README.md` §Fase 11 para el detalle honesto de lo
--      pendiente.
--   3. `guest_review_action.ticket_id` por eso queda SIEMPRE nullable: ninguna
--      inserción de esta fase lo puebla todavía (no hay ruta que cree el ticket
--      real), la columna solo deja el modelo de datos listo para cuando exista esa
--      orquestación.
--
-- Requiere: 001_hoteles_schema.sql ya aplicada (hoteles.guest, hoteles.folio,
-- hoteles.maintenance_ticket de 009_housekeeping_mantenimiento_turnos.sql).
-- Expand-only: ninguna migración ya aplicada se edita.

create type hoteles.guest_review_source as enum ('google', 'booking', 'tripadvisor', 'expedia', 'encuesta_propia', 'otro');
create type hoteles.guest_review_sentiment as enum ('muy_negativo', 'negativo', 'neutral', 'positivo', 'muy_positivo');
create type hoteles.guest_review_stay_state as enum ('en_estancia', 'post_estancia', 'desconocido');

create table hoteles.guest_review (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  -- `on delete set null`: si el huésped se borra (privacidad/ARCO) la reseña YA
  -- CLASIFICADA se conserva (evidencia de la acción disparada), pierde solo el
  -- enlace directo a la identidad -- mismo criterio que `maintenance_ticket.
  -- created_by`/`fraud_alert.resolved_by`.
  guest_id uuid references hoteles.guest(id) on delete set null,
  folio_id uuid references hoteles.folio(id) on delete set null,
  source hoteles.guest_review_source not null,
  -- Id de la reseña en la plataforma de origen (Google/Booking/...) -- NULL para una
  -- encuesta propia capturada directamente (no tiene un id externo que deduplicar).
  external_id text,
  texto text not null check (char_length(texto) between 1 and 4000),
  idioma text not null default 'es',
  calificacion smallint check (calificacion between 1 and 5),
  stay_state hoteles.guest_review_stay_state not null default 'desconocido',
  is_public boolean not null default true,
  -- Salida de `detectarTemas()` (packages/domain-hoteles/src/reputacion/
  -- clasificador.ts): [{topic, esConocido, menciones, palabrasClave}].
  topics jsonb not null default '[]'::jsonb,
  sentiment hoteles.guest_review_sentiment not null,
  sentiment_score numeric(5, 3) not null check (sentiment_score between -1 and 1),
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
-- Idempotencia de ingesta por plataforma: la MISMA reseña externa nunca se clasifica
-- ni se dispara dos veces para la misma property (parcial: una encuesta propia sin
-- `external_id` no tiene con qué deduplicar, cada envío es una fila nueva a propósito).
create unique index guest_review_source_external_idx
  on hoteles.guest_review (property_id, source, external_id)
  where external_id is not null;
create index guest_review_property_created_idx on hoteles.guest_review (organization_id, property_id, created_at desc);
create index guest_review_guest_idx on hoteles.guest_review (guest_id) where guest_id is not null;

alter table hoteles.guest_review enable row level security;

-- Quién captura/clasifica una reseña y quién puede verla -- ver
-- `REPUTACION_SUBMIT_ROLES`/`REPUTACION_VIEW_ROLES` (packages/domain-hoteles/src/
-- roles.ts, comentario completo ahí): capturar es front-of-house
-- (owner/gm/frontdesk/reservations, mismo subconjunto que
-- `hoteles.can_manage_reservations()`); ver suma `accountant` porque una
-- compensación reglada mueve dinero.
create or replace function hoteles.can_submit_reputacion(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role in ('owner', 'gm', 'frontdesk', 'reservations')
  )
$$;

create or replace function hoteles.can_view_reputacion(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role in ('owner', 'gm', 'frontdesk', 'reservations', 'accountant')
  )
$$;

-- Resolver (marcar ejecutada/descartada) una acción pendiente es MÁS estricto que
-- verla o dispararla: mensaje proactivo y compensación son ejecución humana fuera de
-- este dominio puro, compensación en particular mueve dinero -- mismo nivel que
-- `hoteles.can_access_pl()`/`FRAUD_RESOLVER_ROLES`, nunca frontdesk/reservations.
create or replace function hoteles.can_resolve_reputacion_accion(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role in ('owner', 'gm', 'accountant')
  )
$$;

create policy "reputacion: staff con acceso ve reseñas" on hoteles.guest_review for select
  using (hoteles.can_view_reputacion(property_id));
create policy "reputacion: staff con acceso captura reseñas" on hoteles.guest_review for insert
  with check (hoteles.can_submit_reputacion(property_id));
-- Sin policy de update/delete para `authenticated`: una clasificación ya hecha es
-- append-only (mismo criterio que `hoteles.attendance_log`/`hoteles.fraud_alert`) --
-- re-clasificar significa insertar una fila nueva, nunca editar la de antes.

revoke all on hoteles.guest_review from public, anon;
grant select, insert on hoteles.guest_review to authenticated;
grant select, insert, update, delete on hoteles.guest_review to service_role;

create type hoteles.guest_review_action_type as enum ('ticket_mantenimiento', 'mensaje_proactivo', 'compensacion_reglada');
create type hoteles.guest_review_action_status as enum ('pendiente', 'ejecutada', 'descartada');

create table hoteles.guest_review_action (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  review_id uuid not null references hoteles.guest_review(id) on delete cascade,
  action_type hoteles.guest_review_action_type not null,
  status hoteles.guest_review_action_status not null default 'pendiente',
  -- Solo poblado cuando `action_type = 'ticket_mantenimiento'` Y una orquestación
  -- real (fuera de esta fase, ver comentario de cabecera del archivo) ya haya
  -- creado el ticket en `hoteles.maintenance_ticket` -- ninguna fila de esta fase lo
  -- puebla todavía.
  ticket_id uuid references hoteles.maintenance_ticket(id) on delete set null,
  -- Para 'mensaje_proactivo': {mensajeSugerido}. Para 'compensacion_reglada':
  -- {tema, compensacion:{tipo,valor,unidad}}. Estructura de `AccionReputacion`
  -- (packages/domain-hoteles/src/reputacion/clasificador.ts), guardada tal cual.
  detail jsonb not null default '{}'::jsonb,
  reason text not null,
  resolved_by uuid references core.staff_user(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint guest_review_action_resolution_consistency check (
    (status = 'pendiente' and resolved_by is null and resolved_at is null)
    or (status <> 'pendiente' and resolved_at is not null)
  )
);
create index guest_review_action_review_idx on hoteles.guest_review_action (review_id);
create index guest_review_action_property_status_idx
  on hoteles.guest_review_action (organization_id, property_id, status);

alter table hoteles.guest_review_action enable row level security;

create policy "reputacion: staff con acceso ve acciones" on hoteles.guest_review_action for select
  using (hoteles.can_view_reputacion(property_id));
create policy "reputacion: staff con acceso registra acciones" on hoteles.guest_review_action for insert
  with check (hoteles.can_submit_reputacion(property_id));
create policy "reputacion: staff autorizado resuelve acciones" on hoteles.guest_review_action for update
  using (hoteles.can_resolve_reputacion_accion(property_id))
  with check (hoteles.can_resolve_reputacion_accion(property_id));

revoke all on hoteles.guest_review_action from public, anon;
grant select, insert, update on hoteles.guest_review_action to authenticated;
grant select, insert, update, delete on hoteles.guest_review_action to service_role;

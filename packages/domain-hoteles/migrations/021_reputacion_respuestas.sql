-- Fase 13 hoteles (REQ-CRM-002/003, P1/F) — cierre del wiring de reputación: agrega
-- la ÚNICA pieza de modelo de datos que `013_reputacion.sql` (Fase 11) no traía y
-- que el producto sí necesita para "responder" una reseña. Gap real verificado
-- antes de esta migración: `hoteles.guest_review`/`hoteles.guest_review_action` no
-- tienen NINGUNA columna ni tabla para el texto que el staff le escribe de vuelta a
-- un huésped sobre su reseña — `guest_review_action` modela ACCIONES REGLADAS
-- disparadas por la clasificación (ticket/mensaje/compensación, catálogo cerrado,
-- ver `clasificador.ts::AccionReputacion`), nunca una respuesta libre de staff a
-- una reseña cualquiera (incluida una neutra/positiva, que no dispara ninguna
-- acción reglada pero sí amerita un "gracias por tu comentario" del hotel).
--
-- Alcance real de esta migración (mismo criterio "honesto" que 011/013): solo el
-- modelo de datos + su RLS. Publicar esa respuesta de vuelta en Google/Booking/
-- TripAdvisor requeriría las mismas credenciales de esas plataformas que
-- `013_reputacion.sql` ya documentó como "pendiente-credenciales" — esta tabla
-- registra la respuesta REAL del staff (auditable, visible en el inbox unificado
-- de esta property), nunca simula que se publicó en ningún canal externo.
--
-- Requiere: 013_reputacion.sql ya aplicada (hoteles.guest_review,
-- hoteles.can_submit_reputacion/can_view_reputacion — reutilizados tal cual, sin
-- redefinirlos: mismo criterio de autorización exacto que ya rige capturar/ver una
-- reseña, "responder" no es ni más ni menos sensible que "capturar").
-- Expand-only: ninguna migración ya aplicada se edita.

create table hoteles.guest_review_response (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  review_id uuid not null references hoteles.guest_review(id) on delete cascade,
  texto text not null check (char_length(texto) between 1 and 2000),
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
create index guest_review_response_review_idx on hoteles.guest_review_response (review_id, created_at);
create index guest_review_response_property_idx on hoteles.guest_review_response (organization_id, property_id, created_at desc);

alter table hoteles.guest_review_response enable row level security;

-- Mismo criterio de autorización EXACTO que `hoteles.guest_review` (migrations/
-- 013_reputacion.sql): capturar/responder es front-of-house (owner/gm/frontdesk/
-- reservations), ver es ese mismo subconjunto + accountant. Reutiliza los
-- `can_submit_reputacion`/`can_view_reputacion` YA definidos ahí -- nunca se
-- redefinen ni se duplica su lógica.
create policy "reputacion: staff con acceso ve respuestas" on hoteles.guest_review_response for select
  using (hoteles.can_view_reputacion(property_id));
create policy "reputacion: staff con acceso responde reseñas" on hoteles.guest_review_response for insert
  with check (hoteles.can_submit_reputacion(property_id));
-- Sin policy de update/delete para `authenticated`: una respuesta ya enviada es
-- append-only (mismo criterio que `hoteles.guest_review`) -- corregirla significa
-- escribir una respuesta nueva, nunca editar la de antes.

revoke all on hoteles.guest_review_response from public, anon;
grant select, insert on hoteles.guest_review_response to authenticated;
grant select, insert, update, delete on hoteles.guest_review_response to service_role;

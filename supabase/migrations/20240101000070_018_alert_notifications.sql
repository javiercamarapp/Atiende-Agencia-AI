-- Fase 10 — despacho proactivo REAL de las alertas que hasta ahora solo eran
-- registros consultables manualmente (gap identificado por auditoría de
-- paridad): `licitaciones.tender_deadline_reminder` (migración 017, Fase 8),
-- `licitaciones.renewal_alert` (migración 016, Fase 6 REQ-055) y las facturas
-- vencidas de `licitaciones.contract_invoice` (migración 013, Fase 6
-- REQ-051) nunca disparaban NINGÚN aviso -- alguien tenía que abrir el panel
-- y consultarlas a mano. Requiere: 001_licitaciones_schema.sql..
-- 017_source_ingestion_and_deadline_reminders.sql.
--
-- Verificado ANTES de esta migración (ver apps/worker/src/jobs/licitaciones/,
-- packages/whatsapp-gateway/): licitaciones NO es una de las 3 verticales con
-- agente de WhatsApp (citas/hoteles/restaurantes, ver
-- `packages/whatsapp-gateway/README.md`) -- no existe `licitaciones.whatsapp_config`
-- ni ningún webhook entrante, así que el dispatcher transversal de WhatsApp
-- (`@atiende/whatsapp-gateway::WhatsAppOutboundDispatcher`,
-- `POST /internal/whatsapp/dispatch`) NO APLICA aquí. El canal real
-- disponible para este vertical es el mismo motor de correo vía Resend que ya
-- usan citas (migración 009 citas)/rentas (migración 011 rentas): esta
-- migración porta EXACTAMENTE ese mismo patrón --
-- `licitaciones.messaging_outbox` (organization-scoped, NUNCA property_id --
-- §2.1 del diseño Fase 1: licitaciones no particiona por property) +
-- `enqueue_messaging_outbox`/`claim_email_outbox_batch`/
-- `complete_email_outbox_job`, mismo shape de fila, mismo idioma de
-- claim-con-backoff, mismos nombres de función -- ver
-- `packages/domain-licitaciones/src/email-dispatch.ts`,
-- `src/alert-notifications.ts`.
--
-- A diferencia de citas.messaging_outbox (que SÍ declara `channel in
-- ('whatsapp','email')` por consistencia de esquema con una futura fase de
-- WhatsApp que nunca llegó a construirse ahí tampoco), aquí el CHECK se deja
-- ACOTADO a `'email'` únicamente -- declarar un canal 'whatsapp' que este
-- vertical no tiene forma de configurar (sin `whatsapp_config`, sin webhook)
-- sería fingir una superficie que no existe. Si una fase futura agrega
-- WhatsApp a licitaciones, se amplía el CHECK entonces.
create table licitaciones.messaging_outbox (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  channel text not null check (channel in ('email')),
  event_type text not null check (length(event_type) between 1 and 80),
  dedupe_key text not null check (length(dedupe_key) between 1 and 255),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'failed', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  unique (organization_id, channel, dedupe_key)
);
create index licitaciones_messaging_outbox_dispatch_idx on licitaciones.messaging_outbox (channel, status, created_at);

alter table licitaciones.messaging_outbox enable row level security;
-- Nunca visible/escribible desde el panel de staff (authenticated) -- solo el
-- dispatcher de sistema toca esta tabla, mismo criterio EXACTO que
-- citas.messaging_outbox (migración 003 citas)/rentas.messaging_outbox
-- (migración 011 rentas): sin policy de authenticated en absoluto.
revoke all on licitaciones.messaging_outbox from public, anon, authenticated;
grant select, insert, update on licitaciones.messaging_outbox to service_role;

create or replace function licitaciones.enqueue_messaging_outbox(
  p_organization_id uuid, p_channel text, p_event_type text,
  p_dedupe_key text, p_payload jsonb
) returns uuid language plpgsql security definer set search_path = licitaciones as $$
declare v_id uuid;
begin
  if p_channel not in ('email') then raise exception 'invalid outbox channel'; end if;
  insert into licitaciones.messaging_outbox(organization_id, channel, event_type, dedupe_key, payload)
  values (p_organization_id, p_channel, p_event_type, p_dedupe_key, p_payload)
  on conflict (organization_id, channel, dedupe_key) do update
    set payload = excluded.payload, event_type = excluded.event_type
    where messaging_outbox.status in ('pending', 'failed');
  select id into v_id from licitaciones.messaging_outbox
    where organization_id = p_organization_id and channel = p_channel and dedupe_key = p_dedupe_key;
  return v_id;
end; $$;

-- Reclama hasta p_limit jobs `channel='email'` pendientes/fallidos con
-- `attempts < 5` -- mismo tope real que
-- domain-citas::MAX_EMAIL_DISPATCH_ATTEMPTS/domain-rentas (idéntico).
create or replace function licitaciones.claim_email_outbox_batch(p_limit integer default 25)
returns setof licitaciones.messaging_outbox
language sql security definer set search_path = licitaciones as $$
  update licitaciones.messaging_outbox
  set status = 'processing', attempts = attempts + 1
  where id in (
    select id from licitaciones.messaging_outbox
    where channel = 'email'
      and status in ('pending', 'failed')
      and attempts < 5
    order by created_at asc
    limit greatest(p_limit, 0)
    for update skip locked
  )
  returning *;
$$;

create or replace function licitaciones.complete_email_outbox_job(
  p_id uuid, p_status text, p_error text default null
) returns void language plpgsql security definer set search_path = licitaciones as $$
begin
  if p_status not in ('sent', 'failed', 'dead') then
    raise exception 'invalid email outbox completion status: %', p_status;
  end if;
  update licitaciones.messaging_outbox
  set status = p_status, last_error = left(p_error, 500)
  where id = p_id and channel = 'email';
end;
$$;

revoke all on function licitaciones.enqueue_messaging_outbox(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function licitaciones.claim_email_outbox_batch(integer) from public, anon, authenticated;
revoke all on function licitaciones.complete_email_outbox_job(uuid, text, text) from public, anon, authenticated;
grant execute on function licitaciones.enqueue_messaging_outbox(uuid, text, text, text, jsonb) to service_role;
grant execute on function licitaciones.claim_email_outbox_batch(integer) to service_role;
grant execute on function licitaciones.complete_email_outbox_job(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- "Responsable de la organización" -- a quién se le manda el correo. Este
-- vertical no tiene (todavía) ningún concepto de contacto de notificación
-- propio (a diferencia de rentas.guest_minimo.contacto/citas: aquí NO se le
-- avisa a un cliente/huésped externo, se avisa al STAFF interno dueño de la
-- cuenta) -- se reutiliza `core.staff_user.email` vía `core.membership`
-- (`platform_role in ('owner','admin')`), la MISMA fuente real que ya usa
-- `requirePropertyMembership`/`core.has_property_access` para autorización,
-- nunca un campo nuevo inventado. `security definer` (como
-- `core.has_property_access`/`licitaciones.can_write_org`) para que el barrido
-- interno (sesión de sistema `userId: null`, sin `auth.uid()`) pueda
-- resolverlos igual que ya resuelve `listActiveOrganizations` contra
-- `core.organization` -- ver comentario de cabecera de
-- `src/alert-notifications.ts` para el detalle completo de esa decisión.
create or replace function licitaciones.organization_notification_recipients(p_organization_id uuid)
returns table(email text, full_name text)
language sql stable security definer set search_path = core as $$
  select su.email, su.full_name
  from core.membership m
  join core.staff_user su on su.id = m.user_id
  where m.organization_id = p_organization_id
    and m.platform_role in ('owner', 'admin')
  order by su.email asc;
$$;

revoke all on function licitaciones.organization_notification_recipients(uuid) from public, anon, authenticated;
grant execute on function licitaciones.organization_notification_recipients(uuid) to service_role;

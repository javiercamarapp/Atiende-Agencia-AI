-- Quinta migración del esquema `despachos.*` — infraestructura real de correo
-- (hallazgo de auditoría, severidad ALTA): "Despachos no tiene ninguna
-- infraestructura de correo (ni outbox, ni plantilla HTML, ni dispatch),
-- mientras citas/rentas/licitaciones sí la tienen". Verificado ANTES de
-- construir esto: `grep -rn "email\|outbox\|whatsapp" packages/domain-despachos/src`
-- solo encontraba `cobranza/templates.ts` (texto plano, sin HTML/canal real) y
-- el propio README admitiendo "no hay integración con un canal de envío real
-- ... en esta fase"; `packages/domain-despachos/migrations/` no tenía ninguna
-- tabla de outbox (004_cobranza_schema.sql lo difería explícitamente a "fase
-- futura"); `POST .../vencimientos/:deadlineId/escalar` (apps/api) solo
-- insertaba el escalamiento en BD sin notificar a nadie; y `apps/worker/src/jobs`
-- no tenía ninguna carpeta `despachos/` (a diferencia de citas/hoteles/
-- licitaciones/rentas/restaurantes).
--
-- Nota de numeración: mismo caso documentado en el header de
-- 003_cierre_mensual_schema.sql — la migración "002" de esta secuencia interna
-- nunca existió en este directorio (solo su espejo en
-- supabase/migrations/20240101000037_002_despachos_migracion_catalogo_schema.sql).
-- Renumerar esa inconsistencia preexistente está fuera de alcance de este
-- hallazgo; esta migración simplemente toma el siguiente número libre ("005"),
-- verificado con `ls packages/domain-despachos/migrations | sort`.
--
-- Esta migración porta EXACTAMENTE el mismo patrón que ya usan citas
-- (migración 009 citas)/rentas (migración 011 rentas)/licitaciones (migración
-- 018 licitaciones) para su canal de correo vía Resend — `messaging_outbox` +
-- `enqueue_messaging_outbox`/`claim_email_outbox_batch`/
-- `complete_email_outbox_job`, mismo shape de fila, mismos nombres de función.
-- Verificado ANTES de esta migración (mismo chequeo que documenta el header de
-- 018_alert_notifications.sql de licitaciones): despachos NO es una de las 3
-- verticales con agente de WhatsApp (citas/hoteles/restaurantes) — no existe
-- `despachos.whatsapp_config` ni ningún webhook entrante — así que, igual que
-- licitaciones, el CHECK de `channel` se deja acotado a `'email'` únicamente
-- (nunca se finge una superficie de WhatsApp que este vertical no tiene forma
-- de configurar).
create table despachos.messaging_outbox (
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
create index despachos_messaging_outbox_dispatch_idx on despachos.messaging_outbox (channel, status, created_at);

alter table despachos.messaging_outbox enable row level security;
-- Nunca visible/escribible desde el panel de staff (authenticated) -- solo el
-- dispatcher de sistema (sesión `userId: null`, ver
-- apps/api/src/routes/verticals/despachos/notifications.ts) toca esta tabla,
-- mismo criterio EXACTO que citas.messaging_outbox/licitaciones.messaging_outbox.
revoke all on despachos.messaging_outbox from public, anon, authenticated;
grant select, insert, update on despachos.messaging_outbox to service_role;

create or replace function despachos.enqueue_messaging_outbox(
  p_organization_id uuid, p_channel text, p_event_type text,
  p_dedupe_key text, p_payload jsonb
) returns uuid language plpgsql security definer set search_path = despachos as $$
declare v_id uuid;
begin
  if p_channel not in ('email') then raise exception 'invalid outbox channel'; end if;
  insert into despachos.messaging_outbox(organization_id, channel, event_type, dedupe_key, payload)
  values (p_organization_id, p_channel, p_event_type, p_dedupe_key, p_payload)
  on conflict (organization_id, channel, dedupe_key) do update
    set payload = excluded.payload, event_type = excluded.event_type
    where messaging_outbox.status in ('pending', 'failed');
  select id into v_id from despachos.messaging_outbox
    where organization_id = p_organization_id and channel = p_channel and dedupe_key = p_dedupe_key;
  return v_id;
end; $$;

-- Reclama hasta p_limit jobs `channel='email'` pendientes/fallidos con
-- `attempts < 5` -- mismo tope real que
-- domain-citas::MAX_EMAIL_DISPATCH_ATTEMPTS/domain-rentas/domain-licitaciones
-- (idéntico en las 3).
create or replace function despachos.claim_email_outbox_batch(p_limit integer default 25)
returns setof despachos.messaging_outbox
language sql security definer set search_path = despachos as $$
  update despachos.messaging_outbox
  set status = 'processing', attempts = attempts + 1
  where id in (
    select id from despachos.messaging_outbox
    where channel = 'email'
      and status in ('pending', 'failed')
      and attempts < 5
    order by created_at asc
    limit greatest(p_limit, 0)
    for update skip locked
  )
  returning *;
$$;

create or replace function despachos.complete_email_outbox_job(
  p_id uuid, p_status text, p_error text default null
) returns void language plpgsql security definer set search_path = despachos as $$
begin
  if p_status not in ('sent', 'failed', 'dead') then
    raise exception 'invalid email outbox completion status: %', p_status;
  end if;
  update despachos.messaging_outbox
  set status = p_status, last_error = left(p_error, 500)
  where id = p_id and channel = 'email';
end;
$$;

revoke all on function despachos.enqueue_messaging_outbox(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function despachos.claim_email_outbox_batch(integer) from public, anon, authenticated;
revoke all on function despachos.complete_email_outbox_job(uuid, text, text) from public, anon, authenticated;
grant execute on function despachos.enqueue_messaging_outbox(uuid, text, text, text, jsonb) to service_role;
grant execute on function despachos.claim_email_outbox_batch(integer) to service_role;
grant execute on function despachos.complete_email_outbox_job(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- "Responsable de la organización" -- a quién se le manda el correo de
-- escalamiento de vencimientos fiscales (POST .../vencimientos/:id/escalar,
-- ver apps/api/src/routes/verticals/despachos/vencimientos.ts). Un
-- escalamiento fiscal es un aviso INTERNO al despacho contable dueño de la
-- cuenta (nunca al contribuyente/cliente final -- CFF art. 89 exige revisión
-- humana del propio despacho, no un aviso al SAT ni al causante), así que se
-- reutiliza `core.staff_user.email` vía `core.membership`
-- (`platform_role in ('owner','admin')`) -- MISMA fuente real que
-- `licitaciones.organization_notification_recipients` (migración 018 de
-- licitaciones, leída primero como plantilla exacta), nunca un campo nuevo
-- inventado. `security definer` para que el barrido/acción interna (sesión de
-- sistema `userId: null`, sin `auth.uid()`) pueda resolverlos.
create or replace function despachos.organization_notification_recipients(p_organization_id uuid)
returns table(email text, full_name text)
language sql stable security definer set search_path = core as $$
  select su.email, su.full_name
  from core.membership m
  join core.staff_user su on su.id = m.user_id
  where m.organization_id = p_organization_id
    and m.platform_role in ('owner', 'admin')
  order by su.email asc;
$$;

revoke all on function despachos.organization_notification_recipients(uuid) from public, anon, authenticated;
grant execute on function despachos.organization_notification_recipients(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Contacto real del deudor en `despachos.receivable` (migración 004) -- a
-- diferencia del escalamiento de vencimientos (aviso interno, arriba), un
-- recordatorio de cobranza (`src/cobranza/`) SÍ es un aviso a un tercero
-- externo (el cliente que debe la factura), y ese dato NUNCA existió en el
-- modelo: el CFDI (`despachos.invoice`, migración 001) solo trae
-- `rfc_receptor` (el RFC fiscal), nunca un correo de contacto utilizable --
-- gap real verificado antes de esta migración (`grep -n "email" types.ts`
-- sobre `ReceivableRecord`/`NewReceivableInput` no encontraba nada). Columnas
-- NULLABLE a propósito: registrar una cuenta por cobrar sin contacto de correo
-- sigue siendo válido (mismo criterio "honesto" que
-- `citas.customer.email is null` -- ver `appointment-email-notifications.ts`
-- de citas: "sin correo en archivo no es un error"), simplemente esa cuenta no
-- recibe recordatorio por correo hasta que alguien lo capture.
alter table despachos.receivable
  add column cliente_nombre text check (cliente_nombre is null or length(cliente_nombre) between 1 and 200),
  add column cliente_email text check (cliente_email is null or cliente_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$');

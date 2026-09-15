-- Fase 12 hoteles (hallazgo ALTA, verificado el ÚLTIMO de severidad alta pendiente
-- en todo el proyecto): "Hoteles no envía ningún correo/notificación al huésped
-- (sin plantilla, sin despachador, sin branding aplicable)" — domain-hoteles no
-- tenía ninguna carpeta `emails/` ni ruta `email-dispatch` a diferencia de
-- citas/rentas/licitaciones/despachos, que ya traen esta infraestructura completa.
--
-- VERIFICADO ANTES de escribir este archivo: `hoteles.messaging_outbox`
-- (008_messaging_outbox.sql) YA soporta `channel='email'` desde su propio CHECK
-- (`check (channel in ('whatsapp', 'email'))`) y YA trae `attempts`/
-- `last_error_class` desde el día uno (a diferencia de citas, que los agregó en
-- una migración de dos pasos por razones históricas, ver
-- packages/domain-citas/migrations/009_email_outbox_dispatch.sql) — lo único que
-- faltaba en el ESQUEMA era CÓMO se drena ese canal: `enqueue_messaging_outbox`/
-- `claim_messaging_outbox_batch`/`complete_messaging_outbox_*` de
-- 008_messaging_outbox.sql están TODOS acotados a `channel = 'whatsapp'` (ver su
-- propio comentario de cabecera). Esta migración agrega el par de funciones que le
-- falta al canal `email`, mismo patrón EXACTO que:
--   - packages/domain-citas/migrations/009_email_outbox_dispatch.sql
--   - packages/domain-rentas/migrations/011_rentas_email_outbox.sql (claim/complete)
-- acotado a `channel = 'email'` — estas dos funciones NUNCA tocan una fila
-- `channel = 'whatsapp'` (ese lado sigue siendo
-- `hoteles.claim_messaging_outbox_batch`, sin ningún cambio).
--
-- Diferencia real frente a citas/rentas (documentada, no un descuido): hoteles ya
-- traía `attempts`/`last_error_class` desde 008_messaging_outbox.sql, así que esta
-- migración NO altera el esquema de la tabla — reutiliza `last_error_class` (con su
-- límite YA declarado de 120 caracteres) en vez de los 500 de `last_error` en
-- citas/rentas.

-- Reclama hasta p_limit jobs `channel='email'` pendientes/fallidos con
-- `attempts < 5` -- mismo tope real que domain-citas::MAX_EMAIL_DISPATCH_ATTEMPTS.
create or replace function hoteles.claim_email_outbox_batch(p_limit integer default 25)
returns setof hoteles.messaging_outbox
language sql
security definer
set search_path = hoteles
as $$
  update hoteles.messaging_outbox
  set status = 'processing', attempts = attempts + 1
  where id in (
    select id from hoteles.messaging_outbox
    where channel = 'email'
      and status in ('pending', 'failed')
      and attempts < 5
    order by created_at asc
    limit greatest(p_limit, 0)
    for update skip locked
  )
  returning *;
$$;

create or replace function hoteles.complete_email_outbox_job(
  p_id uuid,
  p_status text,
  p_error text default null
) returns void
language plpgsql
security definer
set search_path = hoteles
as $$
begin
  if p_status not in ('sent', 'failed', 'dead') then
    raise exception 'invalid email outbox completion status: %', p_status;
  end if;
  update hoteles.messaging_outbox
  set status = p_status, last_error_class = left(p_error, 120)
  where id = p_id and channel = 'email';
end;
$$;

revoke all on function hoteles.claim_email_outbox_batch(integer) from public, anon, authenticated;
revoke all on function hoteles.complete_email_outbox_job(uuid, text, text) from public, anon, authenticated;
grant execute on function hoteles.claim_email_outbox_batch(integer) to service_role;
grant execute on function hoteles.complete_email_outbox_job(uuid, text, text) to service_role;

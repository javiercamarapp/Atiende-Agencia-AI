-- Mismo hallazgo/mismo criterio que
-- `packages/domain-citas/migrations/014_email_outbox_authenticated_grants.sql`
-- (leer ese header primero para el diagnóstico completo): `rentas.
-- enqueue_messaging_outbox`/`claim_email_outbox_batch`/`complete_email_outbox_job`
-- (migración 011) son `security definer` pero el GRANT EXECUTE solo se le dio a
-- `service_role` -- un rol que este monorepo nunca aprovisiona contra Postgres real
-- (`withAppSession` siempre conecta como `authenticated`). Contra Postgres real,
-- TODAS fallan con "permission denied for function..." sin importar quién llame --
-- esto es la mitad del hallazgo más grave de esta pasada: además del pattern de
-- GRANT roto, las 4 rutas internas de rentas (checkout-sweep-cron.ts/
-- ical-sync-cron.ts/checkin-recordatorio.ts/email-dispatch.ts) también quedaban
-- bloqueadas por RLS normal en sus LECTURAS (`rentas.ocupacion`/
-- `rentas.canal_feed_externo`), resuelto por separado en las migraciones
-- "sistema o dinero" de esta misma pasada (ver comentario de cabecera de
-- `checkout-sweep-cron.ts`/`ical-sync-cron.ts`/`checkin-recordatorio.ts`).
--
-- Verificado con `grep -rn` sobre `apps/api/src/routes/verticals/rentas/` antes de
-- decidir la verificación interna de cada una:
--   - `claim_email_outbox_batch`/`complete_email_outbox_job`: SOLO se llaman desde
--     `email-dispatch.ts`, dentro de `deps.engine.withAppSession({ userId: null })`
--     -- nunca desde una ruta de staff. Verificación: solo sesión de sistema.
--   - `enqueue_messaging_outbox`: se llama TANTO desde la sesión de sistema
--     (`checkin-reminders.ts`, cron de recordatorio de check-in) COMO desde
--     `reservas.ts::POST .../reservas` (staff YA autenticado,
--     `requirePropertyMembership("propertyId")` + `db = c.get("db")` real) -- la
--     verificación interna correcta es "sesión de sistema (auth.uid() is null) O
--     staff con acceso real a esa property" (`core.has_property_access`, MISMA
--     función que ya usan todas las policies RLS de este esquema) -- property-
--     scoped porque `rentas.messaging_outbox` particiona por `property_id`, no por
--     `organization_id` (ver comentario de migración 011).

create or replace function rentas.enqueue_messaging_outbox(
  p_property_id uuid, p_organization_id uuid, p_channel text, p_event_type text,
  p_dedupe_key text, p_payload jsonb
) returns uuid language plpgsql security definer set search_path = rentas as $$
declare v_id uuid;
begin
  if auth.uid() is not null and not core.has_property_access(auth.uid(), p_property_id) then
    raise exception 'sin acceso a esta property' using errcode = '42501';
  end if;

  if p_channel not in ('whatsapp', 'email') then raise exception 'invalid outbox channel'; end if;
  insert into rentas.messaging_outbox(property_id, organization_id, channel, event_type, dedupe_key, payload)
  values (p_property_id, p_organization_id, p_channel, p_event_type, p_dedupe_key, p_payload)
  on conflict (property_id, channel, dedupe_key) do update
    set payload = excluded.payload, event_type = excluded.event_type
    where messaging_outbox.status in ('pending', 'failed');
  select id into v_id from rentas.messaging_outbox
    where property_id = p_property_id and channel = p_channel and dedupe_key = p_dedupe_key;
  return v_id;
end; $$;

create or replace function rentas.claim_email_outbox_batch(p_limit integer default 25)
returns setof rentas.messaging_outbox
language plpgsql security definer set search_path = rentas as $$
begin
  if auth.uid() is not null then
    raise exception 'claim_email_outbox_batch es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    update rentas.messaging_outbox
    set status = 'processing', attempts = attempts + 1
    where id in (
      select id from rentas.messaging_outbox
      where channel = 'email'
        and status in ('pending', 'failed')
        and attempts < 5
      order by created_at asc
      limit greatest(p_limit, 0)
      for update skip locked
    )
    returning *;
end;
$$;

create or replace function rentas.complete_email_outbox_job(
  p_id uuid, p_status text, p_error text default null
) returns void language plpgsql security definer set search_path = rentas as $$
begin
  if auth.uid() is not null then
    raise exception 'complete_email_outbox_job es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_status not in ('sent', 'failed', 'dead') then
    raise exception 'invalid email outbox completion status: %', p_status;
  end if;
  update rentas.messaging_outbox
  set status = p_status, last_error = left(p_error, 500)
  where id = p_id and channel = 'email';
end;
$$;

grant execute on function rentas.enqueue_messaging_outbox(uuid, uuid, text, text, text, jsonb) to authenticated;
grant execute on function rentas.claim_email_outbox_batch(integer) to authenticated;
grant execute on function rentas.complete_email_outbox_job(uuid, text, text) to authenticated;

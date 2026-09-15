-- Mismo hallazgo/mismo criterio que
-- `packages/domain-citas/migrations/014_email_outbox_authenticated_grants.sql`
-- (leer ese header primero para el diagnóstico completo): `restaurantes.
-- enqueue_messaging_outbox` (migración 007) y `restaurantes.claim_email_outbox_batch`/
-- `complete_email_outbox_job` (migración 011) son `security definer` pero el GRANT
-- EXECUTE solo se le dio a `service_role` -- un rol que este monorepo nunca
-- aprovisiona contra Postgres real. Contra Postgres real, TODAS fallan con
-- "permission denied for function..." sin importar quién llame -- incluyendo
-- `admin-staff.ts::POST .../admin/staff/invitaciones`, que encola el correo real de
-- invitación de staff (ver ese archivo, línea ~171) y hoy fallaría en silencio
-- (capturado por el `try/catch` best-effort de esa ruta) contra Postgres real.
--
-- Verificado con `grep -rn` sobre `apps/api/src/routes/verticals/restaurantes/`
-- antes de decidir la verificación interna de cada una:
--   - `claim_email_outbox_batch`/`complete_email_outbox_job`: SOLO se llaman desde
--     `email-dispatch.ts`, dentro de `deps.engine.withAppSession({ userId: null })`
--     -- nunca desde una ruta de staff. Verificación: solo sesión de sistema.
--   - `enqueue_messaging_outbox`: se llama SIEMPRE desde `admin-staff.ts` (staff YA
--     autenticado, `requirePropertyMembership` + `c.get("db")` real) -- no se
--     encontró ningún caller bajo la sesión de sistema para restaurantes, pero la
--     verificación se deja igual de generosa que en el resto de verticales
--     (permite también `auth.uid() is null`) por si una fase futura agrega un
--     encolado desde un cron/webhook sin sesión de staff. La verificación real hoy
--     es membership de organización (`core.membership`, MISMO invariante que ya
--     exige `assertVerticalRole`/`canInviteStaff` en la ruta HTTP, reforzado aquí
--     como autoridad real) -- este esquema particiona `messaging_outbox` por
--     `organization_id`, no por `property_id` (ver comentario de migración 007).

create or replace function restaurantes.enqueue_messaging_outbox(
  p_organization_id uuid, p_channel text, p_event_type text,
  p_dedupe_key text, p_payload jsonb
) returns uuid language plpgsql security definer set search_path = restaurantes as $$
declare v_id uuid;
begin
  if auth.uid() is not null and not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id and m.user_id = auth.uid()
  ) then
    raise exception 'sin acceso a esta organización' using errcode = '42501';
  end if;

  if p_channel not in ('whatsapp', 'email') then raise exception 'invalid outbox channel'; end if;
  insert into restaurantes.messaging_outbox(organization_id, channel, event_type, dedupe_key, payload)
  values (p_organization_id, p_channel, p_event_type, p_dedupe_key, p_payload)
  on conflict (organization_id, channel, dedupe_key) do update
    set payload = excluded.payload, event_type = excluded.event_type
    where messaging_outbox.status in ('pending', 'failed');
  select id into v_id from restaurantes.messaging_outbox
    where organization_id = p_organization_id and channel = p_channel and dedupe_key = p_dedupe_key;
  return v_id;
end; $$;

create or replace function restaurantes.claim_email_outbox_batch(p_limit integer default 25)
returns setof restaurantes.messaging_outbox
language plpgsql
security definer
set search_path = restaurantes
as $$
begin
  if auth.uid() is not null then
    raise exception 'claim_email_outbox_batch es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    update restaurantes.messaging_outbox
    set status = 'processing', attempts = attempts + 1
    where id in (
      select id from restaurantes.messaging_outbox
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

create or replace function restaurantes.complete_email_outbox_job(
  p_id uuid,
  p_status text,
  p_error text default null
) returns void
language plpgsql
security definer
set search_path = restaurantes
as $$
begin
  if auth.uid() is not null then
    raise exception 'complete_email_outbox_job es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_status not in ('sent', 'failed', 'dead') then
    raise exception 'invalid email outbox completion status: %', p_status;
  end if;
  update restaurantes.messaging_outbox
  set status = p_status, last_error_class = left(p_error, 120)
  where id = p_id and channel = 'email';
end;
$$;

grant execute on function restaurantes.enqueue_messaging_outbox(uuid, text, text, text, jsonb) to authenticated;
grant execute on function restaurantes.claim_email_outbox_batch(integer) to authenticated;
grant execute on function restaurantes.complete_email_outbox_job(uuid, text, text) to authenticated;

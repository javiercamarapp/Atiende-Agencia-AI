-- Mismo hallazgo/mismo criterio que
-- `packages/domain-citas/migrations/014_email_outbox_authenticated_grants.sql`
-- (leer ese header primero para el diagnóstico completo): `despachos.
-- enqueue_messaging_outbox`/`claim_email_outbox_batch`/`complete_email_outbox_job`
-- (migración 005) y `despachos.organization_notification_recipients` (misma
-- migración 005) son `security definer` pero el GRANT EXECUTE solo se le dio a
-- `service_role` -- un rol que este monorepo nunca aprovisiona contra Postgres real
-- (`withAppSession` siempre conecta como `authenticated`, ver comentario de
-- `managed-postgres-engine.ts`). Contra Postgres real, TODAS fallan con "permission
-- denied for function..." sin importar quién llame.
--
-- Verificado con `grep -rn` sobre `apps/api/src/routes/verticals/despachos/` antes
-- de decidir la verificación interna de cada una (nunca abrir un GRANT EXECUTE
-- plano a `authenticated` sin reponer la autorización que la RLS bypasseada habría
-- exigido):
--   - `claim_email_outbox_batch`/`complete_email_outbox_job`: SOLO se llaman desde
--     `notifications.ts`, dentro de `deps.engine.withAppSession({ userId: null })`
--     -- nunca desde una ruta de staff. Verificación: solo sesión de sistema.
--   - `enqueue_messaging_outbox`/`organization_notification_recipients`: se llaman
--     TANTO desde la sesión de sistema (`notifications.ts`, cobranza) COMO desde
--     `vencimientos.ts::POST .../:deadlineId/escalar`, una ruta de staff YA
--     autenticado (`requirePropertyMembership("propertyId")` + `c.get("db")` real)
--     -- el `organization_id` que llega ahí es el de la property ya verificada por
--     esa membership (`repo.findDeadline(propertyId, ...)` -> `deadline.
--     organizationId`), así que la verificación interna correcta es "sesión de
--     sistema (auth.uid() is null) O staff con membership real de esa
--     organización" -- mismo invariante que `core.has_property_access` ya aplica en
--     el resto del esquema, reforzado aquí como autoridad real (nunca confiado solo
--     desde la ruta HTTP).

create or replace function despachos.enqueue_messaging_outbox(
  p_organization_id uuid, p_channel text, p_event_type text,
  p_dedupe_key text, p_payload jsonb
) returns uuid language plpgsql security definer set search_path = despachos as $$
declare v_id uuid;
begin
  if auth.uid() is not null and not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id and m.user_id = auth.uid()
  ) then
    raise exception 'sin acceso a esta organización' using errcode = '42501';
  end if;

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

create or replace function despachos.claim_email_outbox_batch(p_limit integer default 25)
returns setof despachos.messaging_outbox
language plpgsql security definer set search_path = despachos as $$
begin
  if auth.uid() is not null then
    raise exception 'claim_email_outbox_batch es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
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
end;
$$;

create or replace function despachos.complete_email_outbox_job(
  p_id uuid, p_status text, p_error text default null
) returns void language plpgsql security definer set search_path = despachos as $$
begin
  if auth.uid() is not null then
    raise exception 'complete_email_outbox_job es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_status not in ('sent', 'failed', 'dead') then
    raise exception 'invalid email outbox completion status: %', p_status;
  end if;
  update despachos.messaging_outbox
  set status = p_status, last_error = left(p_error, 500)
  where id = p_id and channel = 'email';
end;
$$;

create or replace function despachos.organization_notification_recipients(p_organization_id uuid)
returns table(email text, full_name text)
language plpgsql stable security definer set search_path = core as $$
begin
  if auth.uid() is not null and not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id and m.user_id = auth.uid()
  ) then
    raise exception 'sin acceso a esta organización' using errcode = '42501';
  end if;

  return query
    select su.email, su.full_name
    from core.membership m
    join core.staff_user su on su.id = m.user_id
    where m.organization_id = p_organization_id
      and m.platform_role in ('owner', 'admin')
    order by su.email asc;
end;
$$;

grant execute on function despachos.enqueue_messaging_outbox(uuid, text, text, text, jsonb) to authenticated;
grant execute on function despachos.claim_email_outbox_batch(integer) to authenticated;
grant execute on function despachos.complete_email_outbox_job(uuid, text, text) to authenticated;
grant execute on function despachos.organization_notification_recipients(uuid) to authenticated;

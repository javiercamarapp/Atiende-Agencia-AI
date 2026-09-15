-- Hallazgo de auditoría (severidad CRÍTICA, "la sesión de sistema nunca es
-- service_role real"): `packages/db/src/managed-postgres-engine.ts::withAppSession`
-- SIEMPRE abre la conexión con `set local role authenticated` (con o sin
-- `auth.uid()` real vía `request.jwt.claim.sub`) -- este monorepo NUNCA aprovisiona
-- un rol `service_role` real contra Postgres (ver el comentario de cabecera de ese
-- archivo: "DELIBERADAMENTE sin superusuario... el rol de conexión... es el MISMO
-- rol de mínimo privilegio para `admin` y para `withAppSession`"). Verificado antes
-- de esta migración: `grep -rn "SUPABASE_SERVICE_ROLE_KEY" --include=*.ts .` no
-- encuentra NINGÚN archivo server-side que la lea (solo existe como placeholder en
-- `.env.example`, con un comentario que dice exactamente eso), y no hay ninguna
-- migración que haga `grant service_role to <rol de conexión>` -- no hay forma de
-- que `set local role authenticated` alguna vez actúe como `service_role` en este
-- repo tal como está. Mismo gap, misma decisión de diseño (funciones `security
-- definer` en vez de esperar infraestructura de conexión que no existe) que ya usa
-- `packages/domain-rentas/migrations/013_owner_portal_security_definer.sql` y
-- `packages/db/migrations/0002_staff_invite_schema.sql::core.accept_staff_invite`.
--
-- Efecto real del bug: `citas.enqueue_messaging_outbox`/`claim_email_outbox_batch`/
-- `complete_email_outbox_job` (migraciones 003 y 009) están `security definer` desde
-- que se crearon, pero el GRANT EXECUTE solo se le dio a `service_role` -- contra
-- Postgres real, CUALQUIER llamada desde `authenticated` (con o sin `auth.uid()`)
-- falla con "permission denied for function..." — el `security definer` nunca
-- ayuda si el caller ni siquiera puede invocar la función. Verificado con
-- `grep -rn "grant execute.*service_role" supabase/migrations/*.sql`: el mismo
-- patrón se repite en las 6 verticales (hoteles/citas/restaurantes/despachos/
-- licitaciones/rentas) -- esta migración resuelve las 3 de citas.
--
-- Estas 3 funciones NO se llaman todas de la misma manera (verificado con
-- `grep -rn` sobre `apps/api/src`, antes de decidir qué verificación interna
-- agregar a cada una -- nunca abrir un GRANT EXECUTE plano a `authenticated` sin
-- reponer la autorización que la policy de RLS bypasseada habría exigido):
--   - `claim_email_outbox_batch`/`complete_email_outbox_job`: SOLO se llaman desde
--     `apps/api/src/routes/verticals/citas/email-dispatch.ts`, SIEMPRE dentro de
--     `deps.engine.withAppSession({ userId: null })` (la sesión de sistema, sin
--     `auth.uid()` real) -- nunca desde una ruta de staff autenticado. La
--     verificación interna correcta es "solo la sesión de sistema" (mismo criterio
--     ya establecido por `auth.uid() is null` en las policies de
--     `hoteles.night_audit_run`, migración 008 de hoteles).
--   - `enqueue_messaging_outbox`: se llama TANTO desde la sesión de sistema (el
--     booking público de citas, `POST /citas/.../appointments` sin sesión de staff,
--     `appointments.ts` línea ~89) COMO desde rutas de staff YA autenticado
--     (`appointments-lifecycle.ts`, `cancel-from-panel`/`confirm-from-panel`/
--     `complete-from-panel`/`no-show-from-panel`, todas con `c.get("db")` real) --
--     la verificación interna debe permitir la sesión de sistema (`auth.uid() is
--     null`) O un staff con membership real de la organización a la que está
--     encolando (mismo invariante que ya exige `core.membership` en el resto de
--     policies de este esquema -- nunca confiar en que la ruta HTTP ya lo validó).

create or replace function citas.enqueue_messaging_outbox(
  p_organization_id uuid, p_channel text, p_event_type text,
  p_dedupe_key text, p_payload jsonb
) returns uuid language plpgsql security definer set search_path = citas as $$
declare v_id uuid;
begin
  if auth.uid() is not null and not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id and m.user_id = auth.uid()
  ) then
    raise exception 'sin acceso a esta organización' using errcode = '42501';
  end if;

  if p_channel not in ('whatsapp', 'email') then raise exception 'invalid outbox channel'; end if;
  insert into citas.messaging_outbox(organization_id, channel, event_type, dedupe_key, payload)
  values (p_organization_id, p_channel, p_event_type, p_dedupe_key, p_payload)
  on conflict (organization_id, channel, dedupe_key) do update
    set payload = excluded.payload, event_type = excluded.event_type
    where messaging_outbox.status in ('pending', 'failed');
  select id into v_id from citas.messaging_outbox
    where organization_id = p_organization_id and channel = p_channel and dedupe_key = p_dedupe_key;
  return v_id;
end; $$;

create or replace function citas.claim_email_outbox_batch(p_limit integer default 25)
returns setof citas.messaging_outbox
language plpgsql
security definer
set search_path = citas
as $$
begin
  if auth.uid() is not null then
    raise exception 'claim_email_outbox_batch es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    update citas.messaging_outbox
    set status = 'processing', attempts = attempts + 1
    where id in (
      select id from citas.messaging_outbox
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

create or replace function citas.complete_email_outbox_job(
  p_id uuid,
  p_status text,
  p_error text default null
) returns void
language plpgsql
security definer
set search_path = citas
as $$
begin
  if auth.uid() is not null then
    raise exception 'complete_email_outbox_job es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_status not in ('sent', 'failed', 'dead') then
    raise exception 'invalid email outbox completion status: %', p_status;
  end if;
  update citas.messaging_outbox
  set status = p_status, last_error = left(p_error, 500)
  where id = p_id and channel = 'email';
end;
$$;

-- El GRANT a `service_role` se conserva (sin efecto hoy, ver comentario de cabecera
-- de `managed-postgres-engine.ts`) por si una fase futura aprovisiona ese rol real
-- contra Postgres -- no hace daño mantenerlo, y evita otra migración de limpieza si
-- eso llega a pasar.
grant execute on function citas.enqueue_messaging_outbox(uuid, text, text, text, jsonb) to authenticated;
grant execute on function citas.claim_email_outbox_batch(integer) to authenticated;
grant execute on function citas.complete_email_outbox_job(uuid, text, text) to authenticated;

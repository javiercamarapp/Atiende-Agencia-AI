-- Hallazgo de auditoría (severidad CRÍTICA, inventario "flujos de sistema
-- bloqueados en escritura" -- ver PR de flujos-de-sistema-escrituras): el PR
-- #141 (`...000136_0015_core_rls_sesion_sistema.sql`) ya arregló que la sesión
-- de sistema (`packages/db/src/managed-postgres-engine.ts::withAppSession({
-- userId: null })`, `set local role authenticated` + `auth.uid()` SIEMPRE
-- NULL) pudiera LEER `core.organization`/`core.property` -- eso desbloqueó
-- `LicitacionesRepository.listActiveOrganizations()` (el cron ahora SÍ
-- enumera organizaciones). Pero dejó señalado, sin arreglar, que las
-- ESCRITURAS posteriores de los 3 crons reales de licitaciones
-- (`apps/worker/src/jobs/licitaciones/discover-tenders.ts`,
-- `deadline-reminders.ts`, invocados por
-- `apps/api/src/routes/verticals/licitaciones/discover.ts`, ambos bajo
-- `deps.engine.withAppSession({ userId: null })`) siguen gobernadas por
-- policies de `licitaciones.can_write_org(_organization_id)`
-- (`...000016_002_compliance_and_package.sql`), que exige
-- `core.membership.user_id = auth.uid()` -- SIEMPRE `false` bajo sesión de
-- sistema, sin importar el GRANT de tabla (ya correcto: `insert, update` a
-- `authenticated` desde la misma migración 002).
--
-- Verificado leyendo la cadena de llamadas TypeScript real (nunca por
-- adivinanza) + contra Postgres real (`scripts/verify-flujos-sistema/`, ver su
-- README):
--   * `discover-tenders.ts::runDiscoverTendersForOrganization` ->
--     `repo.ingestTendersFromSource()` (postgres-repository.ts) -> `insert
--     into licitaciones.tender (...) on conflict (...) do update ...` --
--     bloqueado por "escritura: roles de escritura crean/actualizan
--     convocatorias" (`licitaciones.tender` INSERT/UPDATE, migración 002).
--   * el mismo método -> `repo.recordSourceRun()` -> `insert into
--     licitaciones.source_run (...)` -- bloqueado por "escritura: roles de
--     escritura registran corridas de ingesta" (`licitaciones.source_run`
--     INSERT, migración 010).
--   * `deadline-reminders.ts::runDeadlineReminderSweep` ->
--     `repo.scanUpcomingDeadlineReminders()` -> (a) `select ... from
--     licitaciones.tender where ...` -- bloqueado por "org ve sus
--     convocatorias" (`licitaciones.tender` SELECT, migración 002, NUNCA
--     redefinida con escape hatch -- a diferencia de `core.organization`/
--     `core.property`, este SELECT sigue devolviendo CERO filas SIEMPRE bajo
--     sesión de sistema, en silencio, el MISMO síntoma que motivó el PR #141);
--     (b) `insert into licitaciones.tender_deadline_reminder (...) on
--     conflict (...) do nothing` -- bloqueado por "escritura: roles de
--     escritura registran recordatorios de vencimiento"
--     (`licitaciones.tender_deadline_reminder` INSERT, migración 017).
--
-- Impacto de producto: el cron diario de descubrimiento
-- (`compras_mx_historico`) descubre convocatorias reales pero NUNCA las
-- guarda (ni la corrida se deja registrada); el cron de recordatorios de
-- plazo NUNCA encuentra ninguna convocatoria próxima a vencer (0 filas en
-- silencio) así que NUNCA crea un recordatorio -- ambos crons corren "ok" en
-- apariencia (200, sin excepción) sin producir ningún efecto real.
--
-- Decisión de diseño (misma regla que el PR #141, aplicada aquí): la
-- alternativa (A) -- escape hatch `auth.uid() is null or <regla actual>`
-- directo en las 3 policies -- se descarta para licitaciones. A diferencia de
-- `core.organization`/`core.property` (catálogo de plataforma sin PII,
-- compartido por las 6 verticales, con 3 precedentes previos de este mismo
-- patrón), `licitaciones.tender` es información de NEGOCIO propia del tenant
-- (convocatorias, `budget_amount`, `contracting_body` -- inteligencia
-- competitiva real de la organización) y licitaciones NO tiene ningún
-- precedente propio de escape hatch en policy -- el patrón YA establecido en
-- ESTA vertical para escritura de sistema es la función `security definer`
-- de solo-sistema (`...000089_020_email_outbox_authenticated_grants.sql`:
-- `enqueue_messaging_outbox`/`claim_email_outbox_batch`/
-- `complete_email_outbox_job`/`organization_notification_recipients`, las 4
-- con el guard `if auth.uid() is not null then raise ... using errcode =
-- '42501'`). Esta migración sigue exactamente ese mismo patrón (B) para las 4
-- escrituras/lectura de sistema que hacían falta, en vez de tocar ninguna
-- policy existente -- las policies de `can_access_org`/`can_write_org` para
-- staff autenticado NO se modifican ni un carácter.
--
-- Sin cambios de GRANT de tabla (ya eran correctos). Sin función nueva para
-- `listActiveOrganizations()` (ya resuelto por el PR #141, sin cambios aquí).
--
-- Orden de despliegue: esta migración debe aplicarse ANTES de desplegar el
-- código de `packages/domain-licitaciones/src/postgres-repository.ts` de este
-- mismo commit. Las 4 funciones son EXCLUSIVAS de los 2 crons (verificado:
-- `grep -rn` sobre `apps/api/src/routes` -- ningún caller de staff
-- autenticado invoca `ingestTendersFromSource`/`recordSourceRun`/
-- `scanUpcomingDeadlineReminders`), así que degradan de forma segura si el
-- código nuevo se desplegara ANTES que esta migración: la llamada fallaría
-- con "function licitaciones.system_... does not exist" en vez de con el
-- "permission denied"/"0 filas" de hoy -- el mismo try/catch por-conector
-- (`classifySourceFailure`) y por-organización que ya envuelve estas 2
-- llamadas hoy sigue capturando el error igual, así que el estado resultante
-- nunca es peor que el bug ya documentado aquí (ambos crons ya "no hacían
-- nada" en producción real).

-- ---------------------------------------------------------------------------
-- 1) Ingesta de convocatorias descubiertas por conector automático (NUNCA
--    "manual" -- ese camino sigue siendo `upsertTenderManual()`, con
--    `created_by` no nulo, sin cambios). Mismo upsert exacto que el código
--    actual: (organization_id, source, external_id) parcial cuando
--    external_id no es null.
-- ---------------------------------------------------------------------------
create or replace function licitaciones.system_ingest_tender(
  p_organization_id uuid,
  p_title text,
  p_submission_deadline timestamptz,
  p_source text,
  p_external_id text,
  p_contracting_body text,
  p_cpv_codes text[],
  p_budget_amount numeric,
  p_currency text,
  p_state text,
  p_procedure_type_raw text
)
returns table (
  out_id uuid,
  out_organization_id uuid,
  out_title text,
  out_submission_deadline text,
  out_updated_at text,
  out_source text,
  out_external_id text,
  out_contracting_body text,
  out_cpv_codes text[],
  out_budget_amount text,
  out_currency text,
  out_state text,
  out_procedure_type_raw text,
  out_status text,
  out_inserted boolean
)
language plpgsql security definer set search_path = licitaciones as $$
begin
  if auth.uid() is not null then
    raise exception 'system_ingest_tender es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_source = 'manual' then
    raise exception 'system_ingest_tender: "source" no puede ser "manual" -- ese camino de escritura es upsertTenderManual(), nunca este.';
  end if;

  return query
    insert into licitaciones.tender
      (organization_id, title, submission_deadline, source, external_id, contracting_body, cpv_codes, budget_amount, currency, state, procedure_type_raw, created_by)
    values
      (p_organization_id, p_title, p_submission_deadline, p_source, p_external_id, p_contracting_body, p_cpv_codes, p_budget_amount, p_currency, p_state, p_procedure_type_raw, null)
    on conflict (organization_id, source, external_id) where external_id is not null
    do update set
      title = excluded.title,
      submission_deadline = excluded.submission_deadline,
      contracting_body = excluded.contracting_body,
      cpv_codes = excluded.cpv_codes,
      budget_amount = excluded.budget_amount,
      currency = excluded.currency,
      state = excluded.state,
      procedure_type_raw = excluded.procedure_type_raw,
      updated_at = now()
    returning
      id, organization_id, title, submission_deadline::text, updated_at::text,
      source, external_id, contracting_body, cpv_codes, budget_amount::text,
      currency, state, procedure_type_raw, status, (xmax = 0);
end;
$$;

revoke execute on function licitaciones.system_ingest_tender(uuid, text, timestamptz, text, text, text, text[], numeric, text, text, text) from public;
grant execute on function licitaciones.system_ingest_tender(uuid, text, timestamptz, text, text, text, text[], numeric, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Registro de corrida de ingesta (`licitaciones.source_run`) -- mismo
--    insert exacto que el código actual, sin `on conflict` (siempre inserta
--    una fila nueva por corrida).
-- ---------------------------------------------------------------------------
create or replace function licitaciones.system_record_source_run(
  p_organization_id uuid,
  p_source text,
  p_state text,
  p_started_at timestamptz,
  p_finished_at timestamptz,
  p_http_status integer,
  p_response_hash text,
  p_message text,
  p_coverage_expected integer,
  p_coverage_obtained integer,
  p_correlation_id text
)
returns table (out_id uuid, out_created_at text)
language plpgsql security definer set search_path = licitaciones as $$
begin
  if auth.uid() is not null then
    raise exception 'system_record_source_run es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    insert into licitaciones.source_run
      (organization_id, source, state, started_at, finished_at, http_status, response_hash, message, coverage_expected, coverage_obtained, correlation_id)
    values
      (p_organization_id, p_source, p_state, p_started_at, p_finished_at, p_http_status, p_response_hash, p_message, p_coverage_expected, p_coverage_obtained, p_correlation_id)
    returning id, created_at::text;
end;
$$;

revoke execute on function licitaciones.system_record_source_run(uuid, text, text, timestamptz, timestamptz, integer, text, text, integer, integer, text) from public;
grant execute on function licitaciones.system_record_source_run(uuid, text, text, timestamptz, timestamptz, integer, text, text, integer, integer, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Lectura de convocatorias con plazo próximo a vencer -- mismo SELECT
--    exacto que `scanUpcomingDeadlineReminders` ejecuta hoy contra
--    `licitaciones.tender` (bloqueado en silencio, 0 filas siempre, nunca un
--    error -- el mismo síntoma exacto que motivó el PR #141 para
--    `core.organization`/`core.property`).
-- ---------------------------------------------------------------------------
create or replace function licitaciones.system_list_tenders_with_upcoming_deadline(
  p_organization_id uuid,
  p_now timestamptz,
  p_window_end timestamptz
)
returns table (out_id uuid, out_title text, out_submission_deadline text)
language plpgsql security definer set search_path = licitaciones as $$
begin
  if auth.uid() is not null then
    raise exception 'system_list_tenders_with_upcoming_deadline es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    select t.id, t.title, t.submission_deadline::text
    from licitaciones.tender t
    where t.organization_id = p_organization_id
      and t.submission_deadline is not null
      and t.submission_deadline > p_now
      and t.submission_deadline <= p_window_end
      and t.status not in ('cancelled', 'lost', 'won', 'submitted')
    order by t.submission_deadline asc;
end;
$$;

revoke execute on function licitaciones.system_list_tenders_with_upcoming_deadline(uuid, timestamptz, timestamptz) from public;
grant execute on function licitaciones.system_list_tenders_with_upcoming_deadline(uuid, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Registro de recordatorio de vencimiento -- mismo insert exacto (dedupe
--    real por `on conflict (tender_id, deadline_date) do nothing`, igual que
--    el código actual).
-- ---------------------------------------------------------------------------
create or replace function licitaciones.system_record_deadline_reminder(
  p_organization_id uuid,
  p_tender_id uuid,
  p_submission_deadline timestamptz,
  p_deadline_date date,
  p_days_remaining integer,
  p_message text
)
returns table (out_id uuid, out_created_at text)
language plpgsql security definer set search_path = licitaciones as $$
begin
  if auth.uid() is not null then
    raise exception 'system_record_deadline_reminder es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    insert into licitaciones.tender_deadline_reminder
      (organization_id, tender_id, submission_deadline, deadline_date, days_remaining, message)
    values
      (p_organization_id, p_tender_id, p_submission_deadline, p_deadline_date, p_days_remaining, p_message)
    on conflict (tender_id, deadline_date) do nothing
    returning id, created_at::text;
end;
$$;

revoke execute on function licitaciones.system_record_deadline_reminder(uuid, uuid, timestamptz, date, integer, text) from public;
grant execute on function licitaciones.system_record_deadline_reminder(uuid, uuid, timestamptz, date, integer, text) to authenticated;

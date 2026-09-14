-- Fase 6 hoteles (REQ-REV-013, H15-018/H16-003/H07-032) — night audit propio,
-- independiente del PMS del hotel. Port ~conceptual (adaptado al esquema real de
-- atiende-fusion: `organization_id`/`property_id`, no `tenant_id`/`hotel_id`) de:
--   - hoteles/packages/db/migrations/0031_night_audit.sql (tabla + claim/finish)
--   - hoteles/packages/db/migrations/0063_night_audit_valida_actor_y_no_reabre.sql
--     (guardas de actor/no-reapertura)
--
-- Requiere: 001_hoteles_schema.sql ya aplicada (hoteles.folio, hoteles.charge,
-- hoteles.payment, hoteles.reservation, hoteles.can_access_money()).
--
-- A diferencia del origen, esta migración NO agrega funciones PL/pgSQL
-- SECURITY DEFINER (`night_audit_claim`/`night_audit_finish`) para el advisory lock:
-- ninguna otra migración de domain-hoteles en atiende-fusion usa ese patrón (fraude,
-- CFDI, Fase 1-5 resuelven idempotencia con `insert ... on conflict do nothing
-- returning` desde @atiende/domain-hoteles/postgres-repository.ts, ver
-- `recordFraudAlert`/`insertCfdiEmision`). El índice único `(property_id,
-- business_date)` de abajo logra la MISMA garantía (una sola corrida gana la
-- inserción, la carrera se resuelve en la base, no en la aplicación) sin introducir
-- un mecanismo nuevo -- ver `PostgresHotelesRepository.claimNightAuditRun/
-- finishNightAuditRun` para el detalle. Las guardas de "no reabrir una corrida ya
-- completada" (0063) sí se portan, como parte del propio `update ... where status =
-- 'en_progreso'` de `finishNightAuditRun` (mismo efecto, sin una función aparte).
--
-- Sin tabla/columna nueva para no-shows: ese mecanismo (REQ-RES-008) ya existe desde
-- Fase 3 (`hoteles.reservation.status`, transición 'confirmada'->'no_show') y su
-- idempotencia ya la garantiza el reclamo atómico de esa transición
-- (`transitionReservation`, `where status = any(fromStatuses)`) -- night-audit lo
-- REUTILIZA (`apps/worker/src/jobs/hoteles/no-show.ts::runNoShowSweep`), no le hace
-- falta una guarda de esquema nueva.

-- ---------------------------------------------------------------------------
-- Corrida de night-audit — una por (property_id, business_date), nunca dos (índice
-- único, ver comentario de cabecera). `summary` guarda el mismo shape que
-- `@atiende/domain-hoteles::NightAuditSummary` (night-audit/engine.ts).
-- ---------------------------------------------------------------------------
create table hoteles.night_audit_run (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  business_date date not null,
  status text not null default 'en_progreso' check (status in ('en_progreso', 'completado')),
  summary jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (property_id, business_date),
  constraint night_audit_run_completion_consistency check (
    (status = 'en_progreso' and completed_at is null)
    or (status = 'completado' and completed_at is not null)
  )
);
create index night_audit_run_property_idx on hoteles.night_audit_run (organization_id, property_id, business_date desc);

alter table hoteles.night_audit_run enable row level security;

-- Mismos roles que pueden disparar/consultar el cierre manual (NIGHT_AUDIT_ROLES:
-- owner/gm/accountant, domain-hoteles/src/roles.ts) -- dinero/conciliación, mismo
-- criterio que fraude/CFDI de Fase 5.
create policy "dinero: staff con acceso ve corridas de night audit" on hoteles.night_audit_run for select
  using (hoteles.can_access_money(property_id));
-- INSERT/UPDATE reales los hace `@atiende/domain-hoteles::PostgresHotelesRepository`
-- (claimNightAuditRun/finishNightAuditRun), invocado tanto desde la ruta interna
-- gateada por secreto (sesión de sistema, `authenticated` sin `auth.uid()`) como desde
-- la ruta manual autenticada -- ambas necesitan poder escribir, así que la policy no
-- puede exigir `can_access_money` (que depende de `auth.uid()`, null en la sesión de
-- sistema) sin dejar la ruta de barrido sin poder escribir nunca; se documenta como
-- el mismo gap ya aceptado por `citasRepo.listActiveOrganizations()` bajo
-- `withAppSession({ userId: null })` (ver apps/api/src/routes/verticals/citas/
-- reminders.ts) -- ninguna vertical de fusion resuelve todavía un rol
-- `service_role`-like para jobs de sistema con RLS real.
create policy "sistema o dinero: escribe corridas de night audit" on hoteles.night_audit_run for insert
  with check (auth.uid() is null or hoteles.can_access_money(property_id));
create policy "sistema o dinero: actualiza corridas de night audit" on hoteles.night_audit_run for update
  using (auth.uid() is null or hoteles.can_access_money(property_id))
  with check (auth.uid() is null or hoteles.can_access_money(property_id));

revoke all on hoteles.night_audit_run from public, anon;
grant select, insert, update on hoteles.night_audit_run to authenticated;
grant select, insert, update, delete on hoteles.night_audit_run to service_role;

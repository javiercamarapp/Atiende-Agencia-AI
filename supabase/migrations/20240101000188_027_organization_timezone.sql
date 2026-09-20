-- FASE 3 (producto) — zona horaria por negocio, parte 4/4 (licitaciones). Las
-- otras 3 partes (citas+rentas, hoteles, despachos+restaurantes) se
-- construyen en ramas paralelas -- esta migración es EXCLUSIVA de
-- domain-licitaciones (nunca toca `connector-registry.ts` ni los conectores
-- OCDS, área cerrada del PR #193).
--
-- `@atiende/core-tenancy::resolverZonaHorariaNegocio` (fecha-negocio.ts) ya
-- es el ÚNICO punto de esta decisión -- ver su comentario de cabecera: hoy
-- SOLO `citas`/`rentas` guardan una zona horaria real por property/
-- organización; licitaciones cae siempre al default de plataforma
-- (`America/Mexico_City`). Licitaciones maneja plazos LEGALES (deadline de
-- propuestas, plazos de impugnación) donde un error de zona horaria tiene
-- consecuencias reales de negocio (perder un plazo) -- de las 5 verticales,
-- es la que tiene MÁS literales `'America/Mexico_City'` hardcodeados
-- (`packages/domain-licitaciones/src/{connectors/ocds/map-cdmx-csv-row.ts,
-- dates.ts,requirement-matrix.ts,types.ts}`).
--
-- AUDITORÍA de `dates.ts`/`requirement-matrix.ts` (mandato explícito de esta
-- fase) -- NINGUNO de los dos se conecta a esta columna, a propósito:
--   * `requirement-matrix.ts::extractDeadline`/`buildMexicoCityIso` fija a
--     America/Mexico_City -06:00 una fecha límite ya declarada TEXTUALMENTE
--     por la CONVOCANTE (el ente de gobierno que emite las bases/actas de la
--     licitación) -- p. ej. "a más tardar el 15 de octubre del 2026 a las
--     14:00 horas". Esa hora la fija QUIEN CONVOCA, no la organización que
--     licita -- una empresa de Tijuana que licita en un proceso federal
--     sigue leyendo "14:00 horas" como hora de CDMX (México eliminó el
--     horario de verano nacional desde 2022; sin franja fronteriza distinta
--     para licitaciones federales), exactamente igual que si la leyera desde
--     CDMX. Conectar esto a `resolverZonaHorariaNegocio(organización)`
--     cambiaría la INTERPRETACIÓN de un plazo legal ya fijo según quién lo
--     lee -- eso SÍ sería el bug, no lo contrario.
--   * `dates.ts::dateOnlyToMexicoCityIso` tiene un único caller real
--     (`connectors/ocds/map-cdmx-csv-row.ts`, el conector CSV del portal de
--     Compras CDMX -- área de conectores OCDS, cerrada del PR #193): ancla
--     `propuestas_fecha` (columna sin hora del CSV) a America/Mexico_City
--     porque ES el portal de la Ciudad de México -- mismo razonamiento que
--     el punto anterior, un dato de la fuente gubernamental, no de la
--     organización que licita.
--   * `dates.ts::nowIso`/`resolveExpedienteAsOfIso` no calculan "hoy" en
--     absoluto (el primero es un instante UTC crudo para timestamps de
--     auditoría; el segundo deriva `asOfIso` de `tender.submissionDeadline`,
--     ya persistido) -- ninguno de los dos necesita zona horaria de negocio.
-- La conexión real de esta fase es la RESOLUCIÓN DE "HOY" para cálculos
-- propios de la organización (vigencia de tarifas aprobadas, vencimiento de
-- facturas de contrato, alertas de renovación) -- ver
-- `PostgresLicitacionesRepository.resolveOrganizationTimezoneForToday`
-- (postgres-repository.ts), que reemplaza los `hoyFechaNegocio()` pelones
-- (default de plataforma) que ya conectó el PR #171 (revisión r6).
--
-- CONSERVADOR A PROPÓSITO: ningún deadline legal YA PERSISTIDO (`licitaciones
-- .tender.submission_deadline`, `requirement_item.deadline`, etc., todos
-- calculados y comunicados con la zona vieja) se recalcula retroactivamente
-- al aplicar esta migración ni al desplegar este código -- el cambio aplica
-- SOLO hacia adelante, a partir del primer cálculo que corra después de que
-- una organización configure su `timezone` real (ver knownGaps del PR para
-- el detalle explícito de qué NO se toca).
--
-- Requiere: 0001_core_schema.sql (`core.organization`, `core.membership`).
-- Interno domain-licitaciones: 027 (siguiente libre, verificado con `ls`).

-- `licitaciones.tenant_config` — mismo rol exacto que `citas.tenant_config`/
-- `rentas.property_config`, pero MUCHO más angosto: licitaciones no tiene
-- (todavía) ningún otro campo de configuración de organización que modelar
-- (rubro/teléfono de aviso no aplican a este vertical) -- una sola columna
-- real. `timezone` NULLABLE a propósito (a diferencia del `not null default
-- 'America/Mexico_City'` de citas): NULL es el estado real de TODA
-- organización de licitaciones hoy (columna nueva, cero filas existentes) y
-- SIEMPRE se resuelve vía `resolverZonaHorariaNegocio` (nunca un default
-- hardcodeado en SQL ni en TS) -- ver `LicitacionesTenantConfigRecord`
-- (repository.ts) para el razonamiento completo.
create table licitaciones.tenant_config (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  timezone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table licitaciones.tenant_config enable row level security;

-- Lectura: cualquier staff real de la organización (mismo umbral que
-- `licitaciones.can_access_org` — ver justificación en 002_compliance_and_
-- package.sql) -- nunca PII, solo un identificador de zona horaria IANA.
create policy "org ve su tenant_config" on licitaciones.tenant_config for select
  using (licitaciones.can_access_org(organization_id));

-- Escritura (INSERT/UPDATE): MÁS ANGOSTO que `licitaciones.can_write_org`
-- (que incluye analyst/writer/reviewer) -- configurar la zona horaria de la
-- organización es una decisión de gobierno del negocio (afecta el cálculo de
-- TODOS los plazos/vigencias de la organización), no redacción de
-- expedientes -- mismo criterio exacto que `STAFF_INVITE_ROLES` en
-- roles.ts (owner/admin únicamente, ver admin-staff.ts). Se define
-- `can_manage_org_settings` como función reutilizable nueva (ningún helper
-- existente de este vertical modela este umbral) en vez de repetir el
-- `exists (...)` a mano -- mismo patrón `security definer` que
-- `can_access_org`/`can_write_org`/`can_decide_org`.
create or replace function licitaciones.can_manage_org_settings(_organization_id uuid)
returns boolean language sql stable security definer set search_path = core as $$
  select exists (
    select 1 from core.membership m
    where m.organization_id = _organization_id and m.user_id = auth.uid()
      and m.vertical_role in ('owner', 'admin')
  )
$$;

create policy "owner/admin edita tenant_config de su organización" on licitaciones.tenant_config for insert
  with check (licitaciones.can_manage_org_settings(organization_id));
create policy "owner/admin actualiza tenant_config de su organización" on licitaciones.tenant_config for update
  using (licitaciones.can_manage_org_settings(organization_id))
  with check (licitaciones.can_manage_org_settings(organization_id));

revoke all on licitaciones.tenant_config from public, anon;
grant select on licitaciones.tenant_config to authenticated;
-- GRANT a nivel COLUMNA (nunca la tabla completa): `PostgresLicitacionesRepository.
-- upsertTenantConfig` (postgres-repository.ts) solo escribe `organization_id`/
-- `timezone` en el INSERT y `timezone`/`updated_at` en el UPDATE -- `created_at`
-- nunca lo escribe el cliente (columna `default now()`, servidor).
grant insert (organization_id, timezone) on licitaciones.tenant_config to authenticated;
grant update (timezone, updated_at) on licitaciones.tenant_config to authenticated;
grant select, insert, update, delete on licitaciones.tenant_config to service_role;

-- Función `security definer` de SOLO-SISTEMA (guard `auth.uid() is not null ->
-- raise 42501`, mismo patrón EXACTO que `licitaciones.system_list_renewal_
-- candidate_contracts`/`system_record_renewal_alert`/`system_list_overdue_
-- contract_invoices` de la migración 025) -- el barrido de sistema
-- (`apps/worker/src/jobs/licitaciones/alert-notifications.ts::
-- runRenewalAlertSweep`/`runCollectionAlertSweep`, sesión `userId: null`) SÍ
-- necesita resolver el `timezone` real de la organización para
-- `systemScanRenewalAlerts`/`listOverdueContractInvoices` -- un SELECT directo
-- contra `licitaciones.tenant_config` bajo sesión de sistema NUNCA hace match
-- con la policy de SELECT de arriba (`can_access_org` exige `auth.uid()` real),
-- así que devolvería SIEMPRE 0 filas EN SILENCIO (RLS filtra, nunca lanza) --
-- una organización de sistema con `timezone` SÍ configurado calcularía "hoy"
-- mal en el barrido (bug real de negocio, nunca un error visible) sin esta
-- función. Justificación de seguridad: expone SOLO el identificador de zona
-- horaria (texto IANA, nunca PII ni datos de negocio) de UNA organización
-- puntual, nunca una lista ni un bypass general de RLS.
create or replace function licitaciones.system_get_organization_timezone(p_organization_id uuid)
returns text language plpgsql security definer set search_path = licitaciones as $$
declare
  v_timezone text;
begin
  if auth.uid() is not null then
    raise exception 'system_get_organization_timezone es solo para la sesión de sistema' using errcode = '42501';
  end if;

  select timezone into v_timezone from licitaciones.tenant_config where organization_id = p_organization_id;
  return v_timezone;
end;
$$;

revoke execute on function licitaciones.system_get_organization_timezone(uuid) from public;
grant execute on function licitaciones.system_get_organization_timezone(uuid) to authenticated;

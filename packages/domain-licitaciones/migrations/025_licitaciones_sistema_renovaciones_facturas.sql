-- Hallazgo de auditoría (severidad ALTA, inventario "flujos de sistema
-- bloqueados en escritura" -- ver `scripts/verify-flujos-sistema/README.md`,
-- sección "Pendiente para un segundo PR", punto 4): el barrido
-- `alert-notifications` (`apps/worker/src/jobs/licitaciones/alert-
-- notifications.ts::runAlertNotificationSweep`/`runRenewalAlertSweep`/
-- `runCollectionAlertSweep`, invocados bajo `deps.engine.withAppSession({
-- userId: null })`) ya despacha correo real de `tender_deadline_reminder`
-- (arreglado por `...000137_024_licitaciones_sistema_ingesta_escritura.sql`,
-- PR anterior) pero las otras 2 alertas de esa misma fase siguen bloqueadas,
-- mismo patrón `can_write_org`/`can_access_org` sin escape hatch ni función:
--   * `repo.scanRenewalAlerts` -> `select ... from licitaciones.contract
--     where organization_id = $1 ...` (`can_access_org`) + `insert into
--     licitaciones.renewal_alert (...) on conflict (...) do nothing`
--     (`can_write_org`) -- ambos bloqueados bajo sesión de sistema.
--   * `repo.listOverdueContractInvoices` -> `select ... from
--     licitaciones.contract_invoice i join licitaciones.contract c ...`
--     (`can_access_org` de `contract_invoice`) -- bloqueado.
--
-- Impacto de producto: el barrido de alertas de renovación/cobranza nunca
-- encuentra ningún contrato por vencer ni ninguna factura vencida -- corre
-- "ok" sin producir ningún efecto real, el mismo síntoma exacto que motivó
-- el PR #141 y el PR anterior de esta misma serie.
--
-- Complicación real (verificada leyendo la cadena de llamadas, nunca por
-- adivinanza) -- a diferencia de `listOverdueContractInvoices` (exclusiva del
-- barrido: `grep -rn` sobre `apps/api/src/routes/verticals/licitaciones/` no
-- encuentra ningún caller de staff autenticado), `scanRenewalAlerts` es
-- código GENUINAMENTE COMPARTIDO: `apps/api/src/routes/verticals/
-- licitaciones/renewalRadar.ts` (`POST .../renewals/scan`) lo invoca hoy bajo
-- sesión de staff autenticado real (`auth.uid()` real satisface
-- `can_access_org`/`can_write_org`, funciona hoy sin cambios). Convertir
-- `scanRenewalAlerts` directo en una función `security definer` de
-- SOLO-sistema lo habría roto para ese caller de staff. Por eso, para
-- `scanRenewalAlerts`, esta migración NO reemplaza ese método ni su cálculo
-- (`computeRenewalAlertCandidates`, puro TypeScript, YA probado -- nunca se
-- duplica en SQL, mismo criterio que el punto 4 de hoteles del reporte de
-- este PR) -- agrega 2 funciones `security definer` de solo-sistema NUEVAS,
-- exclusivas del barrido, que exponen SOLO el acceso a datos (leer contratos
-- candidatos / persistir una alerta ya calculada) que
-- `computeRenewalAlertCandidates` necesita alrededor; el commit de
-- TypeScript de esta vertical agrega `repo.systemScanRenewalAlerts` (nuevo
-- método de contrato, implementado con estas 2 funciones + la MISMA función
-- pura `computeRenewalAlertCandidates` ya usada por `scanRenewalAlerts`) y
-- cablea SOLO `apps/worker/src/jobs/licitaciones/alert-notifications.ts` a
-- usarlo -- `renewalRadar.ts` sigue llamando a `repo.scanRenewalAlerts` sin
-- cambios.
--
-- Decisión de diseño: funciones `security definer` de solo-sistema (guard
-- `auth.uid() is not null -> raise ... 42501`) -- NUNCA escape hatch de
-- policy, mismo criterio que `...000137_024_licitaciones_sistema_ingesta_
-- escritura.sql` (PR anterior): `licitaciones.contract`/`contract_invoice`/
-- `renewal_alert` son información de negocio propia del tenant (fechas de fin
-- de contrato, montos de facturación), sin precedente de escape hatch en esta
-- vertical.
--   1) `licitaciones.system_list_renewal_candidate_contracts(p_organization_id)`
--      -- mismo SELECT exacto que ya ejecuta `scanRenewalAlerts` contra
--      `licitaciones.contract` (candidatos con `end_date` conocida, excluye
--      `cerrado`/`rescindido`) -- el cómputo de qué umbral ya se cumplió
--      (`computeRenewalAlertCandidates`) se sigue haciendo en TypeScript,
--      fuera de esta función, sin cambios.
--   2) `licitaciones.system_record_renewal_alert(...)` -- mismo INSERT exacto
--      (`on conflict (organization_id, contract_id, lead_days) do nothing`,
--      el mismo índice único real ya existente de
--      `...000047_016_renewal_radar.sql:24` -- dedupe atómico real, a
--      diferencia del best-effort de despachos de esta misma serie, porque
--      aquí SÍ hay una restricción `unique` real que además NO afecta al
--      staff: `scanRenewalAlerts` (camino de staff, sin cambios) ya
--      confiaba en ese mismo `on conflict` antes de este commit).
--   3) `licitaciones.system_list_overdue_contract_invoices(p_organization_id,
--      p_today)` -- exclusiva del barrido (sin caller de staff, verificado) --
--      mismo SELECT exacto que `listOverdueContractInvoices`, sin cambio de
--      contrato TypeScript (se sustituye directo dentro de
--      `PostgresLicitacionesRepository.listOverdueContractInvoices`, mismo
--      patrón que `scanUpcomingDeadlineReminders` en el PR anterior).
--
-- Orden de despliegue: esta migración debe aplicarse ANTES de desplegar el
-- código de `packages/domain-licitaciones/src/postgres-repository.ts`/
-- `apps/worker/src/jobs/licitaciones/alert-notifications.ts` de este mismo
-- commit. Las 3 funciones son exclusivas del barrido de sistema (verificado:
-- `grep -rn` sobre `apps/api/src/routes/verticals/licitaciones/` -- ningún
-- caller de staff autenticado invoca `system_list_renewal_candidate_
-- contracts`/`system_record_renewal_alert`/`system_list_overdue_contract_
-- invoices`), así que degradan de forma segura si el código nuevo se
-- desplegara ANTES que esta migración: la llamada fallaría con "function
-- licitaciones.system_... does not exist" en vez del "0 filas"/"permission
-- denied" de hoy -- el mismo `try/catch` por-organización que ya envuelve
-- `runRenewalAlertSweep`/`runCollectionAlertSweep` sigue capturando el error
-- igual, así que el estado resultante nunca es peor que el bug ya
-- documentado aquí.

-- ---------------------------------------------------------------------------
-- 1) Contratos candidatos a alerta de renovación -- mismo SELECT exacto que
--    ya ejecuta `scanRenewalAlerts` (postgres-repository.ts).
-- ---------------------------------------------------------------------------
create or replace function licitaciones.system_list_renewal_candidate_contracts(p_organization_id uuid)
returns table (out_contract_id uuid, out_tender_id uuid, out_end_date text)
language plpgsql security definer set search_path = licitaciones as $$
begin
  if auth.uid() is not null then
    raise exception 'system_list_renewal_candidate_contracts es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    select id, tender_id, end_date::text
    from licitaciones.contract
    where organization_id = p_organization_id and end_date is not null and status not in ('cerrado', 'rescindido');
end;
$$;

revoke execute on function licitaciones.system_list_renewal_candidate_contracts(uuid) from public;
grant execute on function licitaciones.system_list_renewal_candidate_contracts(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Persiste una alerta de renovación ya calculada por
--    `computeRenewalAlertCandidates` (TypeScript, puro, sin cambios) -- mismo
--    INSERT exacto, mismo `on conflict` real que ya usa `scanRenewalAlerts`.
-- ---------------------------------------------------------------------------
create or replace function licitaciones.system_record_renewal_alert(
  p_organization_id uuid,
  p_contract_id uuid,
  p_tender_id uuid,
  p_predicted_date date,
  p_lead_days integer,
  p_confidence numeric
)
returns table (
  out_id uuid, out_organization_id uuid, out_contract_id uuid, out_tender_id uuid,
  out_predicted_date text, out_lead_days integer, out_confidence text, out_status text,
  out_acknowledged_at text, out_acknowledged_by uuid, out_created_at text
)
language plpgsql security definer set search_path = licitaciones as $$
begin
  if auth.uid() is not null then
    raise exception 'system_record_renewal_alert es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    insert into licitaciones.renewal_alert (organization_id, contract_id, tender_id, predicted_date, lead_days, confidence)
    values (p_organization_id, p_contract_id, p_tender_id, p_predicted_date, p_lead_days, p_confidence)
    on conflict (organization_id, contract_id, lead_days) do nothing
    returning
      id, organization_id, contract_id, tender_id, predicted_date::text, lead_days, confidence::text,
      status, acknowledged_at::text, acknowledged_by, created_at::text;
end;
$$;

revoke execute on function licitaciones.system_record_renewal_alert(uuid, uuid, uuid, date, integer, numeric) from public;
grant execute on function licitaciones.system_record_renewal_alert(uuid, uuid, uuid, date, integer, numeric) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Facturas de contrato vencidas de la organización -- exclusiva del
--    barrido (sin caller de staff) -- mismo SELECT exacto que
--    `listOverdueContractInvoices`.
-- ---------------------------------------------------------------------------
create or replace function licitaciones.system_list_overdue_contract_invoices(p_organization_id uuid, p_today date)
returns table (
  out_id uuid, out_contract_id uuid, out_tender_id uuid, out_concepto text,
  out_amount text, out_due_date text, out_days_overdue integer
)
language plpgsql security definer set search_path = licitaciones as $$
begin
  if auth.uid() is not null then
    raise exception 'system_list_overdue_contract_invoices es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    select i.id, i.contract_id, c.tender_id, i.concepto, i.amount::text, i.due_date::text,
           (p_today - i.due_date)::int as days_overdue
    from licitaciones.contract_invoice i
    join licitaciones.contract c on c.id = i.contract_id
    where i.organization_id = p_organization_id and i.paid_at is null and i.due_date < p_today
    order by i.due_date asc;
end;
$$;

revoke execute on function licitaciones.system_list_overdue_contract_invoices(uuid, date) from public;
grant execute on function licitaciones.system_list_overdue_contract_invoices(uuid, date) to authenticated;

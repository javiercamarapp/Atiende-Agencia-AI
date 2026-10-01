-- Superadmin "CFO" -- SA-29 (P&L por vertical y por cliente): fuente de la INFRAESTRUCTURA
-- COMPARTIDA del mes (hosting, base de datos, observabilidad...) que el P&L prorratea entre
-- las organizaciones como parte del COGS. Es la unica fuente que faltaba: el ingreso sale de
-- core.billing_snapshot_monthly / core.plan (0030, 0028) y el costo de LLM, voz, WhatsApp,
-- telefonia y otros sale de core.llm_usage_daily / core.usage_cost_event (0010, 0028); la
-- lectura del P&L compone esas funciones ya existentes (core.get_cfo_dashboard_for_superadmin
-- y core.list_billing_snapshots_for_superadmin) y NO agrega ninguna lectura nueva sobre ellas.
--
--   A) core.infra_cost_monthly                    -- una fila por (mes, concepto), monto en
--                                                    centavos MXN enteros.
--   B) core.superadmin_set_infra_cost             -- captura/corrige un concepto del mes.
--   C) core.list_infra_costs_for_superadmin       -- lectura por rango de meses.
--   D) core.plan_audit_log: un evento nuevo (infra_set) en su CHECK, para que la captura
--                                                    quede en la bitacora append-only existente.
--
-- Requiere: 0001, 0012 (core.is_platform_superadmin), 0025 (core.superadmin_require_caller),
-- 0028 (core.plan_audit_log y core.plan_audit_write).
--
-- No cobra nada, no cambia planes ni topes y no toca Stripe: es una captura manual de un dato
-- contable del mes que alimenta un reporte de solo lectura.
--
-- Justificacion de seguridad (cada GRANT/policy/funcion trae su razon):
--   * core.infra_cost_monthly: RLS habilitado SIN policy y REVOKE ALL a public, anon y
--     authenticated. Razon: el costo de infraestructura de la plataforma es dato financiero
--     interno; ningun rol de la aplicacion lo lee ni lo escribe directo, solo las funciones
--     definer de abajo. Sin GRANT por columna porque no hay ninguna columna accesible por rol
--     alguno (las funciones corren como el dueño y escriben todas las columnas con valores
--     validados dentro de la funcion).
--   * core.superadmin_set_infra_cost: security definer con search_path fijo; REVOKE de public y
--     anon; GRANT EXECUTE solo a authenticated. Razon del GRANT a authenticated: el back office
--     entra con la sesion del superadmin (sin service_role). La puerta real esta DENTRO:
--     core.superadmin_require_caller exige auth.uid() = p_caller_id Y que ese usuario sea
--     superadmin de plataforma; un authenticated cualquiera recibe 42501.
--     Escritura sensible: la ruta del API exige step-up (MFA reciente).
--   * core.list_infra_costs_for_superadmin: security definer con search_path fijo; mismo
--     contrato de lectura que el resto de las *_for_superadmin: auth.uid() = p_caller_id y
--     core.is_platform_superadmin, si no CERO filas (nunca un error que confirme si hay datos).
--     REVOKE de public y anon; GRANT a authenticated por la misma razon de arriba.
--   * Un mes futuro se rechaza (22023): una captura adelantada movería el margen de un mes que
--     aun no ocurre. Los meses pasados SI se aceptan (cierre contable tardio).
--   * La bitacora core.plan_audit_log ya es append-only (trigger 0A000 aun para el dueño); aqui
--     solo se amplia el CHECK de `event` para admitir 'infra_set'.

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Costo de infraestructura compartida por mes
-- ═══════════════════════════════════════════════════════════════════════════
create table core.infra_cost_monthly (
  id uuid primary key default gen_random_uuid(),
  mes date not null check (mes = date_trunc('month', mes)::date),
  concepto text not null check (char_length(btrim(concepto)) between 2 and 80),
  -- Centavos MXN enteros, nunca float. 0 es un monto valido (corregir una captura equivocada).
  monto_mxn_centavos bigint not null check (monto_mxn_centavos >= 0 and monto_mxn_centavos <= 100000000000),
  nota text check (nota is null or char_length(nota) <= 300),
  updated_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Un concepto por mes, sin distinguir mayusculas ("Vercel" y "vercel" son el mismo).
create unique index infra_cost_monthly_mes_concepto_uidx on core.infra_cost_monthly (mes, lower(btrim(concepto)));
alter table core.infra_cost_monthly enable row level security;
revoke all on core.infra_cost_monthly from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- D) Bitacora: evento nuevo
-- ═══════════════════════════════════════════════════════════════════════════
alter table core.plan_audit_log drop constraint if exists plan_audit_log_event_check;
alter table core.plan_audit_log add constraint plan_audit_log_event_check check (event in (
  'fx_set', 'plan_upserted', 'plan_limit_set', 'plan_limit_deleted',
  'assignment_requested', 'assignment_executed', 'assignment_cancelled', 'assignment_expired',
  'infra_set'
));

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Captura (superadmin)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.superadmin_set_infra_cost(
  p_caller_id uuid, p_mes date, p_concepto text, p_monto_mxn_centavos bigint, p_nota text default null
)
returns void
language plpgsql security definer set search_path = core, pg_temp as $$
declare
  v_mes date;
  v_concepto text := btrim(coalesce(p_concepto, ''));
  v_nota text := nullif(btrim(coalesce(p_nota, '')), '');
begin
  perform core.superadmin_require_caller(p_caller_id, 'superadmin_set_infra_cost');
  if p_mes is null then
    raise exception 'superadmin_set_infra_cost: mes obligatorio' using errcode = '22023';
  end if;
  v_mes := date_trunc('month', p_mes)::date;
  if v_mes > date_trunc('month', current_date)::date then
    raise exception 'superadmin_set_infra_cost: el mes no puede ser futuro' using errcode = '22023';
  end if;
  if char_length(v_concepto) < 2 or char_length(v_concepto) > 80 then
    raise exception 'superadmin_set_infra_cost: concepto obligatorio (2-80 caracteres)' using errcode = '22023';
  end if;
  if p_monto_mxn_centavos is null or p_monto_mxn_centavos < 0 or p_monto_mxn_centavos > 100000000000 then
    raise exception 'superadmin_set_infra_cost: monto fuera de rango' using errcode = '22023';
  end if;
  if v_nota is not null and char_length(v_nota) > 300 then
    raise exception 'superadmin_set_infra_cost: nota de maximo 300 caracteres' using errcode = '22023';
  end if;
  insert into core.infra_cost_monthly (mes, concepto, monto_mxn_centavos, nota, updated_by)
  values (v_mes, v_concepto, p_monto_mxn_centavos, v_nota, p_caller_id)
  on conflict (mes, lower(btrim(concepto))) do update set
    concepto = excluded.concepto, monto_mxn_centavos = excluded.monto_mxn_centavos, nota = excluded.nota,
    updated_by = excluded.updated_by, updated_at = now();
  perform core.plan_audit_write('infra_set', p_caller_id, null, null,
    jsonb_build_object('mes', v_mes, 'concepto', v_concepto, 'monto_mxn_centavos', p_monto_mxn_centavos));
end;
$$;
revoke all on function core.superadmin_set_infra_cost(uuid, date, text, bigint, text) from public, anon;
grant execute on function core.superadmin_set_infra_cost(uuid, date, text, bigint, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Lectura (superadmin)
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.list_infra_costs_for_superadmin(p_caller_id uuid, p_desde date, p_hasta date)
returns table (mes date, concepto text, monto_mxn_centavos bigint, nota text, updated_at timestamptz)
language plpgsql stable security definer set search_path = core, pg_temp as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query
    select i.mes, i.concepto, i.monto_mxn_centavos, i.nota, i.updated_at
    from core.infra_cost_monthly i
    where i.mes >= date_trunc('month', p_desde)::date and i.mes <= date_trunc('month', p_hasta)::date
    order by i.mes, lower(i.concepto)
    limit 2000;
end;
$$;
revoke all on function core.list_infra_costs_for_superadmin(uuid, date, date) from public, anon;
grant execute on function core.list_infra_costs_for_superadmin(uuid, date, date) to authenticated;

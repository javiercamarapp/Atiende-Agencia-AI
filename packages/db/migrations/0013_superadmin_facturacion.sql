-- Back office de plataforma — pantalla de FACTURACIÓN de la suscripción SaaS
-- propia de Atiende (lo que Atiende le cobra a cada organización cliente,
-- `core.organization_billing`, ver `0009_billing_saas_schema.sql`). Ya existían
-- Dashboard/Prospectos/Paneles/Gasto de API/Integraciones/Break-glass — esta
-- migración agrega las funciones de LECTURA que le faltaban al "cerebro" de
-- backoffice para ver: estado de suscripción por organización, asientos
-- contratados vs. staff real (para reconciliación en TS, ver
-- `apps/api/src/routes/superadmin-facturacion.ts`), y los últimos eventos de
-- webhook de Stripe ya procesados (para diagnóstico).
--
-- MISMO patrón EXACTO que el resto del back office de plataforma (PRs
-- #127/#130/#132): funciones `security definer` con `p_caller_id uuid`
-- explícito, atadas a `auth.uid() is not null and auth.uid() = p_caller_id`
-- (nunca solo `is_platform_superadmin(p_caller_id)` a secas — ese fue
-- exactamente el hallazgo que `0011_superadmin_caller_binding.sql`/
-- `0012_caller_binding_fase2.sql` cerraron), `revoke all ... from public` +
-- `grant execute ... to authenticated`, cero filas para un caller no-superadmin
-- (nunca un error que confirme/niegue si hay datos — mismo criterio que
-- `core.list_all_organizations_for_superadmin`/`core.count_staff_by_
-- organization_for_superadmin`, que esta migración reutiliza el MISMO criterio
-- de conteo de staff para, no duplica esa lógica). El código TS (`apps/api/src/
-- production/core-repository.ts`) abre sesión COMO el caller (`withAppSession({
-- userId: callerId })`), nunca de sistema — mismo criterio ya establecido para
-- `listAllOrganizationsForSuperadmin`/`getOrganizationBillingForCheckout`.
--
-- LÍMITE HONESTO documentado aquí para que no se repita el hallazgo de "auditoría
-- se equivocó por inventar dato" ni el de "se equivocó por esconder límite real":
-- `core.billing_webhook_event` (`0009_billing_saas_schema.sql`) es SOLO un ledger
-- de dedupe (`event_id`, `processed_at`) -- nunca guardó `organization_id`, tipo de
-- evento, ni si un evento fue ACEPTADO o RECHAZADO (un webhook rechazado por
-- `verificarTenantDelWebhook` lanza 409 ANTES de llegar a `markBillingWebhookEventSeen`,
-- así que ni siquiera queda registrado). Extender esa captura exige tocar la lógica
-- de `POST /billing/webhook` en `apps/api/src/routes/billing.ts` -- explícitamente
-- fuera de alcance de esta tarea (solo se permite extraer la función compartida de
-- checkout, sin cambiar el comportamiento del webhook). Por eso
-- `list_recent_billing_webhook_events_for_superadmin` expone lo que SÍ existe: un
-- feed de PLATAFORMA (no por organización) de eventos ya aplicados con éxito, para
-- diagnóstico de "¿sigue vivo el webhook, cuándo fue el último evento real?" — la
-- pantalla lo etiqueta como tal, nunca finge que es un log por-organización ni que
-- incluye rechazados.
create or replace function core.list_organization_billing_for_superadmin(p_caller_id uuid)
returns table (
  organization_id uuid,
  vertical text,
  name text,
  slug text,
  org_status text,
  created_at timestamptz,
  billing_status text,
  seats integer,
  staff_count bigint,
  price_id text,
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  last_applied_event_unix bigint
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select
    o.id,
    o.vertical,
    o.name,
    o.slug,
    o.status,
    o.created_at,
    coalesce(b.status, 'sin_suscripcion'),
    coalesce(b.seats, 0),
    coalesce(sc.staff_count, 0),
    b.price_id,
    b.stripe_customer_id,
    b.stripe_subscription_id,
    b.current_period_end,
    eo.last_applied_created_unix
  from core.organization o
  left join core.organization_billing b on b.organization_id = o.id
  left join (
    select m.organization_id, count(*)::bigint as staff_count
    from core.membership m
    group by m.organization_id
  ) sc on sc.organization_id = o.id
  left join core.billing_entity_order eo on eo.entity_id = b.stripe_customer_id
  where auth.uid() is not null and auth.uid() = p_caller_id
    and core.is_platform_superadmin(p_caller_id)
  order by o.created_at desc;
$$;

revoke all on function core.list_organization_billing_for_superadmin(uuid) from public;
grant execute on function core.list_organization_billing_for_superadmin(uuid) to authenticated;

-- Feed de plataforma (ver el comentario de cabecera arriba para el límite real
-- de lo que `core.billing_webhook_event` guarda hoy) — últimos N eventos de
-- webhook ya aplicados con éxito, más recientes primero. `p_limit` se acota
-- entre 1 y 200 DENTRO de la función (nunca confía en que el caller mande un
-- valor sano) — mismo criterio defensivo que `core.list_notifications_for_staff`
-- acotando a 50 internamente.
create or replace function core.list_recent_billing_webhook_events_for_superadmin(p_caller_id uuid, p_limit integer)
returns table (event_id text, processed_at timestamptz)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select e.event_id, e.processed_at
  from core.billing_webhook_event e
  where auth.uid() is not null and auth.uid() = p_caller_id
    and core.is_platform_superadmin(p_caller_id)
  order by e.processed_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 200));
$$;

revoke all on function core.list_recent_billing_webhook_events_for_superadmin(uuid, integer) from public;
grant execute on function core.list_recent_billing_webhook_events_for_superadmin(uuid, integer) to authenticated;

-- Conteo TOTAL (no acotado por `p_limit`) — separado de la función de arriba a
-- propósito (mismo criterio que `core.get_llm_platform_budget_for_superadmin`
-- vs. `core.list_llm_usage_by_organization_for_superadmin`: un total agregado y
-- un listado acotado son 2 preguntas distintas, 2 funciones chicas en vez de
-- una con parámetros opcionales que cambian la forma del resultado).
create or replace function core.count_billing_webhook_events_for_superadmin(p_caller_id uuid)
returns bigint
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select count(*)::bigint
  from core.billing_webhook_event e
  where auth.uid() is not null and auth.uid() = p_caller_id
    and core.is_platform_superadmin(p_caller_id);
$$;

revoke all on function core.count_billing_webhook_events_for_superadmin(uuid) from public;
grant execute on function core.count_billing_webhook_events_for_superadmin(uuid) to authenticated;

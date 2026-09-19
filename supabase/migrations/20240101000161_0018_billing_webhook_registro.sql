-- Bitácora completa de webhooks de billing SaaS (Stripe) para el superadmin de
-- plataforma. Cierra el límite honesto documentado en el comentario de cabecera
-- de `0013_superadmin_facturacion.sql`: `core.billing_webhook_event` (creada en
-- `0009_billing_saas_schema.sql`) es SOLO el ledger de dedupe de
-- `@atiende/billing::aplicarConLedger` (`event_id`, `processed_at`) -- nunca
-- guardó organización, tipo de evento, ni si un evento fue ACEPTADO o
-- RECHAZADO, y un webhook rechazado (firma inválida, evento desconocido,
-- organización no resuelta, error al procesar) no queda registrado en ningún
-- lado. Eso hace imposible diagnosticar un cobro que no se reflejó sin leer
-- logs de la instancia. Esta migración agrega `core.billing_webhook_log`
-- (tabla NUEVA, separada del ledger -- ver el porqué abajo) + 1 función de
-- ESCRITURA (sesión de sistema) + 1 función de LECTURA (superadmin real) para
-- que `POST /billing/webhook` (`apps/api/src/routes/billing.ts`) registre
-- CADA intento, con o sin éxito.
--
-- POR QUÉ UNA TABLA NUEVA, NUNCA SE AMPLÍA `core.billing_webhook_event`: esa
-- tabla es la llave de dedupe atómico de `LedgerStore.marcarVisto`
-- (`insert ... on conflict (event_id) do nothing`, ver el comentario de
-- cabecera de `packages/billing/src/ledger.ts`) -- su PK es `event_id`, y un
-- evento RECHAZADO (firma inválida, JSON inválido, sin tenant_id resuelto)
-- muchas veces NO TIENE un id de evento real todavía (una firma inválida se
-- rechaza ANTES de intentar parsear el body -- ver `routes/billing.ts`), o
-- podría traer uno FALSEADO por un atacante que nunca tuvo el secreto -- si
-- ese id llegara a colisionar con el de un evento real futuro, insertarlo en
-- la tabla de dedupe lo "gastaría" y el reintento legítimo de Stripe de ESE
-- evento real quedaría descartado como duplicado. Nunca se toca la tabla de
-- dedupe para nada que no sea su propio propósito -- `billing_webhook_log` es
-- un log de AUDITORÍA aparte, sin relación de identidad con el ledger (puede
-- haber una fila de log por cada intento, exitoso o no, mientras que el
-- ledger solo existe para los que sí llegan a `markBillingWebhookEventSeen`).
--
-- QUÉ NUNCA GUARDA (mismo criterio "solo metadatos" que ya aplica
-- `hoteles.cfdi_emision`/`core.llm_usage_event` para datos de terceros): NUNCA
-- la cabecera `stripe-signature` cruda, NUNCA el payload crudo del webhook
-- (puede traer PII del customer -- email, nombre), NUNCA datos de tarjeta
-- (Stripe tampoco los manda en un webhook, pero se documenta explícito). Solo
-- id de evento (cuando existe), tipo de evento (string corto de Stripe, p.ej.
-- "customer.subscription.updated"), la organización YA RESUELTA (uuid,
-- nullable), resultado, motivo corto y estable, y el timestamp.
create table core.billing_webhook_log (
  id bigint generated always as identity primary key,
  provider_event_id text,
  event_type text,
  organization_id uuid references core.organization(id) on delete set null,
  result text not null check (result in ('procesado', 'ignorado', 'rechazado', 'error')),
  -- Enum corto y ESTABLE (nunca el mensaje libre de una excepción -- un texto
  -- libre no es filtrable/agregable de forma confiable y puede arrastrar
  -- detalle sensible sin querer). Los 4 primeros valores son literalmente
  -- `@atiende/billing::MotivoRechazo` (`tenant-verification.ts`) -- mismo
  -- vocabulario, sin traducir, para que el motivo real y el guardado sean
  -- idénticos de principio a fin.
  reason text not null check (reason in (
    'tenant_id_ausente', 'tenant_no_existe', 'customer_no_coincide', 'email_no_coincide',
    'firma_invalida', 'json_invalido', 'evento_no_reconocido',
    'duplicado', 'fuera_de_orden', 'aplicado', 'error_interno'
  )),
  created_at timestamptz not null default now()
);

-- `(result, created_at desc)` cubre TANTO el filtro de la pantalla (por
-- resultado) COMO la consulta de tope anti-inflado de `record_billing_webhook_
-- event` de abajo (cuenta filas 'rechazado' recientes) -- un solo índice para
-- las 2 lecturas, nunca uno redundante por separado.
create index billing_webhook_log_result_created_at_idx on core.billing_webhook_log (result, created_at desc);
create index billing_webhook_log_created_at_idx on core.billing_webhook_log (created_at desc);
create index billing_webhook_log_organization_id_idx on core.billing_webhook_log (organization_id) where organization_id is not null;
create index billing_webhook_log_event_type_idx on core.billing_webhook_log (event_type) where event_type is not null;

alter table core.billing_webhook_log enable row level security;
-- Sin policies directas -- mismo criterio que `core.billing_webhook_event`/
-- `core.organization_billing` (`0009_billing_saas_schema.sql`): TODO el acceso
-- pasa por las 2 funciones `security definer` de abajo.
revoke all on core.billing_webhook_log from public, anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- ESCRITURA — sesión de SISTEMA (`POST /billing/webhook` corre con
-- `engine.withAppSession({ userId: null }, ...)`, mismo patrón que
-- `getOrganizationBillingForWebhook`/`upsertOrganizationBilling`/
-- `markBillingWebhookEventSeen` de `0009_billing_saas_schema.sql`). MISMO
-- patrón EXACTO que `hoteles.apply_cfdi_webhook_status`
-- (`020_cfdi_webhook_status_security_definer.sql`): `security definer`, guard
-- explícito `auth.uid() is not null -> raise exception` (SOLO sesión de
-- sistema puede llamarla), `set search_path` fijo, y GRANT EXECUTE a
-- `authenticated` -- NUNCA solo a `service_role` (`withAppSession` siempre
-- conecta como `authenticated`, nunca como `service_role`; ver el historial de
-- 7 fixes de este bug exacto que documenta `017_rpc_anti_duplicado_
-- authenticated_grants.sql` en domain-restaurantes).
--
-- BEST-EFFORT por diseño: NUNCA lanza por un `result`/`reason` fuera de
-- catálogo silenciosamente aceptado -- SÍ valida (`raise exception` si el
-- caller de TypeScript tiene un bug), pero el propio `record_billing_webhook_
-- event` nunca es la causa de que el webhook responda distinto a como
-- respondería sin esta escritura: `apps/api/src/routes/billing.ts` la llama
-- SIEMPRE envuelta en su propio try/catch que nunca repropaga (ver el
-- comentario de cabecera de ese archivo) -- un webhook o cron existente jamás
-- debe empezar a fallar por una escritura de bitácora nueva.
--
-- TOPE ANTI-INFLADO (defensa en profundidad para rechazos, ver la nota de
-- diseño completa en `scripts/verify-billing-webhook-registro/README.md`):
-- `POST /billing/webhook` NO tiene todavía ninguna fila en
-- `@atiende/core-ratelimit::ENDPOINT_POLICIES` (`packages/core-ratelimit/src/
-- endpoint-policy.ts`) -- añadir una requeriría wirear Redis/el limitador
-- distribuido a esta ruta, fuera de alcance de esta tarea (solo se permite
-- tocar lo que esta migración + el handler necesitan). De los 11 `reason`
-- posibles, SOLO `firma_invalida` es alcanzable por cualquiera en internet sin
-- conocer el secreto del webhook (`json_invalido`/`tenant_id_ausente`/
-- `tenant_no_existe`/`customer_no_coincide`/`email_no_coincide` requieren
-- pasar PRIMERO la verificación HMAC -- ver `routes/billing.ts`, el orden
-- firma-antes-que-parseo ya existente). Por eso el tope vive AQUÍ, acotado a
-- `result = 'rechazado'`, como una consulta simple sobre el índice
-- `(result, created_at desc)` ya creado arriba -- verificable contra Postgres
-- real en el mismo verify-* de esta migración, sin depender de que Redis esté
-- configurado en el ambiente: más de 200 filas 'rechazado' en el último minuto
-- (a nivel de plataforma, no por-organización -- una firma inválida casi
-- nunca trae organización resuelta) se descarta SIN insertar, en silencio
-- (nunca cuenta como error -- el webhook ya respondió 401 antes de llegar
-- aquí, esta escritura es solo observabilidad).
create or replace function core.record_billing_webhook_event(
  p_provider_event_id text,
  p_event_type text,
  p_organization_id uuid,
  p_result text,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_rechazos_recientes bigint;
begin
  if auth.uid() is not null then
    raise exception 'record_billing_webhook_event es solo para la sesión de sistema' using errcode = '42501';
  end if;

  if p_result not in ('procesado', 'ignorado', 'rechazado', 'error') then
    raise exception 'record_billing_webhook_event: result inválido: %', p_result;
  end if;

  -- Organización desconocida/borrada entre el momento del evento y este
  -- INSERT -> se guarda `null` (nunca se lanza por una FK rota: esta escritura
  -- es best-effort, ver el comentario de cabecera arriba).
  if p_organization_id is not null and not exists (select 1 from core.organization where id = p_organization_id) then
    p_organization_id := null;
  end if;

  if p_result = 'rechazado' then
    select count(*) into v_rechazos_recientes
    from core.billing_webhook_log
    where result = 'rechazado' and created_at > now() - interval '1 minute';
    if v_rechazos_recientes >= 200 then
      return;
    end if;
  end if;

  insert into core.billing_webhook_log (provider_event_id, event_type, organization_id, result, reason)
  values (p_provider_event_id, p_event_type, p_organization_id, p_result, p_reason);
end;
$$;

-- Revisión de PR #153 (bloqueante 4): revocar solo de `public` no basta --
-- un caller `anon` TAMBIÉN tiene `auth.uid() is null` (mismo valor que un
-- caller de sistema sin sesión), así que el GRANT es la ÚNICA barrera real
-- contra `anon` frente al guard `auth.uid() is not null` de arriba. `core`
-- está expuesto por PostgREST (`supabase/config.toml`) y, como documentan
-- `0016_superadmin_acciones.sql` (comentario de cabecera) y
-- `0009_billing_saas_schema.sql`, un `ALTER DEFAULT PRIVILEGES` preexistente
-- en el Supabase real de este proyecto podría conceder `EXECUTE` directo a
-- `anon` sobre funciones nuevas del schema `core` -- revocar de `public` NO
-- retira ese default privilege. Revocar EXPLÍCITAMENTE de `anon` (además de
-- `public`) es la mitigación disponible desde esta migración.
revoke all on function core.record_billing_webhook_event(text, text, uuid, text, text) from public, anon;
grant execute on function core.record_billing_webhook_event(text, text, uuid, text, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- LECTURA — MISMO patrón EXACTO que el resto del back office de plataforma
-- (`0011_superadmin_caller_binding.sql`/`0013_superadmin_facturacion.sql`):
-- `p_caller_id uuid` explícito, atado a `auth.uid() is not null and
-- auth.uid() = p_caller_id`, más `core.is_platform_superadmin(p_caller_id)` --
-- nunca solo el segundo chequeo a secas. Cero filas para un caller no-
-- superadmin (nunca un error que confirme/niegue si hay datos). El código TS
-- (`apps/api/src/production/core-repository.ts`) abre sesión COMO el caller
-- (`withAppSession({ userId: callerId })`), nunca de sistema -- mismo criterio
-- que `listOrganizationBillingForSuperadmin`.
--
-- Filtros todos opcionales (`null` = sin ese filtro). `count(*) over()` trae
-- el TOTAL de filas que matchean el filtro en la MISMA query que la página
-- pedida -- deliberadamente UNA sola función en vez del par lista+conteo que
-- usa `0013_superadmin_facturacion.sql`: ahí el conteo total (`count_billing_
-- webhook_events_for_superadmin`) es una pregunta DISTINTA del listado
-- acotado (el feed no filtra); aquí el conteo que la pantalla necesita es
-- exactamente "cuántas filas matchean ESTE MISMO filtro", así que separarlo
-- en 2 funciones duplicaría la cláusula WHERE en vez de evitar código
-- repetido. `p_limit`/`p_offset` se acotan DENTRO de la función (nunca
-- confía en que el caller mande valores sanos, mismo criterio que
-- `list_recent_billing_webhook_events_for_superadmin`).
create or replace function core.list_billing_webhook_log_for_superadmin(
  p_caller_id uuid,
  p_result text,
  p_event_type text,
  p_organization_id uuid,
  p_desde timestamptz,
  p_hasta timestamptz,
  p_limit integer,
  p_offset integer
)
returns table (
  id bigint,
  provider_event_id text,
  event_type text,
  organization_id uuid,
  organization_name text,
  organization_slug text,
  result text,
  reason text,
  created_at timestamptz,
  total_count bigint
)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select
    l.id,
    l.provider_event_id,
    l.event_type,
    l.organization_id,
    o.name,
    o.slug,
    l.result,
    l.reason,
    l.created_at,
    count(*) over ()
  from core.billing_webhook_log l
  left join core.organization o on o.id = l.organization_id
  where auth.uid() is not null and auth.uid() = p_caller_id
    and core.is_platform_superadmin(p_caller_id)
    and (p_result is null or l.result = p_result)
    and (p_event_type is null or l.event_type = p_event_type)
    and (p_organization_id is null or l.organization_id = p_organization_id)
    and (p_desde is null or l.created_at >= p_desde)
    and (p_hasta is null or l.created_at <= p_hasta)
  order by l.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200))
  offset greatest(0, coalesce(p_offset, 0));
$$;

-- Mismo motivo que el revoke de `record_billing_webhook_event` arriba: revocar
-- también de `anon` explícitamente, no solo de `public`.
revoke all on function core.list_billing_webhook_log_for_superadmin(uuid, text, text, uuid, timestamptz, timestamptz, integer, integer) from public, anon;
grant execute on function core.list_billing_webhook_log_for_superadmin(uuid, text, text, uuid, timestamptz, timestamptz, integer, integer) to authenticated;

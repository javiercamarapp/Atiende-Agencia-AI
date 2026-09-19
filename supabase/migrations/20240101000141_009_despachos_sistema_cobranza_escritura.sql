-- Hallazgo de auditoría (severidad ALTA, inventario "flujos de sistema
-- bloqueados en escritura" -- ver `scripts/verify-flujos-sistema/README.md`,
-- sección "Pendiente para un segundo PR", punto 2): el cron
-- `cobranza-reminders` (`apps/worker/src/jobs/despachos/cobranza-
-- reminders.ts::runCobranzaReminderSweep`, invocado por `POST /internal/
-- despachos/cobranza-reminders` bajo `deps.engine.withAppSession({ userId:
-- null })`) recorre la cartera pendiente de cada property y, por cada cuenta
-- que hoy le toca recordatorio, encola el correo real y registra el evento de
-- auditoría -- pero las 2 lecturas y la escritura que ese recorrido necesita
-- están gobernadas por policies de staff autenticado, sin escape hatch:
--   * `despachos.receivable` SELECT (`listReceivables`, `.../000068_004_
--     cobranza_schema.sql`) -- `core.has_property_access(auth.uid(), ...)`,
--     SIEMPRE falso bajo sesión de sistema -- 0 filas en silencio, mismo
--     síntoma que motivó el PR #141.
--   * `despachos.invoice` SELECT (`findInvoice`, `.../000009_001_despachos_
--     schema.sql`) -- mismo patrón, también bloqueado -- sin el folio
--     fiscal/monto del CFDI, el recordatorio no tiene contenido que mandar.
--   * `despachos.collection_event` INSERT (`insertCollectionEvent`) --
--     mismo patrón -- el evento de auditoría del recordatorio nunca se
--     registra.
--
-- Impacto de producto: el cron de cobranza corre "ok" (200, sin excepción)
-- pero nunca encuentra ninguna cuenta por cobrar de ninguna property --
-- ningún recordatorio de cobranza se envía nunca, sin que quede ningún
-- rastro de que algo falló.
--
-- Complicación real (verificada leyendo la cadena de llamadas, nunca por
-- adivinanza) que esta migración resuelve distinto a licitaciones/hoteles: a
-- diferencia de `ingestTendersFromSource`/`insertFnbOrder` (exclusivos de su
-- cron/tool respectivo), `listReceivables`/`findInvoice`/
-- `insertCollectionEvent` son código GENUINAMENTE COMPARTIDO -- también los
-- usa el staff autenticado real: `apps/api/src/routes/verticals/despachos/
-- cobranza.ts` (panel de cartera, `GET .../cobranza/cuentas`) Y, más
-- importante, `POST .../cobranza/cuentas/:id/recordatorio` (un humano manda
-- un recordatorio FUERA de la secuencia automática) llama al MISMO
-- `enqueueCollectionReminderEmailCore` (`cobranza/email-notifications.ts`)
-- que usa el cron -- ese código YA funciona hoy para staff (su `auth.uid()`
-- real satisface `core.has_property_access`). Sustituir esos 3 métodos por
-- funciones `security definer` de solo-sistema (guard `auth.uid() is not
-- null -> raise`) los habría roto para el staff. Por eso esta migración NO
-- toca esos 3 métodos ni sus policies/grants existentes -- agrega 2 funciones
-- nuevas, EXCLUSIVAS del cron, y el commit de TypeScript de esta misma
-- vertical cablea `apps/worker/src/jobs/despachos/cobranza-reminders.ts` (y
-- SOLO ese archivo) a llamarlas en vez de los 3 métodos compartidos.
--
-- Decisión de diseño: funciones `security definer` de solo-sistema
-- (`despachos.receivable`/`despachos.invoice` son datos de DINERO y de
-- clientes del despacho -- nunca escape hatch, mismo criterio que licitaciones
-- en el PR anterior):
--
--   1) `despachos.system_list_pending_receivables_with_invoice(p_property_id)`
--      -- combina, en una sola función acotada, el MISMO SELECT exacto que
--      `listReceivables(propertyId, {pendiente:true})` con el dato de factura
--      que antes exigía un `findInvoice` aparte por cada fila (folio fiscal +
--      total) -- una función `security definer` puede leer
--      `despachos.invoice` internamente (bypassa RLS como dueña de la tabla,
--      igual que cualquier otra función `security definer` de este
--      monorepo) sin necesitar una función/escape hatch aparte para esa
--      tabla. Devuelve solo las columnas que el cron necesita (acotada) --
--      nunca `select *`.
--   2) `despachos.system_record_collection_event(...)` -- mismo INSERT
--      exacto que `insertCollectionEvent`, con dedupe best-effort (`exists`
--      + `created_at::date`) acotado a esta función -- NUNCA una restricción
--      `unique`/índice nuevo en la tabla, que aplicaría también a las filas
--      que inserta el staff vía `POST .../recordatorio` (`etapa` puede
--      repetirse el mismo día ahí a propósito -- un humano decide reenviar
--      fuera de secuencia, comportamiento existente que este commit no
--      toca). El `exists`-check tiene una ventana de carrera bajo
--      concurrencia real (no es atómico como un `on conflict`) -- aceptable
--      aquí porque `collection_event` es un rastro de AUDITORÍA (qué etapa se
--      generó), nunca la fuente de verdad de si el correo se mandó (ese
--      dedupe real, atómico, ya vive en `despachos.messaging_outbox` vía
--      `dedupe_key`, `unique (organization_id, channel, dedupe_key)`,
--      `...000076_005_email_outbox_and_notificaciones.sql`) -- una
--      duplicación bajo la carrera improbable de 2 corridas de cron
--      EXACTAMENTE simultáneas produciría a lo más una fila de auditoría de
--      más, nunca un correo de más ni un cargo de más.
--
-- `despachos.enqueue_messaging_outbox` (usado por el mismo
-- `enqueueCollectionReminderEmailCore`) YA es correcto para ambos casos desde
-- `...000081_011_email_outbox_dispatch.sql`/`007_email_outbox_authenticated_
-- grants.sql` -- sin GUARD de sesión de sistema (mismo precedente: función
-- `security definer` compartida, ya usada por staff Y sistema) -- sin cambio
-- aquí.
--
-- Orden de despliegue: esta migración debe aplicarse ANTES de desplegar el
-- código de `apps/worker/src/jobs/despachos/cobranza-reminders.ts`/
-- `packages/domain-despachos/src/cobranza/email-notifications.ts` de este
-- mismo commit. Las 2 funciones son EXCLUSIVAS del cron (verificado:
-- `grep -rn` sobre `apps/api/src/routes/verticals/despachos/` -- ningún
-- caller de staff autenticado las invoca), así que degradan de forma segura
-- si el código nuevo se desplegara ANTES que esta migración: la llamada
-- fallaría con "function despachos.system_... does not exist" en vez del "0
-- filas"/"permission denied" de hoy -- el mismo `try/catch` por-organización
-- que ya envuelve `runCobranzaReminderSweep` sigue capturando el error
-- igual, así que el estado resultante nunca es peor que el bug ya
-- documentado aquí.

-- ---------------------------------------------------------------------------
-- 1) Lectura combinada: cartera pendiente de una property + folio fiscal/
--    total del invoice asociado -- mismo SELECT exacto que
--    `listReceivables(propertyId, {pendiente:true})`, más el join a
--    `despachos.invoice` que antes exigía un `findInvoice` aparte por fila.
-- ---------------------------------------------------------------------------
create or replace function despachos.system_list_pending_receivables_with_invoice(p_property_id uuid)
returns table (
  out_id uuid,
  out_organization_id uuid,
  out_property_id uuid,
  out_invoice_id uuid,
  out_fecha_vencimiento text,
  out_cliente_nombre text,
  out_cliente_email text,
  out_factura_folio_fiscal text,
  out_factura_total text
)
language plpgsql security definer set search_path = despachos as $$
begin
  if auth.uid() is not null then
    raise exception 'system_list_pending_receivables_with_invoice es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    select
      r.id, r.organization_id, r.property_id, r.invoice_id,
      r.fecha_vencimiento::text, r.cliente_nombre, r.cliente_email,
      i.folio_fiscal::text, i.total::text
    from despachos.receivable r
    join despachos.invoice i on i.id = r.invoice_id and i.property_id = r.property_id
    where r.property_id = p_property_id and r.pagado_en is null
    order by r.fecha_vencimiento asc;
end;
$$;

revoke execute on function despachos.system_list_pending_receivables_with_invoice(uuid) from public;
grant execute on function despachos.system_list_pending_receivables_with_invoice(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Registro idempotente (best-effort, ver header) del evento de
--    recordatorio de cobranza -- mismo INSERT exacto que
--    `insertCollectionEvent`, exclusivo del cron.
-- ---------------------------------------------------------------------------
create or replace function despachos.system_record_collection_event(
  p_organization_id uuid,
  p_property_id uuid,
  p_receivable_id uuid,
  p_etapa text,
  p_canal text,
  p_respuesta text,
  p_event_date date
)
returns table (out_id uuid, out_created_at text)
language plpgsql security definer set search_path = despachos as $$
begin
  if auth.uid() is not null then
    raise exception 'system_record_collection_event es solo para la sesión de sistema' using errcode = '42501';
  end if;

  if exists (
    select 1 from despachos.collection_event
    where receivable_id = p_receivable_id and etapa = p_etapa and created_at::date = p_event_date
  ) then
    return; -- ya se registró esta etapa/cuenta hoy -- dedupe best-effort, ver header.
  end if;

  return query
    insert into despachos.collection_event (organization_id, property_id, receivable_id, etapa, canal, respuesta)
    values (p_organization_id, p_property_id, p_receivable_id, p_etapa, p_canal, p_respuesta)
    returning id, created_at::text;
end;
$$;

revoke execute on function despachos.system_record_collection_event(uuid, uuid, uuid, text, text, text, date) from public;
grant execute on function despachos.system_record_collection_event(uuid, uuid, uuid, text, text, text, date) to authenticated;

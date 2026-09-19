-- Back office de plataforma — TERCERA y última pieza del "cerebro" de
-- backoffice del superadmin (después de Salud operativa, `...000135`, y
-- Resumen diario, `...000138`): ACCIONES SUGERIDAS CON CONFIRMACIÓN + DOS
-- AUTOMATIZACIONES SEGURAS, todo auditado.
--
-- Principio rector (viene de un incidente REAL en otro producto del mismo
-- dueño: un "agente de backoffice" mandó correos redactados por LLM a
-- terceros sin revisión humana, porque su ventana de veto tenía default 0 y
-- su interruptor vivía en una variable de entorno sin bitácora):
--
--   - Ninguna acción con efecto real hacia un tercero se ejecuta porque el
--     cliente HTTP mande un flag `confirmado: true`. Toda acción que
--     requiere decisión humana pasa por un INTENT creado y guardado por el
--     SERVIDOR (`core.superadmin_action_intent`): primer POST crea el
--     intent (tipo, payload validado, quién, resumen legible, vence en
--     pocos minutos); un SEGUNDO POST explícito del MISMO superadmin lo
--     confirma; el servidor re-valida el estado actual del mundo ANTES de
--     ejecutar (pudo cambiar desde que se creó el intent), ejecuta, y marca
--     el intent `executed` (o `failed` con el motivo). Un intent vencido,
--     ya usado, o de otro superadmin NUNCA se puede confirmar. Todo queda
--     en bitácora (la fila del intent misma).
--   - Lo automático (sin intent, sin humano) es MÍNIMO, REVERSIBLE e
--     INTERNO — nunca manda nada a un tercero por sí solo — y cada
--     ejecución queda registrada en `core.automation_action_log`,
--     consultable.
--   - Nada de LLM aquí: ni para decidir qué es una alerta/sugerencia
--     (siempre determinista, mismo criterio que `salud/motor.ts` y
--     `resumen-diario/motor.ts`) ni para redactar nada.
--
-- CINCO piezas:
--
--   1. `core.prospecto.necesita_seguimiento_desde` (columna nueva) + el
--      redefinido `core.update_prospecto_for_superadmin` que la limpia en
--      CUALQUIER actualización real del prospecto (se "desmarca sola" en
--      cuanto el prospecto cambia, requisito explícito del diseño) — MISMA
--      función, mismo nombre, redefinida en esta migración nueva (patrón ya
--      establecido: `update_prospecto_for_superadmin`/
--      `list_prospectos_for_superadmin`/etc. ya se redefinieron una vez en
--      `...000127_0011_superadmin_caller_binding.sql` sin tocar el archivo
--      original — nunca se edita una migración ya aplicada).
--
--   2. `core.automation_action_log` + DOS pares de funciones
--      SQL de automatización, cada par con la MISMA lógica real compartida
--      en una función INTERNA sin guard (`core._desatascar_outbox_colgados`/
--      `core._marcar_prospectos_sin_movimiento`, prefijo `_` = nunca
--      expuesta a `authenticated` -- `revoke all ... from public` sin
--      ningún `grant`, así que solo es invocable desde OTRA función
--      `security definer` con el MISMO dueño, ver abajo) más DOS entradas
--      públicas que la envuelven con guards DISTINTOS:
--        - `core.desatascar_outbox_colgados_for_system` /
--          `core.marcar_prospectos_sin_movimiento_for_system` — guard
--          SOLO-SISTEMA (`auth.uid() is not null -> 42501`), invocadas por
--          el cron nuevo `/internal/superadmin/mantenimiento`.
--        - `core.confirmar_superadmin_action_intent_for_superadmin` (pieza
--          3 de abajo), para el tipo de acción `ejecutar_mantenimiento_ahora`
--          (correrlas A DEMANDA, con confirmación humana), invoca las MISMAS
--          dos funciones internas directamente — nunca una segunda
--          implementación del cálculo, un solo código real detrás del cron
--          Y del botón "ejecutar ahora".
--      Idempotentes (una fila ya movida/marcada no vuelve a tocarse en la
--      siguiente corrida) y respetan `attempts`/tope de reintentos de cada
--      cola (ver el comentario largo dentro de `core._desatascar_outbox_
--      colgados` para el criterio real verificado en cada migración de
--      vertical, DISTINTO del resumen -- ya desactualizado en ese punto --
--      de `...000135_0014_superadmin_salud_operativa.sql`).
--
--   3. `core.superadmin_action_intent` (la tabla) + la máquina de estados
--      completa: crear/cancelar/confirmar, MISMO patrón `security definer`
--      con `p_caller_id uuid` atado a `auth.uid() = p_caller_id` +
--      `core.is_platform_superadmin(p_caller_id)` que el resto del back
--      office de plataforma. La confirmación es ATÓMICA (un solo UPDATE con
--      `where estado = 'pending' and vence_en > now() and creado_por =
--      p_caller_id and confirmado_en is null`, aprovechando el lock de fila
--      normal de Postgres) para que dos confirmaciones concurrentes del
--      MISMO intent ejecuten una sola vez -- la segunda, al re-evaluar el
--      WHERE después de que la primera ya puso `confirmado_en`, obtiene 0
--      filas y NUNCA vuelve a ejecutar nada.
--
--   4. Catálogo de acciones EJECUTABLES hoy, cerrado por un CHECK sobre
--      `tipo` (`reencolar_mensaje_muerto`/`cerrar_prospecto`/
--      `ejecutar_mantenimiento_ahora`) -- el catálogo COMPLETO (incluidas
--      las acciones "no disponible") vive en TypeScript
--      (`apps/api/src/superadmin-acciones/catalogo.ts`), esta migración
--      solo puede ejecutar estas 3.
--
--   5. Funciones de LECTURA para el back office (mensajes muertos
--      reencolables, bitácora de intents, bitácora de automatizaciones) --
--      MISMO patrón `_for_superadmin` que el resto de la plataforma.
--
-- Las funciones que cruzan esquemas de vertical (`core._desatascar_outbox_
-- colgados`/`core._reencolar_mensaje_muerto`/`core.list_outbox_mensajes_
-- muertos_for_superadmin`/`core.get_outbox_dead_message_for_superadmin`)
-- fijan `search_path = core, pg_temp` explícito, CALIFICAN cada tabla con
-- su esquema completo, y NUNCA arman SQL dinámico con un nombre de cola
-- recibido por parámetro sin validar -- `core._reencolar_mensaje_muerto`
-- valida `p_queue` contra una lista cerrada vía `if/elsif` literal (nunca
-- interpolación de identificador), mismo criterio que el resto de este
-- archivo.

-- ═══ 1. core.prospecto.necesita_seguimiento_desde ══════════════════════════

alter table core.prospecto add column necesita_seguimiento_desde timestamptz;

-- Redefinición de `core.update_prospecto_for_superadmin` (última versión
-- real: `...000127_0011_superadmin_caller_binding.sql`) -- MISMO cuerpo,
-- + limpia `necesita_seguimiento_desde` en cualquier actualización real.
-- Esta es la ÚNICA función de escritura de un prospecto YA EXISTENTE en
-- todo el repo (staff normal de tenant no tiene ningún concepto de
-- "prospecto de plataforma") -- `cerrar_prospecto` (acción con intent, ver
-- abajo) la reutiliza tal cual, nunca duplica esta lógica.
create or replace function core.update_prospecto_for_superadmin(
  p_caller_id uuid,
  p_prospecto_id uuid,
  p_estado text,
  p_notas text
)
returns core.prospecto
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_row core.prospecto;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'update_prospecto_for_superadmin: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update core.prospecto
  set estado = coalesce(p_estado, estado),
      notas = coalesce(p_notas, notas),
      necesita_seguimiento_desde = null,
      updated_at = now()
  where id = p_prospecto_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'prospecto not found' using errcode = 'P0002';
  end if;

  return v_row;
end;
$$;

revoke all on function core.update_prospecto_for_superadmin(uuid, uuid, text, text) from public;
grant execute on function core.update_prospecto_for_superadmin(uuid, uuid, text, text) to authenticated;

-- ═══ 2. Bitácora de automatizaciones + las dos automatizaciones ════════════

create table core.automation_action_log (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('outbox_desatascado', 'prospecto_marcado_seguimiento')),
  tabla text not null check (length(tabla) > 0),
  objetivo_id text not null check (length(objetivo_id) > 0),
  detalle jsonb not null default '{}'::jsonb,
  ejecutado_en timestamptz not null default now(),
  -- Siempre 'system' -- esta tabla es EXCLUSIVA de las dos automatizaciones
  -- internas (nunca de una acción humana confirmada vía intent; esa bitácora
  -- es la propia fila de `core.superadmin_action_intent`, ver abajo), aun
  -- cuando el disparo haya sido "ejecutar ahora" por un superadmin -- lo que
  -- se ejecutó sigue siendo la MISMA automatización determinista, solo
  -- cambia el trigger, capturado por separado en el intent.
  executed_by text not null default 'system' check (executed_by = 'system')
);
create index automation_action_log_ejecutado_en_idx on core.automation_action_log (ejecutado_en desc);
alter table core.automation_action_log enable row level security;
revoke all on core.automation_action_log from public, anon, authenticated;

-- ── 2a. Desatascar filas colgadas en 'processing' ───────────────────────────
--
-- Verificado leyendo CADA migración de vertical (no confiando en el
-- resumen de `...000135`, que para `citas` ya estaba desactualizado en el
-- momento de escribirse -- `...000051_009_email_outbox_dispatch.sql` y
-- `...000052_007_messaging_outbox_dispatch.sql`, AMBAS anteriores a
-- `...000135`, ya le habían agregado `attempts`/`claimed_at`/
-- `next_attempt_at`/`sent_at`/`last_error_class`/`last_error` a
-- `citas.messaging_outbox`):
--
--   - `citas`/`hoteles`/`restaurantes`/`rentas`: SÍ tienen `claimed_at`, pero
--     SOLO se llena cuando la fila se reclamó por el canal 'whatsapp'
--     (`claim_messaging_outbox_batch`, claim-con-lease) -- el claim de
--     'email' (`claim_email_outbox_batch`, en TODAS las verticales que
--     tienen ese canal) pone `status = 'processing'` pero NUNCA toca
--     `claimed_at`. Por eso el criterio real y CIERTO es `status =
--     'processing' and claimed_at is not null and claimed_at < umbral` --
--     una fila 'processing' con `claimed_at` null (reclamo por email) se
--     queda AFUERA a propósito, nunca se inventa su antigüedad.
--   - `despachos`/`licitaciones`: NO tienen columna `claimed_at` en
--     absoluto (solo `attempts`/`last_error`, canal 'email' únicamente) --
--     una fila 'processing' ahí no tiene NINGUNA columna que diga desde
--     cuándo, así que esta automatización NUNCA las toca. Se reportan de
--     todos modos (`aplica = false`, con `motivo`) en vez de desaparecer en
--     silencio.
--   - `attempts < 5` reutiliza el MISMO tope que cada `claim_email_outbox_
--     batch` de este repo ya usa (nunca un número nuevo inventado aquí) --
--     una fila que ya agotó sus intentos por ese camino nunca se resucita;
--     el camino 'whatsapp' no tiene tope explícito en SQL (lo decide
--     `@atiende/whatsapp-gateway` en TS antes de llamar a
--     `complete_messaging_outbox_dead`), así que una fila 'processing' de
--     ese camino, por definición, TODAVÍA no llegó a `dead` -- desatascarla
--     de vuelta a `pending` deja que el MISMO dispatcher decida su destino
--     otra vez, nunca bypassa esa lógica.
--
-- Esta función NUNCA envía nada -- solo mueve `status` de vuelta a
-- `pending` para que el dispatcher existente (cron ya montado) la retome en
-- su próxima corrida.
create or replace function core._desatascar_outbox_colgados(p_umbral_minutos integer)
returns table (queue_name text, aplica boolean, filas_movidas bigint, motivo text)
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_umbral integer := greatest(1, coalesce(p_umbral_minutos, 30));
  v_id uuid;
  v_count bigint;
begin
  v_count := 0;
  for v_id in
    update citas.messaging_outbox
    set status = 'pending', claimed_at = null
    where status = 'processing' and claimed_at is not null and claimed_at < now() - make_interval(mins => v_umbral) and attempts < 5
    returning id
  loop
    insert into core.automation_action_log (tipo, tabla, objetivo_id, detalle)
    values ('outbox_desatascado', 'citas.messaging_outbox', v_id::text, jsonb_build_object('umbralMinutos', v_umbral));
    v_count := v_count + 1;
  end loop;
  queue_name := 'citas'; aplica := true; filas_movidas := v_count; motivo := null;
  return next;

  v_count := 0;
  for v_id in
    update hoteles.messaging_outbox
    set status = 'pending', claimed_at = null
    where status = 'processing' and claimed_at is not null and claimed_at < now() - make_interval(mins => v_umbral) and attempts < 5
    returning id
  loop
    insert into core.automation_action_log (tipo, tabla, objetivo_id, detalle)
    values ('outbox_desatascado', 'hoteles.messaging_outbox', v_id::text, jsonb_build_object('umbralMinutos', v_umbral));
    v_count := v_count + 1;
  end loop;
  queue_name := 'hoteles'; aplica := true; filas_movidas := v_count; motivo := null;
  return next;

  v_count := 0;
  for v_id in
    update restaurantes.messaging_outbox
    set status = 'pending', claimed_at = null
    where status = 'processing' and claimed_at is not null and claimed_at < now() - make_interval(mins => v_umbral) and attempts < 5
    returning id
  loop
    insert into core.automation_action_log (tipo, tabla, objetivo_id, detalle)
    values ('outbox_desatascado', 'restaurantes.messaging_outbox', v_id::text, jsonb_build_object('umbralMinutos', v_umbral));
    v_count := v_count + 1;
  end loop;
  queue_name := 'restaurantes'; aplica := true; filas_movidas := v_count; motivo := null;
  return next;

  v_count := 0;
  for v_id in
    update rentas.messaging_outbox
    set status = 'pending', claimed_at = null
    where status = 'processing' and claimed_at is not null and claimed_at < now() - make_interval(mins => v_umbral) and attempts < 5
    returning id
  loop
    insert into core.automation_action_log (tipo, tabla, objetivo_id, detalle)
    values ('outbox_desatascado', 'rentas.messaging_outbox', v_id::text, jsonb_build_object('umbralMinutos', v_umbral));
    v_count := v_count + 1;
  end loop;
  queue_name := 'rentas'; aplica := true; filas_movidas := v_count; motivo := null;
  return next;

  queue_name := 'despachos'; aplica := false; filas_movidas := null;
  motivo := 'sin columna claimed_at: no se puede saber con certeza desde cuándo una fila processing está colgada';
  return next;

  queue_name := 'licitaciones'; aplica := false; filas_movidas := null;
  motivo := 'sin columna claimed_at: no se puede saber con certeza desde cuándo una fila processing está colgada';
  return next;

  return;
end;
$$;

revoke all on function core._desatascar_outbox_colgados(integer) from public;
-- SIN grant a nadie -- función interna, solo invocable desde otra función
-- `security definer` del MISMO dueño (las dos de abajo).

create or replace function core.desatascar_outbox_colgados_for_system(p_umbral_minutos integer default 30)
returns table (queue_name text, aplica boolean, filas_movidas bigint, motivo text)
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'desatascar_outbox_colgados_for_system es solo para la sesión de sistema' using errcode = '42501';
  end if;
  return query select * from core._desatascar_outbox_colgados(p_umbral_minutos);
end;
$$;

revoke all on function core.desatascar_outbox_colgados_for_system(integer) from public;
grant execute on function core.desatascar_outbox_colgados_for_system(integer) to authenticated;

-- ── 2b. Marcar prospectos sin movimiento ────────────────────────────────────
--
-- Estados terminales (`ganado`/`perdido`/`descartado`) excluidos -- mismo
-- criterio ya establecido en `core.get_prospectos_agregado_for_system`
-- (resumen diario). Idempotente: `necesita_seguimiento_desde is null` en el
-- WHERE evita re-marcar (y re-loguear) un prospecto ya marcado en una
-- corrida anterior; se desmarca solo vía `core.update_prospecto_for_
-- superadmin` (arriba) cuando el prospecto cambia de verdad. NUNCA cambia
-- `estado` ni contacta a nadie -- solo escribe la fecha de la anotación.
create or replace function core._marcar_prospectos_sin_movimiento(p_umbral_dias integer)
returns table (prospecto_id uuid, empresa text)
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_umbral integer := greatest(1, coalesce(p_umbral_dias, 14));
  v_id uuid;
  v_empresa text;
begin
  for v_id, v_empresa in
    update core.prospecto p
    set necesita_seguimiento_desde = now()
    where p.necesita_seguimiento_desde is null
      and p.estado not in ('ganado', 'perdido', 'descartado')
      and p.updated_at < now() - make_interval(days => v_umbral)
    returning p.id, p.empresa
  loop
    insert into core.automation_action_log (tipo, tabla, objetivo_id, detalle)
    values ('prospecto_marcado_seguimiento', 'core.prospecto', v_id::text, jsonb_build_object('umbralDias', v_umbral, 'empresa', v_empresa));
    prospecto_id := v_id;
    empresa := v_empresa;
    return next;
  end loop;
  return;
end;
$$;

revoke all on function core._marcar_prospectos_sin_movimiento(integer) from public;
-- SIN grant a nadie -- función interna, mismo criterio que la de outbox.

create or replace function core.marcar_prospectos_sin_movimiento_for_system(p_umbral_dias integer default 14)
returns table (prospecto_id uuid, empresa text)
language plpgsql
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'marcar_prospectos_sin_movimiento_for_system es solo para la sesión de sistema' using errcode = '42501';
  end if;
  return query select * from core._marcar_prospectos_sin_movimiento(p_umbral_dias);
end;
$$;

revoke all on function core.marcar_prospectos_sin_movimiento_for_system(integer) from public;
grant execute on function core.marcar_prospectos_sin_movimiento_for_system(integer) to authenticated;

-- ═══ 3. core.superadmin_action_intent -- máquina de estados ════════════════

create table core.superadmin_action_intent (
  id uuid primary key default gen_random_uuid(),
  -- Catálogo EJECUTABLE hoy (cerrado por este CHECK) -- el catálogo
  -- COMPLETO, incluidas las acciones "no disponible", vive en
  -- `apps/api/src/superadmin-acciones/catalogo.ts`.
  tipo text not null check (tipo in ('reencolar_mensaje_muerto', 'cerrar_prospecto', 'ejecutar_mantenimiento_ahora')),
  payload jsonb not null default '{}'::jsonb,
  -- Resumen legible YA COMPUESTO por la capa TS al crear el intent (mismo
  -- criterio que `narrativa` en `core.daily_ops_summary`) -- nunca
  -- generado por un LLM, nunca recompuesto aquí.
  resumen text not null check (length(resumen) > 0),
  estado text not null default 'pending' check (estado in ('pending', 'executed', 'failed', 'expired', 'cancelled')),
  -- `on delete set null` (mismo criterio que `core.prospecto.creado_por`) --
  -- un intent es un registro histórico; si el staff que lo creó se elimina
  -- algún día, el intent NUNCA vuelve a ser confirmable (`creado_por =
  -- p_caller_id` ya no puede coincidir con nadie), pero la fila persiste
  -- como bitácora.
  creado_por uuid references core.staff_user(id) on delete set null,
  creado_en timestamptz not null default now(),
  vence_en timestamptz not null,
  confirmado_en timestamptz,
  ejecutado_en timestamptz,
  resultado jsonb,
  error text check (error is null or length(error) <= 500)
);
create index superadmin_action_intent_creado_en_idx on core.superadmin_action_intent (creado_en desc);
create index superadmin_action_intent_pending_idx on core.superadmin_action_intent (estado, vence_en) where estado = 'pending';
alter table core.superadmin_action_intent enable row level security;
revoke all on core.superadmin_action_intent from public, anon, authenticated;

-- Primer POST: crea el intent, NUNCA ejecuta nada. Valida el payload mínimo
-- por tipo (defensa en profundidad -- la capa TS ya valida antes de
-- llamar). `p_vence_en_minutos` acotado a [1, 30] -- "vence en pocos
-- minutos" es un requisito explícito del diseño, nunca una ventana larga.
create or replace function core.crear_superadmin_action_intent_for_superadmin(
  p_caller_id uuid,
  p_tipo text,
  p_payload jsonb,
  p_resumen text,
  p_vence_en_minutos integer default 5
)
returns core.superadmin_action_intent
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_row core.superadmin_action_intent;
  v_minutos integer;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'crear_superadmin_action_intent_for_superadmin: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_resumen is null or length(trim(p_resumen)) = 0 then
    raise exception 'p_resumen no puede estar vacío' using errcode = '22023';
  end if;

  if p_tipo = 'reencolar_mensaje_muerto' then
    if v_payload ->> 'queue' is null or v_payload ->> 'mensajeId' is null then
      raise exception 'payload inválido para reencolar_mensaje_muerto: requiere queue y mensajeId' using errcode = '22023';
    end if;
  elsif p_tipo = 'cerrar_prospecto' then
    if v_payload ->> 'prospectoId' is null or coalesce(v_payload ->> 'estado', '') not in ('perdido', 'descartado') then
      raise exception 'payload inválido para cerrar_prospecto: requiere prospectoId y estado en (perdido, descartado)' using errcode = '22023';
    end if;
  elsif p_tipo = 'ejecutar_mantenimiento_ahora' then
    null; -- sin payload requerido
  else
    raise exception 'tipo de acción desconocido o no disponible: %', p_tipo using errcode = '22023';
  end if;

  v_minutos := greatest(1, least(coalesce(p_vence_en_minutos, 5), 30));

  insert into core.superadmin_action_intent (tipo, payload, resumen, estado, creado_por, creado_en, vence_en)
  values (p_tipo, v_payload, p_resumen, 'pending', p_caller_id, now(), now() + make_interval(mins => v_minutos))
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function core.crear_superadmin_action_intent_for_superadmin(uuid, text, jsonb, text, integer) from public;
grant execute on function core.crear_superadmin_action_intent_for_superadmin(uuid, text, jsonb, text, integer) to authenticated;

-- El operador se arrepiente / ya no aplica -- solo el creador, solo mientras
-- siga `pending`.
create or replace function core.cancelar_superadmin_action_intent_for_superadmin(p_caller_id uuid, p_intent_id uuid)
returns core.superadmin_action_intent
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_row core.superadmin_action_intent;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'cancelar_superadmin_action_intent_for_superadmin: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update core.superadmin_action_intent
  set estado = 'cancelled'
  where id = p_intent_id and estado = 'pending' and creado_por = p_caller_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'intent no cancelable (ya no está pending, venció, o no pertenece a este caller)' using errcode = 'P0002';
  end if;

  return v_row;
end;
$$;

revoke all on function core.cancelar_superadmin_action_intent_for_superadmin(uuid, uuid) from public;
grant execute on function core.cancelar_superadmin_action_intent_for_superadmin(uuid, uuid) to authenticated;

-- Reencola UNA fila concreta en estado 'dead' de UNA cola concreta. Interna
-- (prefijo `_`, sin grant) -- `p_queue` se valida contra una lista cerrada
-- vía `if/elsif` LITERAL (nunca SQL dinámico con un identificador recibido
-- por parámetro). Re-valida `status = 'dead'` en el propio WHERE del UPDATE
-- (el mundo pudo cambiar desde que se creó el intent -- alguien más ya lo
-- reencoló, o el dispatcher ya lo movió) -- devuelve `false` si no tocó
-- ninguna fila, nunca lanza por "ya no está dead". Resetea `attempts`/
-- `next_attempt_at`/`claimed_at` donde la columna existe (un reencolado
-- humano deliberado merece intentos frescos); conserva el último error
-- histórico (`last_error`/`last_error_class`) tal cual -- nunca se borra el
-- rastro de qué lo mató la primera vez.
create or replace function core._reencolar_mensaje_muerto(p_queue text, p_mensaje_id uuid)
returns boolean
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_rows integer;
begin
  if p_queue = 'citas' then
    update citas.messaging_outbox set status = 'pending', attempts = 0, claimed_at = null, next_attempt_at = now()
    where id = p_mensaje_id and status = 'dead';
  elsif p_queue = 'hoteles' then
    update hoteles.messaging_outbox set status = 'pending', attempts = 0, claimed_at = null, next_attempt_at = now()
    where id = p_mensaje_id and status = 'dead';
  elsif p_queue = 'restaurantes' then
    update restaurantes.messaging_outbox set status = 'pending', attempts = 0, claimed_at = null, next_attempt_at = now()
    where id = p_mensaje_id and status = 'dead';
  elsif p_queue = 'rentas' then
    update rentas.messaging_outbox set status = 'pending', attempts = 0, claimed_at = null, next_attempt_at = now()
    where id = p_mensaje_id and status = 'dead';
  elsif p_queue = 'despachos' then
    update despachos.messaging_outbox set status = 'pending', attempts = 0
    where id = p_mensaje_id and status = 'dead';
  elsif p_queue = 'licitaciones' then
    update licitaciones.messaging_outbox set status = 'pending', attempts = 0
    where id = p_mensaje_id and status = 'dead';
  else
    raise exception 'cola desconocida: %', p_queue using errcode = '22023';
  end if;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function core._reencolar_mensaje_muerto(text, uuid) from public;
-- SIN grant a nadie -- función interna, invocada SOLO desde
-- `core.confirmar_superadmin_action_intent_for_superadmin` de abajo.

-- Segundo POST: confirma. ATÓMICO -- el UPDATE de abajo es la ÚNICA fuente
-- de verdad de "quién gana la carrera" entre dos confirmaciones
-- concurrentes del MISMO intent; el lock de fila normal de Postgres hace
-- que la segunda, al re-evaluar el WHERE después de que la primera ya puso
-- `confirmado_en`, obtenga 0 filas. Si el claim falla, esta función NUNCA
-- lanza para "no encontrado"/"no es tuyo"/"ya venció" salvo los dos casos
-- de seguridad real (no existe, no te pertenece) -- para "ya no es
-- confirmable" (vencido/ya usado/ya confirmado por la otra llamada
-- concurrente que ganó) devuelve la fila TAL CUAL (marcando `expired` como
-- efecto secundario cuando corresponde) para que la capa TS decida el
-- código HTTP a partir de `estado`, sin depender de parsear un mensaje de
-- excepción.
create or replace function core.confirmar_superadmin_action_intent_for_superadmin(p_caller_id uuid, p_intent_id uuid)
returns core.superadmin_action_intent
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_intent core.superadmin_action_intent;
  v_queue text;
  v_mensaje_id uuid;
  v_prospecto_id uuid;
  v_estado_destino text;
  v_prospecto core.prospecto;
  v_reencolado boolean;
  v_outbox jsonb;
  v_prospectos jsonb;
  v_resultado jsonb;
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'confirmar_superadmin_action_intent_for_superadmin: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
  if not core.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update core.superadmin_action_intent
  set confirmado_en = now()
  where id = p_intent_id and estado = 'pending' and creado_por = p_caller_id and confirmado_en is null and vence_en > now()
  returning * into v_intent;

  if v_intent.id is null then
    select * into v_intent from core.superadmin_action_intent where id = p_intent_id;
    if v_intent.id is null then
      raise exception 'intent no encontrado' using errcode = 'P0002';
    end if;
    if v_intent.creado_por is distinct from p_caller_id then
      raise exception 'este intent no fue creado por este superadmin' using errcode = '42501';
    end if;
    if v_intent.estado = 'pending' and v_intent.vence_en <= now() then
      update core.superadmin_action_intent set estado = 'expired' where id = p_intent_id and estado = 'pending' returning * into v_intent;
    end if;
    -- `v_intent.estado` ya no es un 'pending' confirmable (expired/executed/
    -- failed/cancelled/ganado por una llamada concurrente) -- se devuelve
    -- TAL CUAL, sin ejecutar nada.
    return v_intent;
  end if;

  -- A partir de aquí el intent está EXCLUSIVAMENTE reclamado por esta
  -- llamada. Re-valida el estado ACTUAL del mundo real antes de ejecutar
  -- (dentro de cada rama) -- nunca se asume que sigue siendo cierto lo que
  -- decía el resumen al crearse el intent.
  begin
    if v_intent.tipo = 'reencolar_mensaje_muerto' then
      v_queue := v_intent.payload ->> 'queue';
      v_mensaje_id := (v_intent.payload ->> 'mensajeId')::uuid;
      v_reencolado := core._reencolar_mensaje_muerto(v_queue, v_mensaje_id);
      if not v_reencolado then
        raise exception 'el mensaje % de la cola % ya no está en estado dead (lo movieron, ya se reencoló antes, o ya no existe)', v_mensaje_id, v_queue;
      end if;
      v_resultado := jsonb_build_object('reencolado', true, 'queue', v_queue, 'mensajeId', v_mensaje_id);

    elsif v_intent.tipo = 'cerrar_prospecto' then
      v_prospecto_id := (v_intent.payload ->> 'prospectoId')::uuid;
      v_estado_destino := v_intent.payload ->> 'estado';
      if v_estado_destino not in ('perdido', 'descartado') then
        raise exception 'estado destino inválido para cerrar_prospecto: %', v_estado_destino;
      end if;
      -- Reutiliza la función YA existente (misma que usa el editor de
      -- prospectos) -- nunca duplica su validación/lógica.
      v_prospecto := core.update_prospecto_for_superadmin(p_caller_id, v_prospecto_id, v_estado_destino, null);
      v_resultado := jsonb_build_object('prospectoId', v_prospecto.id, 'estado', v_prospecto.estado);

    elsif v_intent.tipo = 'ejecutar_mantenimiento_ahora' then
      -- MISMAS dos funciones internas que corre el cron -- un solo código
      -- real detrás de ambos caminos.
      select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_outbox from core._desatascar_outbox_colgados(30) x;
      select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_prospectos from core._marcar_prospectos_sin_movimiento(14) x;
      v_resultado := jsonb_build_object('outbox', v_outbox, 'prospectos', v_prospectos);

    else
      raise exception 'tipo de intent no ejecutable: %', v_intent.tipo;
    end if;

    update core.superadmin_action_intent
    set estado = 'executed', ejecutado_en = now(), resultado = v_resultado, error = null
    where id = p_intent_id
    returning * into v_intent;

  exception when others then
    update core.superadmin_action_intent
    set estado = 'failed', ejecutado_en = now(), error = left(sqlerrm, 500)
    where id = p_intent_id
    returning * into v_intent;
  end;

  return v_intent;
end;
$$;

revoke all on function core.confirmar_superadmin_action_intent_for_superadmin(uuid, uuid) from public;
grant execute on function core.confirmar_superadmin_action_intent_for_superadmin(uuid, uuid) to authenticated;

-- ═══ 4. Lecturas para el back office ════════════════════════════════════════

-- Bitácora de intents -- visible a CUALQUIER superadmin (no solo al que lo
-- creó), mismo criterio que `core.list_prospectos_for_superadmin`: es
-- bitácora de EQUIPO, no un buzón privado.
create or replace function core.list_superadmin_action_intents_for_superadmin(p_caller_id uuid, p_limit integer default 50)
returns setof core.superadmin_action_intent
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select i.* from core.superadmin_action_intent i
  where auth.uid() is not null and auth.uid() = p_caller_id
    and core.is_platform_superadmin(p_caller_id)
  order by i.creado_en desc
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

revoke all on function core.list_superadmin_action_intents_for_superadmin(uuid, integer) from public;
grant execute on function core.list_superadmin_action_intents_for_superadmin(uuid, integer) to authenticated;

-- Bitácora de las DOS automatizaciones (cron o "ejecutar ahora").
create or replace function core.list_automation_action_log_for_superadmin(p_caller_id uuid, p_limit integer default 100)
returns setof core.automation_action_log
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select l.* from core.automation_action_log l
  where auth.uid() is not null and auth.uid() = p_caller_id
    and core.is_platform_superadmin(p_caller_id)
  order by l.ejecutado_en desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

revoke all on function core.list_automation_action_log_for_superadmin(uuid, integer) from public;
grant execute on function core.list_automation_action_log_for_superadmin(uuid, integer) to authenticated;

-- Mensajes muertos reencolables -- alimenta las sugerencias deterministas
-- ("hay N mensajes muertos en <vertical>: revisar y reencolar") con el
-- payload YA precargado (`queue` + `id`) para crear el intent con un clic.
-- Escanea las 6 tablas (mismo patrón que `get_outbox_health_for_superadmin`)
-- y filtra al final -- simple y seguro (sin SQL dinámico), aceptable en
-- costo para una lectura de back office, no un camino caliente.
create or replace function core.list_outbox_mensajes_muertos_for_superadmin(p_caller_id uuid, p_limit integer default 20)
returns table (queue_name text, id uuid, organization_id uuid, organization_name text, channel text, event_type text, error text, created_at timestamptz)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  with authorized as (
    select (auth.uid() is not null and auth.uid() = p_caller_id and core.is_platform_superadmin(p_caller_id)) as ok
  ),
  unioned as (
    select 'citas' as queue_name, m.id, m.organization_id, m.channel, m.event_type, coalesce(m.last_error, m.last_error_class) as error, m.created_at from citas.messaging_outbox m where m.status = 'dead'
    union all
    select 'hoteles', m.id, m.organization_id, m.channel, m.event_type, m.last_error_class, m.created_at from hoteles.messaging_outbox m where m.status = 'dead'
    union all
    select 'restaurantes', m.id, m.organization_id, m.channel, m.event_type, m.last_error_class, m.created_at from restaurantes.messaging_outbox m where m.status = 'dead'
    union all
    select 'despachos', m.id, m.organization_id, m.channel, m.event_type, m.last_error, m.created_at from despachos.messaging_outbox m where m.status = 'dead'
    union all
    select 'rentas', m.id, m.organization_id, m.channel, m.event_type, m.last_error, m.created_at from rentas.messaging_outbox m where m.status = 'dead'
    union all
    select 'licitaciones', m.id, m.organization_id, m.channel, m.event_type, m.last_error, m.created_at from licitaciones.messaging_outbox m where m.status = 'dead'
  )
  select u.queue_name, u.id, u.organization_id, o.name, u.channel, u.event_type, u.error, u.created_at
  from unioned u
  join core.organization o on o.id = u.organization_id
  where (select ok from authorized)
  order by u.created_at asc
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

revoke all on function core.list_outbox_mensajes_muertos_for_superadmin(uuid, integer) from public;
grant execute on function core.list_outbox_mensajes_muertos_for_superadmin(uuid, integer) to authenticated;

-- UN mensaje muerto puntual, CON `payload` -- usado al crear el intent
-- `reencolar_mensaje_muerto` para componer el resumen legible (canal,
-- vertical, organización, destinatario enmascarado extraído del payload en
-- TS, y el error que lo mató) ANTES de guardar el intent.
create or replace function core.get_outbox_dead_message_for_superadmin(p_caller_id uuid, p_queue text, p_mensaje_id uuid)
returns table (queue_name text, id uuid, organization_id uuid, organization_name text, channel text, event_type text, payload jsonb, error text, created_at timestamptz)
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  with authorized as (
    select (auth.uid() is not null and auth.uid() = p_caller_id and core.is_platform_superadmin(p_caller_id)) as ok
  ),
  unioned as (
    select 'citas' as queue_name, m.id, m.organization_id, m.channel, m.event_type, m.payload, coalesce(m.last_error, m.last_error_class) as error, m.created_at from citas.messaging_outbox m where m.status = 'dead' and m.id = p_mensaje_id
    union all
    select 'hoteles', m.id, m.organization_id, m.channel, m.event_type, m.payload, m.last_error_class, m.created_at from hoteles.messaging_outbox m where m.status = 'dead' and m.id = p_mensaje_id
    union all
    select 'restaurantes', m.id, m.organization_id, m.channel, m.event_type, m.payload, m.last_error_class, m.created_at from restaurantes.messaging_outbox m where m.status = 'dead' and m.id = p_mensaje_id
    union all
    select 'despachos', m.id, m.organization_id, m.channel, m.event_type, m.payload, m.last_error, m.created_at from despachos.messaging_outbox m where m.status = 'dead' and m.id = p_mensaje_id
    union all
    select 'rentas', m.id, m.organization_id, m.channel, m.event_type, m.payload, m.last_error, m.created_at from rentas.messaging_outbox m where m.status = 'dead' and m.id = p_mensaje_id
    union all
    select 'licitaciones', m.id, m.organization_id, m.channel, m.event_type, m.payload, m.last_error, m.created_at from licitaciones.messaging_outbox m where m.status = 'dead' and m.id = p_mensaje_id
  )
  select u.queue_name, u.id, u.organization_id, o.name, u.channel, u.event_type, u.payload, u.error, u.created_at
  from unioned u
  join core.organization o on o.id = u.organization_id
  where u.queue_name = p_queue and (select ok from authorized);
$$;

revoke all on function core.get_outbox_dead_message_for_superadmin(uuid, text, uuid) from public;
grant execute on function core.get_outbox_dead_message_for_superadmin(uuid, text, uuid) to authenticated;

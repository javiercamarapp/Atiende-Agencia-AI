-- Superadmin "Fichas de agente" y "Model Ops" (SA-L-09 y SA-L-10): agregados de plataforma que alimentan
-- GET /superadmin/agentes/:ficha y GET /superadmin/model-ops (ver apps/api/src/routes/superadmin-agentes-fichas.ts).
--
-- Solo LECTURA: ninguna tabla nueva, ninguna escritura, ningun cambio a tablas existentes. Cada fuente es su PROPIA
-- funcion para que el API pueda dejar en null solo el campo cuya fuente falla (el resto de la ficha sigue).
--
--   core.get_fichas_documentos_extraidos_for_superadmin -- documentos y requisitos extraidos por el LLM (licitaciones)
--   core.get_fichas_conciliados_for_superadmin          -- movimientos conciliados (motor, LLM aprobado, manual) y sugerencias (despachos)
--   core.get_fichas_voz_por_vertical_for_superadmin     -- minutos y costo de voz por vertical (core.usage_cost_event)
--   core.get_fichas_actividad_diaria_for_superadmin     -- serie diaria de llamadas, costo y fallbacks por rol (core.llm_usage_daily)
--   core.get_fichas_modelos_por_rol_for_superadmin      -- costo y llamadas por rol, proveedor, modelo y carril (core.llm_usage_daily)
--
-- Llamadas, costo y fallbacks historicos por rol NO tienen funcion nueva: el API reutiliza
-- core.get_consola_agentes_actividad_for_superadmin (0042). Conversaciones de WhatsApp por vertical tampoco:
-- core.get_consola_conversaciones_wa_for_superadmin (0042).
--
-- Requiere: 0010 (core.llm_usage_daily), 0012 (core.is_platform_superadmin), 0028 (core.usage_cost_event).
-- Las tablas de licitaciones y despachos se leen con EXCEPTION WHEN undefined_table/undefined_column/
-- insufficient_privilege: una vertical cuya migracion no se aplico devuelve una fila con
-- `razon = 'fuente_no_migrada'`, nunca un error ni un 0 inventado.
--
-- Definiciones (cada cifra dice de que tabla sale, para que un revisor la contraste con el diff):
--   * Documentos extraidos = documentos de bases DISTINTOS (licitaciones.requirement_item.document_id) con al menos
--     un requisito extraido por el LLM (extracted_by = 'llm') y no invalidado. Requisitos = esas mismas filas.
--   * Movimientos conciliados = matches VIGENTES (deshecho_en is null) de despachos.conciliacion_match; hay a lo
--     mucho uno por movimiento (indice unico parcial). Se desglosa por origen (motor, llm_aprobado, manual).
--   * Dia de negocio de la serie diaria: `usage_date` es una columna `date` que el gateway escribe con el dia del
--     servidor de Postgres; se usa tal cual (el API pide el rango en hora de Mexico). Estas funciones no leen
--     current_date: el rango lo decide el API.
--
-- Justificacion de seguridad (cada funcion trae su razon):
--   * Las cinco funciones son `security definer` con `search_path = core, pg_temp` fijo y todas las tablas de
--     vertical calificadas con su esquema. Razon: `authenticated` no tiene GRANT sobre core.llm_usage_daily,
--     core.usage_cost_event, licitaciones.requirement_item ni despachos.conciliacion_*; solo estas funciones las
--     leen, y solo para agregarlas (conteos y sumas): no se lee ningun nombre, telefono, mensaje, texto de
--     requisito ni contenido de movimiento bancario.
--   * Todas exigen `auth.uid() = p_caller_id` y `core.is_platform_superadmin(p_caller_id)` (mismo patron que
--     0030/0042). Un caller que no es superadmin, un uid que no coincide o una sesion de sistema (auth.uid()
--     null) recibe CERO filas, nunca un error que confirme o niegue si hay datos.
--   * REVOKE ALL de public y anon + GRANT EXECUTE solo a authenticated. Razon: anon nunca ejecuta nada de
--     plataforma; el cierre real es el guard interno de cada funcion.
--   * Rango de las dos series acotado a 400 dias (22023 si se excede): evita que un caller superadmin materialice
--     una serie arbitrariamente larga por error.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) Documentos y requisitos extraidos por el LLM (licitaciones)
-- ═══════════════════════════════════════════════════════════════════════════
-- Siempre devuelve UNA fila para un superadmin: con cifras, o con `razon = 'fuente_no_migrada'` y las cifras null.
create or replace function core.get_fichas_documentos_extraidos_for_superadmin(p_caller_id uuid)
returns table (documentos bigint, requisitos bigint, licitaciones bigint, razon text)
language plpgsql stable security definer set search_path = core, pg_temp as $$
#variable_conflict use_column
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  begin
    return query
      select count(distinct ri.document_id)::bigint, count(*)::bigint, count(distinct ri.tender_id)::bigint, null::text
      from licitaciones.requirement_item ri
      where ri.extracted_by = 'llm' and ri.invalidated_at is null;
  exception when undefined_table or undefined_column or insufficient_privilege then
    return query select null::bigint, null::bigint, null::bigint, 'fuente_no_migrada'::text;
  end;
end;
$$;
revoke all on function core.get_fichas_documentos_extraidos_for_superadmin(uuid) from public, anon;
grant execute on function core.get_fichas_documentos_extraidos_for_superadmin(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) Movimientos conciliados y sugerencias del nivel 4 (despachos)
-- ═══════════════════════════════════════════════════════════════════════════
-- Siempre devuelve UNA fila para un superadmin. `sugerencias_*` salen de despachos.conciliacion_sugerencia.
create or replace function core.get_fichas_conciliados_for_superadmin(p_caller_id uuid)
returns table (
  movimientos_conciliados bigint, por_motor bigint, por_llm_aprobado bigint, por_manual bigint,
  sugerencias_pendientes bigint, sugerencias_total bigint, razon text
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
#variable_conflict use_column
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  begin
    return query
      select
        (select count(*) from despachos.conciliacion_match m where m.deshecho_en is null)::bigint,
        (select count(*) from despachos.conciliacion_match m where m.deshecho_en is null and m.origen = 'motor')::bigint,
        (select count(*) from despachos.conciliacion_match m where m.deshecho_en is null and m.origen = 'llm_aprobado')::bigint,
        (select count(*) from despachos.conciliacion_match m where m.deshecho_en is null and m.origen = 'manual')::bigint,
        (select count(*) from despachos.conciliacion_sugerencia s where s.estado = 'pendiente')::bigint,
        (select count(*) from despachos.conciliacion_sugerencia s)::bigint,
        null::text;
  exception when undefined_table or undefined_column or insufficient_privilege then
    return query select null::bigint, null::bigint, null::bigint, null::bigint, null::bigint, null::bigint, 'fuente_no_migrada'::text;
  end;
end;
$$;
revoke all on function core.get_fichas_conciliados_for_superadmin(uuid) from public, anon;
grant execute on function core.get_fichas_conciliados_for_superadmin(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3) Voz por vertical (minutos y costo)
-- ═══════════════════════════════════════════════════════════════════════════
-- Mismo criterio de minutos que core.get_consola_costo_historico_for_superadmin (0042): unidad minuto, o segundo / 60.
-- Una fila por vertical con eventos de voz; una vertical sin eventos no aparece (el API la pinta "sin eventos de voz").
create or replace function core.get_fichas_voz_por_vertical_for_superadmin(p_caller_id uuid)
returns table (vertical text, minutos_voz numeric, costo_micro_usd bigint, eventos bigint)
language plpgsql stable security definer set search_path = core, pg_temp as $$
#variable_conflict use_column
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  return query
    select e.vertical,
      coalesce(sum(case e.unidad when 'minuto' then e.cantidad when 'segundo' then e.cantidad / 60 else 0 end), 0)::numeric,
      coalesce(sum(e.costo_micro_usd), 0)::bigint,
      count(*)::bigint
    from core.usage_cost_event e
    where e.categoria = 'voz'
    group by e.vertical
    order by e.vertical;
end;
$$;
revoke all on function core.get_fichas_voz_por_vertical_for_superadmin(uuid) from public, anon;
grant execute on function core.get_fichas_voz_por_vertical_for_superadmin(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4) Serie diaria por rol (llamadas, costo y fallbacks)
-- ═══════════════════════════════════════════════════════════════════════════
-- Solo filas de dias CON consumo (por vertical y rol); el API rellena los dias sin consumo con 0 porque la fuente SI
-- se leyo. Rango inclusivo [p_desde, p_hasta], maximo 400 dias.
create or replace function core.get_fichas_actividad_diaria_for_superadmin(p_caller_id uuid, p_desde date, p_hasta date)
returns table (dia date, vertical text, role text, llamadas bigint, costo_micro_usd bigint, fallbacks bigint)
language plpgsql stable security definer set search_path = core, pg_temp as $$
#variable_conflict use_column
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 400 then
    raise exception 'get_fichas_actividad_diaria_for_superadmin: rango invalido (maximo 400 dias)' using errcode = '22023';
  end if;
  return query
    select u.usage_date, u.vertical, u.role,
      coalesce(sum(u.call_count), 0)::bigint, coalesce(sum(u.cost_micro_usd), 0)::bigint, coalesce(sum(u.fallback_call_count), 0)::bigint
    from core.llm_usage_daily u
    where u.usage_date between p_desde and p_hasta
    group by u.usage_date, u.vertical, u.role
    order by u.usage_date, u.vertical, u.role;
end;
$$;
revoke all on function core.get_fichas_actividad_diaria_for_superadmin(uuid, date, date) from public, anon;
grant execute on function core.get_fichas_actividad_diaria_for_superadmin(uuid, date, date) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5) Costo y llamadas por rol, proveedor, modelo y carril
-- ═══════════════════════════════════════════════════════════════════════════
-- Alimenta la tabla "costo por modelo" de cada ficha y las tarjetas de Model Ops (carril REAL con el que se uso cada
-- rol, llamadas y costo del rango, fallbacks). Rango inclusivo [p_desde, p_hasta], maximo 400 dias.
create or replace function core.get_fichas_modelos_por_rol_for_superadmin(p_caller_id uuid, p_desde date, p_hasta date)
returns table (
  vertical text, role text, provider_id text, model text, lane text,
  llamadas bigint, fallbacks bigint, costo_micro_usd bigint, tokens_in bigint, tokens_out bigint
)
language plpgsql stable security definer set search_path = core, pg_temp as $$
#variable_conflict use_column
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 400 then
    raise exception 'get_fichas_modelos_por_rol_for_superadmin: rango invalido (maximo 400 dias)' using errcode = '22023';
  end if;
  return query
    select u.vertical, u.role, u.provider_id, u.model, u.lane,
      coalesce(sum(u.call_count), 0)::bigint, coalesce(sum(u.fallback_call_count), 0)::bigint, coalesce(sum(u.cost_micro_usd), 0)::bigint,
      coalesce(sum(u.tokens_in), 0)::bigint, coalesce(sum(u.tokens_out), 0)::bigint
    from core.llm_usage_daily u
    where u.usage_date between p_desde and p_hasta
    group by u.vertical, u.role, u.provider_id, u.model, u.lane
    order by 8 desc, u.vertical, u.role, u.model;
end;
$$;
revoke all on function core.get_fichas_modelos_por_rol_for_superadmin(uuid, date, date) from public, anon;
grant execute on function core.get_fichas_modelos_por_rol_for_superadmin(uuid, date, date) to authenticated;

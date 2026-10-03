-- CHAT-16 -- Copiloto de superadmin (alcance 'plataforma'): bitacora de consultas sin organizacion, medicion del gasto del
-- propio Copiloto y reporte de uso.
--
-- Que agrega (todo aditivo; ninguna tabla ni funcion existente cambia de comportamiento para las verticales):
--   1. core.data_chat_query_log admite el alcance de plataforma: `organization_id` deja de ser obligatorio SOLO para filas con
--      vertical = 'plataforma' (CHECK de coherencia en ambos sentidos: plataforma <=> sin organizacion) y el CHECK de vertical
--      acepta 'plataforma'. Ninguna fila existente cambia (todas llevan organizacion y una de las seis verticales).
--   2. core.record_data_chat_query (sobrecarga de 11 argumentos, 0047): con p_organization_id NULL registra una fila de
--      plataforma, solo si el actor es superadmin vigente; con organizacion se comporta exactamente como antes.
--   3. core.get_copiloto_plataforma_gasto_mes: gasto del mes en curso del Copiloto de plataforma (micro-USD), para su tope mensual.
--   4. core.get_copiloto_uso_for_superadmin: consultas, filas, duracion y costo del Copiloto por vertical, resultado y ruta
--      (herramienta `uso_copiloto` del propio Copiloto de superadmin). Sin texto de preguntas ni respuestas: la bitacora no los guarda.
--
-- DECISION: como se mide el gasto del rol `superadmin:copiloto`.
--   core.llm_usage_daily (0010) exige `organization_id uuid not null references core.organization` y su CHECK de vertical admite solo
--   las 6 verticales de clientes; core.llm_org_budget / core.reserve_llm_monthly_budget topan por ORGANIZACION. El gasto del Copiloto de
--   superadmin es gasto de PLATAFORMA, no de un cliente: extender esas tablas obligaria a inventar una organizacion falsa (el mismo
--   criterio con el que `resumen-diario` ya lo rechazo) y a contaminar los reportes por organizacion (consola, CFO, P&L).
--   Por eso NO se toca llm_usage_daily ni su CHECK. El costo REAL de cada turno (lo que reporta el proveedor) queda en la fila de resumen
--   del turno de core.data_chat_query_log (vertical = 'plataforma', costo_micro_usd, modelo, rol = 'superadmin:copiloto'), que es la fuente
--   unica del gasto del Copiloto: el tope mensual propio se compara contra core.get_copiloto_plataforma_gasto_mes y el reporte contra
--   core.get_copiloto_uso_for_superadmin. El tope de plataforma global (core.llm_platform_budget) sigue protegiendo el gasto total de los
--   tenants y no se mezcla con este. El valor del tope mensual del Copiloto y su presupuesto real en produccion los fija Javier (SA-44).
--
-- Compatibilidad con la base SIN migrar: el codigo TypeScript (apps/api/src/superadmin-copiloto/) corre cada acceso en SAVEPOINT y,
-- si falta la funcion o el CHECK nuevo (42883 / 42P01 / 42703 / 23514 / 42501), cae a un log estructurado sin resultados ni PII, mide el
-- gasto en memoria de la instancia y responde "no disponible aun" en el reporte de uso. Nada de lo existente depende de este archivo.
--
-- Requiere: 0001, 0012 (core.is_platform_superadmin), 0029, 0034 (core.cfo_zone_resolve_role), 0045 y 0047 (core.data_chat_query_log,
-- record_data_chat_query de 11 args).
--
-- JUSTIFICACION DE SEGURIDAD (cada GRANT, policy y funcion nueva):
--   * core.data_chat_query_log conserva RLS activa, `revoke all` a public/anon/authenticated/service_role y el grant de select de 0029. NO se
--     agrega policy nueva: las filas de plataforma (organization_id NULL) no las ve ninguna policy existente (la de owner/admin compara con
--     una membresia de la organizacion, que no existe para NULL), asi que ningun rol de aplicacion las lee directo; solo las funciones
--     definer de abajo. La tabla sigue siendo append-only (triggers de 0029).
--   * Los CHECK nuevos acotan la forma: una fila de plataforma no puede llevar organizacion y una de cliente no puede omitirla ni etiquetarse
--     como plataforma (ninguna via puede sembrar una fila de plataforma con la identidad de un tenant).
--   * core.record_data_chat_query (11 args): conserva TODAS las defensas (actor = auth.uid(), 28000 sin actor, vertical tomada de
--     core.organization, nunca de un parametro, y los mismos CHECK de forma y tamano). La rama de plataforma exige
--     core.is_platform_superadmin(actor) (42501 si no): un staff de cualquier organizacion no puede sembrar filas de plataforma. Un superadmin
--     restringido a `finanzas` si puede registrar (su consulta tambien se audita) porque no escribe datos de negocio.
--   * core.get_copiloto_plataforma_gasto_mes: security definer, `set search_path = core, pg_temp`, revoke de public/anon, GRANT execute a
--     authenticated, exige auth.uid() = p_caller_id y core.is_platform_superadmin(p_caller_id); a cualquier otro llamador devuelve 0 sin
--     tocar la tabla. Devuelve un solo agregado (suma de costo), sin filas ni usuarios. La pueden llamar tambien los superadmin restringidos a
--     `finanzas`: el motor necesita medir el tope antes de cada turno de cualquiera de ellos.
--   * core.get_copiloto_uso_for_superadmin: security definer, search_path fijo, revoke de public/anon, GRANT execute a authenticated, exige
--     auth.uid() = p_caller_id y superadmin vigente SIN rol restringido (core.cfo_zone_resolve_role = 'superadmin'); si no, cero filas. Solo
--     agregados por vertical/resultado/ruta (conteos y costo): sin ids de usuario, sin parametros de consulta, sin texto. Acotada a 366 dias
--     y 500 filas.

-- ---------------------------------------------------------------------------
-- 1) data_chat_query_log: alcance de plataforma
-- ---------------------------------------------------------------------------
alter table core.data_chat_query_log alter column organization_id drop not null;

alter table core.data_chat_query_log drop constraint if exists data_chat_query_log_vertical_check;
alter table core.data_chat_query_log
  add constraint data_chat_query_log_vertical_check
  check (vertical in ('hoteles', 'restaurantes', 'rentas', 'licitaciones', 'citas', 'despachos', 'plataforma'));

alter table core.data_chat_query_log
  add constraint data_chat_query_log_plataforma_sin_org
  check ((vertical = 'plataforma') = (organization_id is null));

-- ---------------------------------------------------------------------------
-- 2) core.record_data_chat_query (11 argumentos) con alcance de plataforma
-- ---------------------------------------------------------------------------
create or replace function core.record_data_chat_query(
  p_organization_id uuid,
  p_tool text,
  p_params jsonb,
  p_outcome text,
  p_row_count integer,
  p_duration_ms integer,
  p_error_code text,
  p_route text,
  p_costo_micro_usd bigint,
  p_modelo text,
  p_rol text
)
returns uuid
language plpgsql
security definer
set search_path = core, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_vertical text;
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'core.record_data_chat_query: requiere un actor autenticado (auth.uid() es NULL) -- nunca corre desde la sesion de sistema.'
      using errcode = '28000';
  end if;

  if p_organization_id is null then
    -- Alcance de plataforma (Copiloto de superadmin): solo un superadmin vigente.
    if not core.is_platform_superadmin(v_actor) then
      raise exception 'core.record_data_chat_query: el actor % no es superadmin de plataforma.', v_actor
        using errcode = '42501';
    end if;
    v_vertical := 'plataforma';
  else
    if not exists (select 1 from core.membership m where m.organization_id = p_organization_id and m.user_id = v_actor) then
      raise exception 'core.record_data_chat_query: el actor % no pertenece a la organizacion %.', v_actor, p_organization_id
        using errcode = '42501';
    end if;
    select o.vertical into v_vertical from core.organization o where o.id = p_organization_id;
  end if;

  insert into core.data_chat_query_log (organization_id, user_id, vertical, tool, params, outcome, row_count, duration_ms, error_code, route, costo_micro_usd, modelo, rol)
  values (
    p_organization_id,
    v_actor,
    v_vertical,
    nullif(regexp_replace(lower(left(p_tool, 80)), '[^a-z0-9_]', '_', 'g'), ''),
    case when p_params is not null and jsonb_typeof(p_params) = 'object' then p_params else '{}'::jsonb end,
    p_outcome,
    greatest(coalesce(p_row_count, 0), 0),
    greatest(coalesce(p_duration_ms, 0), 0),
    left(p_error_code, 60),
    case when p_route in ('directa', 'cache', 'llm', 'escalado', 'sin_ia') then p_route else null end,
    case when p_costo_micro_usd is null then null else greatest(p_costo_micro_usd, 0) end,
    left(p_modelo, 80),
    case when p_rol ~ '^[a-z0-9_]+:[a-z0-9_]+$' then p_rol else null end
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function core.record_data_chat_query(uuid, text, jsonb, text, integer, integer, text, text, bigint, text, text) from public, anon;
grant execute on function core.record_data_chat_query(uuid, text, jsonb, text, integer, integer, text, text, bigint, text, text) to authenticated;

comment on function core.record_data_chat_query(uuid, text, jsonb, text, integer, integer, text, text, bigint, text, text) is
  'Bitacora del Copiloto: costo real, modelo y rol del turno. Con organizacion NULL registra una fila de plataforma (solo superadmin vigente).';

-- ---------------------------------------------------------------------------
-- 3) Gasto del mes en curso del Copiloto de plataforma (para su tope mensual propio)
-- ---------------------------------------------------------------------------
create or replace function core.get_copiloto_plataforma_gasto_mes(p_caller_id uuid)
returns bigint
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return 0;
  end if;
  return (
    select coalesce(sum(l.costo_micro_usd), 0)::bigint
      from core.data_chat_query_log l
     where l.vertical = 'plataforma'
       and l.created_at >= date_trunc('month', now())
  );
end;
$$;

revoke all on function core.get_copiloto_plataforma_gasto_mes(uuid) from public, anon;
grant execute on function core.get_copiloto_plataforma_gasto_mes(uuid) to authenticated;

comment on function core.get_copiloto_plataforma_gasto_mes(uuid) is
  'Gasto real (micro-USD) del mes en curso del Copiloto de superadmin, sumado de core.data_chat_query_log (vertical plataforma).';

-- ---------------------------------------------------------------------------
-- 4) Uso del Copiloto por vertical, resultado y ruta
-- ---------------------------------------------------------------------------
create or replace function core.get_copiloto_uso_for_superadmin(p_caller_id uuid, p_from date, p_to date)
returns table (
  vertical text,
  outcome text,
  route text,
  consultas bigint,
  filas bigint,
  duracion_ms bigint,
  costo_micro_usd bigint
)
language plpgsql
stable
security definer
set search_path = core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id or not core.is_platform_superadmin(p_caller_id) then
    return;
  end if;
  -- Un superadmin restringido a `finanzas` no lee el uso del Copiloto (solo ve herramientas financieras).
  if core.cfo_zone_resolve_role(p_caller_id) is distinct from 'superadmin' then
    return;
  end if;
  if p_from is null or p_to is null or p_to < p_from or (p_to - p_from) > 366 then
    return;
  end if;
  return query
    select l.vertical, l.outcome, l.route,
           count(*)::bigint,
           coalesce(sum(l.row_count), 0)::bigint,
           coalesce(sum(l.duration_ms), 0)::bigint,
           coalesce(sum(l.costo_micro_usd), 0)::bigint
      from core.data_chat_query_log l
     where l.created_at >= p_from
       and l.created_at < (p_to + 1)
     group by l.vertical, l.outcome, l.route
     order by count(*) desc, l.vertical, l.outcome, l.route nulls last
     limit 500;
end;
$$;

revoke all on function core.get_copiloto_uso_for_superadmin(uuid, date, date) from public, anon;
grant execute on function core.get_copiloto_uso_for_superadmin(uuid, date, date) to authenticated;

comment on function core.get_copiloto_uso_for_superadmin(uuid, date, date) is
  'Uso agregado del Copiloto (todas las verticales y plataforma): consultas, filas, duracion y costo; sin texto ni usuarios. Solo superadmin completo.';

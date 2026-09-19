-- Fase 10c rentas -- lectores restantes del break-glass de superadmin. Cierra el
-- gap DOCUMENTADO por `018_break_glass_wiring.sql` (sección "Fuera de alcance") y
-- por el README de scripts/verify-rentas-break-glass/: "solo `resourceType:
-- 'reservas'` tiene un lector concreto hoy... agregar cada categoría adicional
-- es una extensión del mismo mecanismo (nueva función `security definer` + nuevo
-- método del puerto), no un rediseño" -- exactamente lo que esta migración hace,
-- para las 6 categorías que faltaban (finanzas, payouts, pricing, mensajeria,
-- limpieza -- cubre limpieza Y mantenimiento, ver `rentas.tarea_operativa.tipo`
-- -- y sync_ical), más el filtro opcional por propiedad, también documentado
-- como pendiente en el mismo README ("`list_reservas_for_break_glass` no lo usa
-- todavía para filtrar -- lee TODO el tenant").
--
-- MISMO PATRÓN DE AUTORIZACIÓN, EXACTO, que `rentas.list_reservas_for_break_glass`
-- (018_break_glass_wiring.sql sección 3) en las 7 funciones de abajo (las 6
-- nuevas + la de reservas, actualizada aquí para el filtro por propiedad):
--   1. `auth.uid() is null or auth.uid() <> p_caller_id` -> 42501 (nunca confía
--      en el parámetro, siempre lo ata a la sesión real).
--   2. `not rentas.is_platform_superadmin(p_caller_id)` -> 42501 (fuente de
--      verdad real, `core.platform_superadmin`, no el proxy débil que
--      `018_break_glass_wiring.sql` ya corrigió).
--   3. Sin una `rentas.break_glass_session` VIGENTE (sin cerrar, sin vencer)
--      para exactamente ese actor+organización -> 42501. Ninguna de estas 7
--      funciones abre una policy de tabla nueva ni relaja ningún GRANT
--      existente -- cada una es `security definer`, dueña de su propia
--      autorización completa, sobre la sesión por-request real del superadmin
--      (nunca `engine.admin`/`service_role`, ver el comentario de cabecera de
--      `postgres-data-repository.ts` para el porqué completo).
--
-- FILTRO POR PROPIEDAD (`p_property_id`, puede ser NULL = "todo el tenant"):
-- las 7 tablas fuente (`reserva_financiero`/`payout_canal`/`tarifa_base`/
-- `conversacion`/`tarea_operativa`/`canal_feed_externo`/`ocupacion`) ya tienen
-- `property_id` directo (top-level, mismo criterio documentado en cada
-- migración de origen -- 003/005/002/009/010/008/001), así que el filtro es un
-- `where` adicional, sin ningún join nuevo. Si se declara `p_property_id`, se
-- exige que pertenezca a `p_organization_id` (mismo criterio de defensa en
-- profundidad que el resto de este mecanismo) -- error `P0002` explícito,
-- nunca "cero filas" silencioso que se confundiría con "sin datos".
--
-- PAGINADO CON TOPE: `p_limit`/`p_offset`, mismo criterio en las 7 -- el tope
-- real (`BREAK_GLASS_LECTOR_LIMIT_MAX` = 200 en TypeScript, ver tipos.ts) se
-- refuerza aquí también con `least()` -- defensa en profundidad DB-side, nunca
-- la única barrera (un caller que se saltara la capa TS -- imposible hoy, pero
-- el criterio del resto de este mecanismo es no asumirlo -- seguiría acotado).
--
-- LOS 3 PARÁMETROS NUEVOS SON OBLIGATORIOS (nunca `default`), a propósito --
-- ver el comentario de la sección 0 para el porqué exacto: un `default` aquí
-- haría que esta función fuera invocable con solo 2 argumentos, lo mismo que
-- la función de 2 parámetros YA EXISTENTE de `018_break_glass_wiring.sql`
-- (`list_reservas_for_break_glass`) -- Postgres NO puede elegir entre dos
-- funciones candidatas igual de válidas para esa llamada
-- (`function ... is not unique`), así que CUALQUIER llamada con 2 argumentos a
-- ese nombre (incluida la del propio fallback de compatibilidad, ver el
-- comentario de la sección 0) se habría roto en cuanto esta migración se
-- aplicara. `PostgresBreakGlassRentasDataRepository` siempre pasa los 5
-- argumentos (o los 2 de la sobrecarga vieja, nunca una mezcla) -- ver ese
-- archivo.
--
-- ENMASCARADO DE SECRETO: `rentas.canal_feed_externo.url_importacion` es la URL
-- de import de un feed .ics externo -- su propia migración (008) documenta que
-- el DISEÑO de este monorepo nunca guarda credenciales ahí (solo https, o
-- http+simulador.local en desarrollo), pero en la práctica real de las OTAs
-- (Airbnb en particular) esa URL SÍ suele llevar un token de un solo uso
-- embebido en el path/query -- exactamente el tipo de dato que el mandato de
-- esta fase prohíbe devolver ("nunca tokens de iCal/OTA... enmascara"). El
-- lector de `sync_ical` de abajo devuelve solo esquema+host
-- (`regexp_replace`), nunca el path/query completo.
--
-- Requiere: 018_break_glass_wiring.sql (rentas.is_platform_superadmin,
-- rentas.break_glass_session), 002/003/005/008/009/010 (las tablas fuente).

-- ═══════════════════════════════════════════════════════════════════════════
-- 0) rentas.list_reservas_for_break_glass -- se agrega el filtro opcional por
--    propiedad + paginado con tope. Firma NUEVA (2→5 parámetros, LOS 3
--    NUEVOS SIN DEFAULT -- ver el porqué exacto más abajo) -- Postgres NO
--    reemplaza la función de 2 parámetros de 018_break_glass_wiring.sql
--    (permanece intacta, otra sobrecarga válida, sin ambigüedad posible
--    porque ninguna llamada puede resolver a las dos a la vez), así que el
--    código YA desplegado contra la base vieja sigue funcionando sin cambios
--    mientras esta migración no se aplique -- ver
--    PostgresBreakGlassRentasDataRepository.listReservasTenant para el fallback
--    real (SQLSTATE 42883) que usa la sobrecarga vieja + filtra/pagina en
--    TypeScript cuando esta función nueva todavía no existe.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function rentas.list_reservas_for_break_glass(
  p_caller_id uuid,
  p_organization_id uuid,
  p_property_id uuid,
  p_limit integer,
  p_offset integer
)
returns table (
  ocupacion_id uuid,
  property_id uuid,
  unidad_id uuid,
  check_in text,
  check_out text,
  estado text,
  huesped_nombre text,
  huesped_contacto text
)
language plpgsql
stable
security definer
set search_path = rentas, core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'list_reservas_for_break_glass: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
  if not rentas.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (
    select 1 from rentas.break_glass_session s
    where s.actor_user_id = p_caller_id
      and s.organization_id = p_organization_id
      and s.closed_at is null
      and s.expires_at > now()
  ) then
    raise exception 'sin acceso de romper-cristal activo y vigente para esta organización' using errcode = '42501';
  end if;
  if p_property_id is not null and not exists (
    select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id
  ) then
    raise exception 'la propiedad indicada no pertenece a esta organización' using errcode = 'P0002';
  end if;

  return query
    select o.id, o.property_id, o.unidad_id,
           lower(o.rango)::text, upper(o.rango)::text,
           o.estado, g.nombre, g.contacto
    from rentas.ocupacion o
    left join rentas.guest_minimo g on g.id = o.huesped_minimo_id
    where o.organization_id = p_organization_id and o.capa = 'reserva'
      and (p_property_id is null or o.property_id = p_property_id)
    order by lower(o.rango) desc
    limit least(coalesce(p_limit, 100), 200)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function rentas.list_reservas_for_break_glass(uuid, uuid, uuid, integer, integer) from public;
grant execute on function rentas.list_reservas_for_break_glass(uuid, uuid, uuid, integer, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 1) finanzas -- rentas.reserva_financiero (003_finanzas_schema.sql). Sin dato
--    a enmascarar (solo montos en centavos, ninguna cuenta bancaria -- este
--    monorepo no guarda datos bancarios de owner en ninguna tabla, verificado
--    contra 006_owner_portal_schema.sql/001_rentas_schema.sql).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function rentas.list_finanzas_for_break_glass(
  p_caller_id uuid,
  p_organization_id uuid,
  p_property_id uuid,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  ocupacion_id uuid,
  property_id uuid,
  moneda char(3),
  monto_bruto_centavos bigint,
  comision_canal_centavos bigint,
  comision_gestor_centavos bigint,
  gastos_centavos bigint,
  impuestos_centavos bigint,
  neto_centavos bigint,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = rentas, core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'list_finanzas_for_break_glass: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
  if not rentas.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (
    select 1 from rentas.break_glass_session s
    where s.actor_user_id = p_caller_id
      and s.organization_id = p_organization_id
      and s.closed_at is null
      and s.expires_at > now()
  ) then
    raise exception 'sin acceso de romper-cristal activo y vigente para esta organización' using errcode = '42501';
  end if;
  if p_property_id is not null and not exists (
    select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id
  ) then
    raise exception 'la propiedad indicada no pertenece a esta organización' using errcode = 'P0002';
  end if;

  return query
    select rf.id, rf.ocupacion_id, rf.property_id, rf.moneda, rf.monto_bruto_centavos,
           rf.comision_canal_centavos, rf.comision_gestor_centavos, rf.gastos_centavos,
           rf.impuestos_centavos, rf.neto_centavos, rf.created_at
    from rentas.reserva_financiero rf
    where rf.organization_id = p_organization_id
      and (p_property_id is null or rf.property_id = p_property_id)
    order by rf.created_at desc
    limit least(coalesce(p_limit, 100), 200)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function rentas.list_finanzas_for_break_glass(uuid, uuid, uuid, integer, integer) from public;
grant execute on function rentas.list_finanzas_for_break_glass(uuid, uuid, uuid, integer, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2) payouts -- rentas.payout_canal (005_finanzas_statement_payout_schema.sql).
--    Nivel de canal (no de línea individual) -- mismo alcance mínimo que
--    `BreakGlassReservaResumen` (deliberadamente resumido, ver tipos.ts). Sin
--    dato bancario -- este esquema no lo tiene (`referencia_externa` es texto
--    libre operativo, ej. "lote #42", nunca CLABE/IBAN).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function rentas.list_payouts_for_break_glass(
  p_caller_id uuid,
  p_organization_id uuid,
  p_property_id uuid,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  property_id uuid,
  canal_id uuid,
  referencia_externa text,
  moneda char(3),
  monto_total_centavos bigint,
  fecha_payout date,
  creado_en timestamptz
)
language plpgsql
stable
security definer
set search_path = rentas, core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'list_payouts_for_break_glass: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
  if not rentas.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (
    select 1 from rentas.break_glass_session s
    where s.actor_user_id = p_caller_id
      and s.organization_id = p_organization_id
      and s.closed_at is null
      and s.expires_at > now()
  ) then
    raise exception 'sin acceso de romper-cristal activo y vigente para esta organización' using errcode = '42501';
  end if;
  if p_property_id is not null and not exists (
    select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id
  ) then
    raise exception 'la propiedad indicada no pertenece a esta organización' using errcode = 'P0002';
  end if;

  return query
    select pc.id, pc.property_id, pc.canal_id, pc.referencia_externa, pc.moneda,
           pc.monto_total_centavos, pc.fecha_payout, pc.creado_en
    from rentas.payout_canal pc
    where pc.organization_id = p_organization_id
      and (p_property_id is null or pc.property_id = p_property_id)
    order by pc.fecha_payout desc
    limit least(coalesce(p_limit, 100), 200)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function rentas.list_payouts_for_break_glass(uuid, uuid, uuid, integer, integer) from public;
grant execute on function rentas.list_payouts_for_break_glass(uuid, uuid, uuid, integer, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 3) pricing -- rentas.tarifa_base (002_pricing_schema.sql), la tarifa VIGENTE
--    por unidad (no temporadas/descuentos/min-stay/reglas de canal -- mismo
--    criterio de "resumen mínimo" que el resto de estos lectores; un lector
--    adicional para el resto de tarifa_* es una extensión de este mismo
--    mecanismo, no un rediseño, mismo criterio documentado en data-repository.ts).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function rentas.list_pricing_for_break_glass(
  p_caller_id uuid,
  p_organization_id uuid,
  p_property_id uuid,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  property_id uuid,
  unidad_id uuid,
  precio_noche_centavos bigint,
  moneda char(3),
  vigente_desde date
)
language plpgsql
stable
security definer
set search_path = rentas, core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'list_pricing_for_break_glass: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
  if not rentas.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (
    select 1 from rentas.break_glass_session s
    where s.actor_user_id = p_caller_id
      and s.organization_id = p_organization_id
      and s.closed_at is null
      and s.expires_at > now()
  ) then
    raise exception 'sin acceso de romper-cristal activo y vigente para esta organización' using errcode = '42501';
  end if;
  if p_property_id is not null and not exists (
    select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id
  ) then
    raise exception 'la propiedad indicada no pertenece a esta organización' using errcode = 'P0002';
  end if;

  return query
    select tb.id, tb.property_id, tb.unidad_id, tb.precio_noche_centavos, tb.moneda, tb.vigente_desde
    from rentas.tarifa_base tb
    where tb.organization_id = p_organization_id
      and (p_property_id is null or tb.property_id = p_property_id)
    order by tb.vigente_desde desc
    limit least(coalesce(p_limit, 100), 200)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function rentas.list_pricing_for_break_glass(uuid, uuid, uuid, integer, integer) from public;
grant execute on function rentas.list_pricing_for_break_glass(uuid, uuid, uuid, integer, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 4) mensajeria -- rentas.conversacion (009_rentas_mensajeria_schema.sql), un
--    resumen por CONVERSACIÓN (no el contenido de cada mensaje -- ese es un
--    lector más granular, fuera de alcance de esta fase, mismo criterio de "un
--    flujo a la vez"). `rentas.conversacion` no guarda contacto del huésped
--    (teléfono/email) -- solo `huesped_nombre` -- así que no hay nada que
--    enmascarar aquí a diferencia de `list_reservas_for_break_glass`, que sí
--    expone `huesped_contacto` (comportamiento YA EXISTENTE de PR #132, sin
--    tocar en esta fase).
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function rentas.list_mensajeria_for_break_glass(
  p_caller_id uuid,
  p_organization_id uuid,
  p_property_id uuid,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  property_id uuid,
  unidad_id uuid,
  canal_codigo text,
  huesped_nombre text,
  fecha_check_in date,
  fecha_check_out date,
  reserva_confirmada boolean,
  creado_en timestamptz
)
language plpgsql
stable
security definer
set search_path = rentas, core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'list_mensajeria_for_break_glass: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
  if not rentas.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (
    select 1 from rentas.break_glass_session s
    where s.actor_user_id = p_caller_id
      and s.organization_id = p_organization_id
      and s.closed_at is null
      and s.expires_at > now()
  ) then
    raise exception 'sin acceso de romper-cristal activo y vigente para esta organización' using errcode = '42501';
  end if;
  if p_property_id is not null and not exists (
    select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id
  ) then
    raise exception 'la propiedad indicada no pertenece a esta organización' using errcode = 'P0002';
  end if;

  return query
    select c.id, c.property_id, c.unidad_id, c.canal_codigo, c.huesped_nombre,
           c.fecha_check_in, c.fecha_check_out, c.reserva_confirmada, c.creado_en
    from rentas.conversacion c
    where c.organization_id = p_organization_id
      and (p_property_id is null or c.property_id = p_property_id)
    order by c.creado_en desc
    limit least(coalesce(p_limit, 100), 200)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function rentas.list_mensajeria_for_break_glass(uuid, uuid, uuid, integer, integer) from public;
grant execute on function rentas.list_mensajeria_for_break_glass(uuid, uuid, uuid, integer, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 5) limpieza -- rentas.tarea_operativa (010_rentas_limpieza_schema.sql). Cubre
--    limpieza Y mantenimiento (y también 'inspeccion') en un solo lector -- las
--    tres son el mismo `tipo` en la misma tabla, nunca esquemas separados (ver
--    el CHECK `tipo in ('limpieza', 'mantenimiento', 'inspeccion')` de esa
--    migración); dividirlas en dos lectores sería un rediseño artificial de
--    algo que el propio esquema ya modela como una sola categoría operativa.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function rentas.list_limpieza_for_break_glass(
  p_caller_id uuid,
  p_organization_id uuid,
  p_property_id uuid,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  property_id uuid,
  unidad_id uuid,
  tipo text,
  estado text,
  prioridad text,
  programada_para date,
  completada_en timestamptz,
  creado_en timestamptz
)
language plpgsql
stable
security definer
set search_path = rentas, core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'list_limpieza_for_break_glass: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
  if not rentas.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (
    select 1 from rentas.break_glass_session s
    where s.actor_user_id = p_caller_id
      and s.organization_id = p_organization_id
      and s.closed_at is null
      and s.expires_at > now()
  ) then
    raise exception 'sin acceso de romper-cristal activo y vigente para esta organización' using errcode = '42501';
  end if;
  if p_property_id is not null and not exists (
    select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id
  ) then
    raise exception 'la propiedad indicada no pertenece a esta organización' using errcode = 'P0002';
  end if;

  return query
    select t.id, t.property_id, t.unidad_id, t.tipo, t.estado, t.prioridad,
           t.programada_para, t.completada_en, t.creado_en
    from rentas.tarea_operativa t
    where t.organization_id = p_organization_id
      and (p_property_id is null or t.property_id = p_property_id)
    order by t.creado_en desc
    limit least(coalesce(p_limit, 100), 200)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function rentas.list_limpieza_for_break_glass(uuid, uuid, uuid, integer, integer) from public;
grant execute on function rentas.list_limpieza_for_break_glass(uuid, uuid, uuid, integer, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 6) sync_ical -- rentas.canal_feed_externo (008_ical_sync_schema.sql). ÚNICO
--    lector de esta fase con un dato a enmascarar de verdad --
--    `url_importacion` puede llevar un token de un solo uso embebido en el
--    path/query en la práctica real de una OTA (Airbnb en particular), aunque
--    el diseño de esta tabla documente que "no debería" llevar credenciales.
--    `regexp_replace` deja solo esquema+host (ej. "https://www.airbnb.com/***"),
--    nunca el path/query completo -- mandato explícito de esta fase ("nunca
--    tokens de iCal/OTA... enmascara").
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function rentas.list_sync_ical_for_break_glass(
  p_caller_id uuid,
  p_organization_id uuid,
  p_property_id uuid,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  property_id uuid,
  unidad_id uuid,
  canal_id uuid,
  url_importacion_enmascarada text,
  activo boolean,
  ultima_sincronizacion_exitosa_en timestamptz,
  en_cuarentena_desde timestamptz,
  intentos_fallidos_consecutivos integer,
  motivo_cuarentena text
)
language plpgsql
stable
security definer
set search_path = rentas, core, pg_temp
as $$
begin
  if auth.uid() is null or auth.uid() <> p_caller_id then
    raise exception 'list_sync_ical_for_break_glass: el caller autenticado debe coincidir con p_caller_id' using errcode = '42501';
  end if;
  if not rentas.is_platform_superadmin(p_caller_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (
    select 1 from rentas.break_glass_session s
    where s.actor_user_id = p_caller_id
      and s.organization_id = p_organization_id
      and s.closed_at is null
      and s.expires_at > now()
  ) then
    raise exception 'sin acceso de romper-cristal activo y vigente para esta organización' using errcode = '42501';
  end if;
  if p_property_id is not null and not exists (
    select 1 from core.property p where p.id = p_property_id and p.organization_id = p_organization_id
  ) then
    raise exception 'la propiedad indicada no pertenece a esta organización' using errcode = 'P0002';
  end if;

  return query
    select f.id, f.property_id, f.unidad_id, f.canal_id,
           regexp_replace(f.url_importacion, '^(https?://[^/]+).*$', '\1/***') as url_importacion_enmascarada,
           f.activo, f.ultima_sincronizacion_exitosa_en, f.en_cuarentena_desde,
           f.intentos_fallidos_consecutivos, f.motivo_cuarentena
    from rentas.canal_feed_externo f
    where f.organization_id = p_organization_id
      and (p_property_id is null or f.property_id = p_property_id)
    order by f.updated_at desc
    limit least(coalesce(p_limit, 100), 200)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function rentas.list_sync_ical_for_break_glass(uuid, uuid, uuid, integer, integer) from public;
grant execute on function rentas.list_sync_ical_for_break_glass(uuid, uuid, uuid, integer, integer) to authenticated;

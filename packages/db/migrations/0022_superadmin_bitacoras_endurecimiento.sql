-- ENDURECIMIENTO de las dos bitácoras append-only de plataforma (superadmin)
-- ya publicadas: 0020_superadmin_impersonacion.sql y
-- 0021_superadmin_authz_audit_log.sql -- ambas INMUTABLES, esta migración
-- solo agrega columnas/índices/constraints ADITIVOS y reemplaza (`create or
-- replace`) las funciones de esas dos migraciones con el MISMO nombre y la
-- MISMA firma -- nunca las recrea ni cambia su tipo de retorno. Tres partes
-- independientes, agrupadas aquí por ser la ÚNICA migración de packages/db
-- que esta tanda tiene asignada (ver AGENTS.md de la tarea -- como mucho 2
-- migraciones nuevas, y la segunda "solo si de verdad se necesita"; las tres
-- caben en una sola porque ninguna depende de una tabla nueva, solo de
-- 0020/0021 ya publicadas):
--
--   A) core.authz_audit_log (PR #172): el tope defensivo de ráfaga de
--      0021 era GLOBAL (5000 filas/10 min, sin distinguir actor) y se podía
--      agotar con una sola cuenta autenticada variando de ruta -- desde ahí,
--      las denegaciones de TODOS los demás actores se perdían en silencio
--      durante el resto de la ventana (robustez del registro, no una
--      vulnerabilidad de acceso: ningún dato ajeno se expone, lo que se
--      pierde es la EVIDENCIA de que hubo denegaciones). Se agrega un tope
--      POR ACTOR (mucho más bajo) más el tope global de antes, ahora mucho
--      más alto, como última red -- y, en vez de descartar mudo, una fila
--      marcador de desborde (una por actor+ventana, nunca una por evento
--      descartado).
--   B) core.impersonation_audit_log (PR #162): `occurred_at` usa
--      `default now()`, que es CONSTANTE dentro de una transacción de
--      Postgres -- las filas de una misma transacción empatan y
--      `list_impersonation_audit_log_for_superadmin` las ordenaba solo por
--      `occurred_at desc`, sin desempate, dando un orden no determinista (y
--      una paginación por offset inestable). La tabla YA tiene una columna
--      `seq bigint generated always as identity` (0020, línea ~156) --
--      agregada en su momento pero NUNCA usada como desempate de lectura.
--      Arreglo: agregar `a.seq desc` al `order by` de la función de lectura
--      -- sin ALTER TABLE, sin tocar el hash-chain (`seq` nunca entró al
--      cálculo del hash, ver 0020 líneas 196-204).
--   C) `core.list_authz_audit_log_for_superadmin` acota el "peek" de
--      paginación (`limit+1`) a un tope duro de 200 -- en el caso límite
--      exacto `limit = 200` (el máximo que un caller puede pedir, ver
--      `AUTHZ_AUDIT_LOG_LIMIT_MAX` en apps/api/src/routes/superadmin.ts),
--      pedir `limit+1 = 201` no servía de nada (la función lo recortaba de
--      vuelta a 200) y `hasMore` podía reportar `false` con una fila 201+
--      real. Se sube el tope duro INTERNO de la función a 201 -- el máximo
--      EXPUESTO a un caller (200) no cambia, ver
--      `apps/api/src/routes/superadmin.ts::AUTHZ_AUDIT_LOG_LIMIT_MAX`
--      (sin tocar) y `packages/db/src/authz-audit-repository.ts` (el
--      repositorio nunca pide más de `limit+1`, así que un caller que pida
--      200 ahora sí obtiene un peek real de 201, pero nunca ve la fila 201).
--
-- COMPATIBILIDAD CON LA BASE SIN MIGRAR: ninguna de las tres partes cambia la
-- firma de ninguna función -- el TypeScript que las llama (packages/db/src/
-- authz-audit-repository.ts, packages/db/src/impersonation-repository.ts) ya
-- captura 42883/42P01/42703 vía `runWithSavepointFallback` desde ANTES de
-- esta migración (0021/0020 respectivamente) y sigue funcionando idéntico
-- con o sin ella aplicada -- si esta migración no está aplicada, la función
-- VIEJA (0020/0021) sigue activa tal cual, sin ningún estado intermedio roto
-- (columna+función de la parte A se aplican juntas, en el mismo archivo; la
-- parte B solo reemplaza un `order by`, la columna `seq` que usa ya existe
-- desde 0020). Ver `scripts/verify-superadmin-auditoria-denegaciones/` y
-- `scripts/verify-superadmin-impersonacion/` para la prueba contra Postgres
-- real de ambos extremos (función/tabla ausente del todo, y esta migración
-- ausente pero 0020/0021 sí aplicadas).
--
-- Requiere: 0020_superadmin_impersonacion.sql, 0021_superadmin_authz_audit_log.sql.

-- ═══════════════════════════════════════════════════════════════════════════
-- A.1) core.authz_audit_log -- columna `actor_key` (generada, columna
--      ALMACENADA -- necesaria para poder indexarla) para el conteo POR
--      ACTOR del tope defensivo, y los 2 nuevos valores de `reason` que la
--      función de escritura usa para el marcador de desborde (nunca
--      alcanzables desde `p_reason`, ver función de abajo -- el catálogo que
--      valida la ENTRADA del caller sigue siendo el mismo de 4 valores de
--      0021, esta ampliación es solo del CHECK de la tabla, para que la
--      propia función pueda insertar el marcador).
--
--      `actor_user_id::text` cuando existe (siempre el mismo staff, sin
--      importar desde qué IP se conecte); `'ip:' || actor_ip` (ya truncado a
--      64, ver función de abajo -- el `left(p_actor_ip, 64)` de la función
--      de escritura y este cálculo usan la MISMA columna ya truncada, nunca
--      el parámetro crudo, para que ambos coincidan siempre) cuando no hay
--      actor identificado; `'ip:unknown'` en el caso degenerado de "ni
--      actor ni IP resoluble" -- agrupa a todos los actores totalmente
--      anónimos bajo una sola llave compartida, aceptado (documentado, no
--      un descuido): ese caso ya es el peor escenario posible para
--      cualquier tope por actor, sin importar cómo se agrupe.
--
--      `stored` (no virtual): Postgres solo permite indexar una columna
--      generada ALMACENADA -- verificado contra Postgres real que un
--      `ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS AS (...) STORED`
--      sobre una tabla CON FILAS y con los triggers `before update`/
--      `before delete` que bloquean toda mutación NO dispara esos triggers
--      (es una reescritura de tabla interna de Postgres, no un `UPDATE` que
--      pase por el executor de filas -- mismo comportamiento ya verificado
--      para `ADD COLUMN ... GENERATED ALWAYS AS IDENTITY` en el PR #173,
--      `022_rentas_audit_log_orden_determinista.sql`).
-- ═══════════════════════════════════════════════════════════════════════════
alter table core.authz_audit_log
  add column actor_key text generated always as (coalesce(actor_user_id::text, 'ip:' || coalesce(actor_ip, 'unknown'))) stored;

-- Soporta el `count(*) ... where actor_key = $1 and occurred_at > $2` del
-- tope POR ACTOR sin escanear la tabla completa -- mismo criterio que el
-- índice de `occurred_at` a secas que ya soporta el tope global (0021,
-- `authz_audit_log_occurred_recent_idx`).
create index authz_audit_log_actor_key_occurred_idx on core.authz_audit_log (actor_key, occurred_at);

alter table core.authz_audit_log drop constraint authz_audit_log_reason_check;
alter table core.authz_audit_log add constraint authz_audit_log_reason_check
  check (reason is null or reason in (
    'insufficient_role', 'route_not_mapped', 'rate_limited', 'no_membership',
    -- Marcador de desborde -- NUNCA alcanzable desde `p_reason` (ver función
    -- de escritura de abajo: la validación de entrada sigue exigiendo uno de
    -- los 4 valores de arriba; estos 2 solo los inserta la propia función,
    -- con un literal fijo, cuando el tope POR ACTOR o el GLOBAL se alcanza).
    'audit_capacity_overflow_actor', 'audit_capacity_overflow_global'
  ));

-- ═══════════════════════════════════════════════════════════════════════════
-- A.2) core.record_authz_audit_denial -- reemplaza la de 0021. Misma firma,
--      misma validación de entrada (auth.uid() solo-sistema, decision/reason
--      del catálogo de 4 valores, truncado defensivo de texto libre) -- lo
--      único que cambia es el tope defensivo de ráfaga:
--
--        1. Tope POR ACTOR (500 filas/10 min) -- mucho más bajo que el
--           global, así que una sola cuenta/IP insistiendo nunca llega a
--           agotar la capacidad de TODOS los demás actores.
--        2. Tope GLOBAL como ÚLTIMA RED (20000 filas/10 min, antes 5000) --
--           protege contra MUCHOS actores/IPs distintos denegados en
--           paralelo, el caso que un tope solo-por-actor no cubre.
--        3. Al alcanzar CUALQUIERA de los dos, NUNCA descarta mudo: inserta
--           UNA fila marcador de desborde (`reason =
--           'audit_capacity_overflow_actor'`/`'_global'`) -- pero solo la
--           PRIMERA vez dentro de esa ventana (un `exists` barato sobre el
--           mismo índice que ya soporta el conteo, nunca una fila por cada
--           evento descartado) -- con el conteo de lo descartado EN ESE
--           INSTANTE en `metadata` (el mismo `count(*)` que ya se calculó
--           para decidir el tope, cero consultas extra -- un conteo EXACTO y
--           creciente exigiría un `UPDATE` sobre la fila marcador, imposible
--           en una tabla append-only con triggers que bloquean todo UPDATE a
--           propósito -- así que es un piso ("al menos N"), nunca una cifra
--           en vivo, tradeoff documentado y deliberado).
--
--      La ESCRITURA best-effort real (nunca cambia la respuesta HTTP, nunca
--      corre dentro de la transacción del request) y "no persistir cada 429
--      repetida" se resuelven en `packages/core-authz/src/admin-middleware.ts`
--      (capa de aplicación, ver `InMemoryDenialAuditCoalescer`) -- esta
--      función SQL no decide eso, solo protege la CAPACIDAD de la tabla.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.record_authz_audit_denial(
  p_actor_user_id uuid,
  p_actor_ip text,
  p_organization_id uuid,
  p_action text,
  p_route text,
  p_method text,
  p_decision text,
  p_reason text,
  p_metadata jsonb,
  p_occurred_at timestamptz
)
returns uuid
language plpgsql security definer set search_path = core, pg_temp
as $$
declare
  v_id uuid;
  v_actor_ip_truncated text;
  v_actor_key text;
  v_window_start timestamptz;
  v_recent_actor_count bigint;
  v_recent_global_count bigint;
  c_window_minutes constant int := 10;
  -- Mucho más bajo que el global -- una sola cuenta/IP insistiendo contra
  -- muchas rutas distintas (el hallazgo real: el rate-limiter de
  -- `requireAdminAccess` ya acota por actor+RUTA, no por actor a secas)
  -- nunca agota la capacidad compartida de todos los demás actores.
  c_max_per_actor_window constant bigint := 500;
  -- Última red -- antes 5000 (tope único, sin distinción por actor). Sube a
  -- 20000 porque ahora es solo la defensa contra MUCHOS actores/IPs
  -- DISTINTOS en paralelo (el tope por actor de arriba ya cubre el caso de
  -- un solo actor insistiendo).
  c_max_global_window constant bigint := 20000;
begin
  if auth.uid() is not null then
    raise exception 'record_authz_audit_denial: solo puede invocarse desde una sesión de sistema (auth.uid() debe ser NULL)' using errcode = '28000';
  end if;

  if p_decision is null or p_decision not in ('allowed', 'denied') then
    raise exception 'record_authz_audit_denial: decision invalida (esperaba allowed|denied)' using errcode = '22023';
  end if;
  if p_reason is not null and p_reason not in ('insufficient_role', 'route_not_mapped', 'rate_limited', 'no_membership') then
    raise exception 'record_authz_audit_denial: reason invalido' using errcode = '22023';
  end if;

  v_actor_ip_truncated := left(p_actor_ip, 64);
  -- MISMA fórmula que la columna generada `actor_key` de la tabla, sobre el
  -- valor YA truncado -- para que el conteo de abajo (que filtra por esta
  -- misma llave) coincida exactamente con lo que la fila recién insertada
  -- terminará teniendo en su columna `actor_key`.
  v_actor_key := coalesce(p_actor_user_id::text, 'ip:' || coalesce(v_actor_ip_truncated, 'unknown'));
  v_window_start := now() - make_interval(mins => c_window_minutes);

  select count(*) into v_recent_actor_count
  from core.authz_audit_log
  where occurred_at > v_window_start and actor_key = v_actor_key;

  if v_recent_actor_count >= c_max_per_actor_window then
    if not exists (
      select 1 from core.authz_audit_log
      where actor_key = v_actor_key
        and reason = 'audit_capacity_overflow_actor'
        and occurred_at > v_window_start
    ) then
      insert into core.authz_audit_log (actor_user_id, actor_ip, organization_id, action, route, method, decision, reason, metadata, occurred_at)
      values (
        p_actor_user_id, v_actor_ip_truncated, p_organization_id,
        left(coalesce(p_action, ''), 100), left(coalesce(p_route, ''), 300), left(coalesce(p_method, ''), 10),
        'denied', 'audit_capacity_overflow_actor',
        jsonb_build_object('discardedAtLeast', v_recent_actor_count, 'windowMinutes', c_window_minutes),
        now()
      );
    end if;
    return null;
  end if;

  select count(*) into v_recent_global_count
  from core.authz_audit_log
  where occurred_at > v_window_start;

  if v_recent_global_count >= c_max_global_window then
    if not exists (
      select 1 from core.authz_audit_log
      where reason = 'audit_capacity_overflow_global'
        and occurred_at > v_window_start
    ) then
      insert into core.authz_audit_log (actor_user_id, actor_ip, organization_id, action, route, method, decision, reason, metadata, occurred_at)
      values (
        p_actor_user_id, v_actor_ip_truncated, p_organization_id,
        left(coalesce(p_action, ''), 100), left(coalesce(p_route, ''), 300), left(coalesce(p_method, ''), 10),
        'denied', 'audit_capacity_overflow_global',
        jsonb_build_object('discardedAtLeast', v_recent_global_count, 'windowMinutes', c_window_minutes),
        now()
      );
    end if;
    return null;
  end if;

  insert into core.authz_audit_log (
    actor_user_id, actor_ip, organization_id, action, route, method, decision, reason, metadata, occurred_at
  )
  values (
    p_actor_user_id,
    v_actor_ip_truncated,
    p_organization_id,
    left(coalesce(p_action, ''), 100),
    left(coalesce(p_route, ''), 300),
    left(coalesce(p_method, ''), 10),
    p_decision,
    p_reason,
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_occurred_at, now())
  )
  returning id into v_id;

  return v_id;
end;
$$;
revoke all on function core.record_authz_audit_denial(uuid, text, uuid, text, text, text, text, text, jsonb, timestamptz) from public;
grant execute on function core.record_authz_audit_denial(uuid, text, uuid, text, text, text, text, text, jsonb, timestamptz) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) core.list_authz_audit_log_for_superadmin -- reemplaza la de 0021. ÚNICO
--    cambio: el tope duro interno de `limit` sube de 200 a 201 -- 1 más que
--    `AUTHZ_AUDIT_LOG_LIMIT_MAX` (apps/api/src/routes/superadmin.ts, sin
--    tocar, sigue en 200 -- el máximo que un caller real puede pedir). Sin
--    este único row de margen, `PostgresAuthzAuditRepository.list` (que pide
--    `limit+1` como "peek" para saber si hay más página) no podía distinguir
--    "el tenant tiene EXACTAMENTE 200 filas" de "tiene 201+" en el caso
--    límite `limit=200` -- la función recortaba el `limit+1=201` de vuelta a
--    200 antes de que el repositorio pudiera ver la fila de más.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.list_authz_audit_log_for_superadmin(
  p_caller_id uuid,
  p_limit int default 50,
  p_offset int default 0
)
returns table (
  id uuid,
  actor_user_id uuid,
  actor_ip text,
  organization_id uuid,
  action text,
  route text,
  method text,
  decision text,
  reason text,
  metadata jsonb,
  occurred_at timestamptz,
  created_at timestamptz
)
language sql stable security definer set search_path = core, pg_temp
as $$
  select a.id, a.actor_user_id, a.actor_ip, a.organization_id, a.action, a.route, a.method, a.decision, a.reason, a.metadata, a.occurred_at, a.created_at
  from core.authz_audit_log a
  where auth.uid() is not null and auth.uid() = p_caller_id
    and core.is_platform_superadmin(p_caller_id)
  order by a.occurred_at desc, a.id desc
  limit greatest(1, least(coalesce(p_limit, 50), 201))
  offset greatest(0, coalesce(p_offset, 0));
$$;
revoke all on function core.list_authz_audit_log_for_superadmin(uuid, int, int) from public;
grant execute on function core.list_authz_audit_log_for_superadmin(uuid, int, int) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) core.list_impersonation_audit_log_for_superadmin -- reemplaza la de
--    0020. ÚNICO cambio: desempate `, a.seq desc` en el `order by` -- `seq`
--    ya existe desde 0020 (`generated always as identity`, índice único
--    `impersonation_audit_log_seq_idx`), nunca entra al cálculo del hash
--    (0020 líneas 196-204, `v_canonical` no lo incluye), así que este cambio
--    no toca ni la cadena de hash ni ninguna columna -- solo el criterio de
--    orden de la LECTURA. `setof core.impersonation_audit_log` (sin cambios
--    de tipo de retorno) sigue devolviendo la fila completa, `seq` incluido
--    -- el adaptador TS (`packages/db/src/impersonation-repository.ts::
--    mapAuditEntry`) YA lo mapea desde antes de esta migración.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace function core.list_impersonation_audit_log_for_superadmin(p_caller_id uuid, p_limit int default 200)
returns setof core.impersonation_audit_log
language sql stable security definer set search_path = core, pg_temp
as $$
  select a.*
  from core.impersonation_audit_log a
  where auth.uid() is not null and auth.uid() = p_caller_id
    and core.is_platform_superadmin(p_caller_id)
  order by a.occurred_at desc, a.seq desc
  limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;
revoke all on function core.list_impersonation_audit_log_for_superadmin(uuid, int) from public;
grant execute on function core.list_impersonation_audit_log_for_superadmin(uuid, int) to authenticated;

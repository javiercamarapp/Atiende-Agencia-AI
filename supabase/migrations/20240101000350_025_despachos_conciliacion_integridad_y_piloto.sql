-- D-P3-10/11/12 -- Conciliación: integridad del CFDI (cancelado, tope de monto, signo), propuestas guardadas en la sesión y piloto automático.
--
-- Qué cambia respecto de la 021:
--   1. `conciliacion_match_insertar` (núcleo interno de TODA confirmación: manual, motor, IA aprobada y piloto) ahora rechaza, con un error
--      tipado (SQLSTATE propio, la ruta lo traduce a 409):
--        CF001  el CFDI está `cancelado` ante el SAT (no se concilia dinero contra un comprobante cancelado);
--        CF002  la suma de los matches VIGENTES del CFDI (en centavos, valor absoluto de cada movimiento) más este superaría el total del CFDI:
--               antes un mismo CFDI podía quedar conciliado N veces por el monto completo. El CFDI se bloquea (FOR UPDATE) mientras se valida,
--               así que dos confirmaciones simultáneas no pasan juntas el tope. Pagos parciales (suma <= total) siguen permitidos;
--        CF003  el signo no cuadra: un abono (cobro) no concilia contra un CFDI `recibido` ni un cargo (pago) contra uno `emitido`.
--               `indeterminado`/sin dirección se aceptan aquí (la exigencia de revisión humana es de la capa de aplicación, que nunca los
--               autoconfirma).
--   2. `conciliacion_matches_confirmar` rechaza el origen `autopiloto` (solo lo escribe la función del piloto de abajo).
--   3. Nuevo origen de match `autopiloto` (nivel 1, con confianza): lo crea el piloto automático (D-P3-12) cuando el despacho encendió la
--      bandera. El actor humano que subió el estado de cuenta queda en `confirmado_por` (auth.uid(); no se puede falsear) y el origen deja
--      claro que lo decidió el sistema. Se puede deshacer con motivo igual que cualquier match (bitácora íntegra).
--   4. `conciliacion_sesion.propuestas/propuestas_en`: las propuestas del motor se calculan al crear o refrescar la sesión y se GUARDAN; el GET
--      de la sesión ya no recorre el motor en cada lectura (con 60 candidatos, un GET podía colgar la función).
--   5. `property_config.conciliacion_autoconfirmar_nivel1` (bandera, APAGADA por omisión: decisión de Javier). Encendida, el piloto confirma solo
--      los pares de nivel 1 ÚNICOS. Nunca confirma grupos, nivel 2 ni sugerencias de IA.
--
-- Seguridad (cada punto lo ejerce scripts/verify-despachos-conciliacion-integridad/assertions.sql):
--   * Ninguna tabla gana GRANT nuevo y ninguno va a anon. Las dos columnas nuevas de `conciliacion_sesion` (propuestas, propuestas_en) quedan
--     bajo el mismo `select` por property de la 021 y solo se escriben por la función definer `conciliacion_sesion_propuestas_guardar`
--     (no se concede UPDATE, ni siquiera por columna). La columna nueva de `property_config` hereda sus policies de la 012: lectura para el
--     staff de la property y escritura SOLO del `admin` de la organización (RLS, `core.has_property_access` primero); no se amplía ningún
--     privilegio de tabla (el grant existente ya cubre las columnas).
--   * Las 3 funciones nuevas son `security definer` con `set search_path = despachos, pg_temp`, `revoke all ... from public, anon` y EXECUTE solo a
--     `authenticated`. Exigen `auth.uid()` no nulo y `despachos.cartera_puede_escribir(property)` (acceso a la property + rol admin/contador en
--     su organización de despachos). Un auditor/readonly, un contador de otro despacho, un usuario sin membresía, una sesión sin `sub` y anon
--     no pasan. El rol nunca viene de un argumento.
--   * `conciliacion_autopiloto_confirmar` además exige la bandera encendida EN LA BASE (no solo en la aplicación), nivel 1, dirección explícita
--     (emitido/recibido) compatible con el signo y monto del movimiento igual al total del CFDI (a 1 centavo): defensa en profundidad ante un
--     llamador que se salte la ruta. Aun así hereda todas las validaciones de `conciliacion_match_insertar` (pertenencia, periodo cerrado,
--     CFDI cancelado, tope, signo).
--   * `conciliacion_sesion_asegurar` es idempotente (advisory lock por property+periodo+cuenta, no dos sesiones abiertas iguales por carrera) y
--     reutiliza las mismas validaciones de `conciliacion_sesion_crear`.
--
-- Compatibilidad con la base sin migrar: el TypeScript que consume esto captura 42883/42P01/42703 dentro de SAVEPOINT y cae al camino anterior
-- (propuestas calculadas al vuelo, sin piloto, 503 honesto en las escrituras nuevas); nunca un 500. Se puede aplicar antes o después del código.

-- ---------------------------------------------------------------------------
-- Columnas nuevas.
-- ---------------------------------------------------------------------------
alter table despachos.conciliacion_sesion
  add column propuestas jsonb,
  add column propuestas_en timestamptz,
  add constraint conciliacion_sesion_propuestas_tamano check (propuestas is null or pg_column_size(propuestas) <= 2097152);

alter table despachos.property_config
  add column conciliacion_autoconfirmar_nivel1 boolean not null default false;

-- ---------------------------------------------------------------------------
-- Nuevo origen `autopiloto` (nivel 1 con confianza). Se reemplazan por nombre los CHECK de origen de la 021 (autonombrados por Postgres).
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'despachos.conciliacion_match'::regclass
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ~ '\morigen\M'
  loop
    execute format('alter table despachos.conciliacion_match drop constraint %I', r.conname);
  end loop;
end;
$$;
alter table despachos.conciliacion_match
  add constraint conciliacion_match_origen_valido check (origen in ('motor', 'llm_aprobado', 'manual', 'autopiloto')),
  add constraint conciliacion_match_origen_nivel check (
        (origen = 'manual' and nivel is null and confianza is null)
     or (origen = 'motor' and nivel between 1 and 3 and confianza is not null)
     or (origen = 'llm_aprobado' and nivel = 4 and confianza is not null)
     or (origen = 'autopiloto' and nivel = 1 and confianza is not null));

-- ---------------------------------------------------------------------------
-- Núcleo interno de confirmación, con CFDI cancelado / tope de monto / signo. Misma firma que la 021: no se concede a nadie directo.
-- ---------------------------------------------------------------------------
create or replace function despachos.conciliacion_match_insertar(
  p_sesion_id uuid, p_movimiento_id uuid, p_invoice_id uuid, p_nivel smallint, p_confianza numeric, p_origen text
)
returns uuid
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_prop uuid;
  v_periodo text;
  v_estado text;
  v_cuenta text;
  v_fecha date;
  v_mov_cuenta text;
  v_monto numeric;
  v_mov_cents bigint;
  v_estado_sat text;
  v_direccion text;
  v_total_cents bigint;
  v_ya_cents bigint;
  v_id uuid;
begin
  select s.organization_id, s.property_id, s.periodo, s.estado, s.cuenta into v_org, v_prop, v_periodo, v_estado, v_cuenta
    from despachos.conciliacion_sesion s where s.id = p_sesion_id;
  if not found or auth.uid() is null or not despachos.cartera_puede_escribir(v_prop) then
    raise exception 'conciliacion_match: sin permiso o sesión inexistente' using errcode = '42501';
  end if;
  if v_estado <> 'abierta' then
    raise exception 'conciliacion_match: la sesión está cerrada' using errcode = '22023';
  end if;
  if p_origen not in ('motor', 'llm_aprobado', 'manual', 'autopiloto') then
    raise exception 'conciliacion_match: origen inválido' using errcode = '22023';
  end if;
  select mv.fecha, mv.cuenta, mv.monto into v_fecha, v_mov_cuenta, v_monto from despachos.estado_cuenta_movimiento mv
   where mv.id = p_movimiento_id and mv.property_id = v_prop;
  if v_fecha is null or to_char(v_fecha, 'YYYY-MM') <> v_periodo or (v_cuenta is not null and v_mov_cuenta is distinct from v_cuenta) then
    raise exception 'conciliacion_match: el movimiento no pertenece a la sesión' using errcode = '22023';
  end if;
  -- El CFDI se bloquea hasta el fin de la transacción: la suma de matches vigentes que sigue no puede cambiar bajo nuestros pies.
  select i.estado_sat, i.direccion, coalesce(i.total_centavos, round(i.total * 100))::bigint into v_estado_sat, v_direccion, v_total_cents
    from despachos.invoice i where i.id = p_invoice_id and i.property_id = v_prop for update;
  if not found then
    raise exception 'conciliacion_match: el CFDI no pertenece al cliente' using errcode = '22023';
  end if;
  if exists (select 1 from despachos.periodo_cierre pc where pc.property_id = v_prop and pc.anio = extract(year from v_fecha)::int and pc.mes = extract(month from v_fecha)::int and pc.status = 'closed') then
    raise exception 'conciliacion_match: el periodo % está cerrado', v_periodo using errcode = '55000';
  end if;
  if v_estado_sat = 'cancelado' then
    raise exception 'conciliacion_match: el CFDI está cancelado ante el SAT y no se concilia' using errcode = 'CF001';
  end if;
  if (v_monto > 0 and v_direccion = 'recibido') or (v_monto < 0 and v_direccion = 'emitido') then
    raise exception 'conciliacion_match: el signo no cuadra (un abono concilia con un CFDI emitido y un cargo con uno recibido)' using errcode = 'CF003';
  end if;
  v_mov_cents := round(abs(v_monto) * 100)::bigint;
  select coalesce(sum(round(abs(mv2.monto) * 100)), 0)::bigint into v_ya_cents
    from despachos.conciliacion_match m2
    join despachos.estado_cuenta_movimiento mv2 on mv2.id = m2.movimiento_id
   where m2.property_id = v_prop and m2.invoice_id = p_invoice_id and m2.deshecho_en is null;
  if v_ya_cents + v_mov_cents > v_total_cents then
    raise exception 'conciliacion_match: la suma conciliada del CFDI superaría su total' using errcode = 'CF002';
  end if;
  insert into despachos.conciliacion_match (organization_id, property_id, sesion_id, movimiento_id, invoice_id, nivel, confianza, origen, confirmado_por)
  values (v_org, v_prop, p_sesion_id, p_movimiento_id, p_invoice_id, p_nivel, p_confianza, p_origen, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- Confirma un lote (todo o nada): igual que la 021 pero el origen `autopiloto` no se acepta por aquí.
create or replace function despachos.conciliacion_matches_confirmar(p_sesion_id uuid, p_matches jsonb)
returns table (out_match_id uuid, out_movimiento_id uuid, out_invoice_id uuid)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  r record;
  v_n integer;
  v_id uuid;
begin
  if auth.uid() is null or not exists (select 1 from despachos.conciliacion_sesion s where s.id = p_sesion_id and despachos.cartera_puede_escribir(s.property_id)) then
    raise exception 'conciliacion_matches_confirmar: sin permiso o sesión inexistente' using errcode = '42501';
  end if;
  if p_matches is null or jsonb_typeof(p_matches) <> 'array' then
    raise exception 'conciliacion_matches_confirmar: se espera un arreglo de pares' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_matches);
  if v_n < 1 or v_n > 200 then
    raise exception 'conciliacion_matches_confirmar: de 1 a 200 pares por solicitud' using errcode = '22023';
  end if;
  for r in
    select x.movimiento_id, x.invoice_id, x.nivel, x.confianza, x.origen
    from jsonb_to_recordset(p_matches) as x(movimiento_id uuid, invoice_id uuid, nivel smallint, confianza numeric, origen text)
  loop
    if r.origen = 'autopiloto' then
      raise exception 'conciliacion_matches_confirmar: el origen autopiloto solo lo escribe el piloto automático' using errcode = '22023';
    end if;
    v_id := despachos.conciliacion_match_insertar(p_sesion_id, r.movimiento_id, r.invoice_id, r.nivel, r.confianza, r.origen);
    return query select v_id, r.movimiento_id, r.invoice_id;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Propuestas guardadas en la sesión (el GET ya no recalcula el motor en cada lectura).
-- ---------------------------------------------------------------------------
create or replace function despachos.conciliacion_sesion_propuestas_guardar(p_property_id uuid, p_sesion_id uuid, p_propuestas jsonb)
returns void
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_estado text;
begin
  if auth.uid() is null or p_property_id is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'conciliacion_sesion_propuestas_guardar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  if p_propuestas is null or jsonb_typeof(p_propuestas) <> 'object' then
    raise exception 'conciliacion_sesion_propuestas_guardar: se espera un objeto' using errcode = '22023';
  end if;
  if pg_column_size(p_propuestas) > 2097152 then
    raise exception 'conciliacion_sesion_propuestas_guardar: las propuestas exceden 2 MB' using errcode = '54000';
  end if;
  select s.estado into v_estado from despachos.conciliacion_sesion s where s.id = p_sesion_id and s.property_id = p_property_id for update;
  if not found then
    raise exception 'conciliacion_sesion_propuestas_guardar: sesión no encontrada' using errcode = 'P0002';
  end if;
  if v_estado <> 'abierta' then
    raise exception 'conciliacion_sesion_propuestas_guardar: la sesión está cerrada' using errcode = '22023';
  end if;
  update despachos.conciliacion_sesion set propuestas = p_propuestas, propuestas_en = now() where id = p_sesion_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Sesión del periodo y la cuenta, IDEMPOTENTE (piloto automático): devuelve la abierta si ya existe o crea una.
-- ---------------------------------------------------------------------------
create or replace function despachos.conciliacion_sesion_asegurar(p_property_id uuid, p_periodo text, p_cuenta text)
returns table (out_sesion_id uuid, out_creada boolean, out_movimientos integer)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_desde date;
  v_hasta date;
  v_cuenta text := nullif(btrim(coalesce(p_cuenta, '')), '');
  v_n integer;
  v_id uuid;
begin
  if auth.uid() is null or p_property_id is null or not despachos.cartera_puede_escribir(p_property_id) then
    raise exception 'conciliacion_sesion_asegurar: sin permiso sobre el cliente' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id and p.vertical = 'despachos';
  if v_org is null then
    raise exception 'conciliacion_sesion_asegurar: la property no es de despachos' using errcode = '42501';
  end if;
  if p_periodo is null or p_periodo !~ '^20[1-9][0-9]-(0[1-9]|1[0-2])$' then
    raise exception 'conciliacion_sesion_asegurar: periodo con formato YYYY-MM' using errcode = '22023';
  end if;
  if v_cuenta is not null and char_length(v_cuenta) > 34 then
    raise exception 'conciliacion_sesion_asegurar: cuenta de hasta 34 caracteres' using errcode = '22023';
  end if;
  v_desde := (p_periodo || '-01')::date;
  v_hasta := (v_desde + interval '1 month')::date;
  select count(*)::int into v_n from despachos.estado_cuenta_movimiento mv
   where mv.property_id = p_property_id and mv.fecha >= v_desde and mv.fecha < v_hasta and (v_cuenta is null or mv.cuenta = v_cuenta);
  if v_n = 0 then
    raise exception 'conciliacion_sesion_asegurar: no hay movimientos guardados en el periodo %', p_periodo using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('conciliacion_sesion_asegurar|' || p_property_id::text || '|' || p_periodo || '|' || coalesce(v_cuenta, ''), 0));
  select s.id into v_id from despachos.conciliacion_sesion s
   where s.property_id = p_property_id and s.periodo = p_periodo and s.cuenta is not distinct from v_cuenta and s.estado = 'abierta'
   order by s.creada_en desc limit 1;
  if v_id is not null then
    return query select v_id, false, v_n;
    return;
  end if;
  insert into despachos.conciliacion_sesion (organization_id, property_id, periodo, cuenta, creada_por)
  values (v_org, p_property_id, p_periodo, v_cuenta, auth.uid())
  returning id into v_id;
  return query select v_id, true, v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Piloto automático: confirma pares de nivel 1 únicos (los calcula la aplicación) SOLO si el despacho encendió la bandera.
-- ---------------------------------------------------------------------------
create or replace function despachos.conciliacion_autopiloto_confirmar(p_sesion_id uuid, p_matches jsonb)
returns table (out_match_id uuid, out_movimiento_id uuid, out_invoice_id uuid)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  r record;
  v_prop uuid;
  v_activo boolean;
  v_n integer;
  v_id uuid;
  v_monto numeric;
  v_total_cents bigint;
  v_direccion text;
begin
  select s.property_id into v_prop from despachos.conciliacion_sesion s where s.id = p_sesion_id;
  if not found or auth.uid() is null or not despachos.cartera_puede_escribir(v_prop) then
    raise exception 'conciliacion_autopiloto_confirmar: sin permiso o sesión inexistente' using errcode = '42501';
  end if;
  select pc.conciliacion_autoconfirmar_nivel1 into v_activo from despachos.property_config pc where pc.property_id = v_prop;
  if coalesce(v_activo, false) is not true then
    raise exception 'conciliacion_autopiloto_confirmar: el piloto automático está apagado para este cliente' using errcode = 'CF004';
  end if;
  if p_matches is null or jsonb_typeof(p_matches) <> 'array' then
    raise exception 'conciliacion_autopiloto_confirmar: se espera un arreglo de pares' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_matches);
  if v_n < 1 or v_n > 200 then
    raise exception 'conciliacion_autopiloto_confirmar: de 1 a 200 pares por solicitud' using errcode = '22023';
  end if;
  for r in
    select x.movimiento_id, x.invoice_id, x.confianza
    from jsonb_to_recordset(p_matches) as x(movimiento_id uuid, invoice_id uuid, confianza numeric)
  loop
    select mv.monto into v_monto from despachos.estado_cuenta_movimiento mv where mv.id = r.movimiento_id and mv.property_id = v_prop;
    select i.direccion, coalesce(i.total_centavos, round(i.total * 100))::bigint into v_direccion, v_total_cents
      from despachos.invoice i where i.id = r.invoice_id and i.property_id = v_prop;
    if v_monto is null or v_total_cents is null then
      raise exception 'conciliacion_autopiloto_confirmar: movimiento o CFDI inexistente en el cliente' using errcode = '22023';
    end if;
    -- Nivel 1 = monto igual (a 1 centavo) y dirección explícita y compatible con el signo: lo demás es de revisión humana.
    if abs(round(abs(v_monto) * 100) - v_total_cents) > 1 then
      raise exception 'conciliacion_autopiloto_confirmar: el monto no coincide con el CFDI (solo nivel 1)' using errcode = '22023';
    end if;
    if v_direccion is null or v_direccion = 'indeterminado' then
      raise exception 'conciliacion_autopiloto_confirmar: el CFDI no tiene dirección definida (requiere revisión humana)' using errcode = 'CF003';
    end if;
    v_id := despachos.conciliacion_match_insertar(p_sesion_id, r.movimiento_id, r.invoice_id, 1::smallint, r.confianza, 'autopiloto');
    return query select v_id, r.movimiento_id, r.invoice_id;
  end loop;
end;
$$;

revoke all on function despachos.conciliacion_match_insertar(uuid, uuid, uuid, smallint, numeric, text) from public, anon, authenticated;
revoke all on function despachos.conciliacion_matches_confirmar(uuid, jsonb) from public, anon;
revoke all on function despachos.conciliacion_sesion_propuestas_guardar(uuid, uuid, jsonb) from public, anon;
revoke all on function despachos.conciliacion_sesion_asegurar(uuid, text, text) from public, anon;
revoke all on function despachos.conciliacion_autopiloto_confirmar(uuid, jsonb) from public, anon;
grant execute on function despachos.conciliacion_matches_confirmar(uuid, jsonb) to authenticated;
grant execute on function despachos.conciliacion_sesion_propuestas_guardar(uuid, uuid, jsonb) to authenticated;
grant execute on function despachos.conciliacion_sesion_asegurar(uuid, text, text) to authenticated;
grant execute on function despachos.conciliacion_autopiloto_confirmar(uuid, jsonb) to authenticated;

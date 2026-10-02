-- D-27 + D-28 + hueco de D-26 -- funciones de SOLO SISTEMA para los tres crons de despachos: (1) estatus de CFDI ante el SAT,
-- (2) alerta 69-B sobre CFDI ya ingeridos y (3) generacion/escalamiento diario de vencimientos fiscales.
--
-- Por que funciones y no acceso directo: los crons corren como sesion de sistema (auth.uid() is null), que NO tiene acceso por RLS
-- a ninguna property (las policies de despachos son todas `core.has_property_access(auth.uid(), ...)`). La unica forma de barrer
-- varios clientes sin abrir las tablas es con funciones security definer, acotadas, con un trabajo concreto cada una.
--
-- Seguridad (cada punto lo ejerce scripts/verify-despachos-cron-sat-vencimientos/assertions.sql):
--   1. Las 7 funciones nuevas son security definer con `set search_path = despachos, pg_temp`, `revoke ... from public, anon` y
--      EXECUTE solo a `authenticated` (la sesion de sistema del cron usa ese rol sin claim `sub`; mismo patron que 014 y 020).
--      TODAS exigen `auth.uid() is null` (42501 si no): un staff autenticado NO puede invocarlas, asi que no sirven para leer ni
--      escribir datos de otro cliente. Anon no tiene EXECUTE.
--   2. `system_cfdi_pendientes_estatus_sat` devuelve solo lo que la consulta publica del SAT necesita (RFC emisor/receptor, total y
--      folio fiscal) mas ids; limite duro de 500 por llamada. `system_cfdi_registrar_estatus_sat` es la unica escritura de
--      `invoice.estado_sat*` desde el cron: un CFDI 'cancelado' es terminal (no regresa), y un resultado 'pendiente' (consulta
--      que no concluyo) solo marca el intento: NUNCA sobrescribe un estado ya verificado.
--   3. `system_efos_invoices_afectados` devuelve solo ids + situacion (sin RFC, nombre ni montos): el aviso de la campana es de
--      catalogo y no lleva PII.
--   4. `system_despachos_clientes_ficha` solo lista properties activas con ficha de cliente; `system_vencimiento_upsert` exige
--      esa ficha (22023) y no toca un vencimiento 'completado'; `system_vencimiento_escalar` es idempotente (un nivel igual o
--      mayor ya registrado no se repite) y no escala un vencimiento completado.
--   5. Columna nueva `invoice.estado_sat_intentado_en` (nullable): ultimo INTENTO de consulta al SAT. Sirve para repartir la cuota
--      del barrido (mas antiguos primero) sin que un CFDI cuya consulta falla siempre acapare el tope de cada corrida. No agrega
--      GRANT: hereda los de la tabla (select/insert a authenticated) y solo la funcion de sistema la escribe en la practica.
--   6. Ninguna funcion llama a la red; el SAT se consulta desde el cron (TypeScript) con un adaptador inyectable.
--
-- Compatibilidad con la base sin migrar: el TypeScript que consume esto captura 42883/42P01/42703 dentro de SAVEPOINT
-- (runWithSavepointFallback) y responde "no disponible aun" (sin barrer); nunca un 500. Se puede aplicar antes o despues del codigo.

alter table despachos.invoice add column if not exists estado_sat_intentado_en timestamptz;
create index if not exists invoice_estado_sat_barrido_idx on despachos.invoice (estado_sat_intentado_en nulls first, created_at) where estado_sat <> 'cancelado';

-- ---------------------------------------------------------------------------
-- D-27 -- CFDI por verificar ante el SAT (mas antiguos primero).
-- ---------------------------------------------------------------------------
create or replace function despachos.system_cfdi_pendientes_estatus_sat(p_limit integer, p_reintento_dias integer)
returns table (
  out_invoice_id uuid,
  out_organization_id uuid,
  out_property_id uuid,
  out_folio_fiscal text,
  out_rfc_emisor text,
  out_rfc_receptor text,
  out_total numeric,
  out_estado_sat text
)
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'system_cfdi_pendientes_estatus_sat es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_reintento_dias is null or p_reintento_dias < 0 or p_reintento_dias > 365 then
    raise exception 'system_cfdi_pendientes_estatus_sat: límite o ventana inválidos' using errcode = '22023';
  end if;
  return query
    select i.id, i.organization_id, i.property_id, i.folio_fiscal::text, i.rfc_emisor, i.rfc_receptor, i.total, i.estado_sat
    from despachos.invoice i
    join core.property p on p.id = i.property_id and p.status = 'active'
    where i.estado_sat <> 'cancelado'
      and (i.estado_sat_intentado_en is null or i.estado_sat_intentado_en < now() - make_interval(days => p_reintento_dias))
    order by coalesce(i.estado_sat_intentado_en, 'epoch'::timestamptz) asc, i.created_at asc, i.id asc
    limit least(p_limit, 500);
end;
$$;
revoke all on function despachos.system_cfdi_pendientes_estatus_sat(integer, integer) from public, anon;
grant execute on function despachos.system_cfdi_pendientes_estatus_sat(integer, integer) to authenticated;

-- Registra el resultado de UNA consulta (el cron abre una transaccion por CFDI).
create or replace function despachos.system_cfdi_registrar_estatus_sat(p_invoice_id uuid, p_estado text)
returns table (
  out_organization_id uuid,
  out_property_id uuid,
  out_estado_anterior text,
  out_estado_nuevo text,
  out_cambio_a_cancelado boolean
)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_prop uuid;
  v_actual text;
  v_nuevo text;
begin
  if auth.uid() is not null then
    raise exception 'system_cfdi_registrar_estatus_sat es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_estado is null or p_estado not in ('pendiente', 'vigente', 'cancelado', 'no_encontrado') then
    raise exception 'system_cfdi_registrar_estatus_sat: estado inválido' using errcode = '22023';
  end if;
  select i.organization_id, i.property_id, i.estado_sat into v_org, v_prop, v_actual
    from despachos.invoice i where i.id = p_invoice_id for update;
  if v_actual is null then
    raise exception 'system_cfdi_registrar_estatus_sat: CFDI no encontrado' using errcode = 'P0002';
  end if;
  -- 'pendiente' = la consulta no concluyo: solo se anota el intento. 'cancelado' es terminal.
  if p_estado = 'pendiente' or v_actual = 'cancelado' then
    update despachos.invoice set estado_sat_intentado_en = now() where id = p_invoice_id;
    v_nuevo := v_actual;
  else
    update despachos.invoice set estado_sat = p_estado, estado_sat_verificado_en = now(), estado_sat_intentado_en = now() where id = p_invoice_id;
    v_nuevo := p_estado;
  end if;
  return query select v_org, v_prop, v_actual, v_nuevo, (v_actual <> 'cancelado' and v_nuevo = 'cancelado');
end;
$$;
revoke all on function despachos.system_cfdi_registrar_estatus_sat(uuid, text) from public, anon;
grant execute on function despachos.system_cfdi_registrar_estatus_sat(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- D-28 -- CFDI ya ingeridos cuyo emisor figura hoy como presunto/definitivo en la edicion mas reciente.
-- ---------------------------------------------------------------------------
create or replace function despachos.system_efos_invoices_afectados(p_limit integer)
returns table (out_invoice_id uuid, out_organization_id uuid, out_property_id uuid, out_situacion text)
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'system_efos_invoices_afectados es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'system_efos_invoices_afectados: límite inválido' using errcode = '22023';
  end if;
  return query
    select i.id, i.organization_id, i.property_id, c.situacion
    from despachos.invoice i
    join core.property p on p.id = i.property_id and p.status = 'active'
    join despachos.efos_contribuyente c
      on c.rfc = upper(btrim(i.rfc_emisor))
     and c.periodo = (select max(g.periodo) from despachos.efos_ingesta g)
    where c.situacion in ('presunto', 'definitivo')
    order by i.created_at asc, i.id asc
    limit least(p_limit, 2000);
end;
$$;
revoke all on function despachos.system_efos_invoices_afectados(integer) from public, anon;
grant execute on function despachos.system_efos_invoices_afectados(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- D-26 -- generacion y escalamiento diario de vencimientos fiscales.
-- ---------------------------------------------------------------------------
create or replace function despachos.system_despachos_clientes_ficha(p_limit integer)
returns table (out_organization_id uuid, out_property_id uuid, out_regimenes text[], out_zona_horaria text)
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'system_despachos_clientes_ficha es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'system_despachos_clientes_ficha: límite inválido' using errcode = '22023';
  end if;
  return query
    select f.organization_id, f.property_id, f.regimenes_fiscales, pc.zona_horaria
    from despachos.cliente_ficha f
    join core.property p on p.id = f.property_id and p.status = 'active'
    join core.organization o on o.id = f.organization_id and o.status = 'active'
    left join despachos.property_config pc on pc.property_id = f.property_id
    order by f.property_id
    limit least(p_limit, 1000);
end;
$$;
revoke all on function despachos.system_despachos_clientes_ficha(integer) from public, anon;
grant execute on function despachos.system_despachos_clientes_ficha(integer) to authenticated;

-- Misma semantica que `createDeadline` + `updateDeadlineFechaLimite` del repositorio: idempotente y correctivo (una fila
-- pendiente con otra fecha se corrige; una completada no se toca).
create or replace function despachos.system_vencimiento_upsert(p_property_id uuid, p_tipo text, p_periodo text, p_fecha_limite date, p_prioridad text)
returns table (out_deadline_id uuid, out_creado boolean)
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_org uuid;
  v_id uuid;
begin
  if auth.uid() is not null then
    raise exception 'system_vencimiento_upsert es solo para la sesión de sistema' using errcode = '42501';
  end if;
  select f.organization_id into v_org from despachos.cliente_ficha f where f.property_id = p_property_id;
  if v_org is null then
    raise exception 'system_vencimiento_upsert: la property no tiene ficha de cliente' using errcode = '22023';
  end if;
  insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad)
  values (v_org, p_property_id, p_tipo, p_periodo, p_fecha_limite, p_prioridad)
  on conflict (property_id, tipo, periodo) do nothing
  returning id into v_id;
  if v_id is not null then
    return query select v_id, true;
    return;
  end if;
  update despachos.fiscal_deadline d
     set fecha_limite = p_fecha_limite, prioridad = p_prioridad
   where d.property_id = p_property_id and d.tipo = p_tipo and d.periodo = p_periodo and d.estado <> 'completado'
     and (d.fecha_limite is distinct from p_fecha_limite or d.prioridad is distinct from p_prioridad);
  select d.id into v_id from despachos.fiscal_deadline d where d.property_id = p_property_id and d.tipo = p_tipo and d.periodo = p_periodo;
  return query select v_id, false;
end;
$$;
revoke all on function despachos.system_vencimiento_upsert(uuid, text, text, date, text) from public, anon;
grant execute on function despachos.system_vencimiento_upsert(uuid, text, text, date, text) to authenticated;

-- Vencimientos no completados que ya vencieron o vencen hoy/manana, con el mayor nivel de escalamiento ya registrado.
create or replace function despachos.system_vencimientos_por_escalar(p_property_id uuid, p_hoy date)
returns table (out_deadline_id uuid, out_tipo text, out_periodo text, out_fecha_limite date, out_prioridad text, out_nivel_max text)
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'system_vencimientos_por_escalar es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_hoy is null then
    raise exception 'system_vencimientos_por_escalar: fecha inválida' using errcode = '22023';
  end if;
  return query
    select d.id, d.tipo, d.periodo, d.fecha_limite, d.prioridad,
           (select e.level from despachos.deadline_escalation e where e.deadline_id = d.id order by e.level desc limit 1)
    from despachos.fiscal_deadline d
    where d.property_id = p_property_id and d.estado <> 'completado' and d.fecha_limite <= p_hoy + 1
    order by d.fecha_limite, d.tipo
    limit 200;
end;
$$;
revoke all on function despachos.system_vencimientos_por_escalar(uuid, date) from public, anon;
grant execute on function despachos.system_vencimientos_por_escalar(uuid, date) to authenticated;

-- Inserta el escalamiento y marca el vencimiento 'escalado'. false = no hizo nada (completado o ya tenia ese nivel o uno mayor).
create or replace function despachos.system_vencimiento_escalar(p_deadline_id uuid, p_level text, p_notes text)
returns boolean
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_estado text;
begin
  if auth.uid() is not null then
    raise exception 'system_vencimiento_escalar es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_level is null or p_level not in ('nivel_1', 'nivel_2', 'nivel_3', 'nivel_4') then
    raise exception 'system_vencimiento_escalar: nivel inválido' using errcode = '22023';
  end if;
  select d.estado into v_estado from despachos.fiscal_deadline d where d.id = p_deadline_id for update;
  if v_estado is null then
    raise exception 'system_vencimiento_escalar: vencimiento no encontrado' using errcode = 'P0002';
  end if;
  if v_estado = 'completado' then
    return false;
  end if;
  if exists (select 1 from despachos.deadline_escalation e where e.deadline_id = p_deadline_id and e.level >= p_level) then
    return false;
  end if;
  insert into despachos.deadline_escalation (deadline_id, level, notes) values (p_deadline_id, p_level, coalesce(p_notes, ''));
  update despachos.fiscal_deadline set estado = 'escalado' where id = p_deadline_id;
  return true;
end;
$$;
revoke all on function despachos.system_vencimiento_escalar(uuid, text, text) from public, anon;
grant execute on function despachos.system_vencimiento_escalar(uuid, text, text) to authenticated;

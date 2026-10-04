-- Vigesimocuarta migración del esquema `despachos.*` (paridad3-despachos-fiscal-correcciones, D-P3-33) -- amplía los tipos de
-- vencimiento fiscal y la ventana del barrido de escalamiento.
--
-- Contexto: el calendario fiscal (`domain-despachos/src/vencimientos/calendario-fiscal.ts`) ahora genera, además de
-- ISR/IVA/DIOT/Nómina/Balanza/Anual, las obligaciones que un despacho vigila cada mes: retenciones de ISR/IVA ('Retenciones'),
-- cuotas obrero-patronales del IMSS mensuales ('IMSS') y bimestrales ('IMSS-bimestral'), impuesto sobre nómina estatal ('ISN') y la
-- declaración informativa anual de retenciones ('Informativa'). El CHECK vigente de `tipo` (migraciones 001 y 019) solo admite los
-- 6 primeros: insertar los nuevos fallaría con SQLSTATE 23514.
--
-- Qué hace:
--  1. Reemplaza el CHECK de `despachos.fiscal_deadline.tipo` por uno que admite los 11 valores. Misma mecánica que la 019.
--  2. Redefine `despachos.system_vencimientos_por_escalar` (creada en la 022) con la ventana de 21 días naturales en lugar de
--     "hoy o mañana": el barrido avisa a 7/3/1 días HÁBILES de la fecha límite y 7 días hábiles pueden ser hasta ~14 naturales (fines
--     de semana, festivos y Semana Santa). El filtro fino por días hábiles lo hace el TypeScript con el calendario fiscal; la función
--     solo entrega los candidatos. Mismas columnas, mismos atributos y mismo tope de 200 filas.
--  3. Agrega dos funciones de SOLO SISTEMA para el cron diario de vencimientos: `system_vencimientos_periodos` (periodos que ya
--     tienen vencimientos, para rellenar el periodo anterior solo en clientes que ya corrían) y `system_cliente_nombre` (razón
--     social del cliente para que el correo de escalamiento diga de QUIÉN es el vencimiento).
--  No agrega tablas, columnas ni policies; los únicos GRANT nuevos son el EXECUTE a `authenticated` de esas dos funciones.
--
-- Justificación de seguridad:
--  * Sin GRANT nuevos a nivel tabla: los de `despachos.fiscal_deadline` (select/insert/update a `authenticated`, migración 001) no
--    cambian; no hay GRANT a `anon`. El EXECUTE de `system_vencimientos_por_escalar` sigue siendo solo `authenticated` (la sesión de
--    sistema del cron usa ese rol sin claim `sub`), con `revoke all ... from public, anon` repetido tras el `create or replace`.
--  * Sin policy nueva ni modificada: el aislamiento por property sigue siendo `core.has_property_access` (001). Ampliar el CHECK no
--    abre ninguna fila a otro tenant.
--  * El CHECK sigue siendo una lista cerrada (no `tipo <> ''`): un cliente no puede inventar tipos.
--  * `system_vencimientos_por_escalar` conserva `security definer`, `set search_path = despachos, pg_temp` y la guarda
--    `auth.uid() is not null` -> 42501: un staff autenticado NO puede invocarla, así que ensanchar la ventana no expone datos a
--    ningún usuario; el filtro por `property_id` y por `estado <> 'completado'` no cambia y devuelve solo ids, tipo, periodo, fecha,
--    prioridad y el nivel máximo (sin PII).
--  * `system_vencimientos_periodos` y `system_cliente_nombre` son `security definer`, `set search_path = despachos, pg_temp`,
--    `revoke all ... from public, anon`, EXECUTE solo a `authenticated` y exigen `auth.uid() is null` (42501 si no): un staff
--    autenticado no puede invocarlas, así que no sirven para leer datos de otro cliente. La primera devuelve únicamente la lista de
--    periodos 'YYYY-MM' (sin montos ni RFC, tope 36) de UNA property; la segunda devuelve la razón social de UNA property con ficha y
--    solo se usa para armar el asunto de un correo interno al owner/admin de esa misma organización.
--
-- Compatibilidad con la base sin migrar: el código TypeScript inserta los tipos nuevos dentro de un SAVEPOINT y, si el CHECK los
-- rechaza (23514), los omite con "requiere la migración 024" sin tumbar el resto del lote; los 6 tipos anteriores siguen funcionando.
-- Contra la función de la 022 (ventana de 1 día) el barrido sigue funcionando, solo que sin los avisos anticipados.
--
-- Idempotente: busca el CHECK por su definición (no por nombre) y lo reemplaza solo si todavía es el viejo.
do $$
declare
  v_nombre text;
begin
  select c.conname into v_nombre
    from pg_constraint c
   where c.conrelid = 'despachos.fiscal_deadline'::regclass
     and c.contype = 'c'
     and pg_get_constraintdef(c.oid) like '%tipo%ISR%IVA%DIOT%'
     and pg_get_constraintdef(c.oid) not like '%Informativa%';
  if v_nombre is not null then
    execute format('alter table despachos.fiscal_deadline drop constraint %I', v_nombre);
  end if;
end $$;

alter table despachos.fiscal_deadline drop constraint if exists fiscal_deadline_tipo_check;
alter table despachos.fiscal_deadline
  add constraint fiscal_deadline_tipo_check
  check (tipo in ('ISR', 'IVA', 'DIOT', 'Nómina', 'Balanza', 'Anual', 'Retenciones', 'IMSS', 'IMSS-bimestral', 'ISN', 'Informativa'));

-- Vencimientos no completados que ya vencieron o vencen en los próximos 21 días naturales, con el mayor nivel de escalamiento ya registrado.
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
    where d.property_id = p_property_id and d.estado <> 'completado' and d.fecha_limite <= p_hoy + 21
    order by d.fecha_limite, d.tipo
    limit 200;
end;
$$;
revoke all on function despachos.system_vencimientos_por_escalar(uuid, date) from public, anon;
grant execute on function despachos.system_vencimientos_por_escalar(uuid, date) to authenticated;

-- Periodos ('YYYY-MM') que ya tienen al menos un vencimiento en la property, del más reciente al más antiguo.
create or replace function despachos.system_vencimientos_periodos(p_property_id uuid)
returns table (out_periodo text)
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'system_vencimientos_periodos es solo para la sesión de sistema' using errcode = '42501';
  end if;
  return query
    select distinct d.periodo
    from despachos.fiscal_deadline d
    where d.property_id = p_property_id
    order by d.periodo desc
    limit 36;
end;
$$;
revoke all on function despachos.system_vencimientos_periodos(uuid) from public, anon;
grant execute on function despachos.system_vencimientos_periodos(uuid) to authenticated;

-- Razón social del cliente (ficha de cartera); null si la property no tiene ficha.
create or replace function despachos.system_cliente_nombre(p_property_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_nombre text;
begin
  if auth.uid() is not null then
    raise exception 'system_cliente_nombre es solo para la sesión de sistema' using errcode = '42501';
  end if;
  select f.razon_social into v_nombre from despachos.cliente_ficha f where f.property_id = p_property_id;
  return v_nombre;
end;
$$;
revoke all on function despachos.system_cliente_nombre(uuid) from public, anon;
grant execute on function despachos.system_cliente_nombre(uuid) to authenticated;

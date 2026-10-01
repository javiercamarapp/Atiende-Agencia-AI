-- D-04 -- Lista 69-B del SAT (EFOS): almacén de la lista pública mensual y funciones de
-- ingesta/consulta. Es dato PÚBLICO y GLOBAL (no pertenece a ningún tenant), así que no
-- lleva organization_id; el aislamiento que importa aquí es otro: nadie escribe la lista
-- salvo la sesión de sistema, y solo staff real de despachos puede consultarla.
--
-- Modelo:
--   * `despachos.efos_ingesta`        -- una fila por periodo (YYYY-MM) ingerido, con el
--                                        SHA-256 del archivo fuente (llave de idempotencia).
--   * `despachos.efos_contribuyente`  -- una fila por (periodo, RFC) con la situación:
--                                        presunto | desvirtuado | definitivo | sentencia_favorable.
-- La lista del SAT es ACUMULATIVA (cada edición trae el estado completo), así que la
-- "situación vigente" de un RFC es la de la edición con periodo más reciente.
--
-- Seguridad (cada punto lo ejerce scripts/verify-despachos-efos-69b/assertions.sql):
--   1. Ambas tablas: RLS habilitado SIN ninguna policy y REVOKE explícito de todo a
--      public/anon/authenticated -> ningún cliente puede leer ni escribir directo; el único
--      camino son las 4 funciones de abajo. No hay `using (true)` ni GRANT a anon.
--   2. `efos_ingestar_periodo` (SOLO SISTEMA): security definer, search_path fijo,
--      `auth.uid() is null` o 42501, revoke de public. Se concede EXECUTE a `authenticated`
--      porque la sesión de sistema de la app corre bajo ese rol sin sub (mismo precedente
--      que `despachos.record_audit_log`, 010); cualquier sesión con sub real es rechazada
--      DENTRO de la función. Un staff NO puede reescribir la lista que luego alerta a
--      todos los tenants (integridad de un dato compartido). Idempotente por periodo:
--      mismo SHA -> 'sin_cambios'; SHA distinto -> 'reemplazada' (el SAT corrige ediciones);
--      lock asesor por periodo contra ingestas concurrentes; tope de 100000 filas.
--   3. `efos_consultar` / `efos_estado` (STAFF DE DESPACHOS): exigen `auth.uid()` no nulo y
--      una membresía real en una organización con vertical = 'despachos'. Un staff de otra
--      vertical, un usuario sin membresía y un anon reciben 42501. `efos_consultar` acota el
--      arreglo de RFC a 500 para no usarse como volcado de la lista.
--   4. `efos_invoices_afectados(p_property_id)` (STAFF DE LA PROPERTY): `auth.uid()` no nulo
--      y `core.has_property_access(auth.uid(), p_property_id)`; el join solo expone los
--      invoices de ESA property (cross-tenant cerrado) y solo situaciones accionables
--      (presunto/definitivo), tope 500.
--   5. Todas security definer con `set search_path = despachos, pg_temp`, revoke de public y
--      GRANT EXECUTE únicamente a `authenticated`. Ninguna a anon.
--
-- Compatibilidad con la base sin migrar: el TypeScript que consume estas funciones captura
-- 42883/42P01/42703 dentro de SAVEPOINT (runWithSavepointFallback) y degrada a "lista no
-- disponible" -- nunca a un 500 ni a "emisor limpio". Orden de despliegue: esta migración se
-- puede aplicar antes o después del código; sin ella el código muestra "no disponible".

create table despachos.efos_ingesta (
  periodo text primary key check (periodo ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  fuente_sha256 text not null check (fuente_sha256 ~ '^[0-9a-f]{64}$'),
  filas integer not null check (filas > 0),
  ingestado_en timestamptz not null default now()
);

create table despachos.efos_contribuyente (
  periodo text not null references despachos.efos_ingesta(periodo) on delete cascade,
  rfc text not null check (rfc ~ '^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$'),
  nombre text not null default '',
  situacion text not null check (situacion in ('presunto', 'desvirtuado', 'definitivo', 'sentencia_favorable')),
  oficio_presuncion text,
  fecha_presuncion_sat date,
  fecha_desvirtuado_sat date,
  fecha_definitivo_sat date,
  fecha_sentencia_favorable_sat date,
  primary key (periodo, rfc)
);
create index efos_contribuyente_rfc_idx on despachos.efos_contribuyente (rfc, periodo desc);

alter table despachos.efos_ingesta enable row level security;
alter table despachos.efos_contribuyente enable row level security;
revoke all on despachos.efos_ingesta from public, anon, authenticated;
revoke all on despachos.efos_contribuyente from public, anon, authenticated;

-- Helper interno: ¿el caller es staff real de una organización de despachos? No se expone
-- (revoke de public): lo invocan las funciones security definer de abajo como su dueña.
create or replace function despachos.efos_caller_es_staff_despachos()
returns boolean
language sql
stable
security definer
set search_path = despachos, pg_temp
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from core.membership m
      join core.organization o on o.id = m.organization_id
      where m.user_id = auth.uid() and o.vertical = 'despachos'
    );
$$;
revoke all on function despachos.efos_caller_es_staff_despachos() from public;

-- 1) Ingesta idempotente por periodo (solo sistema).
create or replace function despachos.efos_ingestar_periodo(p_periodo text, p_fuente_sha256 text, p_filas jsonb)
returns text
language plpgsql
security definer
set search_path = despachos, pg_temp
as $$
declare
  v_existente text;
  v_n integer;
begin
  if auth.uid() is not null then
    raise exception 'efos_ingestar_periodo: solo alcanzable desde sesión de sistema' using errcode = '42501';
  end if;
  if p_periodo is null or p_periodo !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'efos_ingestar_periodo: periodo inválido' using errcode = '22023';
  end if;
  if p_fuente_sha256 is null or p_fuente_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'efos_ingestar_periodo: sha256 inválido' using errcode = '22023';
  end if;
  if p_filas is null or jsonb_typeof(p_filas) <> 'array' then
    raise exception 'efos_ingestar_periodo: p_filas debe ser un arreglo' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_filas);
  if v_n = 0 or v_n > 100000 then
    raise exception 'efos_ingestar_periodo: tamaño de lista fuera de rango (1..100000)' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('despachos.efos_ingesta:' || p_periodo, 0));

  select fuente_sha256 into v_existente from despachos.efos_ingesta where periodo = p_periodo;
  if v_existente = p_fuente_sha256 then
    return 'sin_cambios';
  end if;

  if v_existente is not null then
    delete from despachos.efos_contribuyente where periodo = p_periodo;
    update despachos.efos_ingesta set fuente_sha256 = p_fuente_sha256, filas = v_n, ingestado_en = now() where periodo = p_periodo;
  else
    insert into despachos.efos_ingesta (periodo, fuente_sha256, filas) values (p_periodo, p_fuente_sha256, v_n);
  end if;

  insert into despachos.efos_contribuyente
    (periodo, rfc, nombre, situacion, oficio_presuncion, fecha_presuncion_sat, fecha_desvirtuado_sat, fecha_definitivo_sat, fecha_sentencia_favorable_sat)
  select p_periodo, upper(btrim(f.rfc)), coalesce(f.nombre, ''), f.situacion, f.oficio_presuncion,
         f.fecha_presuncion_sat, f.fecha_desvirtuado_sat, f.fecha_definitivo_sat, f.fecha_sentencia_favorable_sat
  from jsonb_to_recordset(p_filas) as f(
    rfc text, nombre text, situacion text, oficio_presuncion text,
    fecha_presuncion_sat date, fecha_desvirtuado_sat date, fecha_definitivo_sat date, fecha_sentencia_favorable_sat date
  );

  return case when v_existente is null then 'insertada' else 'reemplazada' end;
end;
$$;
revoke all on function despachos.efos_ingestar_periodo(text, text, jsonb) from public;
grant execute on function despachos.efos_ingestar_periodo(text, text, jsonb) to authenticated;

-- 2) Consulta de RFC contra la edición más reciente (staff de despachos).
create or replace function despachos.efos_consultar(p_rfcs text[])
returns table (
  out_periodo text,
  out_rfc text,
  out_nombre text,
  out_situacion text,
  out_oficio_presuncion text,
  out_fecha_presuncion_sat text,
  out_fecha_desvirtuado_sat text,
  out_fecha_definitivo_sat text,
  out_fecha_sentencia_favorable_sat text
)
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
begin
  if not despachos.efos_caller_es_staff_despachos() then
    raise exception 'efos_consultar: requiere staff de despachos' using errcode = '42501';
  end if;
  if p_rfcs is null or coalesce(array_length(p_rfcs, 1), 0) > 500 then
    raise exception 'efos_consultar: máximo 500 RFC por consulta' using errcode = '22023';
  end if;

  return query
    select c.periodo, c.rfc, c.nombre, c.situacion, c.oficio_presuncion,
           c.fecha_presuncion_sat::text, c.fecha_desvirtuado_sat::text, c.fecha_definitivo_sat::text, c.fecha_sentencia_favorable_sat::text
    from despachos.efos_contribuyente c
    where c.periodo = (select max(i.periodo) from despachos.efos_ingesta i)
      and c.rfc = any (select upper(btrim(x)) from unnest(p_rfcs) as x);
end;
$$;
revoke all on function despachos.efos_consultar(text[]) from public;
grant execute on function despachos.efos_consultar(text[]) to authenticated;

-- 3) Estado de la lista vigente (staff de despachos). Cero filas = nunca se ingirió.
create or replace function despachos.efos_estado()
returns table (out_periodo text, out_filas integer, out_ingestado_en text)
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
begin
  if not despachos.efos_caller_es_staff_despachos() then
    raise exception 'efos_estado: requiere staff de despachos' using errcode = '42501';
  end if;
  return query
    select i.periodo, i.filas, i.ingestado_en::text
    from despachos.efos_ingesta i
    order by i.periodo desc
    limit 1;
end;
$$;
revoke all on function despachos.efos_estado() from public;
grant execute on function despachos.efos_estado() to authenticated;

-- 4) Invoices ya ingeridos de UNA property cuyo emisor figura hoy como presunto/definitivo
--    (re-evaluación contra la lista vigente: una publicación nueva alerta CFDI viejos).
create or replace function despachos.efos_invoices_afectados(p_property_id uuid)
returns table (
  out_invoice_id uuid,
  out_folio_fiscal text,
  out_rfc_emisor text,
  out_emisor_nombre text,
  out_fecha text,
  out_total text,
  out_situacion text,
  out_periodo_lista text
)
language plpgsql
stable
security definer
set search_path = despachos, pg_temp
as $$
begin
  if auth.uid() is null or not core.has_property_access(auth.uid(), p_property_id) then
    raise exception 'efos_invoices_afectados: sin acceso a la property' using errcode = '42501';
  end if;

  return query
    select i.id, i.folio_fiscal::text, i.rfc_emisor, i.emisor_nombre, i.fecha::text, i.total::text, c.situacion, c.periodo
    from despachos.invoice i
    join despachos.efos_contribuyente c
      on c.rfc = upper(btrim(i.rfc_emisor))
     and c.periodo = (select max(g.periodo) from despachos.efos_ingesta g)
    where i.property_id = p_property_id
      and c.situacion in ('presunto', 'definitivo')
    order by i.fecha desc, i.id
    limit 500;
end;
$$;
revoke all on function despachos.efos_invoices_afectados(uuid) from public;
grant execute on function despachos.efos_invoices_afectados(uuid) to authenticated;

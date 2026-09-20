-- Ejerce, contra Postgres REAL (no el repositorio en memoria, que nunca ejecuta SQL),
-- el hallazgo de auditoría "'Calcular vencimientos' en despachos duplica filas si se
-- pulsa dos veces" y el fix real de
-- `packages/domain-despachos/src/postgres-repository.ts::createDeadline` (SQL copiado
-- LITERAL de ahí, no reescrito de memoria).
--
-- Corre bajo `service_role` (bypassrls) a propósito -- mismo criterio que
-- verify-despachos-fechas-postgres-real/assertions.sql: lo que este archivo verifica
-- es el comportamiento del SQL/índice, no RLS/GRANT (eso ya lo cubren
-- verify-outbox-grants/verify-hoteles-sql-critico con sesión de staff real).
--
-- Cada escenario corre en su propio `begin; ... rollback;` -- nada aquí persiste,
-- salvo el fixture de organización/property de arriba (compartido, fuera de
-- cualquier begin/rollback, igual que verify-despachos-fechas-postgres-real). Los
-- escenarios 2 y 6 (numeración de los `\echo` de abajo) deben terminar en ERROR --
-- ver la lista explícita al final del archivo, que es la fuente de verdad que usa
-- `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo criterio que
-- verify-outbox-grants/assertions.sql).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000e0', 'despachos', 'Despacho Verify Unique SC', 'despacho-verify-fiscal-deadline-unique')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e0', 'despachos', 'Sede única')
on conflict do nothing;

\echo '=== 1. El índice unique (property_id, tipo, periodo) YA existe -- viene de la migración ORIGINAL de la Fase 1 (001_despachos_schema.sql), no de una migración nueva de este PR. Debe haber exactamente 1. ==='
begin;
set local role service_role;
select conname, pg_get_constraintdef(oid) as definicion
  from pg_constraint
 where conrelid = 'despachos.fiscal_deadline'::regclass
   and contype = 'u';
select count(*) as indice_unique_deberia_ser_1
  from pg_constraint
 where conrelid = 'despachos.fiscal_deadline'::regclass
   and contype = 'u'
   and pg_get_constraintdef(oid) = 'UNIQUE (property_id, tipo, periodo)';
rollback;

\echo ''
\echo '=== 2. REPRODUCE EL BUG ORIGINAL (antes de este fix): INSERT plano dos veces para el mismo (property_id, tipo, periodo) -- el 2do INSERT DEBE FALLAR con 23505 (unique_violation) crudo. Este es el "500 en vez de idempotente" que veía el staff al pulsar "Calcular" dos veces. ==='
begin;
set local role service_role;
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad)
  values ('00000000-0000-0000-0000-0000000000e0', '00000000-0000-0000-0000-0000000000e1', 'ISR', '2026-06', '2026-07-17', 'media');
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad)
  values ('00000000-0000-0000-0000-0000000000e0', '00000000-0000-0000-0000-0000000000e1', 'ISR', '2026-06', '2026-07-17', 'media');
rollback;

\echo ''
\echo '=== 3. SQL REAL del fix (insertDeadlineOnConflictDoNothing) -- 1a llamada: inserta y devuelve la fila; 2a llamada (MISMA transacción, como el loop real de vencimientos.ts): ON CONFLICT DO NOTHING descarta en silencio, sin lanzar; findDeadlineByPeriodo relee la fila EXISTENTE. Efecto real: exactamente 1 fila, nunca 2. ==='
begin;
set local role service_role;
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad)
  values ('00000000-0000-0000-0000-0000000000e0', '00000000-0000-0000-0000-0000000000e1', 'IVA', '2026-06', '2026-07-17', 'media')
  on conflict (property_id, tipo, periodo) do nothing
  returning id, organization_id, property_id, tipo, periodo, fecha_limite::text as fecha_limite, prioridad, estado,
            fecha_presentacion::text as fecha_presentacion, comprobante_url, created_at;
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad)
  values ('00000000-0000-0000-0000-0000000000e0', '00000000-0000-0000-0000-0000000000e1', 'IVA', '2026-06', '2026-07-17', 'media')
  on conflict (property_id, tipo, periodo) do nothing
  returning id, organization_id, property_id, tipo, periodo, fecha_limite::text as fecha_limite, prioridad, estado,
            fecha_presentacion::text as fecha_presentacion, comprobante_url, created_at;
select id, organization_id, property_id, tipo, periodo, fecha_limite::text as fecha_limite, prioridad, estado,
       fecha_presentacion::text as fecha_presentacion, comprobante_url, created_at
  from despachos.fiscal_deadline where property_id = '00000000-0000-0000-0000-0000000000e1' and tipo = 'IVA' and periodo = '2026-06';
select count(*) as filas_deberia_ser_1
  from despachos.fiscal_deadline where property_id = '00000000-0000-0000-0000-0000000000e1' and tipo = 'IVA' and periodo = '2026-06';
rollback;

\echo ''
\echo '=== 4. El batch completo de "calcular" (4 tipos ISR/IVA/DIOT/Nómina) llamado DOS VECES para el mismo periodo, EN LA MISMA transacción (como hace vencimientos.ts en un solo request) -- 8 llamadas a ON CONFLICT DO NOTHING, deben quedar exactamente 4 filas, nunca 8, nunca un error. ==='
begin;
set local role service_role;
do $$
declare
  v_tipo text;
begin
  for v_tipo in select unnest(array['ISR', 'IVA', 'DIOT', 'Nómina']) loop
    insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad)
      values ('00000000-0000-0000-0000-0000000000e0', '00000000-0000-0000-0000-0000000000e1', v_tipo, '2026-07', '2026-08-17', 'alta')
      on conflict (property_id, tipo, periodo) do nothing;
    insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad)
      values ('00000000-0000-0000-0000-0000000000e0', '00000000-0000-0000-0000-0000000000e1', v_tipo, '2026-07', '2026-08-17', 'alta')
      on conflict (property_id, tipo, periodo) do nothing;
  end loop;
end $$;
select count(*) as filas_deberia_ser_4
  from despachos.fiscal_deadline where property_id = '00000000-0000-0000-0000-0000000000e1' and periodo = '2026-07';
rollback;

\echo ''
\echo '=== 5. Verificación de duplicados PREEXISTENTES (requisito de la tarea: confirmar que no hay filas que ya violarían el índice antes de que exista) -- esta es la MISMA query a correr contra la base real de producción vía el dashboard/CLI de Supabase (no accesible desde este entorno de build); aquí, base efímera recién creada, el resultado esperado es 0. ==='
begin;
set local role service_role;
select property_id, tipo, periodo, count(*) as duplicados
  from despachos.fiscal_deadline
 group by property_id, tipo, periodo
having count(*) > 1;
select count(*) as filas_con_duplicados_deberia_ser_0
  from (
    select property_id, tipo, periodo
      from despachos.fiscal_deadline
     group by property_id, tipo, periodo
    having count(*) > 1
  ) dup;
rollback;

\echo ''
\echo '=== 6. CANARIO NEGATIVO -- 42P10 real: mismo `ON CONFLICT (property_id, tipo, periodo) DO NOTHING` pero contra una tabla EQUIVALENTE sin el índice unique (simula la base sin migrar que el catch de 42P10 en postgres-repository.ts maneja). DEBE FALLAR con SQLSTATE 42P10, nunca con otro código. ==='
begin;
set local role service_role;
create temporary table fiscal_deadline_sin_indice (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  property_id uuid not null,
  tipo text not null,
  periodo text not null,
  fecha_limite date not null,
  prioridad text not null
);
insert into fiscal_deadline_sin_indice (organization_id, property_id, tipo, periodo, fecha_limite, prioridad)
  values ('00000000-0000-0000-0000-0000000000e0', '00000000-0000-0000-0000-0000000000e1', 'ISR', '2026-08', '2026-09-17', 'media')
  on conflict (property_id, tipo, periodo) do nothing;
rollback;

-- Lista explícita para scripts/verify-real-postgres-ci/run-gate.mjs (fuente de verdad
-- que anula al heurístico de alias por bloque): los escenarios 2/6 deben terminar en ERROR.

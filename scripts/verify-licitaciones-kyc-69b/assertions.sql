-- Fixtures + assertions contra Postgres REAL (RLS + GRANT por columna + definer + auth.uid()
-- reales) para packages/domain-licitaciones/migrations/031_licitaciones_kyc_69b.sql
-- (L-08: KYC negativo contra la lista 69-B del SAT).
--
-- Actores (todos "authenticated"; el rol de plataforma lo fija vertical_role):
--   c1 = owner Org A   c3 = writer Org A   c4 = viewer Org A   c5 = analyst Org A
--   c2 = owner Org B (otro tenant de licitaciones)   c6 = staff de una org de DESPACHOS
--
-- Lista 69-B de fixtures (RFC ficticios; nada se descarga de internet): dos ediciones. La mas
-- reciente (2024-06) es la vigente; la anterior (2024-05) debe ignorarse.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): `as should_fail`
-- = el escenario DEBE terminar en ERROR; cualquier otro escenario debe completar sin error
-- (los positivos y los negativos con SQLSTATE exacto afirman con DO ... raise exception).
-- Cada escenario corre en su propio `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000d1', 'licitaciones', 'Org A (kyc)', 'org-a-kyc'),
  ('00000000-0000-0000-0000-0000000000d2', 'licitaciones', 'Org B (kyc, ajena)', 'org-b-kyc'),
  ('00000000-0000-0000-0000-0000000000d3', 'despachos', 'Despacho (kyc, otra vertical)', 'despacho-kyc')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000c1', 'owner-a-kyc@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c2', 'owner-b-kyc@example.com', 'Owner B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-0000000000c3', 'writer-a-kyc@example.com', 'Writer A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c4', 'viewer-a-kyc@example.com', 'Viewer A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c5', 'analyst-a-kyc@example.com', 'Analyst A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c6', 'staff-despacho-kyc@example.com', 'Staff despacho', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000d1', null, 'member', 'writer'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000d1', null, 'viewer', 'viewer'),
  ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000d1', null, 'member', 'analyst'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000d2', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000000c6', '00000000-0000-0000-0000-0000000000d3', null, 'owner', 'owner')
on conflict do nothing;

-- Lista 69-B (como superusuario: las tablas de despachos no tienen GRANT para nadie mas).
insert into despachos.efos_ingesta (periodo, fuente_sha256, filas) values
  ('2024-05', repeat('a', 64), 3),
  ('2024-06', repeat('b', 64), 5);
insert into despachos.efos_contribuyente (periodo, rfc, nombre, situacion, oficio_presuncion, fecha_presuncion_sat, fecha_desvirtuado_sat, fecha_definitivo_sat, fecha_sentencia_favorable_sat) values
  ('2024-05', 'FISI800101AB1', 'PERSONA FISICA FICTICIA', 'presunto', '500-05-2024-1', '2024-05-10', null, null, null),
  ('2024-05', 'OLD900909ZZ9', 'SOLO EDICION VIEJA SA', 'presunto', '500-05-2024-2', '2024-05-11', null, null, null),
  ('2024-05', 'PRE850101AB1', 'PRESUNTA FICTICIA SA', 'presunto', '500-05-2024-3', '2024-05-12', null, null, null),
  ('2024-06', 'PRE850101AB1', 'PRESUNTA FICTICIA SA', 'presunto', '500-05-2024-3', '2024-05-12', null, null, null),
  ('2024-06', 'DEF900202CD2', 'DEFINITIVA FICTICIA SA', 'definitivo', '500-05-2024-4', '2024-01-15', null, '2024-06-03', null),
  ('2024-06', 'DES800303EF3', 'DESVIRTUADA FICTICIA SA', 'desvirtuado', '500-05-2024-5', '2024-01-16', '2024-04-20', null, null),
  ('2024-06', 'SEN700404GH4', 'SENTENCIA FICTICIA SA', 'sentencia_favorable', '500-05-2024-6', '2024-01-17', null, null, '2024-05-30'),
  ('2024-06', 'FISI800101AB1', 'PERSONA FISICA FICTICIA', 'definitivo', '500-05-2024-1', '2024-05-10', null, '2024-06-03', null);

\echo ''
\echo '=== licitaciones: KYC negativo 69-B (031) ==='
\echo ''

\echo '--- 1. POSITIVO: writer consulta un lote (mayusculas/espacios/duplicados) y obtiene la situacion de la edicion VIGENTE ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$ declare n integer; r record; begin
  select count(*) into n from licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1',
    array['  pre850101ab1 ', 'PRE850101AB1', 'DEF900202CD2', 'DES800303EF3', 'SEN700404GH4', 'FISI800101AB1', 'LIM750505IJ5', 'OLD900909ZZ9']);
  if n <> 7 then raise exception 'esperadas 7 filas distintas, obtuve %', n; end if;
  select * into r from licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array['PRE850101AB1']);
  if r.out_situacion <> 'presunto' or r.out_fecha_publicacion <> '2024-05-12' or r.out_periodo <> '2024-06' or not r.out_encontrado then
    raise exception 'presunto mal: %', r; end if;
  select * into r from licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array['DEF900202CD2']);
  if r.out_situacion <> 'definitivo' or r.out_fecha_publicacion <> '2024-06-03' then raise exception 'definitivo mal: %', r; end if;
  select * into r from licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array['DES800303EF3']);
  if r.out_situacion <> 'desvirtuado' or r.out_fecha_publicacion <> '2024-04-20' then raise exception 'desvirtuado mal: %', r; end if;
  select * into r from licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array['SEN700404GH4']);
  if r.out_situacion <> 'sentencia_favorable' or r.out_fecha_publicacion <> '2024-05-30' then raise exception 'sentencia mal: %', r; end if;
  -- la edicion vieja dice presunto, la vigente dice definitivo: gana la vigente (persona fisica, 13 caracteres)
  select * into r from licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array['FISI800101AB1']);
  if r.out_situacion <> 'definitivo' then raise exception 'persona fisica debia ser definitivo (edicion vigente): %', r; end if;
  -- no aparece en la vigente (solo estaba en la vieja) y no aparece en ninguna
  select * into r from licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array['OLD900909ZZ9']);
  if r.out_encontrado or r.out_situacion is not null then raise exception 'OLD debia no aparecer: %', r; end if;
  select * into r from licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array['LIM750505IJ5']);
  if r.out_encontrado or r.out_periodo <> '2024-06' then raise exception 'LIM debia no aparecer en 2024-06: %', r; end if;
end $$;
rollback;

\echo '--- 2. POSITIVO: la consulta queda en la bitacora de SU organizacion y la ve el rol de decision ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
select count(*) from licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array['PRE850101AB1', 'LIM750505IJ5']);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
do $$ declare n integer; m integer; begin
  select count(*) into n from licitaciones.kyc_consulta;
  select count(*) into m from licitaciones.kyc_consulta where user_id = '00000000-0000-0000-0000-0000000000c3' and lote_id is not null
    and ((rfc = 'PRE850101AB1' and encontrado and situacion = 'presunto' and periodo = '2024-06')
      or (rfc = 'LIM750505IJ5' and not encontrado and situacion is null));
  if n <> 2 or m <> 2 then raise exception 'bitacora esperada 2/2, obtuve % / %', n, m; end if;
end $$;
rollback;

\echo '--- 3. NEGATIVO: viewer no puede consultar (una consulta deja huella; exige rol de escritura) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
do $$ begin
  perform licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array['PRE850101AB1']);
  raise exception 'el viewer no debia poder consultar';
exception when sqlstate '42501' then null;
end $$;
rollback;

\echo '--- 4. ANON: no puede ejecutar ninguna de las tres funciones ---'
begin;
set local role anon;
-- as should_fail (permission denied for function)
select * from licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array['PRE850101AB1']) as should_fail;
rollback;

begin;
set local role anon;
-- as should_fail (permission denied for function)
select * from licitaciones.kyc_estado_lista() as should_fail;
rollback;

begin;
set local role anon;
-- as should_fail (permission denied for function)
select * from licitaciones.kyc_fichas_con_situacion('00000000-0000-0000-0000-0000000000d1') as should_fail;
rollback;

\echo '--- 5. CROSS-TENANT: owner de Org B no puede consultar ni listar fichas a nombre de la organizacion A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
do $$ begin
  perform licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array['PRE850101AB1']);
  raise exception 'cross-tenant: consulta a nombre de otra org no debia pasar';
exception when sqlstate '42501' then null;
end $$;
do $$ begin
  perform licitaciones.kyc_fichas_con_situacion('00000000-0000-0000-0000-0000000000d1');
  raise exception 'cross-tenant: fichas de otra org no debian pasar';
exception when sqlstate '42501' then null;
end $$;
rollback;

\echo '--- 6. CROSS-TENANT: la bitacora de una org es invisible para otra (y para roles sin decision) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
select count(*) from licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array['PRE850101AB1']);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select count(*) from licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d2', array['DEF900202CD2', 'SEN700404GH4']);
do $$ declare n integer; begin
  select count(*) into n from licitaciones.kyc_consulta;
  if n <> 2 then raise exception 'owner B debia ver solo sus 2 consultas, vio %', n; end if;
  if exists (select 1 from licitaciones.kyc_consulta where organization_id = '00000000-0000-0000-0000-0000000000d1') then
    raise exception 'owner B ve consultas de la org A';
  end if;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$ declare n integer; begin
  select count(*) into n from licitaciones.kyc_consulta;
  if n <> 0 then raise exception 'writer (sin rol de decision) no debia ver la bitacora, vio %', n; end if;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
do $$ declare n integer; begin
  select count(*) into n from licitaciones.kyc_consulta;
  if n <> 0 then raise exception 'viewer no debia ver la bitacora, vio %', n; end if;
end $$;
rollback;

\echo '--- 7. NEGATIVO: la bitacora no se escribe desde el cliente (sin INSERT) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (permission denied for table kyc_consulta)
insert into licitaciones.kyc_consulta (organization_id, lote_id, rfc, encontrado) values ('00000000-0000-0000-0000-0000000000d1', gen_random_uuid(), 'PRE850101AB1', false);
rollback;

\echo '--- 8. NEGATIVO: la bitacora no se borra desde el cliente (sin DELETE) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (permission denied for table kyc_consulta)
delete from licitaciones.kyc_consulta;
rollback;

\echo '--- 9. NEGATIVO: RFC con forma invalida (22023): corto, mes 13, dia 32, homoclave final invalida, caracteres raros, NULL ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$ declare bad text; begin
  foreach bad in array array['123', 'PRE85010', 'PRE851301AB1', 'PRE850132AB1', 'PRE850101ABZ', 'PRE85-101AB1', 'PRE850101AB1X', 'PRE850101AB', E'PRE850101AB1\n', '''; drop table x; --'] loop
    begin
      perform licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array[bad]);
      raise exception 'RFC invalido aceptado: %', bad;
    exception when sqlstate '22023' then null;
    end;
  end loop;
  begin
    perform licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array[null]::text[]);
    raise exception 'RFC NULL aceptado';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array['PRE850101AB1', 'xx']);
    raise exception 'un RFC invalido dentro de un lote debia rechazar TODO el lote';
  exception when sqlstate '22023' then null;
  end;
end $$;
rollback;

\echo '--- 9b. Un lote rechazado no deja huella en la bitacora ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$ begin
  perform licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array['PRE850101AB1', 'xx']);
exception when sqlstate '22023' then null;
end $$;
reset role;
do $$ declare n integer; begin
  select count(*) into n from licitaciones.kyc_consulta;
  if n <> 0 then raise exception 'un lote rechazado dejo % filas en la bitacora', n; end if;
end $$;
rollback;

\echo '--- 10. NEGATIVO: RFC genericos (publico en general / extranjero) no identifican a nadie ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$ begin
  perform licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array['XAXX010101000']);
  raise exception 'RFC generico aceptado';
exception when sqlstate '22023' then null;
end $$;
do $$ begin
  perform licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array['xexx010101000']);
  raise exception 'RFC generico (extranjero) aceptado';
exception when sqlstate '22023' then null;
end $$;
rollback;

\echo '--- 11. TOPE DE LOTE: 50 RFC distintos pasan, 51 se rechazan, vacio y NULL se rechazan ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$ declare n integer; begin
  select count(*) into n from licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1',
    (select array_agg('ZZZ010101' || chr(65 + i / 26) || chr(65 + i % 26) || '1') from generate_series(0, 49) i));
  if n <> 50 then raise exception 'esperaba 50 filas, obtuve %', n; end if;
  begin
    perform licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1',
      (select array_agg('ZZY010101' || chr(65 + i / 26) || chr(65 + i % 26) || '1') from generate_series(0, 50) i));
    raise exception '51 RFC aceptados';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array[]::text[]);
    raise exception 'lote vacio aceptado';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', null);
    raise exception 'lote NULL aceptado';
  exception when sqlstate '22023' then null;
  end;
end $$;
rollback;

\echo '--- 12. ANTI-SCRAPING: tope de 1000 RFC por organizacion cada 24 h (54000), la otra org no se ve afectada ---'
begin;
insert into licitaciones.kyc_consulta (organization_id, lote_id, rfc, encontrado)
  select '00000000-0000-0000-0000-0000000000d1', gen_random_uuid(), 'PRE850101AB1', false from generate_series(1, 990);
-- consultas viejas (fuera de la ventana de 24 h) no cuentan
insert into licitaciones.kyc_consulta (organization_id, lote_id, rfc, encontrado, consultado_en)
  select '00000000-0000-0000-0000-0000000000d1', gen_random_uuid(), 'PRE850101AB1', false, now() - interval '3 days' from generate_series(1, 500);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$ begin
  perform licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1',
    (select array_agg('ZZX010101' || chr(65 + i / 26) || chr(65 + i % 26) || '1') from generate_series(0, 10) i));
  raise exception '11 RFC mas debian rebasar el tope diario';
exception when sqlstate '54000' then null;
end $$;
do $$ declare n integer; begin
  select count(*) into n from licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1',
    (select array_agg('ZZW010101' || chr(65 + i / 26) || chr(65 + i % 26) || '1') from generate_series(0, 9) i));
  if n <> 10 then raise exception 'los 10 RFC que completan 1000 debian pasar'; end if;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
do $$ declare n integer; begin
  select count(*) into n from licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d2', array['PRE850101AB1']);
  if n <> 1 then raise exception 'la org B no debia verse afectada por el tope de la org A'; end if;
end $$;
rollback;

\echo '--- 13. SISTEMA (auth.uid() NULL) y staff de OTRA vertical no pueden consultar ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  perform licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array['PRE850101AB1']);
  raise exception 'la sesion de sistema no debia consultar';
exception when sqlstate '42501' then null;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c6', true);
do $$ begin
  perform licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d3', array['PRE850101AB1']);
  raise exception 'staff de despachos no debia consultar a nombre de su org (vertical distinta)';
exception when sqlstate '42501' then null;
end $$;
do $$ begin
  perform licitaciones.kyc_estado_lista();
  raise exception 'staff de despachos no debia leer kyc_estado_lista';
exception when sqlstate '42501' then null;
end $$;
rollback;

\echo '--- 14. SIN LISTA CARGADA: devuelve filas "no encontrado" con periodo NULL (la app lo muestra como lista no disponible) ---'
begin;
delete from despachos.efos_ingesta;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$ declare r record; n integer; begin
  select * into r from licitaciones.kyc_consultar_69b('00000000-0000-0000-0000-0000000000d1', array['PRE850101AB1']);
  if r.out_periodo is not null or r.out_encontrado then raise exception 'sin lista debia dar periodo NULL y no encontrado: %', r; end if;
  select count(*) into n from licitaciones.kyc_estado_lista();
  if n <> 0 then raise exception 'kyc_estado_lista debia dar 0 filas sin ingesta'; end if;
end $$;
rollback;

\echo '--- 15. kyc_estado_lista: staff de licitaciones ve el periodo vigente ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
do $$ declare r record; begin
  select * into r from licitaciones.kyc_estado_lista();
  if r.out_periodo <> '2024-06' or r.out_filas <> 5 then raise exception 'estado mal: %', r; end if;
end $$;
rollback;

\echo '--- 16. Las tablas de la lista (despachos) siguen cerradas: licitaciones solo lee via la funcion definer ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (permission denied for table efos_contribuyente)
select count(*) as should_fail from despachos.efos_contribuyente;
rollback;

\echo '--- 17. kyc_party POSITIVO: writer crea una ficha y edita solo el nombre; created_by lo pone la base ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
insert into licitaciones.kyc_party (organization_id, rfc, rol, nombre) values ('00000000-0000-0000-0000-0000000000d1', 'PRE850101AB1', 'proveedor', 'Proveedor uno');
update licitaciones.kyc_party set nombre = 'Proveedor uno (renombrado)' where rfc = 'PRE850101AB1';
do $$ declare r record; begin
  select * into r from licitaciones.kyc_party where rfc = 'PRE850101AB1';
  if r.nombre <> 'Proveedor uno (renombrado)' or r.created_by <> '00000000-0000-0000-0000-0000000000c3' then raise exception 'ficha mal: %', r; end if;
end $$;
rollback;

\echo '--- 18. kyc_party NEGATIVO: viewer no inserta (RLS) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
-- as should_fail (row-level security)
insert into licitaciones.kyc_party (organization_id, rfc, rol, nombre) values ('00000000-0000-0000-0000-0000000000d1', 'PRE850101AB1', 'proveedor', 'x');
rollback;

\echo '--- 19. kyc_party CROSS-TENANT: owner de Org B no inserta en la org A (RLS) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
-- as should_fail (row-level security)
insert into licitaciones.kyc_party (organization_id, rfc, rol, nombre) values ('00000000-0000-0000-0000-0000000000d1', 'PRE850101AB1', 'competidor', 'x');
rollback;

\echo '--- 20. kyc_party GRANT por columna: created_by no se fija desde el cliente ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
-- as should_fail (permission denied for column created_by)
insert into licitaciones.kyc_party (organization_id, rfc, rol, created_by) values ('00000000-0000-0000-0000-0000000000d1', 'PRE850101AB1', 'proveedor', '00000000-0000-0000-0000-0000000000c1');
rollback;

\echo '--- 21. kyc_party GRANT por columna: rfc es inmutable (UPDATE de rfc denegado) ---'
begin;
insert into licitaciones.kyc_party (organization_id, rfc, rol, nombre) values ('00000000-0000-0000-0000-0000000000d1', 'PRE850101AB1', 'proveedor', 'x');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
-- as should_fail (permission denied for column rfc)
update licitaciones.kyc_party set rfc = 'DEF900202CD2' where rfc = 'PRE850101AB1';
rollback;

\echo '--- 22. kyc_party: RFC invalido por CHECK y ficha duplicada por UNIQUE ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$ begin
  insert into licitaciones.kyc_party (organization_id, rfc, rol) values ('00000000-0000-0000-0000-0000000000d1', 'pre850101ab1', 'proveedor');
  raise exception 'RFC en minusculas aceptado por la tabla';
exception when sqlstate '23514' then null;
end $$;
do $$ begin
  insert into licitaciones.kyc_party (organization_id, rfc, rol) values ('00000000-0000-0000-0000-0000000000d1', 'PRE850101AB1', 'cliente');
  raise exception 'rol invalido aceptado';
exception when sqlstate '23514' then null;
end $$;
insert into licitaciones.kyc_party (organization_id, rfc, rol) values ('00000000-0000-0000-0000-0000000000d1', 'PRE850101AB1', 'proveedor');
do $$ begin
  insert into licitaciones.kyc_party (organization_id, rfc, rol) values ('00000000-0000-0000-0000-0000000000d1', 'PRE850101AB1', 'proveedor');
  raise exception 'ficha duplicada aceptada';
exception when sqlstate '23505' then null;
end $$;
rollback;

\echo '--- 23. kyc_party LECTURA: viewer ve las fichas de su org; otra org ve 0 ---'
begin;
insert into licitaciones.kyc_party (organization_id, rfc, rol, nombre) values
  ('00000000-0000-0000-0000-0000000000d1', 'PRE850101AB1', 'proveedor', 'A1'),
  ('00000000-0000-0000-0000-0000000000d1', 'DEF900202CD2', 'competidor', 'A2'),
  ('00000000-0000-0000-0000-0000000000d2', 'DES800303EF3', 'proveedor', 'B1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
do $$ declare n integer; begin
  select count(*) into n from licitaciones.kyc_party;
  if n <> 2 then raise exception 'viewer A debia ver 2 fichas, vio %', n; end if;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
do $$ declare n integer; begin
  select count(*) into n from licitaciones.kyc_party where organization_id = '00000000-0000-0000-0000-0000000000d1';
  if n <> 0 then raise exception 'owner B ve fichas de A'; end if;
end $$;
rollback;

\echo '--- 24. kyc_party: borrar exige rol de escritura (viewer: 0 filas) y writer si borra ---'
begin;
insert into licitaciones.kyc_party (organization_id, rfc, rol, nombre) values ('00000000-0000-0000-0000-0000000000d1', 'PRE850101AB1', 'proveedor', 'A1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
do $$ declare n integer; begin
  delete from licitaciones.kyc_party;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'viewer borro % fichas', n; end if;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$ declare n integer; begin
  delete from licitaciones.kyc_party;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'writer debia borrar 1 ficha, borro %', n; end if;
end $$;
rollback;

\echo '--- 25. kyc_party TOPE: la ficha 501 de una organizacion se rechaza (54000) ---'
begin;
insert into licitaciones.kyc_party (organization_id, rfc, rol)
  select '00000000-0000-0000-0000-0000000000d1', 'ZZV010101' || chr(65 + i / 26) || chr(65 + i % 26) || '1', 'competidor' from generate_series(0, 499) i;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$ begin
  insert into licitaciones.kyc_party (organization_id, rfc, rol) values ('00000000-0000-0000-0000-0000000000d1', 'PRE850101AB1', 'proveedor');
  raise exception 'la ficha 501 debia rechazarse';
exception when sqlstate '54000' then null;
end $$;
rollback;

\echo '--- 26. kyc_fichas_con_situacion: semaforo de la cartera (alerta de proveedor propio) ---'
begin;
insert into licitaciones.kyc_party (organization_id, rfc, rol, nombre) values
  ('00000000-0000-0000-0000-0000000000d1', 'PRE850101AB1', 'proveedor', 'Proveedor presunto'),
  ('00000000-0000-0000-0000-0000000000d1', 'DEF900202CD2', 'competidor', 'Competidor definitivo'),
  ('00000000-0000-0000-0000-0000000000d1', 'LIM750505IJ5', 'proveedor', 'Proveedor limpio'),
  ('00000000-0000-0000-0000-0000000000d2', 'DEF900202CD2', 'proveedor', 'Ficha de OTRA org');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
do $$ declare n integer; r record; begin
  select count(*) into n from licitaciones.kyc_fichas_con_situacion('00000000-0000-0000-0000-0000000000d1');
  if n <> 3 then raise exception 'esperadas 3 fichas de A, obtuve %', n; end if;
  select * into r from licitaciones.kyc_fichas_con_situacion('00000000-0000-0000-0000-0000000000d1') where out_rfc = 'PRE850101AB1';
  if r.out_rol <> 'proveedor' or r.out_situacion <> 'presunto' or r.out_fecha_publicacion <> '2024-05-12' or r.out_periodo <> '2024-06' then raise exception 'ficha presunta mal: %', r; end if;
  select * into r from licitaciones.kyc_fichas_con_situacion('00000000-0000-0000-0000-0000000000d1') where out_rfc = 'LIM750505IJ5';
  if r.out_encontrado or r.out_situacion is not null then raise exception 'ficha limpia mal: %', r; end if;
end $$;
-- una lectura de la cartera NO es una consulta nueva: no registra en la bitacora
reset role;
do $$ declare n integer; begin
  select count(*) into n from licitaciones.kyc_consulta;
  if n <> 0 then raise exception 'kyc_fichas_con_situacion no debia registrar consultas, hay %', n; end if;
end $$;
rollback;

\echo '--- 27. Las funciones son security definer con search_path fijo y sin EXECUTE para public/anon ---'
begin;
do $$ declare n integer; begin
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
   where s.nspname = 'licitaciones'
     and p.proname in ('kyc_consultar_69b', 'kyc_estado_lista', 'kyc_fichas_con_situacion')
     and p.prosecdef
     and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
     and not has_function_privilege('anon', p.oid, 'execute')
     and has_function_privilege('authenticated', p.oid, 'execute');
  if n <> 3 then raise exception 'esperaba 3 funciones definer endurecidas, hay %', n; end if;
end $$;
rollback;

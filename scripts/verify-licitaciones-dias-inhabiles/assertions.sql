-- Fixtures + assertions contra Postgres REAL (RLS + GRANT por columna + trigger + definer + auth.uid()
-- reales) para packages/domain-licitaciones/migrations/032_licitaciones_dias_inhabiles.sql
-- (L-22: calendario de dias inhabiles por organizacion y por convocatoria).
--
-- Actores (todos "authenticated"; el rol de plataforma lo fija vertical_role):
--   c1 = owner Org A   c3 = writer Org A   c4 = viewer Org A   c5 = analyst Org A
--   c2 = owner Org B (otro tenant de licitaciones)
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): `as should_fail` = el
-- escenario DEBE terminar en ERROR; los demas deben completar sin error (los negativos con SQLSTATE
-- exacto afirman con DO ... raise exception). Cada escenario corre en su propio `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000d1', 'licitaciones', 'Org A (dias inhabiles)', 'org-a-dias'),
  ('00000000-0000-0000-0000-0000000000d2', 'licitaciones', 'Org B (dias inhabiles, ajena)', 'org-b-dias')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000c1', 'owner-a-dias@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c2', 'owner-b-dias@example.com', 'Owner B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-0000000000c3', 'writer-a-dias@example.com', 'Writer A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c4', 'viewer-a-dias@example.com', 'Viewer A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c5', 'analyst-a-dias@example.com', 'Analyst A', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000d1', null, 'member', 'writer'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000d1', null, 'viewer', 'viewer'),
  ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000d1', null, 'member', 'analyst'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000d2', null, 'owner', 'owner')
on conflict do nothing;

insert into licitaciones.tender (id, organization_id, title, submission_deadline) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', 'Convocatoria A', now() + interval '20 days'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000d2', 'Convocatoria B (ajena)', now() + interval '20 days')
on conflict do nothing;

-- Dias ya declarados (como superusuario) para los escenarios de lectura y de sistema.
insert into licitaciones.dia_inhabil (id, organization_id, tender_id, fecha, nombre, created_by) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1', null, '2026-04-02', 'Jueves Santo (Org A)', '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', '2026-04-10', 'Dia de la convocante (Org A)', '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000d2', null, '2026-05-04', 'Dia de Org B', '00000000-0000-0000-0000-0000000000c2');

\echo ''
\echo '=== licitaciones: calendario de dias inhabiles (032) ==='
\echo ''

\echo '--- 1. POSITIVO: cualquier miembro (viewer) ve SOLO los dias de su organizacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
do $$ declare n integer; begin
  select count(*) into n from licitaciones.dia_inhabil;
  if n <> 2 then raise exception 'el viewer de Org A debia ver 2 dias, vio %', n; end if;
  select count(*) into n from licitaciones.dia_inhabil where organization_id = '00000000-0000-0000-0000-0000000000d2';
  if n <> 0 then raise exception 'el viewer de Org A veia dias de Org B'; end if;
end $$;
rollback;

\echo '--- 2. CROSS-TENANT: el owner de Org B no ve ni los dias ni la convocatoria de Org A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
do $$ declare n integer; begin
  select count(*) into n from licitaciones.dia_inhabil;
  if n <> 1 then raise exception 'el owner de Org B debia ver 1 dia, vio %', n; end if;
  select count(*) into n from licitaciones.dia_inhabil where organization_id = '00000000-0000-0000-0000-0000000000d1';
  if n <> 0 then raise exception 'Org B veia dias de Org A'; end if;
end $$;
rollback;

\echo '--- 3. POSITIVO: owner y analyst declaran un dia (created_by = auth.uid()) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
insert into licitaciones.dia_inhabil (organization_id, fecha, nombre, publicado_por, fuente, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '2026-04-03', 'Viernes Santo', 'SHCP', 'DOF 2026-01-10', '00000000-0000-0000-0000-0000000000c1');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
insert into licitaciones.dia_inhabil (organization_id, tender_id, fecha, nombre, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', '2026-04-14', 'Dia de la convocante', '00000000-0000-0000-0000-0000000000c5');
do $$ declare n integer; begin
  select count(*) into n from licitaciones.dia_inhabil where eliminado_en is null;
  if n <> 4 then raise exception 'esperados 4 dias vigentes de Org A tras declarar 2, hay %', n; end if;
end $$;
rollback;

\echo '--- 4. NEGATIVO: writer y viewer NO declaran dias (cambian plazos legales: exige owner/admin/analyst) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$ begin
  insert into licitaciones.dia_inhabil (organization_id, fecha, nombre, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '2026-06-01', 'Intento del writer', '00000000-0000-0000-0000-0000000000c3');
  raise exception 'el writer no debia poder declarar un dia';
exception when sqlstate '42501' then null;
end $$;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
do $$ begin
  insert into licitaciones.dia_inhabil (organization_id, fecha, nombre, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '2026-06-01', 'Intento del viewer', '00000000-0000-0000-0000-0000000000c4');
  raise exception 'el viewer no debia poder declarar un dia';
exception when sqlstate '42501' then null;
end $$;
rollback;

\echo '--- 5. CROSS-TENANT: el owner de Org B no declara dias a nombre de Org A ni cuelga uno de la convocatoria de Org A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
do $$ begin
  insert into licitaciones.dia_inhabil (organization_id, fecha, nombre, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '2026-06-01', 'Org B a nombre de Org A', '00000000-0000-0000-0000-0000000000c2');
  raise exception 'Org B no debia poder escribir en Org A';
exception when sqlstate '42501' then null;
end $$;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
do $$ begin
  insert into licitaciones.dia_inhabil (organization_id, tender_id, fecha, nombre, created_by)
    values ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000e1', '2026-06-01', 'Convocatoria ajena', '00000000-0000-0000-0000-0000000000c2');
  raise exception 'no debia poder colgar un dia de la convocatoria de otra organizacion';
exception when sqlstate '42501' then null;
end $$;
rollback;

\echo '--- 6. NEGATIVO: nadie firma un dia a nombre de otro (created_by distinto de auth.uid()) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
do $$ begin
  insert into licitaciones.dia_inhabil (organization_id, fecha, nombre, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '2026-06-01', 'Firmado por otro', '00000000-0000-0000-0000-0000000000c5');
  raise exception 'created_by debia ser auth.uid()';
exception when sqlstate '42501' then null;
end $$;
rollback;

\echo '--- 7. NEGATIVO: no nace ya quitado (eliminado_en no tiene GRANT de INSERT) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (permission denied for table: eliminado_en no es columna insertable)
insert into licitaciones.dia_inhabil (organization_id, fecha, nombre, created_by, eliminado_en)
  values ('00000000-0000-0000-0000-0000000000d1', '2026-06-01', 'Nace quitado', '00000000-0000-0000-0000-0000000000c1', now());
rollback;

\echo '--- 8. VALIDACION: fecha fuera de rango y nombre corto (CHECK 23514); verificacion no escribible por el cliente (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
do $$ begin
  insert into licitaciones.dia_inhabil (organization_id, fecha, nombre, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '1999-12-31', 'Fuera de rango', '00000000-0000-0000-0000-0000000000c1');
  raise exception 'fecha 1999 debia rechazarse';
exception when sqlstate '23514' then null;
end $$;
do $$ begin
  insert into licitaciones.dia_inhabil (organization_id, fecha, nombre, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '2026-06-01', 'ab', '00000000-0000-0000-0000-0000000000c1');
  raise exception 'nombre de 2 caracteres debia rechazarse';
exception when sqlstate '23514' then null;
end $$;
do $$ begin
  insert into licitaciones.dia_inhabil (organization_id, fecha, nombre, verificacion, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '2026-06-01', 'Verificacion rara', 'quizas', '00000000-0000-0000-0000-0000000000c1');
  raise exception 'el cliente no debia poder fijar verificacion (se autoverificaria)';
exception when sqlstate '42501' then null;
end $$;
rollback;

\echo '--- 9. UNICIDAD: un dia vigente por (organizacion, alcance, fecha); otro alcance o tras quitar si se puede ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
do $$ begin
  insert into licitaciones.dia_inhabil (organization_id, fecha, nombre, created_by)
    values ('00000000-0000-0000-0000-0000000000d1', '2026-04-02', 'Duplicado de toda la organizacion', '00000000-0000-0000-0000-0000000000c1');
  raise exception 'el duplicado vigente debia rechazarse';
exception when sqlstate '23505' then null;
end $$;
-- misma fecha pero alcance de convocatoria: permitido
insert into licitaciones.dia_inhabil (organization_id, tender_id, fecha, nombre, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', '2026-04-02', 'Mismo dia, solo la convocatoria', '00000000-0000-0000-0000-0000000000c1');
-- quitar el vigente y volver a declararlo: permitido
update licitaciones.dia_inhabil set eliminado_en = now() where id = '00000000-0000-0000-0000-0000000000f1';
insert into licitaciones.dia_inhabil (organization_id, fecha, nombre, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '2026-04-02', 'Re-declarado tras quitar', '00000000-0000-0000-0000-0000000000c1');
rollback;

\echo '--- 10. SOFT DELETE: el trigger sella quien y cuando; eliminado_por no es falsificable; no se reabre ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
update licitaciones.dia_inhabil set eliminado_en = '2001-01-01' where id = '00000000-0000-0000-0000-0000000000f1';
do $$ declare r record; begin
  select * into r from licitaciones.dia_inhabil where id = '00000000-0000-0000-0000-0000000000f1';
  if r.eliminado_por is distinct from '00000000-0000-0000-0000-0000000000c5'::uuid then raise exception 'eliminado_por debia ser el analyst, es %', r.eliminado_por; end if;
  if r.eliminado_en < now() - interval '1 minute' then raise exception 'eliminado_en lo fija el trigger (now()), no el cliente: %', r.eliminado_en; end if;
end $$;
-- ya quitado: la policy (USING eliminado_en is null) no lo deja tocar de nuevo
do $$ declare n integer; begin
  update licitaciones.dia_inhabil set eliminado_en = null where id = '00000000-0000-0000-0000-0000000000f1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'un dia quitado no debia poder reabrirse'; end if;
end $$;
rollback;

\echo '--- 11. NEGATIVO: writer y viewer no quitan dias; Org B tampoco (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$ declare n integer; begin
  update licitaciones.dia_inhabil set eliminado_en = now() where id = '00000000-0000-0000-0000-0000000000f1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'el writer no debia quitar un dia'; end if;
end $$;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
do $$ declare n integer; begin
  update licitaciones.dia_inhabil set eliminado_en = now() where id = '00000000-0000-0000-0000-0000000000f1';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'Org B no debia quitar un dia de Org A'; end if;
end $$;
rollback;

\echo '--- 12. GRANT por COLUMNA: no se actualiza fecha, nombre ni eliminado_por; no hay DELETE ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (permission denied for table: fecha no tiene GRANT de UPDATE)
update licitaciones.dia_inhabil set fecha = '2026-06-01' where id = '00000000-0000-0000-0000-0000000000f1' returning 1 as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (permission denied for table: eliminado_por lo fija el trigger)
update licitaciones.dia_inhabil set eliminado_por = '00000000-0000-0000-0000-0000000000c2' where id = '00000000-0000-0000-0000-0000000000f1' returning 1 as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (permission denied for table: sin DELETE; quitar es soft delete)
delete from licitaciones.dia_inhabil where id = '00000000-0000-0000-0000-0000000000f1' returning 1 as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (permission denied for table: id no es columna insertable)
insert into licitaciones.dia_inhabil (id, organization_id, fecha, nombre, created_by)
  values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000d1', '2026-06-01', 'Con id propio', '00000000-0000-0000-0000-0000000000c1') returning 1 as should_fail;
rollback;

\echo '--- 13. ANON: sin ningun privilegio sobre la tabla ni sobre la funcion de sistema ---'
begin;
set local role anon;
-- as should_fail (permission denied for table)
select count(*) as should_fail from licitaciones.dia_inhabil;
rollback;

begin;
set local role anon;
-- as should_fail (permission denied for table)
insert into licitaciones.dia_inhabil (organization_id, fecha, nombre, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '2026-06-01', 'Anon', '00000000-0000-0000-0000-0000000000c1') returning 1 as should_fail;
rollback;

begin;
set local role anon;
-- as should_fail (permission denied for function)
select * from licitaciones.system_list_dias_inhabiles('00000000-0000-0000-0000-0000000000d1') as should_fail;
rollback;

\echo '--- 14. SISTEMA: sin auth.uid() la funcion devuelve SOLO los dias vigentes de la organizacion pedida ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$ declare n integer; m integer; begin
  select count(*) into n from licitaciones.system_list_dias_inhabiles('00000000-0000-0000-0000-0000000000d1');
  if n <> 2 then raise exception 'Org A debia devolver 2 dias, devolvio %', n; end if;
  select count(*) into m from licitaciones.system_list_dias_inhabiles('00000000-0000-0000-0000-0000000000d2');
  if m <> 1 then raise exception 'Org B debia devolver 1 dia, devolvio %', m; end if;
  select count(*) into n from licitaciones.system_list_dias_inhabiles('00000000-0000-0000-0000-0000000000d3');
  if n <> 0 then raise exception 'una organizacion inexistente debia devolver 0 dias'; end if;
end $$;
rollback;

\echo '--- 15. SISTEMA: un usuario autenticado NO puede usar la funcion de sistema (42501), ni siquiera para su propia organizacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
do $$ begin
  perform * from licitaciones.system_list_dias_inhabiles('00000000-0000-0000-0000-0000000000d2');
  raise exception 'un usuario autenticado no debia poder llamar la funcion de sistema';
exception when sqlstate '42501' then null;
end $$;
rollback;

\echo '--- 16. SISTEMA: los dias quitados no salen en la lectura de sistema ---'
begin;
update licitaciones.dia_inhabil set eliminado_en = now() where id = '00000000-0000-0000-0000-0000000000f1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$ declare n integer; begin
  select count(*) into n from licitaciones.system_list_dias_inhabiles('00000000-0000-0000-0000-0000000000d1');
  if n <> 1 then raise exception 'tras quitar uno, Org A debia devolver 1 dia, devolvio %', n; end if;
end $$;
rollback;

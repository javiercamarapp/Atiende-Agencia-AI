-- Fixtures + assertions contra Postgres REAL (RLS/GRANT/auth.uid()/security definer reales -- el repositorio en
-- memoria de domain-rentas nunca los aplica) de packages/domain-rentas/migrations/033_rentas_limpieza_autopiloto.sql
-- (paridad3 rentas: limpieza en piloto automatico).
--
-- Que demuestra (positivo, negativo, cross-tenant, anon):
--   A. responsable de limpieza por omision de la unidad: lo fijan admin_gestora y operador:acceso_total; lo rechazan
--      el operador de calendario, limpieza, otra organizacion, el sistema y anon; el responsable debe ser miembro
--      operativo de ESA propiedad (otra propiedad, contador y otra organizacion se rechazan); la columna no admite
--      UPDATE directo; dar de baja al responsable deja la unidad sin responsable.
--   B. `rentas.responsable_limpieza_vigente`: la sesion de sistema (el barrido) lo ve, un staff ajeno recibe null y un
--      responsable que ya no es miembro tambien.
--   C. `rentas.puede_operar_limpieza` y `rentas.listar_asignables_limpieza`: solo con acceso a la propiedad y rol de
--      gestion; no se puede sondear membresias de otra organizacion.
--   D. `rentas.notificacion_tarea` como cola de avisos: la sesion de sistema inserta/lee/marca; otra organizacion no
--      ve filas; solo la columna `notificada_in_app_en` admite UPDATE; anon no tiene acceso.
--   E. definer con search_path fijo, EXECUTE revocado a public/anon, helpers internos sin EXECUTE para authenticated e
--      indices nuevos presentes.
--   F. SQL del barrido por propiedad bajo la sesion de sistema (candidatos a tarea, buffer pendiente, tareas de una
--      reserva cancelada o movida) y ciclo de la tarea: nace al confirmar, se reprograma y se cancela.
--
-- Run via scripts/verify-real-postgres-ci/run-gate.mjs (auto-descubierto en CI) o con ./run.sh. Cada escenario corre
-- en su propio `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000a1', 'rentas', 'Org A (limpieza)', 'org-a-limpieza'),
  ('00000000-0000-0000-0000-0000000000a2', 'rentas', 'Org B (limpieza, ajena)', 'org-b-limpieza')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'rentas', 'Casa Playa'),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a1', 'rentas', 'Casa Centro'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', 'rentas', 'Casa Ajena')
on conflict do nothing;

insert into rentas.property_config (property_id, organization_id, zona_horaria, moneda) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'America/Cancun', 'MXN'),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a1', 'America/Mexico_City', 'MXN'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', 'America/Mexico_City', 'MXN')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000011', 'admin-a-limp@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-000000000012', 'op-total-a-limp@example.com', 'Operador total A', 'seed'),
  ('00000000-0000-0000-0000-000000000013', 'op-calendario-a-limp@example.com', 'Operador calendario A', 'seed'),
  ('00000000-0000-0000-0000-000000000014', 'limpieza-b1-a-limp@example.com', 'Limpieza Casa Playa', 'seed'),
  ('00000000-0000-0000-0000-000000000015', 'limpieza-b3-a-limp@example.com', 'Limpieza Casa Centro', 'seed'),
  ('00000000-0000-0000-0000-000000000016', 'contador-a-limp@example.com', 'Contador A', 'seed'),
  ('00000000-0000-0000-0000-000000000017', 'admin-b-limp@example.com', 'Admin B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-000000000018', 'limpieza-b-limp@example.com', 'Limpieza B (ajena)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-0000000000a1', null, 'owner', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-0000000000a1', null, 'admin', 'operador:acceso_total'),
  ('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-0000000000a1', null, 'member', 'operador:calendario_mensajeria'),
  ('00000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-0000000000a1', array['00000000-0000-0000-0000-0000000000b1']::uuid[], 'member', 'limpieza'),
  ('00000000-0000-0000-0000-000000000015', '00000000-0000-0000-0000-0000000000a1', array['00000000-0000-0000-0000-0000000000b3']::uuid[], 'member', 'limpieza'),
  ('00000000-0000-0000-0000-000000000016', '00000000-0000-0000-0000-0000000000a1', null, 'viewer', 'contador'),
  ('00000000-0000-0000-0000-000000000017', '00000000-0000-0000-0000-0000000000a2', null, 'owner', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000000018', '00000000-0000-0000-0000-0000000000a2', null, 'member', 'limpieza')
on conflict do nothing;

insert into rentas.unidad (id, organization_id, property_id, name, duracion_minima_noches) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'Suite 1', 1),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b3', 'Loft 1', 1),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b2', 'Suite Ajena', 1)
on conflict do nothing;

-- Tarea con un aviso pendiente (rentas.notificacion_tarea) en Casa Playa.
insert into rentas.tarea_operativa (id, organization_id, property_id, unidad_id, tipo, estado, prioridad, programada_para, asignado_a)
values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', 'limpieza', 'asignada', 'media', '2030-01-10', '00000000-0000-0000-0000-000000000014')
on conflict do nothing;
insert into rentas.notificacion_tarea (id, tarea_id, evento, canales) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1', 'asignada', '{}')
on conflict do nothing;

\echo ''
\echo '=== A. responsable de limpieza por omision (rentas.fijar_responsable_limpieza_unidad) ==='
\echo ''

\echo '--- 1. admin_gestora fija un responsable valido (limpieza de la propiedad) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.fijar_responsable_limpieza_unidad('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000014');
select count(*) as fijado_deberia_ser_1 from rentas.unidad where id = '00000000-0000-0000-0000-0000000000c1' and responsable_limpieza_default = '00000000-0000-0000-0000-000000000014';
rollback;

\echo '--- 2. operador:acceso_total tambien puede fijarlo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000012', true);
select rentas.fijar_responsable_limpieza_unidad('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000014');
select count(*) as fijado_deberia_ser_1 from rentas.unidad where id = '00000000-0000-0000-0000-0000000000c1' and responsable_limpieza_default = '00000000-0000-0000-0000-000000000014';
rollback;

\echo '--- 3. operador:calendario_mensajeria NO puede fijarlo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select rentas.fijar_responsable_limpieza_unidad('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000014') as should_fail;
rollback;

\echo '--- 4. el rol limpieza NO puede fijarlo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000014', true);
select rentas.fijar_responsable_limpieza_unidad('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000014') as should_fail;
rollback;

\echo '--- 5. cross-tenant: el admin de otra organizacion NO puede fijarlo en una unidad ajena ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000017', true);
select rentas.fijar_responsable_limpieza_unidad('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000018') as should_fail;
rollback;

\echo '--- 6. la sesion de sistema (auth.uid() null) NO puede fijarlo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.fijar_responsable_limpieza_unidad('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000014') as should_fail;
rollback;

\echo '--- 7. anon NO puede ejecutarlo (EXECUTE revocado) ---'
begin;
set local role anon;
select rentas.fijar_responsable_limpieza_unidad('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000014') as should_fail;
rollback;

\echo '--- 8. un responsable de OTRA propiedad (acotado a Casa Centro) se rechaza ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.fijar_responsable_limpieza_unidad('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000015') as should_fail;
rollback;

\echo '--- 9. un contador no puede ser responsable ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.fijar_responsable_limpieza_unidad('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000016') as should_fail;
rollback;

\echo '--- 10. un miembro de OTRA organizacion no puede ser responsable ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.fijar_responsable_limpieza_unidad('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000018') as should_fail;
rollback;

\echo '--- 11. fijar null quita el responsable ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.fijar_responsable_limpieza_unidad('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-000000000014');
select rentas.fijar_responsable_limpieza_unidad('00000000-0000-0000-0000-0000000000c1', null);
select count(*) as sin_responsable_deberia_ser_1 from rentas.unidad where id = '00000000-0000-0000-0000-0000000000c1' and responsable_limpieza_default is null;
rollback;

\echo '--- 12. la columna NO admite UPDATE directo ni para el admin (solo la funcion definer escribe) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.unidad set responsable_limpieza_default = '00000000-0000-0000-0000-000000000014' where id = '00000000-0000-0000-0000-0000000000c1' returning id as should_fail;
rollback;

\echo '--- 13. dar de baja al responsable (borrar el staff) deja la unidad sin responsable, nunca colgante ---'
begin;
update rentas.unidad set responsable_limpieza_default = '00000000-0000-0000-0000-000000000014' where id = '00000000-0000-0000-0000-0000000000c1';
delete from core.staff_user where id = '00000000-0000-0000-0000-000000000014';
select count(*) as sin_responsable_deberia_ser_1 from rentas.unidad where id = '00000000-0000-0000-0000-0000000000c1' and responsable_limpieza_default is null;
rollback;

\echo ''
\echo '=== B. rentas.responsable_limpieza_vigente ==='
\echo ''

\echo '--- 14. la sesion de sistema (el barrido) ve al responsable vigente ---'
begin;
update rentas.unidad set responsable_limpieza_default = '00000000-0000-0000-0000-000000000014' where id = '00000000-0000-0000-0000-0000000000c1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (rentas.responsable_limpieza_vigente('00000000-0000-0000-0000-0000000000c1') = '00000000-0000-0000-0000-000000000014')::int as vigente_deberia_ser_1;
rollback;

\echo '--- 15. un staff de otra organizacion recibe null (no revela la unidad ni su responsable) ---'
begin;
update rentas.unidad set responsable_limpieza_default = '00000000-0000-0000-0000-000000000014' where id = '00000000-0000-0000-0000-0000000000c1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000017', true);
select count(rentas.responsable_limpieza_vigente('00000000-0000-0000-0000-0000000000c1')) as ajeno_deberia_ser_0;
rollback;

\echo '--- 16. si el responsable ya no es miembro de la propiedad, el barrido recibe null ---'
begin;
update rentas.unidad set responsable_limpieza_default = '00000000-0000-0000-0000-000000000014' where id = '00000000-0000-0000-0000-0000000000c1';
delete from core.membership where user_id = '00000000-0000-0000-0000-000000000014';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(rentas.responsable_limpieza_vigente('00000000-0000-0000-0000-0000000000c1')) as ex_miembro_deberia_ser_0;
rollback;

\echo '--- 17. una unidad sin responsable devuelve null ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(rentas.responsable_limpieza_vigente('00000000-0000-0000-0000-0000000000c3')) as sin_default_deberia_ser_0;
rollback;

\echo ''
\echo '=== C. rentas.puede_operar_limpieza y rentas.listar_asignables_limpieza ==='
\echo ''

\echo '--- 18. el admin valida a una persona de limpieza de la propiedad ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.puede_operar_limpieza('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000014')::int as miembro_deberia_ser_1;
rollback;

\echo '--- 19. un miembro acotado a otra propiedad NO es asignable ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.puede_operar_limpieza('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000015')::int as otra_propiedad_deberia_ser_0;
rollback;

\echo '--- 20. un contador NO es asignable ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.puede_operar_limpieza('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000016')::int as contador_deberia_ser_0;
rollback;

\echo '--- 21. no se puede sondear membresias de otra organizacion (el admin B pregunta por Casa Playa) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000017', true);
select rentas.puede_operar_limpieza('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000014')::int as sondeo_deberia_ser_0;
rollback;

\echo '--- 22. el admin lista las 4 personas asignables de Casa Playa (admin, 2 operadores, limpieza de la propiedad) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select count(*) as asignables_deberia_ser_4 from rentas.listar_asignables_limpieza('00000000-0000-0000-0000-0000000000b1');
rollback;

\echo '--- 23. el operador de calendario tambien puede listar asignables ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select count(*) as asignables_deberia_ser_4 from rentas.listar_asignables_limpieza('00000000-0000-0000-0000-0000000000b1');
rollback;

\echo '--- 24. el rol limpieza NO puede listar asignables ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000014', true);
select count(*) as should_fail from rentas.listar_asignables_limpieza('00000000-0000-0000-0000-0000000000b1');
rollback;

\echo '--- 25. cross-tenant: el admin B NO puede listar asignables de Casa Playa ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000017', true);
select count(*) as should_fail from rentas.listar_asignables_limpieza('00000000-0000-0000-0000-0000000000b1');
rollback;

\echo '--- 26. la sesion de sistema NO puede listar asignables ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as should_fail from rentas.listar_asignables_limpieza('00000000-0000-0000-0000-0000000000b1');
rollback;

\echo ''
\echo '=== D. rentas.notificacion_tarea como cola de avisos ==='
\echo ''

\echo '--- 27. la sesion de sistema (barrido) puede insertar el aviso de una tarea asignada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into rentas.notificacion_tarea (tarea_id, evento, canales) values ('00000000-0000-0000-0000-0000000000e1', 'asignada', '{}') returning id;
rollback;

\echo '--- 28. la sesion de sistema ve los avisos pendientes y los marca como emitidos ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
update rentas.notificacion_tarea set notificada_in_app_en = now() where id = '00000000-0000-0000-0000-0000000000f1' and notificada_in_app_en is null;
select count(*) as marcados_deberia_ser_1 from rentas.notificacion_tarea where id = '00000000-0000-0000-0000-0000000000f1' and notificada_in_app_en is not null;
rollback;

\echo '--- 29. staff de la propiedad tambien puede marcar la columna ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.notificacion_tarea set notificada_in_app_en = now() where id = '00000000-0000-0000-0000-0000000000f1';
select count(*) as marcados_deberia_ser_1 from rentas.notificacion_tarea where id = '00000000-0000-0000-0000-0000000000f1' and notificada_in_app_en is not null;
rollback;

\echo '--- 30. cross-tenant: el staff de otra organizacion no ve los avisos ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000017', true);
select count(*) as filas_ajenas_deberia_ser_0 from rentas.notificacion_tarea where id = '00000000-0000-0000-0000-0000000000f1';
rollback;

\echo '--- 31. cross-tenant: el staff de otra organizacion no puede marcar avisos ajenos (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000017', true);
with u as (update rentas.notificacion_tarea set notificada_in_app_en = now() where id = '00000000-0000-0000-0000-0000000000f1' returning id)
select count(*) as marcados_ajenos_deberia_ser_0 from u;
rollback;

\echo '--- 32. solo la columna notificada_in_app_en admite UPDATE (cambiar el evento se rechaza) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.notificacion_tarea set evento = 'completada' where id = '00000000-0000-0000-0000-0000000000f1' returning id as should_fail;
rollback;

\echo '--- 33. anon no tiene acceso a la tabla ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.notificacion_tarea;
rollback;

\echo ''
\echo '=== E. definer, search_path fijo, EXECUTE e indices ==='
\echo ''

\echo '--- 34. las 6 funciones nuevas son security definer con search_path fijo ---'
begin;
select count(*) as definer_deberia_ser_6 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'rentas'
    and p.proname in ('rol_limpieza_en_propiedad', 'es_miembro_operativo_limpieza', 'responsable_limpieza_vigente', 'puede_operar_limpieza', 'listar_asignables_limpieza', 'fijar_responsable_limpieza_unidad')
    and p.prosecdef
    and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%');
rollback;

\echo '--- 35. ninguna funcion nueva es ejecutable por anon ni por public ---'
begin;
select count(*) as expuestas_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'rentas'
    and p.proname in ('rol_limpieza_en_propiedad', 'es_miembro_operativo_limpieza', 'responsable_limpieza_vigente', 'puede_operar_limpieza', 'listar_asignables_limpieza', 'fijar_responsable_limpieza_unidad')
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'));
rollback;

\echo '--- 36. los 2 helpers internos no son ejecutables por authenticated ---'
begin;
select count(*) as internas_expuestas_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'rentas'
    and p.proname in ('rol_limpieza_en_propiedad', 'es_miembro_operativo_limpieza')
    and has_function_privilege('authenticated', p.oid, 'execute');
rollback;

\echo '--- 37. las 4 funciones publicas si son ejecutables por authenticated ---'
begin;
select count(*) as publicas_deberia_ser_4 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'rentas'
    and p.proname in ('responsable_limpieza_vigente', 'puede_operar_limpieza', 'listar_asignables_limpieza', 'fijar_responsable_limpieza_unidad')
    and has_function_privilege('authenticated', p.oid, 'execute');
rollback;

\echo '--- 38. los 4 indices nuevos existen ---'
begin;
select count(*) as indices_deberia_ser_4 from pg_indexes where schemaname = 'rentas'
  and indexname in ('unidad_responsable_limpieza_idx', 'notificacion_tarea_por_avisar_idx', 'ocupacion_checkout_barrido_idx', 'tarea_operativa_property_programada_idx');
rollback;

\echo ''
\echo '==> listo -- revisa arriba: los escenarios marcados "should_fail"/"deberia_ser_0" deben terminar en ERROR o 0 filas (correcto), el resto debe devolver filas reales.'

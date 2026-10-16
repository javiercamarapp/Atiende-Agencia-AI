-- Fixtures + assertions contra Postgres REAL (RLS + GRANT + SECURITY DEFINER + auth.uid() reales) para
-- packages/domain-licitaciones/migrations/038_licitaciones_stepup_un_solo_uso_y_bitacora_escrituras.sql
-- (L-P3-12: step-up de un solo uso; L-P3-17: bitacora append-only de escrituras con antes/despues y correlacion).
--
-- Actores (todos "authenticated"): a1 owner Org A, a2 admin Org A, a3 writer Org A, a4 viewer Org A, b1 owner Org B (otro tenant).
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es `begin; ... rollback;` en su propia
-- conexion; los chequeos viven en bloques DO que lanzan excepcion si la afirmacion falla (el negativo afirma el SQLSTATE exacto).
-- La carrera de dos conexiones vive en concurrencia.sh.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('38000000-0000-0000-0000-0000000000d1', 'licitaciones', 'Org A (stepup y bitacora)', 'org-a-stepup'),
  ('38000000-0000-0000-0000-0000000000d2', 'licitaciones', 'Org B (stepup y bitacora, ajena)', 'org-b-stepup')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('38000000-0000-0000-0000-0000000000a1', 'owner-a-stepup@example.com', 'Owner A', 'seed'),
  ('38000000-0000-0000-0000-0000000000a2', 'admin-a-stepup@example.com', 'Admin A', 'seed'),
  ('38000000-0000-0000-0000-0000000000a3', 'writer-a-stepup@example.com', 'Writer A', 'seed'),
  ('38000000-0000-0000-0000-0000000000a4', 'viewer-a-stepup@example.com', 'Viewer A', 'seed'),
  ('38000000-0000-0000-0000-0000000000b1', 'owner-b-stepup@example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('38000000-0000-0000-0000-0000000000a1', '38000000-0000-0000-0000-0000000000d1', null, 'owner', 'owner'),
  ('38000000-0000-0000-0000-0000000000a2', '38000000-0000-0000-0000-0000000000d1', null, 'admin', 'admin'),
  ('38000000-0000-0000-0000-0000000000a3', '38000000-0000-0000-0000-0000000000d1', null, 'member', 'writer'),
  ('38000000-0000-0000-0000-0000000000a4', '38000000-0000-0000-0000-0000000000d1', null, 'member', 'viewer'),
  ('38000000-0000-0000-0000-0000000000b1', '38000000-0000-0000-0000-0000000000d2', null, 'owner', 'owner')
on conflict do nothing;

\echo ''
\echo '=== licitaciones: step-up de un solo uso y bitacora de escrituras (038) ==='
\echo ''

\echo '--- 1. POSITIVO: el mismo jti se consume una vez (true) y la segunda vez no (false) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '38000000-0000-0000-0000-0000000000a1', true);
do $$ declare r1 boolean; r2 boolean; begin
  r1 := core.consume_step_up('jti-uno-0001', '38000000-0000-0000-0000-0000000000a1', '38000000-0000-0000-0000-0000000000d1', 'contract_sensitive', now() + interval '5 minutes');
  r2 := core.consume_step_up('jti-uno-0001', '38000000-0000-0000-0000-0000000000a1', '38000000-0000-0000-0000-0000000000d1', 'contract_sensitive', now() + interval '5 minutes');
  if r1 is not true then raise exception 'la primera vez debia consumir: %', r1; end if;
  if r2 is not false then raise exception 'la segunda vez debia rechazar el reuso: %', r2; end if;
end $$;
rollback;

\echo '--- 2. POSITIVO: dos jti distintos se consumen cada uno una vez ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '38000000-0000-0000-0000-0000000000a1', true);
do $$ begin
  if not core.consume_step_up('jti-dos-0001', '38000000-0000-0000-0000-0000000000a1', '38000000-0000-0000-0000-0000000000d1', 'contract_sensitive', now() + interval '5 minutes') then raise exception 'a'; end if;
  if not core.consume_step_up('jti-dos-0002', '38000000-0000-0000-0000-0000000000a1', '38000000-0000-0000-0000-0000000000d1', 'expediente_approval', now() + interval '5 minutes') then raise exception 'b'; end if;
end $$;
rollback;

\echo '--- 3. NEGATIVO: no se puede consumir a nombre de otro usuario (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '38000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    perform core.consume_step_up('jti-tres-0001', '38000000-0000-0000-0000-0000000000a1', '38000000-0000-0000-0000-0000000000d1', 'contract_sensitive', now() + interval '5 minutes');
    raise exception 'consumio a nombre de otro usuario';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;

\echo '--- 4. NEGATIVO: cross-tenant, un usuario sin membresia en la organizacion no consume (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '38000000-0000-0000-0000-0000000000b1', true);
do $$ begin
  begin
    perform core.consume_step_up('jti-cuatro-001', '38000000-0000-0000-0000-0000000000b1', '38000000-0000-0000-0000-0000000000d1', 'contract_sensitive', now() + interval '5 minutes');
    raise exception 'consumio en una organizacion ajena';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;

\echo '--- 5. NEGATIVO: sin sesion de usuario (auth.uid() nulo) y como anon no se consume (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  begin
    perform core.consume_step_up('jti-cinco-001', '38000000-0000-0000-0000-0000000000a1', '38000000-0000-0000-0000-0000000000d1', 'contract_sensitive', now() + interval '5 minutes');
    raise exception 'consumio sin sesion';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;

begin;
set local role anon;
do $$ begin
  begin
    perform core.consume_step_up('jti-cinco-002', '38000000-0000-0000-0000-0000000000a1', '38000000-0000-0000-0000-0000000000d1', 'contract_sensitive', now() + interval '5 minutes');
    raise exception 'anon consumio';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;

\echo '--- 6. NEGATIVO: ningun rol de aplicacion lee, inserta ni borra core.step_up_consumption directo (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '38000000-0000-0000-0000-0000000000a1', true);
do $$ begin
  begin perform 1 from core.step_up_consumption; raise exception 'leyo la tabla'; exception when sqlstate '42501' then null; end;
  begin
    insert into core.step_up_consumption (jti, user_id, organization_id, scope, expires_at)
    values ('jti-seis-0001', '38000000-0000-0000-0000-0000000000a1', '38000000-0000-0000-0000-0000000000d1', 'x', now());
    raise exception 'inserto directo';
  exception when sqlstate '42501' then null; end;
  begin delete from core.step_up_consumption; raise exception 'borro directo'; exception when sqlstate '42501' then null; end;
end $$;
rollback;

\echo '--- 7. purga: con usuario 42501; como sistema solo borra consumos vencidos (con holgura) ---'
begin;
insert into core.step_up_consumption (jti, user_id, organization_id, scope, expires_at) values
  ('jti-siete-vencido', '38000000-0000-0000-0000-0000000000a1', '38000000-0000-0000-0000-0000000000d1', 'contract_sensitive', now() - interval '3 hours'),
  ('jti-siete-vivo-01', '38000000-0000-0000-0000-0000000000a1', '38000000-0000-0000-0000-0000000000d1', 'contract_sensitive', now() + interval '3 minutes');
set local role authenticated;
select set_config('request.jwt.claim.sub', '38000000-0000-0000-0000-0000000000a1', true);
do $$ begin
  begin perform core.purge_step_up_consumption(); raise exception 'un usuario purgo'; exception when sqlstate '42501' then null; end;
end $$;
select set_config('request.jwt.claim.sub', '', true);
do $$ declare n integer; left_ integer; begin
  n := core.purge_step_up_consumption();
  if n <> 1 then raise exception 'debia borrar solo el vencido: %', n; end if;
  begin perform core.purge_step_up_consumption(interval '1 minute'); raise exception 'holgura menor a 5 minutos'; exception when sqlstate '22023' then null; end;
end $$;
rollback;

\echo '--- 8. POSITIVO: un writer anota una escritura; el owner la lee con antes/despues y correlacion; el writer no la lee ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '38000000-0000-0000-0000-0000000000a3', true);
select licitaciones.append_audit('38000000-0000-0000-0000-0000000000a3', '38000000-0000-0000-0000-0000000000d1', 'tarifa', 'abc', 'tarifa.actualizada',
  '{"unitPrice":"10.00"}'::jsonb, '{"unitPrice":"12.00"}'::jsonb, 'corr-1');
do $$ declare n integer; begin
  select count(*) into n from licitaciones.audit_trail;
  if n <> 0 then raise exception 'el writer no debia leer la bitacora: %', n; end if;
end $$;
select set_config('request.jwt.claim.sub', '38000000-0000-0000-0000-0000000000a1', true);
do $$ declare r record; begin
  select * into r from licitaciones.audit_trail where entity = 'tarifa';
  if r.actor_id <> '38000000-0000-0000-0000-0000000000a3' or r.correlation_id <> 'corr-1' or r.before->>'unitPrice' <> '10.00' or r.after->>'unitPrice' <> '12.00' then
    raise exception 'renglon incorrecto: %', r;
  end if;
end $$;
rollback;

\echo '--- 9. NEGATIVO: no se anota a nombre de otro actor, ni sin rol de escritura (viewer), ni en otra organizacion (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '38000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin perform licitaciones.append_audit('38000000-0000-0000-0000-0000000000a1', '38000000-0000-0000-0000-0000000000d1', 'x', null, 'a', null, null, null); raise exception 'actor falso'; exception when sqlstate '42501' then null; end;
  begin perform licitaciones.append_audit('38000000-0000-0000-0000-0000000000a3', '38000000-0000-0000-0000-0000000000d2', 'x', null, 'a', null, null, null); raise exception 'cross-tenant'; exception when sqlstate '42501' then null; end;
end $$;
select set_config('request.jwt.claim.sub', '38000000-0000-0000-0000-0000000000a4', true);
do $$ begin
  begin perform licitaciones.append_audit('38000000-0000-0000-0000-0000000000a4', '38000000-0000-0000-0000-0000000000d1', 'x', null, 'a', null, null, null); raise exception 'viewer escribio'; exception when sqlstate '42501' then null; end;
end $$;
rollback;

\echo '--- 10. NEGATIVO: UPDATE, DELETE e INSERT directos sobre audit_trail fallan para authenticated y service_role (42501) ---'
begin;
insert into licitaciones.audit_trail (organization_id, entity, action) values ('38000000-0000-0000-0000-0000000000d1', 'semilla', 'semilla.creada');
set local role authenticated;
select set_config('request.jwt.claim.sub', '38000000-0000-0000-0000-0000000000a1', true);
do $$ begin
  begin update licitaciones.audit_trail set action = 'x'; raise exception 'update permitido'; exception when sqlstate '42501' then null; end;
  begin delete from licitaciones.audit_trail; raise exception 'delete permitido'; exception when sqlstate '42501' then null; end;
  begin insert into licitaciones.audit_trail (organization_id, entity, action) values ('38000000-0000-0000-0000-0000000000d1', 'x', 'y'); raise exception 'insert directo permitido'; exception when sqlstate '42501' then null; end;
end $$;
reset role;
set local role service_role;
do $$ begin
  begin update licitaciones.audit_trail set action = 'x'; raise exception 'service_role update'; exception when sqlstate '42501' then null; end;
  begin delete from licitaciones.audit_trail; raise exception 'service_role delete'; exception when sqlstate '42501' then null; end;
end $$;
rollback;

\echo '--- 11. NEGATIVO: anon y sin sesion no leen la bitacora; cross-tenant el owner B ve 0 renglones de Org A ---'
begin;
insert into licitaciones.audit_trail (organization_id, entity, action) values ('38000000-0000-0000-0000-0000000000d1', 'semilla', 'semilla.creada');
set local role anon;
do $$ begin
  begin perform 1 from licitaciones.audit_trail; raise exception 'anon leyo'; exception when sqlstate '42501' then null; end;
end $$;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '38000000-0000-0000-0000-0000000000b1', true);
do $$ declare n integer; begin
  select count(*) into n from licitaciones.audit_trail;
  if n <> 0 then raise exception 'cross-tenant: el owner B vio %', n; end if;
end $$;
rollback;

\echo '--- 12. POSITIVO: la sesion de sistema (sin usuario) anota sin actor; declarar actor es 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.append_audit(null, '38000000-0000-0000-0000-0000000000d1', 'tender', 't1', 'tender.ingested', null, '{"source":"x"}'::jsonb, 'ingesta-9');
do $$ begin
  begin perform licitaciones.append_audit('38000000-0000-0000-0000-0000000000a1', '38000000-0000-0000-0000-0000000000d1', 'x', null, 'a', null, null, null); raise exception 'sistema declaro actor'; exception when sqlstate '42501' then null; end;
end $$;
reset role;
do $$ declare r record; begin
  select * into r from licitaciones.audit_trail where correlation_id = 'ingesta-9';
  if r.actor_id is not null or r.entity <> 'tender' then raise exception 'renglon de sistema incorrecto'; end if;
end $$;
rollback;

\echo '--- 13. NEGATIVO: correlation_id con formato invalido (23514) y antes/despues de mas de 64 KB (22023) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '38000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin perform licitaciones.append_audit('38000000-0000-0000-0000-0000000000a3', '38000000-0000-0000-0000-0000000000d1', 'x', null, 'a', null, null, 'con espacios; drop'); raise exception 'correlacion invalida aceptada'; exception when sqlstate '23514' then null; end;
  begin perform licitaciones.append_audit('38000000-0000-0000-0000-0000000000a3', '38000000-0000-0000-0000-0000000000d1', 'x', null, 'a', null, to_jsonb(repeat('x', 70000)), null); raise exception 'payload enorme aceptado'; exception when sqlstate '22023' then null; end;
end $$;
rollback;

\echo '--- 14. POSITIVO: paginacion por llave (seq) estable y filtro por correlacion, solo owner/admin ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '38000000-0000-0000-0000-0000000000a3', true);
select licitaciones.append_audit('38000000-0000-0000-0000-0000000000a3', '38000000-0000-0000-0000-0000000000d1', 'tender', 't9', 'tender.ingested', null, null, 'traza-14');
select licitaciones.append_audit('38000000-0000-0000-0000-0000000000a3', '38000000-0000-0000-0000-0000000000d1', 'tender', 't9', 'tender.version_recorded', null, null, 'traza-14');
select licitaciones.append_audit('38000000-0000-0000-0000-0000000000a3', '38000000-0000-0000-0000-0000000000d1', 'expediente', 'e9', 'expediente.approved', null, null, 'traza-14');
select licitaciones.append_audit('38000000-0000-0000-0000-0000000000a3', '38000000-0000-0000-0000-0000000000d1', 'tarifa', 'r9', 'tarifa.creada', null, null, 'otra');
select set_config('request.jwt.claim.sub', '38000000-0000-0000-0000-0000000000a2', true);
do $$ declare n integer; ult bigint; pag integer; begin
  select count(*) into n from licitaciones.audit_trail where correlation_id = 'traza-14';
  if n <> 3 then raise exception 'la traza debia traer 3: %', n; end if;
  select max(seq) into ult from licitaciones.audit_trail;
  select count(*) into pag from (select seq from licitaciones.audit_trail where seq <= ult order by seq desc limit 2) s;
  if pag <> 2 then raise exception 'pagina: %', pag; end if;
  if (select array_agg(action order by seq) from licitaciones.audit_trail where correlation_id = 'traza-14') <> array['tender.ingested','tender.version_recorded','expediente.approved'] then
    raise exception 'orden de la traza incorrecto';
  end if;
end $$;
rollback;

\echo '--- 15. POSITIVO: cualquier miembro (writer) hereda la correlacion de la convocatoria sin leer la bitacora; cross-tenant y anon no (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '38000000-0000-0000-0000-0000000000a3', true);
select licitaciones.append_audit('38000000-0000-0000-0000-0000000000a3', '38000000-0000-0000-0000-0000000000d1', 'convocatoria', 'tender-15', 'convocatoria.creada', null, null, 'origen-15');
select licitaciones.append_audit('38000000-0000-0000-0000-0000000000a3', '38000000-0000-0000-0000-0000000000d1', 'convocatoria', 'tender-15', 'convocatoria.version_registrada', null, null, 'posterior-15');
do $$ declare c text; begin
  c := licitaciones.tender_correlation_id('38000000-0000-0000-0000-0000000000d1', 'tender-15');
  if c is distinct from 'origen-15' then raise exception 'debia heredar la correlacion de origen: %', c; end if;
  if licitaciones.tender_correlation_id('38000000-0000-0000-0000-0000000000d1', 'no-existe') is not null then raise exception 'debia ser nulo'; end if;
end $$;
select set_config('request.jwt.claim.sub', '38000000-0000-0000-0000-0000000000b1', true);
do $$ begin
  begin perform licitaciones.tender_correlation_id('38000000-0000-0000-0000-0000000000d1', 'tender-15'); raise exception 'cross-tenant'; exception when sqlstate '42501' then null; end;
end $$;
rollback;

begin;
set local role anon;
do $$ begin
  begin perform licitaciones.tender_correlation_id('38000000-0000-0000-0000-0000000000d1', 'tender-15'); raise exception 'anon'; exception when sqlstate '42501' then null; end;
end $$;
rollback;

\echo ''
\echo '=== listo ==='

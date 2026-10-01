-- Fixtures + assertions contra Postgres REAL (RLS + GRANT por columna + triggers +
-- auth.uid() reales) para
-- packages/domain-licitaciones/migrations/030_whatsapp_avisos_y_decisiones.sql
-- (L-05: avisos y decisiones go/no-go por WhatsApp).
--
-- Actores (todos "authenticated"; el rol de plataforma lo fija vertical_role):
--   c1 = owner Org A   c3 = writer Org A   c4 = viewer Org A
--   c5 = analyst Org A (puede decidir go/no-go)   c2 = owner Org B (otro tenant)
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): `as should_fail`
-- = el escenario DEBE terminar en ERROR; alias `..._deberia_ser_N` = valor esperado;
-- cualquier otro escenario debe completar sin error (los positivos afirman con DO).
-- Cada escenario corre en su propio `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000d1', 'licitaciones', 'Org A (whatsapp)', 'org-a-whatsapp'),
  ('00000000-0000-0000-0000-0000000000d2', 'licitaciones', 'Org B (whatsapp, ajena)', 'org-b-whatsapp')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000c1', 'owner-a-wa@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c2', 'owner-b-wa@example.com', 'Owner B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-0000000000c3', 'writer-a-wa@example.com', 'Writer A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c4', 'viewer-a-wa@example.com', 'Viewer A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c5', 'analyst-a-wa@example.com', 'Analyst A', 'seed')
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

\echo ''
\echo '=== licitaciones: WhatsApp avisos y decisiones (030) ==='
\echo ''

\echo '--- 1. POSITIVO: viewer registra su propio telefono (queda pendiente) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c4', '+5215511110004') returning status;
rollback;

\echo '--- 2. NEGATIVO: un usuario no puede registrar el telefono de OTRO usuario (RLS) ---'
begin;
-- as should_fail (user_id ajeno)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1', '+5215500000001');
rollback;

\echo '--- 3. NEGATIVO: auto-activarse sin probar el numero (GRANT por columna sobre status) ---'
begin;
-- as should_fail (permission denied for column status)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c4', '+5215511110004', 'activo');
rollback;

\echo '--- 4. CROSS-TENANT: owner de Org B registra un contacto en la organizacion A (RLS) ---'
begin;
-- as should_fail (organization_id ajeno)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c2', '+5215500000002');
rollback;

\echo '--- 5. GRANT por columna: el usuario no puede escribir status en un UPDATE ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c4', '+5215511110004', 'pendiente', now());
-- as should_fail (permission denied for column status)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
update licitaciones.whatsapp_contact set status = 'activo' where user_id = '00000000-0000-0000-0000-0000000000c4';
rollback;

\echo '--- 6. GRANT por columna: el usuario no puede reasignar organization_id ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c4', '+5215511110004', 'pendiente', now());
-- as should_fail (permission denied for column organization_id)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
update licitaciones.whatsapp_contact set organization_id = '00000000-0000-0000-0000-0000000000d2' where user_id = '00000000-0000-0000-0000-0000000000c4';
rollback;

\echo '--- 7. TRIGGER: cambiar el telefono de un contacto activo lo regresa a pendiente ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at, opted_in_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c4', '+5215511110004', 'activo', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
update licitaciones.whatsapp_contact set phone_e164 = '+5215599998888' where user_id = '00000000-0000-0000-0000-0000000000c4';
do $$ declare s text; begin
  select status into s from licitaciones.whatsapp_contact where user_id = '00000000-0000-0000-0000-0000000000c4';
  if s <> 'pendiente' then raise exception 'esperado pendiente tras cambio de telefono, obtuve %', s; end if;
end $$;
rollback;

\echo '--- 8. LECTURA: un compañero de la misma organizacion NO ve el telefono ajeno ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c4', '+5215511110004', 'pendiente', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
select count(*) as telefonos_ajenos_deberia_ser_0 from licitaciones.whatsapp_contact;
rollback;

\echo '--- 9. CROSS-TENANT lectura: owner de Org B ve 0 contactos de Org A ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c4', '+5215511110004', 'pendiente', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select count(*) as contactos_ajenos_deberia_ser_0 from licitaciones.whatsapp_contact;
rollback;

\echo '--- 10. ANON: sin ningun GRANT sobre los contactos ---'
begin;
set local role anon;
-- as should_fail (permission denied)
select count(*) as should_fail from licitaciones.whatsapp_contact;
rollback;

\echo '--- 11. ANON: sin ningun GRANT sobre los tokens ---'
begin;
set local role anon;
-- as should_fail (permission denied)
select count(*) as should_fail from licitaciones.whatsapp_action_token;
rollback;

\echo '--- 12. ANON: no puede ejecutar la funcion de consumo de tokens ---'
begin;
set local role anon;
-- as should_fail (permission denied for function)
select * from licitaciones.whatsapp_consume_action_token(repeat('a', 64), '+5215511110005', 'm1');
rollback;

\echo '--- 13. NEGATIVO: authenticated no lee la tabla de tokens (solo funciones definer) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
-- as should_fail (permission denied for table)
select count(*) as should_fail from licitaciones.whatsapp_action_token;
rollback;

\echo '--- 14. NEGATIVO: authenticated no lee ni escribe el outbox directamente ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
-- as should_fail (permission denied for table)
select count(*) as should_fail from licitaciones.whatsapp_outbox;
rollback;

\echo '--- 15. SOLO-SISTEMA: un usuario autenticado no puede emitir tokens ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at, opted_in_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '+5215511110005', 'activo', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (solo sesion de sistema, 42501)
select licitaciones.system_issue_whatsapp_action_token('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000e1', 'go', repeat('b', 64), now() + interval '1 day') as should_fail;
rollback;

\echo '--- 16. SOLO-SISTEMA: un usuario autenticado no puede reclamar el outbox ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (solo sesion de sistema, 42501)
select * from licitaciones.claim_whatsapp_outbox_batch(10, 60);
rollback;

\echo '--- 17. SOLO-SISTEMA: un usuario autenticado no puede confirmar opt-in por telefono ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (solo sesion de sistema, 42501)
select licitaciones.system_whatsapp_confirm_opt_in('+5215511110005') as should_fail;
rollback;

\echo '--- 18. POSITIVO: la sesion de sistema emite un token ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at, opted_in_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '+5215511110005', 'activo', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.system_issue_whatsapp_action_token('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000e1', 'go', repeat('b', 64), now() + interval '1 day') ;
rollback;

\echo '--- 19. NEGATIVO: no se emite token a un usuario sin rol go/no-go (viewer) ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c4', '+5215511110004', 'activo', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
-- as should_fail (el usuario no tiene rol go/no-go)
select licitaciones.system_issue_whatsapp_action_token('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000e1', 'go', repeat('c', 64), now() + interval '1 day') as should_fail;
rollback;

\echo '--- 20. NEGATIVO: no se emite token para una convocatoria de OTRA organizacion ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at, opted_in_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '+5215511110005', 'activo', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
-- as should_fail (convocatoria ajena)
select licitaciones.system_issue_whatsapp_action_token('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000e2', 'go', repeat('d', 64), now() + interval '1 day') as should_fail;
rollback;

\echo '--- 21. NEGATIVO: no se emite token con contacto pendiente (sin opt-in) ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '+5215511110005', 'pendiente', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
-- as should_fail (contacto no activo)
select licitaciones.system_issue_whatsapp_action_token('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000e1', 'go', repeat('e', 64), now() + interval '1 day') as should_fail;
rollback;

\echo '--- 22. NEGATIVO: la expiracion maxima es de 7 dias ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at, opted_in_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '+5215511110005', 'activo', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
-- as should_fail (expiracion fuera de rango)
select licitaciones.system_issue_whatsapp_action_token('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000e1', 'go', repeat('f', 64), now() + interval '8 days') as should_fail;
rollback;

\echo '--- 23. NEGATIVO: el hash de un token es unico (no se reemite el mismo secreto) ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at, opted_in_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '+5215511110005', 'activo', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.system_issue_whatsapp_action_token('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000e1', 'go', repeat('b', 64), now() + interval '1 day') ;
-- as should_fail (unique token_hash)
select licitaciones.system_issue_whatsapp_action_token('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000e1', 'no_go', repeat('b', 64), now() + interval '1 day') as should_fail;
rollback;

\echo '--- 24. POSITIVO + ANTI-REPLAY: consumo ok, el mismo mensaje es duplicado (idempotente), otro mensaje es ya_usado ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at, opted_in_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '+5215511110005', 'activo', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.system_issue_whatsapp_action_token('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000e1', 'go', repeat('b', 64), now() + interval '1 day') ;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
do $$ declare r record; begin
  select * into r from licitaciones.whatsapp_consume_action_token(repeat('b', 64), '+5215511110005', 'wamid.1');
  if r.resultado <> 'ok' then raise exception 'primer consumo: esperado ok, obtuve %', r.resultado; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
do $$ declare r record; begin
  select * into r from licitaciones.whatsapp_consume_action_token(repeat('b', 64), '+5215511110005', 'wamid.1');
  if r.resultado <> 'duplicado' then raise exception 'reintento del mismo mensaje: esperado duplicado, obtuve %', r.resultado; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
do $$ declare r record; begin
  select * into r from licitaciones.whatsapp_consume_action_token(repeat('b', 64), '+5215511110005', 'wamid.2');
  if r.resultado <> 'ya_usado' then raise exception 'replay con otro mensaje: esperado ya_usado, obtuve %', r.resultado; end if;
end $$;
rollback;

\echo '--- 25. OTRO USUARIO: el token del analista no sirve para el owner (no_encontrado, sin oraculo) ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at, opted_in_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '+5215511110005', 'activo', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.system_issue_whatsapp_action_token('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000e1', 'go', repeat('b', 64), now() + interval '1 day') ;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
do $$ declare r record; begin
  select * into r from licitaciones.whatsapp_consume_action_token(repeat('b', 64), '+5215511110005', 'wamid.3');
  if r.resultado <> 'no_encontrado' then raise exception 'otro usuario: esperado no_encontrado, obtuve %', r.resultado; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
do $$ declare c integer; begin
  select count(*) into c from (select * from licitaciones.whatsapp_consume_action_token(repeat('b', 64), '+5215511110005', 'wamid.4')) q where q.resultado = 'ok';
  if c <> 1 then raise exception 'el dueno legitimo aun debe poder consumirlo (rechazo ajeno no consume)'; end if;
end $$;
rollback;

\echo '--- 26. EXPIRADO: un token vencido se rechaza y no se consume ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at, opted_in_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '+5215511110005', 'activo', now(), now());
insert into licitaciones.whatsapp_action_token (organization_id, user_id, tender_id, action, phone_e164, token_hash, expires_at, created_at)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000e1', 'go', '+5215511110005', repeat('9', 64), now() - interval '1 hour', now() - interval '2 hours');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
do $$ declare r record; begin
  select * into r from licitaciones.whatsapp_consume_action_token(repeat('9', 64), '+5215511110005', 'wamid.5');
  if r.resultado <> 'expirado' then raise exception 'token vencido: esperado expirado, obtuve %', r.resultado; end if;
end $$;
reset role;
do $$ begin
  if exists (select 1 from licitaciones.whatsapp_action_token where consumed_at is not null) then raise exception 'un token expirado no debe consumirse'; end if;
end $$;
rollback;

\echo '--- 27. TELEFONO DISTINTO: otro numero no puede usar el token y el token sigue vigente ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at, opted_in_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '+5215511110005', 'activo', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.system_issue_whatsapp_action_token('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000e1', 'go', repeat('b', 64), now() + interval '1 day') ;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
do $$ declare r record; begin
  select * into r from licitaciones.whatsapp_consume_action_token(repeat('b', 64), '+5215500009999', 'wamid.6');
  if r.resultado <> 'telefono_distinto' then raise exception 'remitente distinto: esperado telefono_distinto, obtuve %', r.resultado; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
do $$ declare r record; begin
  select * into r from licitaciones.whatsapp_consume_action_token(repeat('b', 64), '+5215511110005', 'wamid.7');
  if r.resultado <> 'ok' then raise exception 'el titular aun puede usarlo: esperado ok, obtuve %', r.resultado; end if;
end $$;
rollback;

\echo '--- 28. BAJA: tras opt-out el token ya emitido deja de servir ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at, opted_in_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '+5215511110005', 'activo', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.system_issue_whatsapp_action_token('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000e1', 'go', repeat('b', 64), now() + interval '1 day') ;
select licitaciones.system_whatsapp_opt_out('+5215511110005');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
do $$ declare r record; begin
  select * into r from licitaciones.whatsapp_consume_action_token(repeat('b', 64), '+5215511110005', 'wamid.8');
  if r.resultado <> 'contacto_inactivo' then raise exception 'contacto en baja: esperado contacto_inactivo, obtuve %', r.resultado; end if;
end $$;
rollback;

\echo '--- 29. ROL REVOCADO: si el usuario pierde el rol go/no-go el token se rechaza ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at, opted_in_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '+5215511110005', 'activo', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.system_issue_whatsapp_action_token('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000e1', 'go', repeat('b', 64), now() + interval '1 day') ;
reset role;
update core.membership set vertical_role = 'viewer' where user_id = '00000000-0000-0000-0000-0000000000c5' and organization_id = '00000000-0000-0000-0000-0000000000d1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
do $$ declare r record; begin
  select * into r from licitaciones.whatsapp_consume_action_token(repeat('b', 64), '+5215511110005', 'wamid.9');
  if r.resultado <> 'rol_insuficiente' then raise exception 'rol revocado: esperado rol_insuficiente, obtuve %', r.resultado; end if;
end $$;
rollback;

\echo '--- 30. OPT-IN: un mensaje entrante del numero activa solo contactos pendientes con consentimiento solicitado ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c4', '+5215511110004', 'pendiente', now());
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c3', '+5215511110003', 'pendiente', null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.system_whatsapp_confirm_opt_in('+5215511110004') as activados_deberia_ser_1;
rollback;

\echo '--- 31. OPT-IN: sin consentimiento solicitado un SI suelto no activa nada ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c3', '+5215511110003', 'pendiente', null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.system_whatsapp_confirm_opt_in('+5215511110003') as activados_deberia_ser_0;
rollback;

\echo '--- 32. OPT-IN: una baja explicita NO se revierte con un SI suelto ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at, opted_out_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c3', '+5215511110003', 'baja', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.system_whatsapp_confirm_opt_in('+5215511110003') as activados_deberia_ser_0;
rollback;

\echo '--- 33. OPT-OUT: BAJA entrante desactiva todas las filas del numero ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at, opted_in_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '+5215511110005', 'activo', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.system_whatsapp_opt_out('+5215511110005') as bajas_deberia_ser_1;
rollback;

\echo '--- 34. PANEL: el usuario pide consentimiento y queda UN solo mensaje aunque lo pida dos veces ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c4', '+5215511110004', 'pendiente', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
select licitaciones.whatsapp_request_consent('00000000-0000-0000-0000-0000000000d1');
select licitaciones.whatsapp_request_consent('00000000-0000-0000-0000-0000000000d1');
reset role;
select count(*) as mensajes_deberia_ser_1 from licitaciones.whatsapp_outbox where event_type = 'consent_request';
rollback;

\echo '--- 35. PANEL: pedir consentimiento en una organizacion ajena no hace nada ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c4', '+5215511110004', 'pendiente', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select (licitaciones.whatsapp_request_consent('00000000-0000-0000-0000-0000000000d1'))::int as ajeno_deberia_ser_0;
rollback;

\echo '--- 36. PANEL: opt-out propio deja status baja ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at, opted_in_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '+5215511110005', 'activo', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
select licitaciones.whatsapp_opt_out_self('00000000-0000-0000-0000-0000000000d1');
do $$ declare s text; begin
  select status into s from licitaciones.whatsapp_contact where user_id = '00000000-0000-0000-0000-0000000000c5';
  if s <> 'baja' then raise exception 'esperado baja, obtuve %', s; end if;
end $$;
rollback;

\echo '--- 37. OUTBOX: encolar es idempotente por dedupe_key; reclamar y cerrar borra los botones (token en claro) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.system_enqueue_whatsapp_outbox('00000000-0000-0000-0000-0000000000d1', 'decision_request', 'dk-1', '{"to":"+5215511110005","body":"hola","buttons":[{"id":"x","title":"Go"}]}'::jsonb);
select licitaciones.system_enqueue_whatsapp_outbox('00000000-0000-0000-0000-0000000000d1', 'decision_request', 'dk-1', '{"to":"+5215511110005","body":"hola","buttons":[{"id":"x","title":"Go"}]}'::jsonb);
reset role;
do $$ declare c integer; i uuid; begin
  select count(*) into c from licitaciones.whatsapp_outbox;
  if c <> 1 then raise exception 'esperado 1 fila por dedupe, obtuve %', c; end if;
  select id into i from licitaciones.claim_whatsapp_outbox_batch(10, 60);
  if i is null then raise exception 'el claim debe devolver la fila'; end if;
  perform licitaciones.complete_whatsapp_outbox_sent(i);
  if exists (select 1 from licitaciones.whatsapp_outbox where payload ? 'buttons') then raise exception 'los botones deben borrarse al enviar'; end if;
  if exists (select 1 from licitaciones.claim_whatsapp_outbox_batch(10, 60)) then raise exception 'un mensaje enviado no vuelve a ser elegible'; end if;
end $$;
rollback;

\echo '--- 38. OUTBOX: payload sin to/body se rechaza ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
-- as should_fail (payload invalido)
select licitaciones.system_enqueue_whatsapp_outbox('00000000-0000-0000-0000-0000000000d1', 'x', 'dk-2', '{"foo":1}'::jsonb) as should_fail;
rollback;

\echo '--- 39. BITACORA: el owner ve los eventos de su organizacion; el viewer y el owner ajeno no ---'
begin;
insert into licitaciones.whatsapp_event_log (organization_id, user_id, event) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', 'prueba');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
select count(*) as viewer_deberia_ser_0 from licitaciones.whatsapp_event_log;
rollback;

\echo '--- 40. BITACORA cross-tenant: owner de Org B ve 0 eventos de Org A ---'
begin;
insert into licitaciones.whatsapp_event_log (organization_id, user_id, event) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', 'prueba');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select count(*) as ajeno_deberia_ser_0 from licitaciones.whatsapp_event_log;
rollback;

\echo '--- 41. BITACORA: el owner lee su bitacora ---'
begin;
insert into licitaciones.whatsapp_event_log (organization_id, user_id, event) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', 'prueba');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
select count(*) as owner_deberia_ser_1 from licitaciones.whatsapp_event_log;
rollback;

\echo '--- 42. BITACORA append-only: authenticated no puede insertar eventos ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (sin INSERT para authenticated)
insert into licitaciones.whatsapp_event_log (organization_id, event) values ('00000000-0000-0000-0000-0000000000d1', 'falsificado');
rollback;

\echo '--- 43. BITACORA append-only: authenticated no puede borrar eventos ---'
begin;
insert into licitaciones.whatsapp_event_log (organization_id, user_id, event) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', 'prueba');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (sin DELETE para authenticated)
delete from licitaciones.whatsapp_event_log;
rollback;

\echo '--- 44. BITACORA: el consumo de un token deja su rastro en la misma transaccion ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at, opted_in_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '+5215511110005', 'activo', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.system_issue_whatsapp_action_token('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000e1', 'go', repeat('b', 64), now() + interval '1 day') ;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
do $$ declare r record; begin
  select * into r from licitaciones.whatsapp_consume_action_token(repeat('b', 64), '+5215511110005', 'wamid.20');
  if r.resultado <> 'ok' then raise exception 'consumo: esperado ok, obtuve %', r.resultado; end if;
end $$;
reset role;
select count(*) as rastro_deberia_ser_1 from licitaciones.whatsapp_event_log where event = 'decision_por_whatsapp' and message_id = 'wamid.20';
rollback;

\echo '--- 45. IDEMPOTENCIA: emitir dos veces para el mismo usuario/convocatoria/accion devuelve NULL la segunda (no duplica la solicitud) ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at, opted_in_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '+5215511110005', 'activo', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.system_issue_whatsapp_action_token('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000e1', 'go', repeat('b', 64), now() + interval '1 day');
select (licitaciones.system_issue_whatsapp_action_token('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000e1', 'go', repeat('c', 64), now() + interval '1 day') is null)::int as repetida_nula_deberia_ser_1;
rollback;

\echo '--- 46. ROL: el consumo exitoso devuelve el rol vigente del usuario (para sellar go_no_go_decision) ---'
begin;
insert into licitaciones.whatsapp_contact (organization_id, user_id, phone_e164, status, consent_requested_at, opted_in_at) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '+5215511110005', 'activo', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.system_issue_whatsapp_action_token('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000e1', 'no_go', repeat('b', 64), now() + interval '1 day');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
do $$ declare r record; begin
  select * into r from licitaciones.whatsapp_consume_action_token(repeat('b', 64), '+5215511110005', 'wamid.rol');
  if r.resultado <> 'ok' or r.rol <> 'analyst' or r.accion <> 'no_go' then raise exception 'esperado ok/analyst/no_go, obtuve %/%/%', r.resultado, r.rol, r.accion; end if;
end $$;
rollback;

\echo ''
\echo '=== fin: los escenarios marcados should_fail / deberia_ser_N deben terminar en ERROR / en el valor N; el resto sin error ==='

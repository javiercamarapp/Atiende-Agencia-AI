-- Fixtures + assertions contra Postgres REAL (RLS + GRANT por columna + triggers +
-- auth.uid() reales) para
-- packages/domain-licitaciones/migrations/029_sala_de_guerra_y_junta_aclaraciones.sql
-- (L-04: sala de guerra + preguntas de la junta de aclaraciones).
--
-- Actores (todos "authenticated"; el rol de plataforma lo fija vertical_role):
--   c1 = owner Org A      c3 = writer Org A     c4 = viewer Org A
--   c5 = analyst Org A    c2 = owner Org B (otro tenant)
--
-- Cobertura: positivo, negativo, cross-tenant, anon, GRANT por columna, sellos del
-- trigger, maquina de estados, funcion de solo-sistema y degradacion a base sin
-- migrar con SAVEPOINT. Cada escenario corre en su propio `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000d1', 'licitaciones', 'Org A (sala de guerra)', 'org-a-sala-guerra'),
  ('00000000-0000-0000-0000-0000000000d2', 'licitaciones', 'Org B (sala de guerra, ajena)', 'org-b-sala-guerra')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000c1', 'owner-a-sg@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c2', 'owner-b-sg@example.com', 'Owner B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-0000000000c3', 'writer-a-sg@example.com', 'Writer A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c4', 'viewer-a-sg@example.com', 'Viewer A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c5', 'analyst-a-sg@example.com', 'Analyst A', 'seed')
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

insert into licitaciones.requirement_item (id, organization_id, tender_id, description) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'Acreditar experiencia minima de 3 anios')
on conflict do nothing;

\echo ''
\echo '=== licitaciones: sala de guerra + junta de aclaraciones (029) ==='
\echo ''

-- ===================== war_room_item =====================

\echo '--- 1. POSITIVO: writer de Org A crea un requisito ligado a su requirement_item y a un responsable propio ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
insert into licitaciones.war_room_item (organization_id, tender_id, kind, title, responsible_user_id, due_at, requirement_item_id, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'requisito', 'Acreditar experiencia', '00000000-0000-0000-0000-0000000000c5', now() + interval '3 days', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000c3') returning id;
rollback;

\echo '--- 2. NEGATIVO: viewer de Org A no puede crear items (RLS) ---'
begin;
-- as should_fail (insert de viewer, RLS can_write_org)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
insert into licitaciones.war_room_item (organization_id, tender_id, kind, title, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'tarea', 'Tarea de viewer', '00000000-0000-0000-0000-0000000000c4');
rollback;

\echo '--- 3a. CROSS-TENANT: owner de Org B inserta un item en la organizacion A (RLS) ---'
begin;
-- as should_fail (organization_id ajeno)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
insert into licitaciones.war_room_item (organization_id, tender_id, kind, title, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'tarea', 'Intruso', '00000000-0000-0000-0000-0000000000c2');
rollback;

\echo '--- 3b. CROSS-TENANT: owner de Org A apunta un item de SU organizacion a la convocatoria de Org B (WITH CHECK de convocatoria) ---'
begin;
-- as should_fail (tender de otra organizacion)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
insert into licitaciones.war_room_item (organization_id, tender_id, kind, title, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e2', 'tarea', 'Convocatoria ajena', '00000000-0000-0000-0000-0000000000c1');
rollback;

\echo '--- 4. NEGATIVO: responsable que NO pertenece a la organizacion (owner de Org B) -- rechazado ---'
begin;
-- as should_fail (responsable de otro tenant)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
insert into licitaciones.war_room_item (organization_id, tender_id, kind, title, responsible_user_id, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'tarea', 'Asignada a un ajeno', '00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000c1');
rollback;

\echo '--- 5. NEGATIVO: created_by falsificado (writer firma como owner) -- rechazado ---'
begin;
-- as should_fail (created_by != auth.uid())
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
insert into licitaciones.war_room_item (organization_id, tender_id, kind, title, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'tarea', 'Firma falsa', '00000000-0000-0000-0000-0000000000c1');
rollback;

\echo '--- 6. NEGATIVO: anon no tiene ningun GRANT sobre el tablero ---'
begin;
set local role anon;
-- as should_fail (permission denied)
select count(*) as should_fail from licitaciones.war_room_item;
rollback;

\echo '--- 7. CROSS-TENANT lectura: owner de Org B ve 0 items de Org A ---'
begin;
insert into licitaciones.war_room_item (organization_id, tender_id, kind, title, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'tarea', 'Solo Org A', '00000000-0000-0000-0000-0000000000c1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select count(*) as items_ajenos_deberia_ser_0 from licitaciones.war_room_item;
rollback;

\echo '--- 8. GRANT por columna: authenticated no puede reasignar organization_id en un UPDATE ---'
begin;
insert into licitaciones.war_room_item (id, organization_id, tender_id, kind, title, created_by)
  values ('00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'tarea', 'Para mover', '00000000-0000-0000-0000-0000000000c1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (permission denied for column organization_id)
update licitaciones.war_room_item set organization_id = '00000000-0000-0000-0000-0000000000d2' where id = '00000000-0000-0000-0000-0000000000a9';
rollback;

\echo '--- 9. SELLOS: cerrar un item fija completed_at y updated_by en el trigger; reabrirlo los limpia ---'
begin;
insert into licitaciones.war_room_item (id, organization_id, tender_id, kind, title, created_by)
  values ('00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'tarea', 'Cerrar', '00000000-0000-0000-0000-0000000000c1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
update licitaciones.war_room_item set status = 'listo' where id = '00000000-0000-0000-0000-0000000000a9';
do $$
declare r licitaciones.war_room_item;
begin
  select * into r from licitaciones.war_room_item where id = '00000000-0000-0000-0000-0000000000a9';
  if r.completed_at is null or r.updated_by is distinct from '00000000-0000-0000-0000-0000000000c3'::uuid then
    raise exception 'sellos de cierre no aplicados';
  end if;
end $$;
update licitaciones.war_room_item set status = 'en_curso' where id = '00000000-0000-0000-0000-0000000000a9';
do $$
begin
  if (select completed_at from licitaciones.war_room_item where id = '00000000-0000-0000-0000-0000000000a9') is not null then
    raise exception 'completed_at debia limpiarse al reabrir';
  end if;
end $$;
rollback;

\echo '--- 10. NEGATIVO: el cliente no puede fijar completed_at (sin GRANT de columna) ---'
begin;
insert into licitaciones.war_room_item (id, organization_id, tender_id, kind, title, created_by)
  values ('00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'tarea', 'Sello', '00000000-0000-0000-0000-0000000000c1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
-- as should_fail (permission denied for column completed_at)
update licitaciones.war_room_item set completed_at = now() where id = '00000000-0000-0000-0000-0000000000a9';
rollback;

\echo '--- 11. NEGATIVO: solo un riesgo lleva severidad (CHECK) ---'
begin;
-- as should_fail (severity en una tarea)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
insert into licitaciones.war_room_item (organization_id, tender_id, kind, title, severity, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'tarea', 'Tarea con severidad', 'alta', '00000000-0000-0000-0000-0000000000c1');
rollback;

-- ===================== war_room_entry (append-only) =====================

\echo '--- 12. POSITIVO: writer comenta; analyst registra una DECISION ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
insert into licitaciones.war_room_entry (organization_id, tender_id, entry_kind, body, author_id)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'comentario', 'Falta la carta del fabricante', '00000000-0000-0000-0000-0000000000c3') returning id;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
insert into licitaciones.war_room_entry (organization_id, tender_id, entry_kind, body, author_id)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'decision', 'Se decide participar con el socio local', '00000000-0000-0000-0000-0000000000c5') returning id;
rollback;

\echo '--- 13. NEGATIVO: un writer NO puede registrar una DECISION (can_go_no_go_org) ---'
begin;
-- as should_fail (decision de writer)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
insert into licitaciones.war_room_entry (organization_id, tender_id, entry_kind, body, author_id)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'decision', 'Decision de writer', '00000000-0000-0000-0000-0000000000c3');
rollback;

\echo '--- 14. NEGATIVO: la bitacora es append-only -- UPDATE sin GRANT ---'
begin;
insert into licitaciones.war_room_entry (id, organization_id, tender_id, entry_kind, body, author_id)
  values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'comentario', 'original', '00000000-0000-0000-0000-0000000000c1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (permission denied: update)
update licitaciones.war_room_entry set body = 'reescrita' where id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo '--- 15. NEGATIVO: la bitacora es append-only -- DELETE sin GRANT ---'
begin;
insert into licitaciones.war_room_entry (id, organization_id, tender_id, entry_kind, body, author_id)
  values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'comentario', 'original', '00000000-0000-0000-0000-0000000000c1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
-- as should_fail (permission denied: delete)
delete from licitaciones.war_room_entry where id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo '--- 16. NEGATIVO: autor falsificado en la bitacora ---'
begin;
-- as should_fail (author_id != auth.uid())
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
insert into licitaciones.war_room_entry (organization_id, tender_id, entry_kind, body, author_id)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'comentario', 'a nombre de otro', '00000000-0000-0000-0000-0000000000c1');
rollback;

\echo '--- 17. CROSS-TENANT: owner de Org B lee 0 anotaciones de Org A ---'
begin;
insert into licitaciones.war_room_entry (organization_id, tender_id, entry_kind, body, author_id)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'comentario', 'solo A', '00000000-0000-0000-0000-0000000000c1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select count(*) as anotaciones_ajenas_deberia_ser_0 from licitaciones.war_room_entry;
rollback;

-- ===================== junta_aclaraciones =====================

\echo '--- 18. POSITIVO: writer registra y luego actualiza las fechas de la junta (upsert) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
insert into licitaciones.junta_aclaraciones (tender_id, organization_id, questions_deadline_at, meeting_at, updated_by)
  values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', now() + interval '2 days', now() + interval '3 days', '00000000-0000-0000-0000-0000000000c3')
  on conflict (tender_id) do update set questions_deadline_at = excluded.questions_deadline_at, meeting_at = excluded.meeting_at, updated_by = excluded.updated_by, updated_at = now();
insert into licitaciones.junta_aclaraciones (tender_id, organization_id, questions_deadline_at, meeting_at, updated_by)
  values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', now() + interval '4 days', now() + interval '5 days', '00000000-0000-0000-0000-0000000000c3')
  on conflict (tender_id) do update set questions_deadline_at = excluded.questions_deadline_at, meeting_at = excluded.meeting_at, updated_by = excluded.updated_by, updated_at = now() returning tender_id;
rollback;

\echo '--- 19. NEGATIVO: viewer no registra fechas de junta ---'
begin;
-- as should_fail (viewer)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
insert into licitaciones.junta_aclaraciones (tender_id, organization_id, questions_deadline_at, updated_by)
  values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', now() + interval '2 days', '00000000-0000-0000-0000-0000000000c4');
rollback;

\echo '--- 20. CROSS-TENANT: owner de Org B no registra fechas sobre la convocatoria de Org A ---'
begin;
-- as should_fail (organizacion ajena)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
insert into licitaciones.junta_aclaraciones (tender_id, organization_id, questions_deadline_at, updated_by)
  values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', now() + interval '2 days', '00000000-0000-0000-0000-0000000000c2');
rollback;

\echo '--- 21. NEGATIVO: el limite de preguntas no puede ser posterior a la junta (CHECK) ---'
begin;
-- as should_fail (limite posterior a la junta)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
insert into licitaciones.junta_aclaraciones (tender_id, organization_id, questions_deadline_at, meeting_at, updated_by)
  values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', now() + interval '5 days', now() + interval '2 days', '00000000-0000-0000-0000-0000000000c1');
rollback;

-- ===================== junta_question =====================

\echo '--- 22. POSITIVO: writer captura una pregunta (nace borrador) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
insert into licitaciones.junta_question (organization_id, tender_id, question_text, topic, priority, dedupe_key, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'Se aceptan contratos de dependencias estatales como experiencia?', 'tecnico', 'alta', 'k1', '00000000-0000-0000-0000-0000000000c3') returning status;
rollback;

\echo '--- 23. NEGATIVO: no se puede insertar una pregunta ya aprobada (status sin GRANT en INSERT) ---'
begin;
-- as should_fail (permission denied para status)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
insert into licitaciones.junta_question (organization_id, tender_id, question_text, dedupe_key, created_by, status)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'Pregunta que nace aprobada', 'k2', '00000000-0000-0000-0000-0000000000c3', 'aprobada');
rollback;

\echo '--- 24. NEGATIVO: dedupe -- una segunda pregunta viva con la misma huella viola el indice unico ---'
begin;
insert into licitaciones.junta_question (organization_id, tender_id, question_text, dedupe_key, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'Pregunta original sobre plazos de entrega', 'plazos entrega', '00000000-0000-0000-0000-0000000000c1');
-- as should_fail (unique tender_id+dedupe_key)
insert into licitaciones.junta_question (organization_id, tender_id, question_text, dedupe_key, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'Pregunta duplicada sobre plazos de entrega', 'plazos entrega', '00000000-0000-0000-0000-0000000000c1');
rollback;

\echo '--- 25. POSITIVO: una pregunta descartada libera la huella para una nueva ---'
begin;
insert into licitaciones.junta_question (organization_id, tender_id, question_text, dedupe_key, created_by, status, discard_reason)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'Pregunta descartada sobre anticipos', 'anticipos', '00000000-0000-0000-0000-0000000000c1', 'descartada', 'duplicada');
insert into licitaciones.junta_question (organization_id, tender_id, question_text, dedupe_key, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'Pregunta nueva sobre anticipos', 'anticipos', '00000000-0000-0000-0000-0000000000c1') returning id;
rollback;

\echo '--- 26. NEGATIVO: un writer NO aprueba (exige rol de decision; trigger 42501) ---'
begin;
insert into licitaciones.junta_question (id, organization_id, tender_id, question_text, dedupe_key, created_by)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'Pregunta pendiente de aprobacion', 'ap', '00000000-0000-0000-0000-0000000000c3');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
-- as should_fail (aprobar sin rol de decision)
update licitaciones.junta_question set status = 'aprobada' where id = '00000000-0000-0000-0000-0000000000a1';
rollback;

\echo '--- 27. NEGATIVO: borrador -> enviada se salta la aprobacion (transicion no permitida) ---'
begin;
insert into licitaciones.junta_question (id, organization_id, tender_id, question_text, dedupe_key, created_by)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'Pregunta que intenta saltarse la aprobacion', 'salto', '00000000-0000-0000-0000-0000000000c3');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
-- as should_fail (borrador -> enviada)
update licitaciones.junta_question set status = 'enviada' where id = '00000000-0000-0000-0000-0000000000a1';
rollback;

\echo '--- 28. POSITIVO: ciclo completo analyst aprueba, writer envia y registra respuesta del acta; sellos fijados por trigger ---'
begin;
insert into licitaciones.junta_question (id, organization_id, tender_id, question_text, dedupe_key, created_by)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'Pregunta del ciclo completo de estados', 'ciclo', '00000000-0000-0000-0000-0000000000c3');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
update licitaciones.junta_question set status = 'aprobada' where id = '00000000-0000-0000-0000-0000000000a1';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
update licitaciones.junta_question set status = 'enviada', sent_reference = 'Acuse 123' where id = '00000000-0000-0000-0000-0000000000a1';
update licitaciones.junta_question set status = 'respondida', answer_text = 'Si se aceptan.', answer_acta_reference = 'Acta junta, pregunta 4' where id = '00000000-0000-0000-0000-0000000000a1';
do $$
declare q licitaciones.junta_question;
begin
  select * into q from licitaciones.junta_question where id = '00000000-0000-0000-0000-0000000000a1';
  if q.status <> 'respondida'
     or q.approved_by is distinct from '00000000-0000-0000-0000-0000000000c5'::uuid or q.approved_at is null
     or q.sent_by is distinct from '00000000-0000-0000-0000-0000000000c3'::uuid or q.sent_at is null
     or q.answered_by is distinct from '00000000-0000-0000-0000-0000000000c3'::uuid or q.answered_at is null then
    raise exception 'sellos de aprobacion/envio/respuesta incorrectos';
  end if;
end $$;
rollback;

\echo '--- 29. NEGATIVO: el cliente no puede falsificar approved_by (sin GRANT de columna) ---'
begin;
insert into licitaciones.junta_question (id, organization_id, tender_id, question_text, dedupe_key, created_by)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'Pregunta con sello falsificado', 'sello', '00000000-0000-0000-0000-0000000000c3');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
-- as should_fail (permission denied for column approved_by)
update licitaciones.junta_question set approved_by = '00000000-0000-0000-0000-0000000000c1' where id = '00000000-0000-0000-0000-0000000000a1';
rollback;

\echo '--- 30. NEGATIVO: una pregunta aprobada no cambia de texto sin devolverla a borrador ---'
begin;
insert into licitaciones.junta_question (id, organization_id, tender_id, question_text, dedupe_key, created_by, status, approved_at)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'Pregunta ya aprobada con texto fijo', 'fijo', '00000000-0000-0000-0000-0000000000c3', 'aprobada', now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
-- as should_fail (texto de pregunta aprobada)
update licitaciones.junta_question set question_text = 'Texto cambiado despues de la aprobacion' where id = '00000000-0000-0000-0000-0000000000a1';
rollback;

\echo '--- 31. NEGATIVO: no se marca respondida sin texto de respuesta (CHECK) ---'
begin;
insert into licitaciones.junta_question (id, organization_id, tender_id, question_text, dedupe_key, created_by, status, approved_at, sent_at)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'Pregunta enviada sin respuesta aun', 'sinresp', '00000000-0000-0000-0000-0000000000c3', 'enviada', now(), now());
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
-- as should_fail (respondida sin answer_text)
update licitaciones.junta_question set status = 'respondida' where id = '00000000-0000-0000-0000-0000000000a1';
rollback;

\echo '--- 32. CROSS-TENANT: owner de Org B actualiza 0 preguntas de Org A (RLS) ---'
begin;
insert into licitaciones.junta_question (id, organization_id, tender_id, question_text, dedupe_key, created_by)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'Pregunta solo visible para Org A', 'privada', '00000000-0000-0000-0000-0000000000c3');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
with u as (update licitaciones.junta_question set priority = 'baja' where id = '00000000-0000-0000-0000-0000000000a1' returning 1)
  select count(*) as actualizadas_ajenas_deberia_ser_0 from u;
rollback;

\echo '--- 33. CROSS-TENANT: owner de Org B ve 0 preguntas de Org A ---'
begin;
insert into licitaciones.junta_question (organization_id, tender_id, question_text, dedupe_key, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'Pregunta solo visible para Org A', 'privada2', '00000000-0000-0000-0000-0000000000c3');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c2', true);
select count(*) as preguntas_ajenas_deberia_ser_0 from licitaciones.junta_question;
rollback;

\echo '--- 34. NEGATIVO: anon no tiene ningun GRANT sobre las preguntas ---'
begin;
set local role anon;
-- as should_fail (permission denied)
select count(*) as should_fail from licitaciones.junta_question;
rollback;

-- ===================== recordatorios (funcion de solo-sistema) =====================

\echo '--- 35. POSITIVO: sesion de sistema (auth.uid() NULL) crea 1 recordatorio y un segundo barrido no duplica ---'
begin;
insert into licitaciones.junta_aclaraciones (tender_id, organization_id, questions_deadline_at, meeting_at, updated_by)
  values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', now() + interval '2 days', now() + interval '3 days', '00000000-0000-0000-0000-0000000000c1');
insert into licitaciones.junta_question (organization_id, tender_id, question_text, dedupe_key, created_by)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'Pregunta pendiente antes del limite', 'rec1', '00000000-0000-0000-0000-0000000000c1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare n1 integer; n2 integer;
begin
  select count(*) into n1 from licitaciones.system_record_junta_question_reminders('00000000-0000-0000-0000-0000000000d1', now(), now() + interval '3 days');
  select count(*) into n2 from licitaciones.system_record_junta_question_reminders('00000000-0000-0000-0000-0000000000d1', now(), now() + interval '3 days');
  if n1 <> 1 or n2 <> 0 then raise exception 'se esperaba 1 y 0, fue % y %', n1, n2; end if;
end $$;
rollback;

\echo '--- 36. POSITIVO: sin preguntas pendientes no se crea recordatorio ---'
begin;
insert into licitaciones.junta_aclaraciones (tender_id, organization_id, questions_deadline_at, meeting_at, updated_by)
  values ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', now() + interval '2 days', now() + interval '3 days', '00000000-0000-0000-0000-0000000000c1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as recordatorios_sin_pendientes_deberia_ser_0 from licitaciones.system_record_junta_question_reminders('00000000-0000-0000-0000-0000000000d1', now(), now() + interval '3 days');
rollback;

\echo '--- 37. NEGATIVO: sesion autenticada (auth.uid() no nulo), aunque sea owner -- funcion de solo-sistema (42501) ---'
begin;
-- as should_fail (sesion con usuario)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
select out_id as should_fail from licitaciones.system_record_junta_question_reminders('00000000-0000-0000-0000-0000000000d1', now(), now() + interval '3 days');
rollback;

\echo '--- 38. NEGATIVO: anon sin EXECUTE sobre la funcion de sistema ---'
begin;
set local role anon;
-- as should_fail (permission denied for function)
select out_id as should_fail from licitaciones.system_record_junta_question_reminders('00000000-0000-0000-0000-0000000000d1', now(), now() + interval '3 days');
rollback;

\echo '--- 39. NEGATIVO: authenticated no inserta recordatorios directo (sin policy ni GRANT de INSERT) ---'
begin;
-- as should_fail (permission denied: insert)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', true);
insert into licitaciones.junta_question_reminder (organization_id, tender_id, questions_deadline_at, deadline_date, days_remaining, pending_count, message)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', now(), current_date, 1, 1, 'falso');
rollback;

-- ===================== base sin migrar + SAVEPOINT =====================

\echo '--- 40. SIN MIGRAR + SAVEPOINT (runWithSavepointFallback): 42P01 recuperado, el trabajo previo de la transaccion se CONSERVA y la sesion sigue utilizable ---'
begin;
insert into licitaciones.war_room_item (id, organization_id, tender_id, kind, title, created_by)
  values ('00000000-0000-0000-0000-0000000000a9', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000e1', 'tarea', 'Trabajo previo del request', '00000000-0000-0000-0000-0000000000c1');
drop table licitaciones.junta_question cascade;
savepoint sp_fallback_sala_guerra;
do $$
declare v_state text;
begin
  begin
    perform 1 from licitaciones.junta_question;
    raise exception 'se esperaba 42P01 (tabla sin migrar)';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then raise exception 'se esperaba 42P01 pero fue %', v_state; end if;
  end;
end $$;
rollback to savepoint sp_fallback_sala_guerra;
release savepoint sp_fallback_sala_guerra;
do $$
begin
  if (select count(*) from licitaciones.war_room_item where id = '00000000-0000-0000-0000-0000000000a9') <> 1 then
    raise exception 'el trabajo previo debia conservarse tras el SAVEPOINT';
  end if;
end $$;
rollback;

\echo ''
\echo 'Los escenarios marcados should_fail deben terminar en ERROR; los marcados deberia_ser_0 deben dar 0 filas; el resto debe completar sin error.'

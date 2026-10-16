-- Fixtures + assertions contra Postgres REAL para
-- packages/domain-licitaciones/migrations/037_licitaciones_boveda_matriz_estable_y_revision.sql
-- (L-P3-05/06/07). Actores (todos "authenticated"; el rol de plataforma lo fija vertical_role):
--   a1 = owner Org A   a3 = writer Org A   a5 = viewer Org A   b1 = owner Org B (otro tenant)
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario corre en su propio
-- begin/rollback; los negativos afirman el SQLSTATE exacto con DO ... raise exception, asi un error distinto
-- al esperado tambien falla el escenario.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('34000000-0000-0000-0000-0000000000d1', 'licitaciones', 'Org A (boveda)', 'org-a-boveda'),
  ('34000000-0000-0000-0000-0000000000d2', 'licitaciones', 'Org B (boveda, ajena)', 'org-b-boveda')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('34000000-0000-0000-0000-0000000000a1', 'owner-a-boveda@example.com', 'Owner A', 'seed'),
  ('34000000-0000-0000-0000-0000000000a3', 'writer-a-boveda@example.com', 'Writer A', 'seed'),
  ('34000000-0000-0000-0000-0000000000a5', 'viewer-a-boveda@example.com', 'Viewer A', 'seed'),
  ('34000000-0000-0000-0000-0000000000b1', 'owner-b-boveda@example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('34000000-0000-0000-0000-0000000000a1', '34000000-0000-0000-0000-0000000000d1', null, 'owner', 'owner'),
  ('34000000-0000-0000-0000-0000000000a3', '34000000-0000-0000-0000-0000000000d1', null, 'member', 'writer'),
  ('34000000-0000-0000-0000-0000000000a5', '34000000-0000-0000-0000-0000000000d1', null, 'viewer', 'viewer'),
  ('34000000-0000-0000-0000-0000000000b1', '34000000-0000-0000-0000-0000000000d2', null, 'owner', 'owner')
on conflict do nothing;

insert into licitaciones.tender (id, organization_id, title) values
  ('34000000-0000-0000-0000-0000000000e1', '34000000-0000-0000-0000-0000000000d1', 'Convocatoria A'),
  ('34000000-0000-0000-0000-0000000000e2', '34000000-0000-0000-0000-0000000000d2', 'Convocatoria B')
on conflict do nothing;

insert into licitaciones.proposal (id, organization_id, tender_id, title) values
  ('34000000-0000-0000-0000-0000000000f1', '34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'Propuesta A'),
  ('34000000-0000-0000-0000-0000000000f2', '34000000-0000-0000-0000-0000000000d2', '34000000-0000-0000-0000-0000000000e2', 'Propuesta B')
on conflict do nothing;

insert into licitaciones.file_blob (id, organization_id, sha256, size_bytes, content) values
  ('34000000-0000-0000-0000-0000000000c1', '34000000-0000-0000-0000-0000000000d1', repeat('a', 64), 4, '\x25504446'),
  ('34000000-0000-0000-0000-0000000000c2', '34000000-0000-0000-0000-0000000000d2', repeat('b', 64), 4, '\x25504446')
on conflict do nothing;

-- Un documento y un requisito del tenant A, sembrados como superusuario, para los escenarios de lectura/cross-tenant.
insert into licitaciones.tender_document (id, organization_id, tender_id, document_type, storage_ref, filename, file_blob_id, extraction_status, version)
values ('34000000-0000-0000-0000-0000000000c5', '34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'bases', '34000000-0000-0000-0000-0000000000c1', 'bases.pdf', '34000000-0000-0000-0000-0000000000c1', 'extracted', 1);
insert into licitaciones.requirement_item (id, organization_id, tender_id, description, stable_key)
values ('34000000-0000-0000-0000-0000000000c6', '34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'Requisito sembrado', 'clave-sembrada');
insert into licitaciones.requirement_conflict (id, organization_id, tender_id, conflict_key, kind, topic_key, description)
values ('34000000-0000-0000-0000-0000000000c7', '34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'conflicto-sembrado', 'deadline_mismatch', 'plazo', 'Dos plazos distintos');
insert into licitaciones.proposal_comment (id, organization_id, proposal_id, scope, scope_ref, body, author_id, author_role)
values ('34000000-0000-0000-0000-0000000000c8', '34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', 'Comentario sembrado', '34000000-0000-0000-0000-0000000000a1', 'owner');

\echo ''
\echo '=== licitaciones: boveda de bases, matriz estable, conflictos y comentarios (037) ==='
\echo ''
\echo '--- 1. POSITIVO: writer sube un documento (con su blob) y el viewer de la misma org lo lee ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.tender_document (organization_id, tender_id, document_type, storage_ref, filename, file_blob_id, extraction_status, version, uploaded_by) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'bases', '34000000-0000-0000-0000-0000000000c1', 'bases.pdf', '34000000-0000-0000-0000-0000000000c1', 'extracted', 1, '34000000-0000-0000-0000-0000000000a3');
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a5', true);
do $$ declare k integer; begin
  select count(*) into k from licitaciones.tender_document where tender_id = '34000000-0000-0000-0000-0000000000e1';
  if k <> 2 then raise exception 'el viewer debia ver 2 documentos, vio %', k; end if;
end $$;
rollback;
\echo '--- 2. POSITIVO: nueva version del mismo documento (mismo lineage, version 2); repetir la version es 23505 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.tender_document (organization_id, tender_id, document_type, storage_ref, filename, file_blob_id, extraction_status, version, lineage_id) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'bases', '34000000-0000-0000-0000-0000000000c1', 'bases.pdf', '34000000-0000-0000-0000-0000000000c1', 'extracted', 1, '34000000-0000-0000-0000-0000000000b1');
insert into licitaciones.tender_document (organization_id, tender_id, document_type, storage_ref, filename, file_blob_id, extraction_status, version, lineage_id) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'bases', '34000000-0000-0000-0000-0000000000c1', 'bases.pdf', '34000000-0000-0000-0000-0000000000c1', 'extracted', 2, '34000000-0000-0000-0000-0000000000b1');
do $$ begin
  begin
    insert into licitaciones.tender_document (organization_id, tender_id, document_type, storage_ref, filename, file_blob_id, extraction_status, version, lineage_id) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'bases', '34000000-0000-0000-0000-0000000000c1', 'bases.pdf', '34000000-0000-0000-0000-0000000000c1', 'extracted', 2, '34000000-0000-0000-0000-0000000000b1');
    raise exception 'la version duplicada del mismo linaje no fue rechazada';
  exception when sqlstate '23505' then null;
  end;
end $$;
rollback;
\echo '--- 3. NEGATIVO: viewer no puede subir documentos (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a5', true);
do $$ begin
  begin
    insert into licitaciones.tender_document (organization_id, tender_id, document_type, storage_ref, filename, file_blob_id, extraction_status, version) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'bases', '34000000-0000-0000-0000-0000000000c1', 'bases.pdf', '34000000-0000-0000-0000-0000000000c1', 'extracted', 1);
    raise exception 'el viewer logro subir un documento';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;
\echo '--- 4. NEGATIVO cross-tenant: owner B no sube a la convocatoria de A ni con su org ni con la de A (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000b1', true);
do $$ begin
  begin
    insert into licitaciones.tender_document (organization_id, tender_id, document_type, storage_ref, filename, file_blob_id, extraction_status, version) values ('34000000-0000-0000-0000-0000000000d2', '34000000-0000-0000-0000-0000000000e1', 'bases', '34000000-0000-0000-0000-0000000000c2', 'bases.pdf', '34000000-0000-0000-0000-0000000000c2', 'extracted', 1);
    raise exception 'owner B logro enlazar un documento a la convocatoria de A';
  exception when sqlstate '42501' then null;
  end;
end $$;
do $$ begin
  begin
    insert into licitaciones.tender_document (organization_id, tender_id, document_type, storage_ref, filename, file_blob_id, extraction_status, version) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'bases', '34000000-0000-0000-0000-0000000000c1', 'bases.pdf', '34000000-0000-0000-0000-0000000000c1', 'extracted', 1);
    raise exception 'owner B logro escribir con la organizacion de A';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;
\echo '--- 5. NEGATIVO: el documento no puede apuntar al archivo (blob) de otra organizacion (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    insert into licitaciones.tender_document (organization_id, tender_id, document_type, storage_ref, filename, file_blob_id, extraction_status, version) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'bases', '34000000-0000-0000-0000-0000000000c2', 'bases.pdf', '34000000-0000-0000-0000-0000000000c2', 'extracted', 1);
    raise exception 'se enlazo un blob ajeno';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;
\echo '--- 6. NEGATIVO: uploaded_by solo puede ser quien escribe (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    insert into licitaciones.tender_document (organization_id, tender_id, document_type, storage_ref, filename, file_blob_id, extraction_status, version, uploaded_by) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'bases', '34000000-0000-0000-0000-0000000000c1', 'bases.pdf', '34000000-0000-0000-0000-0000000000c1', 'extracted', 1, '34000000-0000-0000-0000-0000000000a1');
    raise exception 'se subio a nombre de otro usuario';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;
\echo '--- 7. NEGATIVO: tipo de documento fuera del catalogo (23514) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    insert into licitaciones.tender_document (organization_id, tender_id, document_type, storage_ref, filename, file_blob_id, extraction_status, version) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'cualquiera', '34000000-0000-0000-0000-0000000000c1', 'bases.pdf', '34000000-0000-0000-0000-0000000000c1', 'extracted', 1);
    raise exception 'se acepto un tipo invalido';
  exception when sqlstate '23514' then null;
  end;
end $$;
rollback;
\echo '--- 8. NEGATIVO: el documento es inmutable, sin update ni delete (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    update licitaciones.tender_document set filename = 'otro.pdf' where id = '34000000-0000-0000-0000-0000000000c5';
    raise exception 'el writer logro actualizar un documento';
  exception when sqlstate '42501' then null;
  end;
end $$;
do $$ begin
  begin
    delete from licitaciones.tender_document where id = '34000000-0000-0000-0000-0000000000c5';
    raise exception 'el writer logro borrar un documento';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;
\echo '--- 9. NEGATIVO anon: no lee ni escribe documentos (42501) ---'
begin;
set local role anon;
do $$ begin
  begin
    perform 1 from licitaciones.tender_document limit 1;
    raise exception 'anon logro leer documentos';
  exception when sqlstate '42501' then null;
  end;
end $$;
do $$ begin
  begin
    insert into licitaciones.tender_document (organization_id, tender_id, document_type, storage_ref, filename, file_blob_id, extraction_status, version) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'bases', '34000000-0000-0000-0000-0000000000c1', 'bases.pdf', '34000000-0000-0000-0000-0000000000c1', 'extracted', 1);
    raise exception 'anon logro escribir documentos';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;
\echo '--- 10. NEGATIVO cross-tenant: owner B no ve documentos de A (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000b1', true);
select count(*) as documentos_ajenos_deberia_ser_0 from licitaciones.tender_document where organization_id = '34000000-0000-0000-0000-0000000000d1';
rollback;
\echo '--- 11. POSITIVO: la clave estable es unica entre requisitos ACTIVOS (23505) y un retirado libera la clave ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.requirement_item (organization_id, tender_id, description, stable_key) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'Requisito', 'k1');
do $$ begin
  begin
    insert into licitaciones.requirement_item (organization_id, tender_id, description, stable_key) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'Requisito', 'k1');
    raise exception 'se duplico una clave estable activa';
  exception when sqlstate '23505' then null;
  end;
end $$;
update licitaciones.requirement_item set invalidated_at = now(), retired_in_version = 2 where tender_id = '34000000-0000-0000-0000-0000000000e1' and stable_key = 'k1';
insert into licitaciones.requirement_item (organization_id, tender_id, description, stable_key) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'Requisito', 'k1');
rollback;
\echo '--- 12. POSITIVO: writer asigna responsable, estado, causa de desechamiento y marca de edicion manual ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a3', true);
update licitaciones.requirement_item set responsible_role = 'legal', status = 'en_progreso', disqualifying = true, assigned_to = '34000000-0000-0000-0000-0000000000a3', manually_edited_at = now(), manually_edited_by = '34000000-0000-0000-0000-0000000000a3' where id = '34000000-0000-0000-0000-0000000000c6';
do $$ declare k integer; begin
  select count(*) into k from licitaciones.requirement_item where id = '34000000-0000-0000-0000-0000000000c6' and disqualifying and manually_edited_by = '34000000-0000-0000-0000-0000000000a3';
  if k <> 1 then raise exception 'la edicion manual no se guardo'; end if;
end $$;
rollback;
\echo '--- 13. NEGATIVO: el viewer no edita requisitos (0 filas afectadas) y owner B tampoco los ve ni edita ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a5', true);
do $$ declare k integer; begin
  update licitaciones.requirement_item set status = 'cumplido' where id = '34000000-0000-0000-0000-0000000000c6';
  get diagnostics k = row_count;
  if k <> 0 then raise exception 'el viewer edito % filas', k; end if;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000b1', true);
select count(*) as requisitos_ajenos_deberia_ser_0 from licitaciones.requirement_item where tender_id = '34000000-0000-0000-0000-0000000000e1';
rollback;
\echo '--- 14. POSITIVO: writer registra un conflicto abierto y la huella repetida es 23505 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.requirement_conflict (organization_id, tender_id, conflict_key, kind, topic_key, description, item_ids) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'nuevo', 'obligatoriedad_mismatch', 'garantia', 'Contradiccion', '{}');
do $$ begin
  begin
    insert into licitaciones.requirement_conflict (organization_id, tender_id, conflict_key, kind, topic_key, description, item_ids) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'nuevo', 'obligatoriedad_mismatch', 'garantia', 'Contradiccion', '{}');
    raise exception 'se duplico la huella del conflicto';
  exception when sqlstate '23505' then null;
  end;
end $$;
rollback;
\echo '--- 15. NEGATIVO: resolver sin notas es 23514 (con notas vacias tambien) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    update licitaciones.requirement_conflict set status = 'resuelto', resolved_at = now(), resolved_by = '34000000-0000-0000-0000-0000000000a3' where id = '34000000-0000-0000-0000-0000000000c7';
    raise exception 'se resolvio sin notas';
  exception when sqlstate '23514' then null;
  end;
end $$;
do $$ begin
  begin
    update licitaciones.requirement_conflict set status = 'resuelto', resolved_at = now(), resolved_by = '34000000-0000-0000-0000-0000000000a3', resolution_notes = '   ' where id = '34000000-0000-0000-0000-0000000000c7';
    raise exception 'se resolvio con notas vacias';
  exception when sqlstate '23514' then null;
  end;
end $$;
rollback;
\echo '--- 16. POSITIVO: resolver con notas deja resolved_by = quien resuelve ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a3', true);
update licitaciones.requirement_conflict set status = 'resuelto', resolved_at = now(), resolved_by = '34000000-0000-0000-0000-0000000000a3', resolution_notes = 'Prevalece el acta de junta', updated_at = now() where id = '34000000-0000-0000-0000-0000000000c7';
do $$ declare k integer; begin
  select count(*) into k from licitaciones.requirement_conflict where id = '34000000-0000-0000-0000-0000000000c7' and status = 'resuelto' and resolved_by = '34000000-0000-0000-0000-0000000000a3';
  if k <> 1 then raise exception 'el conflicto no quedo resuelto por el writer'; end if;
end $$;
rollback;
\echo '--- 17. NEGATIVO: no se puede resolver a nombre de otra persona (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    update licitaciones.requirement_conflict set status = 'resuelto', resolved_at = now(), resolved_by = '34000000-0000-0000-0000-0000000000a1', resolution_notes = 'x' where id = '34000000-0000-0000-0000-0000000000c7';
    raise exception 'se resolvio a nombre de otro';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;
\echo '--- 18. NEGATIVO: el viewer no resuelve ni registra conflictos ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a5', true);
do $$ declare k integer; begin
  update licitaciones.requirement_conflict set status = 'resuelto', resolved_at = now(), resolution_notes = 'x' where id = '34000000-0000-0000-0000-0000000000c7';
  get diagnostics k = row_count;
  if k <> 0 then raise exception 'el viewer resolvio % filas', k; end if;
end $$;
do $$ begin
  begin
    insert into licitaciones.requirement_conflict (organization_id, tender_id, conflict_key, kind, topic_key, description, item_ids) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'del-viewer', 'obligatoriedad_mismatch', 'garantia', 'Contradiccion', '{}');
    raise exception 'el viewer registro un conflicto';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;
\echo '--- 19. NEGATIVO cross-tenant: owner B no ve, no registra en A y no resuelve conflictos de A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000b1', true);
do $$ begin
  begin
    insert into licitaciones.requirement_conflict (organization_id, tender_id, conflict_key, kind, topic_key, description, item_ids) values ('34000000-0000-0000-0000-0000000000d2', '34000000-0000-0000-0000-0000000000e1', 'ajeno', 'obligatoriedad_mismatch', 'garantia', 'Contradiccion', '{}');
    raise exception 'owner B registro un conflicto en la convocatoria de A';
  exception when sqlstate '42501' then null;
  end;
end $$;
do $$ declare k integer; begin
  update licitaciones.requirement_conflict set status = 'resuelto', resolved_at = now(), resolution_notes = 'x' where id = '34000000-0000-0000-0000-0000000000c7';
  get diagnostics k = row_count;
  if k <> 0 then raise exception 'owner B resolvio % filas de A', k; end if;
end $$;
select count(*) as conflictos_ajenos_deberia_ser_0 from licitaciones.requirement_conflict where tender_id = '34000000-0000-0000-0000-0000000000e1';
rollback;
\echo '--- 20. NEGATIVO: sin delete de conflictos (42501) y anon no lee ni escribe (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    delete from licitaciones.requirement_conflict where id = '34000000-0000-0000-0000-0000000000c7';
    raise exception 'el writer borro un conflicto';
  exception when sqlstate '42501' then null;
  end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin
    perform 1 from licitaciones.requirement_conflict limit 1;
    raise exception 'anon leyo conflictos';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;
\echo '--- 21. POSITIVO: writer comenta en el expediente y en una seccion; el viewer los lee ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.proposal_comment (organization_id, proposal_id, scope, scope_ref, body, author_id, author_role) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', 'Revisar el anexo 3', '34000000-0000-0000-0000-0000000000a3', 'writer');
insert into licitaciones.proposal_comment (organization_id, proposal_id, scope, scope_ref, body, author_id, author_role) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000f1', 'seccion', 'seccion:technical:legal', 'Revisar el anexo 3', '34000000-0000-0000-0000-0000000000a3', 'writer');
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a5', true);
do $$ declare k integer; begin
  select count(*) into k from licitaciones.proposal_comment where proposal_id = '34000000-0000-0000-0000-0000000000f1';
  if k <> 3 then raise exception 'el viewer debia leer 3 comentarios, leyo %', k; end if;
end $$;
rollback;
\echo '--- 22. NEGATIVO: el autor siempre es la sesion (42501) y el viewer no comenta (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    insert into licitaciones.proposal_comment (organization_id, proposal_id, scope, scope_ref, body, author_id, author_role) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', 'Revisar el anexo 3', '34000000-0000-0000-0000-0000000000a1', 'writer');
    raise exception 'se comento a nombre de otro';
  exception when sqlstate '42501' then null;
  end;
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a5', true);
do $$ begin
  begin
    insert into licitaciones.proposal_comment (organization_id, proposal_id, scope, scope_ref, body, author_id, author_role) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', 'Revisar el anexo 3', '34000000-0000-0000-0000-0000000000a5', 'viewer');
    raise exception 'el viewer comento';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;
\echo '--- 23. NEGATIVO cross-tenant: owner B no comenta en la propuesta de A (42501) ni la lee (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000b1', true);
do $$ begin
  begin
    insert into licitaciones.proposal_comment (organization_id, proposal_id, scope, scope_ref, body, author_id, author_role) values ('34000000-0000-0000-0000-0000000000d2', '34000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', 'Revisar el anexo 3', '34000000-0000-0000-0000-0000000000b1', 'owner');
    raise exception 'owner B comento en la propuesta de A';
  exception when sqlstate '42501' then null;
  end;
end $$;
do $$ begin
  begin
    insert into licitaciones.proposal_comment (organization_id, proposal_id, scope, scope_ref, body, author_id, author_role) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', 'Revisar el anexo 3', '34000000-0000-0000-0000-0000000000b1', 'owner');
    raise exception 'owner B comento con la organizacion de A';
  exception when sqlstate '42501' then null;
  end;
end $$;
select count(*) as comentarios_ajenos_deberia_ser_0 from licitaciones.proposal_comment where proposal_id = '34000000-0000-0000-0000-0000000000f1';
rollback;
\echo '--- 24. NEGATIVO: solo de adicion, sin update ni delete (42501), ni siquiera el autor ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a1', true);
do $$ begin
  begin
    update licitaciones.proposal_comment set body = 'editado' where id = '34000000-0000-0000-0000-0000000000c8';
    raise exception 'se edito un comentario';
  exception when sqlstate '42501' then null;
  end;
end $$;
do $$ begin
  begin
    delete from licitaciones.proposal_comment where id = '34000000-0000-0000-0000-0000000000c8';
    raise exception 'se borro un comentario';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;
\echo '--- 25. NEGATIVO: alcance inconsistente (23514) y cuerpo vacio (23514) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a3', true);
do $$ begin
  begin
    insert into licitaciones.proposal_comment (organization_id, proposal_id, scope, scope_ref, body, author_id, author_role) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000f1', 'seccion', 'expediente', 'Revisar el anexo 3', '34000000-0000-0000-0000-0000000000a3', 'writer');
    raise exception 'se acepto una seccion con scope_ref expediente';
  exception when sqlstate '23514' then null;
  end;
end $$;
do $$ begin
  begin
    insert into licitaciones.proposal_comment (organization_id, proposal_id, scope, scope_ref, body, author_id, author_role) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000f1', 'expediente', 'seccion:x', 'Revisar el anexo 3', '34000000-0000-0000-0000-0000000000a3', 'writer');
    raise exception 'se acepto expediente con scope_ref de seccion';
  exception when sqlstate '23514' then null;
  end;
end $$;
do $$ begin
  begin
    insert into licitaciones.proposal_comment (organization_id, proposal_id, scope, scope_ref, body, author_id, author_role) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', '   ', '34000000-0000-0000-0000-0000000000a3', 'writer');
    raise exception 'se acepto un comentario vacio';
  exception when sqlstate '23514' then null;
  end;
end $$;
rollback;
\echo '--- 26. NEGATIVO anon: no lee ni escribe comentarios (42501) ---'
begin;
set local role anon;
do $$ begin
  begin
    perform 1 from licitaciones.proposal_comment limit 1;
    raise exception 'anon leyo comentarios';
  exception when sqlstate '42501' then null;
  end;
end $$;
do $$ begin
  begin
    insert into licitaciones.proposal_comment (organization_id, proposal_id, scope, scope_ref, body, author_id, author_role) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000f1', 'expediente', 'expediente', 'Revisar el anexo 3', '34000000-0000-0000-0000-0000000000a3', 'writer');
    raise exception 'anon comento';
  exception when sqlstate '42501' then null;
  end;
end $$;
rollback;
\echo '--- 27. POSITIVO/NEGATIVO: la bitacora acepta las acciones nuevas y rechaza una desconocida (23514) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '34000000-0000-0000-0000-0000000000a3', true);
insert into licitaciones.tender_audit_log (organization_id, tender_id, action, actor_id) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'requirement.edited', '34000000-0000-0000-0000-0000000000a3');
insert into licitaciones.tender_audit_log (organization_id, tender_id, action, actor_id) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'document.uploaded', '34000000-0000-0000-0000-0000000000a3');
do $$ begin
  begin
    insert into licitaciones.tender_audit_log (organization_id, tender_id, action, actor_id) values ('34000000-0000-0000-0000-0000000000d1', '34000000-0000-0000-0000-0000000000e1', 'accion.inventada', '34000000-0000-0000-0000-0000000000a3');
    raise exception 'se acepto una accion de bitacora desconocida';
  exception when sqlstate '23514' then null;
  end;
end $$;
rollback;

\echo ''
\echo '==> 27 escenarios: cada uno corre en su begin/rollback y termina sin error si la regla se cumple.'

-- Fixtures + assertions contra Postgres REAL para packages/domain-restaurantes/migrations/191_voz_turno_hilos.sql
-- (hilo por llamada del turno de voz del cerebro v2 + resolucion del secreto de sucursal + purga).
--
--   A. Lectura del hilo: solo la sesion de sistema (auth.uid() NULL); owner, staff y otra organizacion ven 0 filas; anon no tiene ni SELECT.
--   B. Escritura: el sistema crea y avanza (compare-and-swap por version); staff no inserta ni actualiza; nadie cambia telefono/call_id; sin DELETE directo;
--      CHECK de call_id, telefono y la pareja en_proceso.
--   C. resolver_secreto: vigente -> su organizacion y sucursal; anterior dentro de la gracia si, vencido no; formato invalido y desconocido -> nada;
--      el secreto de OTRA organizacion devuelve la otra (la ruta no confia en nada mas); solo sistema (staff 42501, anon sin EXECUTE).
--   D. Purga: solo sistema, borra lo viejo y deja lo reciente; p_dias < 1 rechazado.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; `..._deberia_ser_N` marca el valor esperado; un escenario sin alias debe
-- terminar sin error. Para exigir un ERROR de SQLSTATE exacto se usa public.t_esperar_error (falla si la sentencia NO falla o falla con otro codigo).
\pset pager off

create or replace function public.t_esperar_error(p_sql text, p_estado text) returns text
language plpgsql as $$
declare
  v text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v = returned_sqlstate;
    if v <> p_estado then
      raise exception 'se esperaba SQLSTATE %, se obtuvo % (%)', p_estado, v, sqlerrm;
    end if;
    return 'ok';
  end;
  raise exception 'se esperaba SQLSTATE % y la sentencia no fallo', p_estado;
end $$;
grant execute on function public.t_esperar_error(text, text) to public;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000f9a01', 'restaurantes', 'Voz Org A', 'voz-a'),
  ('00000000-0000-0000-0000-0000000f9a02', 'restaurantes', 'Voz Org B (ajena)', 'voz-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000f9b01', '00000000-0000-0000-0000-0000000f9a01', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000f9b02', '00000000-0000-0000-0000-0000000f9a01', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000f9b03', '00000000-0000-0000-0000-0000000f9a02', 'Sucursal B1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f9c01', 'voz-owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000f9c02', 'voz-staff-a@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000f9c03', 'voz-owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f9c01', '00000000-0000-0000-0000-0000000f9a01', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f9c02', '00000000-0000-0000-0000-0000000f9a01', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000f9c03', '00000000-0000-0000-0000-0000000f9a02', null, 'owner', 'owner')
on conflict do nothing;

-- Secretos (solo hashes sha256 de valores de PRUEBA): A1 vigente 'a1-nuevo' con el anterior 'a1-viejo' en gracia; A2 vigente con anterior VENCIDO; B1 vigente.
insert into restaurantes.voice_branch_secret (property_id, organization_id, secret_hash, secret_hint, previous_hash, previous_valid_until) values
  ('00000000-0000-0000-0000-0000000f9b01', '00000000-0000-0000-0000-0000000f9a01', encode(sha256('a1-nuevo'::bytea), 'hex'), 'nuevo', encode(sha256('a1-viejo'::bytea), 'hex'), now() + interval '1 hour'),
  ('00000000-0000-0000-0000-0000000f9b02', '00000000-0000-0000-0000-0000000f9a01', encode(sha256('a2-nuevo'::bytea), 'hex'), 'nuevo', encode(sha256('a2-vencido'::bytea), 'hex'), now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000f9b03', '00000000-0000-0000-0000-0000000f9a02', encode(sha256('b1-nuevo'::bytea), 'hex'), 'nuevo', null, null);

-- Hilos: dos de la Org A (uno reciente, uno de hace 40 dias) y uno de la Org B.
insert into restaurantes.voz_turno_hilo (organization_id, call_id, property_id, telefono, mensajes, turnos, seq_ultimo, version, updated_at) values
  ('00000000-0000-0000-0000-0000000f9a01', 'CA-reciente-01', '00000000-0000-0000-0000-0000000f9b01', '9991112222', '[{"role":"assistant","content":"Hola"}]', 0, 0, 1, now()),
  ('00000000-0000-0000-0000-0000000f9a01', 'CA-viejo-0001', '00000000-0000-0000-0000-0000000f9b01', '9993334444', '[]', 3, 3, 4, now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000f9a02', 'CA-ajena-0001', '00000000-0000-0000-0000-0000000f9b03', '9995556666', '[]', 1, 1, 2, now());

\echo '=== A) Lectura del hilo ==='

\echo '--- 1. sesion de SISTEMA (auth.uid() NULL) ve los 3 hilos ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as filas_visibles_deberia_ser_3 from restaurantes.voz_turno_hilo;
rollback;

\echo '--- 2. el owner de la Org A NO ve transcripciones (ni las suyas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9c01', true);
select count(*) as filas_visibles_deberia_ser_0 from restaurantes.voz_turno_hilo;
rollback;

\echo '--- 3. staff de la Org A tampoco ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9c02', true);
select count(*) as filas_visibles_deberia_ser_0 from restaurantes.voz_turno_hilo;
rollback;

\echo '--- 4. owner de la Org B (cross-tenant) tampoco ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9c03', true);
select count(*) as filas_visibles_deberia_ser_0 from restaurantes.voz_turno_hilo;
rollback;

\echo '--- 5. anon no tiene ni SELECT: RECHAZADO ---'
begin;
set local role anon;
select count(*) as should_fail from restaurantes.voz_turno_hilo;
rollback;

\echo ''
\echo '=== B) Escritura ==='

\echo '--- 6. el SISTEMA crea un hilo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into restaurantes.voz_turno_hilo (organization_id, call_id, property_id, telefono, mensajes, turnos, seq_ultimo, version, en_proceso_seq, en_proceso_desde)
  values ('00000000-0000-0000-0000-0000000f9a01', 'CA-nueva-0001', '00000000-0000-0000-0000-0000000f9b01', '9997778888', '[]', 0, 0, 1, 1, now());
select count(*) as creado_deberia_ser_1 from restaurantes.voz_turno_hilo where call_id = 'CA-nueva-0001';
rollback;

\echo '--- 7. compare-and-swap: con la version correcta avanza (1 fila), con la vieja no (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
with u as (
  update restaurantes.voz_turno_hilo set seq_ultimo = 1, turnos = 1, version = version + 1, updated_at = now()
   where organization_id = '00000000-0000-0000-0000-0000000f9a01' and call_id = 'CA-reciente-01' and version = 1 returning 1
) select count(*) as avanzo_deberia_ser_1 from u;
rollback;

\echo '--- 8. compare-and-swap con version vieja: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
with u as (
  update restaurantes.voz_turno_hilo set seq_ultimo = 1, version = version + 1
   where organization_id = '00000000-0000-0000-0000-0000000f9a01' and call_id = 'CA-reciente-01' and version = 0 returning 1
) select count(*) as avanzo_deberia_ser_0 from u;
rollback;

\echo '--- 9. el sistema NO puede cambiar el telefono de una llamada (sin GRANT de columna): 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_esperar_error($$update restaurantes.voz_turno_hilo set telefono = '9990000000' where call_id = 'CA-reciente-01'$$, '42501');
rollback;

\echo '--- 10. sin DELETE directo (ni el sistema): 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_esperar_error($$delete from restaurantes.voz_turno_hilo where call_id = 'CA-reciente-01'$$, '42501');
rollback;

\echo '--- 11. staff NO inserta (RLS): 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9c01', true);
select public.t_esperar_error($$insert into restaurantes.voz_turno_hilo (organization_id, call_id, telefono) values ('00000000-0000-0000-0000-0000000f9a01', 'CA-staff-0001', '9991231234')$$, '42501');
rollback;

\echo '--- 12. staff NO actualiza (RLS filtra: 0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9c01', true);
with u as (update restaurantes.voz_turno_hilo set turnos = 9 where call_id = 'CA-reciente-01' returning 1) select count(*) as actualizo_deberia_ser_0 from u;
rollback;

\echo '--- 13. CHECK: call_id con caracteres invalidos, telefono que no es de 10 digitos y marca en_proceso a medias: 23514 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_esperar_error($$insert into restaurantes.voz_turno_hilo (organization_id, call_id, telefono) values ('00000000-0000-0000-0000-0000000f9a01', 'CA con espacio', '9991231234')$$, '23514');
select public.t_esperar_error($$insert into restaurantes.voz_turno_hilo (organization_id, call_id, telefono) values ('00000000-0000-0000-0000-0000000f9a01', 'CA-telefono-01', '+52999123')$$, '23514');
select public.t_esperar_error($$insert into restaurantes.voz_turno_hilo (organization_id, call_id, telefono, en_proceso_seq) values ('00000000-0000-0000-0000-0000000f9a01', 'CA-marca-0001', '9991231234', 2)$$, '23514');
rollback;

\echo '--- 14. un call_id repetido en la MISMA organizacion: 23505 (crear devuelve false con on conflict) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_esperar_error($$insert into restaurantes.voz_turno_hilo (organization_id, call_id, telefono) values ('00000000-0000-0000-0000-0000000f9a01', 'CA-reciente-01', '9991112222')$$, '23505');
rollback;

\echo ''
\echo '=== C) resolver_secreto ==='

\echo '--- 15. secreto vigente de A1 -> Org A / Sucursal A1 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as resuelto_deberia_ser_1 from restaurantes.voz_turno_resolver_secreto(encode(sha256('a1-nuevo'::bytea), 'hex'))
  where organization_id = '00000000-0000-0000-0000-0000000f9a01' and property_id = '00000000-0000-0000-0000-0000000f9b01';
rollback;

\echo '--- 16. secreto ANTERIOR de A1 dentro de la gracia: tambien resuelve A1 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as resuelto_deberia_ser_1 from restaurantes.voz_turno_resolver_secreto(encode(sha256('a1-viejo'::bytea), 'hex'))
  where property_id = '00000000-0000-0000-0000-0000000f9b01';
rollback;

\echo '--- 17. secreto anterior VENCIDO de A2: nada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as resuelto_deberia_ser_0 from restaurantes.voz_turno_resolver_secreto(encode(sha256('a2-vencido'::bytea), 'hex'));
rollback;

\echo '--- 18. hash desconocido y formato invalido: nada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as resuelto_deberia_ser_0 from (
  select * from restaurantes.voz_turno_resolver_secreto(encode(sha256('no-existe'::bytea), 'hex'))
  union all select * from restaurantes.voz_turno_resolver_secreto('no-es-un-hash')
  union all select * from restaurantes.voz_turno_resolver_secreto(null)
) x;
rollback;

\echo '--- 19. el secreto de la Org B resuelve SOLO la Org B (aislamiento entre restaurantes) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as de_otra_org_deberia_ser_0 from restaurantes.voz_turno_resolver_secreto(encode(sha256('b1-nuevo'::bytea), 'hex'))
  where organization_id <> '00000000-0000-0000-0000-0000000f9a02';
rollback;

\echo '--- 20. un staff autenticado NO puede resolver secretos: 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9c01', true);
select public.t_esperar_error($$select * from restaurantes.voz_turno_resolver_secreto(encode(sha256('a1-nuevo'::bytea), 'hex'))$$, '42501');
rollback;

\echo '--- 21. anon no tiene EXECUTE: RECHAZADO ---'
begin;
set local role anon;
select count(*) as should_fail from restaurantes.voz_turno_resolver_secreto(encode(sha256('a1-nuevo'::bytea), 'hex'));
rollback;

\echo ''
\echo '=== D) Purga ==='

\echo '--- 22. el sistema purga lo de mas de 30 dias: borra 1 (el viejo) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.voz_turno_hilo_purgar(30) as borrados_deberia_ser_1;
rollback;

\echo '--- 23. p_dias < 1 rechazado: 22023 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select public.t_esperar_error($$select restaurantes.voz_turno_hilo_purgar(0)$$, '22023');
rollback;

\echo '--- 24. un staff no purga: 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9c01', true);
select public.t_esperar_error($$select restaurantes.voz_turno_hilo_purgar(30)$$, '42501');
rollback;

\echo '--- 25. anon no purga: RECHAZADO ---'
begin;
set local role anon;
select restaurantes.voz_turno_hilo_purgar(30) as should_fail;
rollback;

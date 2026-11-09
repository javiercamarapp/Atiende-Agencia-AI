-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales), packages/db/migrations/0077_registro_autoservicio_restaurantes.sql:
--   A) solicitar: solo la sesion de sistema (auth.uid() is null); un usuario con sesion y anon no; validaciones (vertical, metodo,
--      correo, nombres, zona IANA, vigencia); topes en la base (3 enlaces vigentes por correo, 10 por origen en 24 h).
--   B) completar: crea organizacion restaurantes en 'trial' con trial_ends_at ~14 dias, cuenta con correo verificado y sin contraseña,
--      membresia owner/owner de toda la organizacion y la primera sucursal INACTIVA (branch_detail + bitacora 'dueno'); un solo uso;
--      token vencido o inventado P0002; correo ya registrado 23505; Google exige correo verificado; slug desambiguado.
--   S) la tabla de solicitudes no se lee ni escribe directo (authenticated ni anon).
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): begin/rollback por escenario; deberia_ser_N = ultima fila vale N;
-- should_fail = el escenario debe terminar en ERROR.
\set ON_ERROR_STOP off
\pset pager off

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000b7700', 'ya-existe@example.com', 'Ya existe', 'seed')
on conflict do nothing;
insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000b7701', 'restaurantes', 'Taqueria previa', 'taqueria-lupita', 'trial')
on conflict do nothing;

\echo 'A1. sistema crea la solicitud (correo) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from core.registro_autoservicio_solicitar('restaurantes', 'correo', 'Dueno@Example.com', 'Taqueria Lupita', 'Centro', 'Lupita', 'America/Merida', repeat('a', 64), repeat('o', 64), 30);
reset role;
select (select count(*) from core.registro_autoservicio_solicitud where correo = 'dueno@example.com' and consumed_at is null and organization_id is null)::int as deberia_ser_1;
rollback;

\echo 'A2. usuario con sesion no crea solicitudes: 42501 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b7700', true);
select core.registro_autoservicio_solicitar('restaurantes', 'correo', 'x@example.com', 'Resto', 'Centro', 'Ana', null, repeat('b', 64), repeat('o', 64), 30) as should_fail;
rollback;

\echo 'A3. anon no tiene EXECUTE -- RECHAZADO'
begin;
set local role anon;
select core.registro_autoservicio_solicitar('restaurantes', 'correo', 'x@example.com', 'Resto', 'Centro', 'Ana', null, repeat('c', 64), repeat('o', 64), 30) as should_fail;
rollback;

\echo 'A4. vertical distinta de restaurantes -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.registro_autoservicio_solicitar('hoteles', 'correo', 'x@example.com', 'Hotel', 'Centro', 'Ana', null, repeat('d', 64), repeat('o', 64), 30) as should_fail;
rollback;

\echo 'A5. zona horaria inventada -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.registro_autoservicio_solicitar('restaurantes', 'correo', 'x@example.com', 'Resto', 'Centro', 'Ana', 'Marte/Olimpo', repeat('e', 64), repeat('o', 64), 30) as should_fail;
rollback;

\echo 'A6. correo invalido en metodo correo -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.registro_autoservicio_solicitar('restaurantes', 'correo', 'sin-arroba', 'Resto', 'Centro', 'Ana', null, repeat('f', 64), repeat('o', 64), 30) as should_fail;
rollback;

\echo 'A7. vigencia fuera de rango (> 60 min) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.registro_autoservicio_solicitar('restaurantes', 'correo', 'x@example.com', 'Resto', 'Centro', 'Ana', null, repeat('g', 64), repeat('o', 64), 600) as should_fail;
rollback;

\echo 'A8. cuarto enlace vigente para el mismo correo: 54000 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.registro_autoservicio_solicitar('restaurantes', 'correo', 'tope@example.com', 'Resto', 'Centro', 'Ana', null, repeat('1', 64), repeat('p', 64), 30);
select core.registro_autoservicio_solicitar('restaurantes', 'correo', 'tope@example.com', 'Resto', 'Centro', 'Ana', null, repeat('2', 64), repeat('q', 64), 30);
select core.registro_autoservicio_solicitar('restaurantes', 'correo', 'tope@example.com', 'Resto', 'Centro', 'Ana', null, repeat('3', 64), repeat('r', 64), 30);
select core.registro_autoservicio_solicitar('restaurantes', 'correo', 'tope@example.com', 'Resto', 'Centro', 'Ana', null, repeat('4', 64), repeat('s', 64), 30) as should_fail;
rollback;

\echo 'A9. undecima solicitud del mismo origen en 24 h: 54000 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(core.registro_autoservicio_solicitar('restaurantes', 'google', null, 'Resto', 'Centro', 'Ana', null, repeat('h', 60) || lpad(g::text, 4, '0'), repeat('z', 64), 15)) from generate_series(1, 10) g;
select core.registro_autoservicio_solicitar('restaurantes', 'google', null, 'Resto', 'Centro', 'Ana', null, repeat('i', 64), repeat('z', 64), 15) as should_fail;
rollback;

\echo 'B1. completar (correo): organizacion trial ~14 dias + cuenta verificada sin contraseña + owner + sucursal inactiva -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from core.registro_autoservicio_solicitar('restaurantes', 'correo', 'nuevo@example.com', 'Taquería Lupita', 'Sucursal Centro', 'Lupita', 'America/Merida', repeat('j', 64), repeat('o', 64), 30);
select count(*) from core.registro_autoservicio_completar(repeat('j', 64), null);
reset role;
select (
  select count(*) from core.organization o
  join core.membership m on m.organization_id = o.id and m.platform_role = 'owner' and m.vertical_role = 'owner' and m.property_ids is null
  join core.staff_user u on u.id = m.user_id and u.email = 'nuevo@example.com' and u.email_verified_at is not null and u.password_hash is null and u.created_via = 'registro_autoservicio'
  join core.property p on p.organization_id = o.id and p.status = 'inactive' and p.name = 'Sucursal Centro'
  join restaurantes.branch_detail bd on bd.property_id = p.id and bd.slug = 'sucursal-centro' and bd.zona_horaria = 'America/Merida'
  join core.propiedad_alta_log l on l.property_id = p.id and l.origen = 'dueno' and l.actor_user_id = u.id
  where o.vertical = 'restaurantes' and o.status = 'trial' and o.slug = 'taqueria-lupita-2'
    and o.trial_ends_at between now() + interval '13 days 23 hours' and now() + interval '14 days 1 minute'
)::int as deberia_ser_1;
rollback;

\echo 'B2. un solo uso: el segundo canje del mismo token es P0002 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from core.registro_autoservicio_solicitar('restaurantes', 'correo', 'doble@example.com', 'Resto Doble', 'Centro', 'Ana', null, repeat('k', 64), repeat('o', 64), 30);
select count(*) from core.registro_autoservicio_completar(repeat('k', 64), null);
select * from core.registro_autoservicio_completar(repeat('k', 64), null) as should_fail;
rollback;

\echo 'B3. token inventado: P0002 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from core.registro_autoservicio_completar(repeat('x', 64), null) as should_fail;
rollback;

\echo 'B4. token vencido: P0002 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from core.registro_autoservicio_solicitar('restaurantes', 'correo', 'vencido@example.com', 'Resto', 'Centro', 'Ana', null, repeat('l', 64), repeat('o', 64), 30);
reset role;
update core.registro_autoservicio_solicitud set expires_at = now() - interval '1 minute' where token_hash = repeat('l', 64);
set local role authenticated;
select * from core.registro_autoservicio_completar(repeat('l', 64), null) as should_fail;
rollback;

\echo 'B5. el correo ya tiene cuenta: 23505 (no crea segunda cuenta) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from core.registro_autoservicio_solicitar('restaurantes', 'correo', 'Ya-Existe@example.com', 'Resto', 'Centro', 'Ana', null, repeat('m', 64), repeat('o', 64), 30);
select * from core.registro_autoservicio_completar(repeat('m', 64), null) as should_fail;
rollback;

\echo 'B6. google sin correo verificado: 22023 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from core.registro_autoservicio_solicitar('restaurantes', 'google', null, 'Resto Google', 'Centro', 'Ana', null, repeat('n', 64), repeat('o', 64), 15);
select * from core.registro_autoservicio_completar(repeat('n', 64), null) as should_fail;
rollback;

\echo 'B7. google con correo verificado: cuenta created_via google -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from core.registro_autoservicio_solicitar('restaurantes', 'google', null, 'Resto Google', 'Centro', 'Ana', null, repeat('q', 64), repeat('o', 64), 15);
select count(*) from core.registro_autoservicio_completar(repeat('q', 64), 'Ana@Gmail.com');
reset role;
select (select count(*) from core.staff_user u where u.email = 'ana@gmail.com' and u.created_via = 'google' and u.email_verified_at is not null)::int as deberia_ser_1;
rollback;

\echo 'B8. usuario con sesion no completa registros: 42501 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from core.registro_autoservicio_solicitar('restaurantes', 'correo', 'sesion@example.com', 'Resto', 'Centro', 'Ana', null, repeat('r', 64), repeat('o', 64), 30);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b7700', true);
select * from core.registro_autoservicio_completar(repeat('r', 64), null) as should_fail;
rollback;

\echo 'B9. anon no completa -- RECHAZADO'
begin;
set local role anon;
select * from core.registro_autoservicio_completar(repeat('s', 64), null) as should_fail;
rollback;

\echo 'S1. authenticated no lee la tabla de solicitudes -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b7700', true);
select count(*) from core.registro_autoservicio_solicitud as should_fail;
rollback;

\echo 'S2. anon no lee la tabla de solicitudes -- RECHAZADO'
begin;
set local role anon;
select count(*) from core.registro_autoservicio_solicitud as should_fail;
rollback;

\echo 'S3. authenticated (sistema) no inserta directo -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into core.registro_autoservicio_solicitud (vertical, metodo, correo, nombre_negocio, nombre_sucursal, nombre_completo, token_hash, origen_hash, expires_at)
values ('restaurantes', 'correo', 'directo@example.com', 'Resto', 'Centro', 'Ana', repeat('t', 64), repeat('o', 64), now() + interval '30 minutes') returning id as should_fail;
rollback;

\echo 'B10. un restaurante llamado «Registro» no tapa la ruta publica /restaurantes/registro: slug registro-restaurante -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) from core.registro_autoservicio_solicitar('restaurantes', 'correo', 'reservado@example.com', 'Registro', 'Centro', 'Ana', null, repeat('u', 64), repeat('o', 64), 30);
select count(*) from core.registro_autoservicio_completar(repeat('u', 64), null);
reset role;
select (select count(*) from core.organization o where o.slug = 'registro-restaurante')::int as deberia_ser_1;
rollback;

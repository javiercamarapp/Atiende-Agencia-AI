-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales), la migracion
-- packages/db/migrations/0033_staff_sessions_y_google_vinculo.sql:
--   * register_staff_session es solo-sistema (auth.uid() nulo): authenticated con sesion y anon, rechazados;
--   * list/revoke de sesiones y list/unlink de identidades de Google atadas al usuario (auth.uid() = p_staff_id):
--     positivo, negativo (otra cuenta), cross-user y anon;
--   * core.staff_session sin acceso directo; rotacion hereda started_at y no toca sesiones ajenas;
--     corte masivo, expiracion y revocacion por logout las ocultan; tope de 50 vivas por cuenta.
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): `as should_fail`
-- = el escenario debe terminar en ERROR; `*_deberia_ser_N` = la ultima fila debe valer N.
\set ON_ERROR_STOP off
\pset pager off

insert into core.staff_user (id, email, full_name, created_via, password_hash) values
  ('00000000-0000-0000-0000-00000000a301', 'sess-a@example.com', 'Staff A sesiones', 'seed', 'scrypt$16384$8$1$00$00'),
  ('00000000-0000-0000-0000-00000000a302', 'sess-b@example.com', 'Staff B sesiones', 'seed', 'scrypt$16384$8$1$00$00')
on conflict do nothing;
insert into core.staff_google_identity (id, staff_user_id, provider_sub, email) values
  ('00000000-0000-0000-0000-00000000c601', '00000000-0000-0000-0000-00000000a301', 'sub-google-a-sess', 'sess-a@gmail.com'),
  ('00000000-0000-0000-0000-00000000c602', '00000000-0000-0000-0000-00000000a302', 'sub-google-b-sess', 'sess-b@gmail.com')
on conflict do nothing;

\echo '=== 1. anon no puede registrar una sesion -- RECHAZADO ==='
begin;
set local role anon;
select core.register_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e01', now() + interval '1 day', 'ua', null) as should_fail;
rollback;

\echo '=== 2. un usuario con sesion (auth.uid() real) no puede fabricar sesiones de otra cuenta -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a302', true);
select core.register_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e01', now() + interval '1 day', 'ua', null) as should_fail;
rollback;

\echo '=== 3. sesion de sistema registra; A la ve (1 fila) ==='
begin;
set local role authenticated;
select core.register_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e01', now() + interval '1 day', 'Mozilla/5.0', null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a301', true);
select count(*) as propia_deberia_ser_1 from core.list_staff_sessions('00000000-0000-0000-0000-00000000a301');
rollback;

\echo '=== 4. cross-user: B no puede listar las sesiones de A -- RECHAZADO ==='
begin;
set local role authenticated;
select core.register_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e01', now() + interval '1 day', 'ua', null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a302', true);
select count(*) as should_fail from core.list_staff_sessions('00000000-0000-0000-0000-00000000a301');
rollback;

\echo '=== 5. anon no puede listar sesiones -- RECHAZADO ==='
begin;
set local role anon;
select count(*) as should_fail from core.list_staff_sessions('00000000-0000-0000-0000-00000000a301');
rollback;

\echo '=== 6. sesion de sistema (auth.uid() nulo) no puede listar sesiones de nadie -- RECHAZADO ==='
begin;
set local role authenticated;
select count(*) as should_fail from core.list_staff_sessions('00000000-0000-0000-0000-00000000a301');
rollback;

\echo '=== 7. authenticated no puede leer core.staff_session directo (sin GRANT) -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a301', true);
select count(*) as should_fail from core.staff_session;
rollback;

\echo '=== 8. anon no puede leer core.staff_session directo -- RECHAZADO ==='
begin;
set local role anon;
select count(*) as should_fail from core.staff_session;
rollback;

\echo '=== 9. cross-user: B no puede cerrar la sesion de A pasando el id de A -- RECHAZADO ==='
begin;
set local role authenticated;
select core.register_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e01', now() + interval '1 day', 'ua', null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a302', true);
select core.revoke_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e01') as should_fail;
rollback;

\echo '=== 10. B con su propio id pero la sesion de A: false (indistinguible de inexistente) y A conserva su sesion ==='
begin;
set local role authenticated;
select core.register_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e01', now() + interval '1 day', 'ua', null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a302', true);
select core.revoke_staff_session('00000000-0000-0000-0000-00000000a302', '00000000-0000-0000-0000-0000000a5e01');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a301', true);
select count(*) as sesion_ajena_intacta_deberia_ser_1 from core.list_staff_sessions('00000000-0000-0000-0000-00000000a301');
rollback;

\echo '=== 11. A cierra su propia sesion: desaparece de la lista ==='
begin;
set local role authenticated;
select core.register_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e01', now() + interval '1 day', 'ua', null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a301', true);
select core.revoke_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e01');
select count(*) as cierre_deberia_ser_0 from core.list_staff_sessions('00000000-0000-0000-0000-00000000a301');
rollback;

\echo '=== 12. cerrar una sesion revoca su refresh token (jti en revoked_refresh_token) ==='
begin;
set local role authenticated;
select core.register_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e01', now() + interval '1 day', 'ua', null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a301', true);
select core.revoke_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e01');
reset role;
select count(*) as jti_revocado_deberia_ser_1 from core.revoked_refresh_token where jti = '00000000-0000-0000-0000-0000000a5e01' and user_id = '00000000-0000-0000-0000-00000000a301';
rollback;

\echo '=== 13. cerrar una sesion inexistente: false ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a301', true);
select core.revoke_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e03')::int as inexistente_deberia_ser_0;
rollback;

\echo '=== 14. rotacion: la fila nueva reemplaza a la vieja y hereda started_at ==='
begin;
set local role authenticated;
select core.register_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e01', now() + interval '1 day', 'ua', null);
reset role;
update core.staff_session set started_at = now() - interval '2 days' where id = '00000000-0000-0000-0000-0000000a5e01';
set local role authenticated;
select core.register_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e02', now() + interval '1 day', 'ua2', '00000000-0000-0000-0000-0000000a5e01');
reset role;
select (
  (select count(*) from core.staff_session where staff_user_id = '00000000-0000-0000-0000-00000000a301') = 1
  and (select started_at < now() - interval '1 day' from core.staff_session where id = '00000000-0000-0000-0000-0000000a5e02')
)::int as rotacion_deberia_ser_1;
rollback;

\echo '=== 15. rotacion cross-user: B no puede borrar la sesion de A usando su jti como "reemplazada" ==='
begin;
set local role authenticated;
select core.register_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e01', now() + interval '1 day', 'ua', null);
select core.register_staff_session('00000000-0000-0000-0000-00000000a302', '00000000-0000-0000-0000-0000000a5e02', now() + interval '1 day', 'ua', '00000000-0000-0000-0000-0000000a5e01');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a301', true);
select count(*) as sesion_de_A_intacta_deberia_ser_1 from core.list_staff_sessions('00000000-0000-0000-0000-00000000a301');
rollback;

\echo '=== 16. corte masivo (sessions_revoked_at posterior a la emision) oculta la sesion ==='
begin;
set local role authenticated;
select core.register_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e01', now() + interval '1 day', 'ua', null);
reset role;
update core.staff_user set sessions_revoked_at = now() + interval '1 minute' where id = '00000000-0000-0000-0000-00000000a301';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a301', true);
select count(*) as cortada_deberia_ser_0 from core.list_staff_sessions('00000000-0000-0000-0000-00000000a301');
rollback;

\echo '=== 17. sesion vencida no aparece ==='
begin;
set local role authenticated;
select core.register_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e01', now() - interval '1 hour', 'ua', null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a301', true);
select count(*) as vencida_deberia_ser_0 from core.list_staff_sessions('00000000-0000-0000-0000-00000000a301');
rollback;

\echo '=== 18. refresh token revocado por logout (revoked_refresh_token) no aparece ==='
begin;
set local role authenticated;
select core.register_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e01', now() + interval '1 day', 'ua', null);
reset role;
insert into core.revoked_refresh_token (jti, user_id, expires_at) values ('00000000-0000-0000-0000-0000000a5e01', '00000000-0000-0000-0000-00000000a301', now() + interval '1 day');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a301', true);
select count(*) as logout_deberia_ser_0 from core.list_staff_sessions('00000000-0000-0000-0000-00000000a301');
rollback;

\echo '=== 19. tope: 52 sesiones registradas -> quedan 50 vivas ==='
begin;
set local role authenticated;
select core.register_staff_session('00000000-0000-0000-0000-00000000a301', gen_random_uuid(), now() + interval '1 day', 'ua', null) from generate_series(1, 52);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a301', true);
select count(*) as tope_deberia_ser_50 from core.list_staff_sessions('00000000-0000-0000-0000-00000000a301');
rollback;

\echo '=== 20. user_agent de mas de 200 caracteres se recorta (no rompe el registro) ==='
begin;
set local role authenticated;
select core.register_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e01', now() + interval '1 day', repeat('x', 500), null);
reset role;
select (length(user_agent) = 200)::int as recortado_deberia_ser_1 from core.staff_session where id = '00000000-0000-0000-0000-0000000a5e01';
rollback;

\echo '=== 21. A lista sus identidades de Google (1 fila) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a301', true);
select count(*) as google_propia_deberia_ser_1 from core.list_google_identities('00000000-0000-0000-0000-00000000a301');
rollback;

\echo '=== 22. cross-user: B no puede listar las identidades de Google de A -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a302', true);
select count(*) as should_fail from core.list_google_identities('00000000-0000-0000-0000-00000000a301');
rollback;

\echo '=== 23. anon no puede listar identidades de Google -- RECHAZADO ==='
begin;
set local role anon;
select count(*) as should_fail from core.list_google_identities('00000000-0000-0000-0000-00000000a301');
rollback;

\echo '=== 24. cross-user: B no puede desvincular el Google de A pasando el id de A -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a302', true);
select core.unlink_google_identity('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-00000000c601') as should_fail;
rollback;

\echo '=== 25. B con su id pero la identidad de A: false y la identidad de A sigue vinculada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a302', true);
select core.unlink_google_identity('00000000-0000-0000-0000-00000000a302', '00000000-0000-0000-0000-00000000c601');
reset role;
select count(*) as identidad_ajena_intacta_deberia_ser_1 from core.staff_google_identity where id = '00000000-0000-0000-0000-00000000c601';
rollback;

\echo '=== 26. A desvincula su propia identidad: true y la de B sigue ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a301', true);
select core.unlink_google_identity('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-00000000c601');
reset role;
select ((select count(*) from core.staff_google_identity where id = '00000000-0000-0000-0000-00000000c601') = 0 and (select count(*) from core.staff_google_identity where id = '00000000-0000-0000-0000-00000000c602') = 1)::int as desvinculo_deberia_ser_1;
rollback;

\echo '=== 27. anon no puede desvincular -- RECHAZADO ==='
begin;
set local role anon;
select core.unlink_google_identity('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-00000000c601') as should_fail;
rollback;

\echo '=== 28. authenticated no puede leer core.staff_google_identity directo (sin GRANT) -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a301', true);
select count(*) as should_fail from core.staff_google_identity;
rollback;

\echo '=== 29. anon no puede cortar todas las sesiones -- RECHAZADO ==='
begin;
set local role anon;
select core.revoke_all_staff_sessions('00000000-0000-0000-0000-00000000a301') as should_fail;
rollback;

\echo '=== 30. cross-user: B no puede cortar todas las sesiones de A -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a302', true);
select core.revoke_all_staff_sessions('00000000-0000-0000-0000-00000000a301') as should_fail;
rollback;

\echo '=== 31. sesion de sistema (auth.uid() nulo) no puede cortar las sesiones de nadie -- RECHAZADO ==='
begin;
set local role authenticated;
select core.revoke_all_staff_sessions('00000000-0000-0000-0000-00000000a301') as should_fail;
rollback;

\echo '=== 32. A corta todas las suyas: fija el corte truncado a segundo y las sesiones previas dejan de listarse ==='
begin;
set local role authenticated;
select core.register_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e01', now() + interval '1 day', 'ua', null);
reset role;
update core.staff_session set issued_at = now() - interval '1 hour' where id = '00000000-0000-0000-0000-0000000a5e01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a301', true);
select core.revoke_all_staff_sessions('00000000-0000-0000-0000-00000000a301');
select count(*) as previas_cortadas_deberia_ser_0 from core.list_staff_sessions('00000000-0000-0000-0000-00000000a301');
rollback;

\echo '=== 33. el corte de A no toca las sesiones de B ==='
begin;
set local role authenticated;
select core.register_staff_session('00000000-0000-0000-0000-00000000a302', '00000000-0000-0000-0000-0000000a5e01', now() + interval '1 day', 'ua', null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a301', true);
select core.revoke_all_staff_sessions('00000000-0000-0000-0000-00000000a301');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a302', true);
select count(*) as sesion_de_B_intacta_deberia_ser_1 from core.list_staff_sessions('00000000-0000-0000-0000-00000000a302');
rollback;

\echo '=== 34. la sesion emitida justo despues del corte (mismo segundo) sigue viva ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a301', true);
select core.revoke_all_staff_sessions('00000000-0000-0000-0000-00000000a301');
select set_config('request.jwt.claim.sub', '', true);
select core.register_staff_session('00000000-0000-0000-0000-00000000a301', '00000000-0000-0000-0000-0000000a5e01', now() + interval '1 day', 'ua', null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a301', true);
select count(*) as posterior_viva_deberia_ser_1 from core.list_staff_sessions('00000000-0000-0000-0000-00000000a301');
rollback;

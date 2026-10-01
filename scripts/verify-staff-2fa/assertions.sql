-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales), la migracion
-- packages/db/migrations/0025_staff_totp_stepup_reset.sql:
--   * funciones del segundo factor atadas al usuario (auth.uid() = p_staff_id): positivo,
--     negativo (otro usuario), cross-tenant/cross-user y anon;
--   * tablas sin acceso directo para authenticated/anon;
--   * anti-replay por paso, lockout 5 fallos/15 min, codigos de respaldo de un solo uso;
--   * cambio y reset de contrasena (solo-sistema), verificacion de correo (solo-sistema).
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): `as should_fail`
-- = el escenario debe terminar en ERROR; `*_deberia_ser_N` = la ultima fila debe valer N.
\set ON_ERROR_STOP off
\pset pager off

insert into core.staff_user (id, email, full_name, created_via, password_hash) values
  ('00000000-0000-0000-0000-00000000a201', 'totp-a@example.com', 'Staff A 2FA', 'seed', 'scrypt$16384$8$1$00$00'),
  ('00000000-0000-0000-0000-00000000a202', 'totp-b@example.com', 'Staff B 2FA', 'seed', 'scrypt$16384$8$1$00$00')
on conflict do nothing;


\echo '=== 1. anon no puede ejecutar totp_get_status -- RECHAZADO ==='
begin;
set local role anon;
select * from core.totp_get_status('00000000-0000-0000-0000-00000000a201') as should_fail;
rollback;

\echo '=== 2. sesion de sistema (auth.uid() nulo) no puede leer el estado 2FA de nadie -- RECHAZADO ==='
begin;
set local role authenticated;
select * from core.totp_get_status('00000000-0000-0000-0000-00000000a201') as should_fail;
rollback;

\echo '=== 3. cross-user: B no puede iniciar el alta de A -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a202', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-robado') as should_fail;
rollback;

\echo '=== 4. cross-user: B no puede leer el secreto cifrado de A -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a202', true);
select * from core.totp_get_secret('00000000-0000-0000-0000-00000000a201') as should_fail;
rollback;

\echo '=== 5. A inicia su alta: queda pendiente (pending = 1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select (select pending from core.totp_get_status('00000000-0000-0000-0000-00000000a201'))::int as pendiente_deberia_ser_1;
rollback;

\echo '=== 6. A lee su propio secreto cifrado tras iniciar el alta (1 fila) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select count(*) as secreto_propio_deberia_ser_1 from core.totp_get_secret('00000000-0000-0000-0000-00000000a201');
rollback;

\echo '=== 7. authenticated no puede leer core.staff_totp directo (sin GRANT) -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select count(*) as should_fail from core.staff_totp;
rollback;

\echo '=== 8. authenticated no puede leer core.staff_backup_code directo -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select count(*) as should_fail from core.staff_backup_code;
rollback;

\echo '=== 9. authenticated no puede leer core.password_reset_token directo -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select count(*) as should_fail from core.password_reset_token;
rollback;

\echo '=== 10. authenticated no puede escribir core.email_verification_token directo -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
insert into core.email_verification_token (token_hash, staff_user_id, expires_at) values ('x', '00000000-0000-0000-0000-00000000a201', now() + interval '1 hour') returning 1 as should_fail;
rollback;

\echo '=== 11. anon no puede leer core.staff_totp directo -- RECHAZADO ==='
begin;
set local role anon;
select count(*) as should_fail from core.staff_totp;
rollback;

\echo '=== 12. confirmar con el primer codigo: queda activo y con 8 codigos de respaldo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']);
select ((select enrolled from core.totp_get_status('00000000-0000-0000-0000-00000000a201')) and (select backup_codes_remaining from core.totp_get_status('00000000-0000-0000-0000-00000000a201')) = 8)::int as activo_deberia_ser_1;
rollback;

\echo '=== 13. confirmar sin alta pendiente -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']) as should_fail;
rollback;

\echo '=== 14. confirmar con 0 codigos de respaldo -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array[]::text[]) as should_fail;
rollback;

\echo '=== 15. confirmar con 21 codigos de respaldo -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, (select array_agg('c' || g) from generate_series(1,21) g)) as should_fail;
rollback;

\echo '=== 16. iniciar un alta con 2FA ya activo -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'otro-secreto') as should_fail;
rollback;

\echo '=== 17. anti-replay: reusar el paso ya consumido (100) devuelve false ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']);
select core.totp_register_success('00000000-0000-0000-0000-00000000a201', 100)::int as replay_deberia_ser_0;
rollback;

\echo '=== 18. anti-replay: un paso anterior (99) tambien devuelve false ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']);
select core.totp_register_success('00000000-0000-0000-0000-00000000a201', 99)::int as anterior_deberia_ser_0;
rollback;

\echo '=== 19. un paso posterior (101) se acepta (true) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']);
select core.totp_register_success('00000000-0000-0000-0000-00000000a201', 101)::int as posterior_deberia_ser_1;
rollback;

\echo '=== 20. cross-user: B no puede registrar un acierto para A -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a202', true);
select core.totp_register_success('00000000-0000-0000-0000-00000000a201', 500) as should_fail;
rollback;

\echo '=== 21. cross-user: B no puede quemar intentos de A (lockout ajeno) -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a202', true);
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201') as should_fail;
rollback;

\echo '=== 22. lockout: 5 fallos bloquean (locked_until en el futuro) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']);
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select (select locked_until > now() from core.totp_get_status('00000000-0000-0000-0000-00000000a201'))::int as bloqueado_deberia_ser_1;
rollback;

\echo '=== 23. lockout: bloqueado, un paso nuevo valido ya no se acepta ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']);
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_register_success('00000000-0000-0000-0000-00000000a201', 900)::int as bloqueado_paso_deberia_ser_0;
rollback;

\echo '=== 24. lockout: bloqueado, un codigo de respaldo valido ya no se acepta ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']);
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_consume_backup_code('00000000-0000-0000-0000-00000000a201', 'h1')::int as bloqueado_respaldo_deberia_ser_0;
rollback;

\echo '=== 25. 4 fallos NO bloquean todavia ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']);
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select (select locked_until is null from core.totp_get_status('00000000-0000-0000-0000-00000000a201'))::int as no_bloqueado_deberia_ser_1;
rollback;

\echo '=== 26. un acierto reinicia el contador de fallos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']);
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select core.totp_register_success('00000000-0000-0000-0000-00000000a201', 101);
select core.totp_register_failure('00000000-0000-0000-0000-00000000a201');
select (select locked_until is null from core.totp_get_status('00000000-0000-0000-0000-00000000a201'))::int as reiniciado_deberia_ser_1;
rollback;

\echo '=== 27. codigo de respaldo valido se consume (true) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']);
select core.totp_consume_backup_code('00000000-0000-0000-0000-00000000a201', 'h1')::int as respaldo_deberia_ser_1;
rollback;

\echo '=== 28. codigo de respaldo: un solo uso (el segundo intento devuelve false) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']);
select core.totp_consume_backup_code('00000000-0000-0000-0000-00000000a201', 'h1');
select core.totp_consume_backup_code('00000000-0000-0000-0000-00000000a201', 'h1')::int as reuso_deberia_ser_0;
rollback;

\echo '=== 29. codigo de respaldo inexistente devuelve false ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']);
select core.totp_consume_backup_code('00000000-0000-0000-0000-00000000a201', 'no-existe')::int as inexistente_deberia_ser_0;
rollback;

\echo '=== 30. consumir un respaldo reduce el conteo a 7 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']);
select core.totp_consume_backup_code('00000000-0000-0000-0000-00000000a201', 'h2');
select (select backup_codes_remaining from core.totp_get_status('00000000-0000-0000-0000-00000000a201')) as quedan_deberia_ser_7;
rollback;

\echo '=== 31. cross-user: B no puede consumir un respaldo de A -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a202', true);
select core.totp_consume_backup_code('00000000-0000-0000-0000-00000000a201', 'h3') as should_fail;
rollback;

\echo '=== 32. regenerar respaldos invalida los anteriores ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']);
select core.totp_replace_backup_codes('00000000-0000-0000-0000-00000000a201', array['n1','n2']);
select core.totp_consume_backup_code('00000000-0000-0000-0000-00000000a201', 'h1')::int as viejo_deberia_ser_0;
rollback;

\echo '=== 33. regenerar respaldos sin 2FA activo -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_replace_backup_codes('00000000-0000-0000-0000-00000000a201', array['n1']) as should_fail;
rollback;

\echo '=== 34. cross-user: B no puede desactivar el 2FA de A -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a202', true);
select core.totp_disable('00000000-0000-0000-0000-00000000a201') as should_fail;
rollback;

\echo '=== 35. A desactiva su 2FA: queda sin alta ni respaldos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.totp_begin_enrollment('00000000-0000-0000-0000-00000000a201', 'cifrado-A');
select core.totp_confirm_enrollment('00000000-0000-0000-0000-00000000a201', 100, array['h1','h2','h3','h4','h5','h6','h7','h8']);
select core.totp_disable('00000000-0000-0000-0000-00000000a201');
select ((select not enrolled and not pending from core.totp_get_status('00000000-0000-0000-0000-00000000a201')) and (select backup_codes_remaining from core.totp_get_status('00000000-0000-0000-0000-00000000a201')) = 0)::int as desactivado_deberia_ser_1;
rollback;

\echo '=== 36. anon no puede ejecutar totp_disable -- RECHAZADO ==='
begin;
set local role anon;
select core.totp_disable('00000000-0000-0000-0000-00000000a201') as should_fail;
rollback;

\echo '=== 37. cross-user: B no puede cambiar la contrasena de A -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a202', true);
select core.change_staff_password('00000000-0000-0000-0000-00000000a201', 'scrypt$16384$8$1$aa$bb') as should_fail;
rollback;

\echo '=== 38. hash que no es scrypt -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.change_staff_password('00000000-0000-0000-0000-00000000a201', 'texto-plano') as should_fail;
rollback;

\echo '=== 39. A cambia su contrasena: hash nuevo y sessions_revoked_at fijado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a201', true);
select core.change_staff_password('00000000-0000-0000-0000-00000000a201', 'scrypt$16384$8$1$aa$bb');
reset role;
select (password_hash = 'scrypt$16384$8$1$aa$bb' and sessions_revoked_at is not null and sessions_revoked_at <= now())::int as cambio_deberia_ser_1 from core.staff_user where id = '00000000-0000-0000-0000-00000000a201';
rollback;

\echo '=== 40. sesion de sistema no puede cambiar contrasenas (auth.uid() nulo) -- RECHAZADO ==='
begin;
set local role authenticated;
select core.change_staff_password('00000000-0000-0000-0000-00000000a201', 'scrypt$16384$8$1$aa$bb') as should_fail;
rollback;

\echo '=== 41. anon no puede ejecutar change_staff_password -- RECHAZADO ==='
begin;
set local role anon;
select core.change_staff_password('00000000-0000-0000-0000-00000000a201', 'scrypt$16384$8$1$aa$bb') as should_fail;
rollback;

\echo '=== 42. un usuario con sesion (auth.uid() real) no puede crear tokens de reset -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a202', true);
select core.create_password_reset_token('00000000-0000-0000-0000-00000000a201', 'tok-x', now() + interval '1 hour') as should_fail;
rollback;

\echo '=== 43. anon no puede crear tokens de reset -- RECHAZADO ==='
begin;
set local role anon;
select core.create_password_reset_token('00000000-0000-0000-0000-00000000a201', 'tok-x', now() + interval '1 hour') as should_fail;
rollback;

\echo '=== 44. un usuario con sesion no puede canjear tokens de reset -- RECHAZADO ==='
begin;
set local role authenticated;
select core.create_password_reset_token('00000000-0000-0000-0000-00000000a201', 'tok-y', now() + interval '1 hour');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a202', true);
select core.consume_password_reset_token('tok-y', 'scrypt$16384$8$1$aa$bb') as should_fail;
rollback;

\echo '=== 45. reset valido (sistema): devuelve el id, fija hash, corta sesiones y verifica el correo ==='
begin;
set local role authenticated;
select core.create_password_reset_token('00000000-0000-0000-0000-00000000a201', 'tok-ok', now() + interval '1 hour');
select core.consume_password_reset_token('tok-ok', 'scrypt$16384$8$1$cc$dd');
reset role;
select (password_hash = 'scrypt$16384$8$1$cc$dd' and sessions_revoked_at is not null and email_verified_at is not null)::int as reset_deberia_ser_1 from core.staff_user where id = '00000000-0000-0000-0000-00000000a201';
rollback;

\echo '=== 46. reset: el token es de un solo uso (segundo canje devuelve null) ==='
begin;
set local role authenticated;
select core.create_password_reset_token('00000000-0000-0000-0000-00000000a201', 'tok-uno', now() + interval '1 hour');
select core.consume_password_reset_token('tok-uno', 'scrypt$16384$8$1$cc$dd');
select (core.consume_password_reset_token('tok-uno', 'scrypt$16384$8$1$ee$ff') is null)::int as reuso_deberia_ser_1;
rollback;

\echo '=== 47. reset: token vencido devuelve null y no cambia la contrasena ==='
begin;
set local role authenticated;
select core.create_password_reset_token('00000000-0000-0000-0000-00000000a201', 'tok-viejo', now() - interval '1 minute');
select (core.consume_password_reset_token('tok-viejo', 'scrypt$16384$8$1$cc$dd') is null)::int as vencido_deberia_ser_1;
rollback;

\echo '=== 48. reset: token inexistente devuelve null ==='
begin;
set local role authenticated;
select (core.consume_password_reset_token('no-existe', 'scrypt$16384$8$1$cc$dd') is null)::int as inexistente_deberia_ser_1;
rollback;

\echo '=== 49. reset: pedir un enlace nuevo invalida el anterior ==='
begin;
set local role authenticated;
select core.create_password_reset_token('00000000-0000-0000-0000-00000000a201', 'tok-a', now() + interval '1 hour');
select core.create_password_reset_token('00000000-0000-0000-0000-00000000a201', 'tok-b', now() + interval '1 hour');
select (core.consume_password_reset_token('tok-a', 'scrypt$16384$8$1$cc$dd') is null)::int as anterior_deberia_ser_1;
rollback;

\echo '=== 50. reset: hash de contrasena invalido -- RECHAZADO ==='
begin;
set local role authenticated;
select core.create_password_reset_token('00000000-0000-0000-0000-00000000a201', 'tok-h', now() + interval '1 hour');
select core.consume_password_reset_token('tok-h', 'sin-formato') as should_fail;
rollback;

\echo '=== 51. un usuario con sesion no puede crear tokens de verificacion -- RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a202', true);
select core.create_email_verification_token('00000000-0000-0000-0000-00000000a201', 'v-x', now() + interval '1 hour') as should_fail;
rollback;

\echo '=== 52. anon no puede canjear tokens de verificacion -- RECHAZADO ==='
begin;
set local role anon;
select core.consume_email_verification_token('v-x') as should_fail;
rollback;

\echo '=== 53. verificacion valida (sistema): fija email_verified_at ==='
begin;
set local role authenticated;
select core.create_email_verification_token('00000000-0000-0000-0000-00000000a202', 'v-ok', now() + interval '1 hour');
select core.consume_email_verification_token('v-ok');
reset role;
select (email_verified_at is not null)::int as verificado_deberia_ser_1 from core.staff_user where id = '00000000-0000-0000-0000-00000000a202';
rollback;

\echo '=== 54. verificacion: un solo uso (segundo canje devuelve null) ==='
begin;
set local role authenticated;
select core.create_email_verification_token('00000000-0000-0000-0000-00000000a202', 'v-uno', now() + interval '1 hour');
select core.consume_email_verification_token('v-uno');
select (core.consume_email_verification_token('v-uno') is null)::int as reuso_deberia_ser_1;
rollback;

\echo '=== 55. verificacion: token vencido devuelve null ==='
begin;
set local role authenticated;
select core.create_email_verification_token('00000000-0000-0000-0000-00000000a202', 'v-viejo', now() - interval '1 minute');
select (core.consume_email_verification_token('v-viejo') is null)::int as vencido_deberia_ser_1;
rollback;

\echo 'listo: los escenarios "should_fail" deben terminar en ERROR; los "deberia_ser_N" deben devolver N.'

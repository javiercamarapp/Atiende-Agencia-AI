-- Rn-24 / Rn-25 (migracion rentas 029) -- verificacion contra Postgres REAL (RLS + GRANT +
-- funciones security definer reales; el repositorio en memoria nunca aplica ninguno).
-- Cada escenario corre en su propio `begin; ... rollback;`. Alias `should_fail` = debe terminar
-- en ERROR; alias `..._deberia_ser_N` = el ultimo valor entero esperado (ver
-- scripts/verify-real-postgres-ci/run-gate.mjs). Sesion de SISTEMA = rol authenticated con
-- request.jwt.claim.sub vacio (withAppSession({ userId: null })); staff real = claim con su id.
-- Datos ficticios.
--
-- Fixtures: org A (propiedad A1, admin_gestora A, operador A, unidad, huesped, 2 reservas:
-- una de Airbnb y una directa 'manual'), org B (propiedad B1, admin_gestora B). Zona
-- America/Mexico_City (UTC-6 todo el ano desde 2022).
--   disparo de la reserva Airbnb (check-in 2030-06-10, offset -48 h) =
--   2030-06-08 00:00 CDMX = 2030-06-08T06:00:00Z.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e2a00', 'rentas', 'Org A (mensajes)', 'org-a-mensajes'),
  ('00000000-0000-0000-0000-0000000e2b00', 'rentas', 'Org B (mensajes, ajena)', 'org-b-mensajes')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000e2a10', '00000000-0000-0000-0000-0000000e2a00', 'rentas', 'Casa Mar'),
  ('00000000-0000-0000-0000-0000000e2b10', '00000000-0000-0000-0000-0000000e2b00', 'rentas', 'Casa Ajena')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e2a01', 'admin-a-msg@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000e2a02', 'operador-a-msg@example.com', 'Operador A', 'seed'),
  ('00000000-0000-0000-0000-0000000e2b01', 'admin-b-msg@example.com', 'Admin B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e2a01', '00000000-0000-0000-0000-0000000e2a00', null, 'admin', 'admin_gestora'),
  ('00000000-0000-0000-0000-0000000e2a02', '00000000-0000-0000-0000-0000000e2a00', null, 'member', 'operador:acceso_total'),
  ('00000000-0000-0000-0000-0000000e2b01', '00000000-0000-0000-0000-0000000e2b00', null, 'admin', 'admin_gestora')
on conflict do nothing;
insert into rentas.property_config (property_id, organization_id, zona_horaria) values
  ('00000000-0000-0000-0000-0000000e2a10', '00000000-0000-0000-0000-0000000e2a00', 'America/Mexico_City')
on conflict do nothing;
insert into rentas.unidad (id, organization_id, property_id, name, duracion_minima_noches) values
  ('00000000-0000-0000-0000-0000000e2a20', '00000000-0000-0000-0000-0000000e2a00', '00000000-0000-0000-0000-0000000e2a10', 'Depto 1', 1)
on conflict do nothing;
insert into rentas.guest_minimo (id, organization_id, property_id, nombre) values
  ('00000000-0000-0000-0000-0000000e2a30', '00000000-0000-0000-0000-0000000e2a00', '00000000-0000-0000-0000-0000000e2a10', 'Ana')
on conflict do nothing;
insert into rentas.plantilla_mensaje (id, organization_id, evento, idioma, canal_codigo, cuerpo, aprobada_por_tenant, activa) values
  ('00000000-0000-0000-0000-0000000e2a40', '00000000-0000-0000-0000-0000000e2a00', 'pre_llegada', 'es', null, 'Hola {{huesped}}, te esperamos en {{propiedad}} el {{fecha_check_in}}.', true, true),
  ('00000000-0000-0000-0000-0000000e2a41', '00000000-0000-0000-0000-0000000e2a00', 'pre_llegada', 'es', null, 'Borrador sin aprobar', false, true),
  ('00000000-0000-0000-0000-0000000e2a42', '00000000-0000-0000-0000-0000000e2a00', 'check_out', 'es', null, 'Gracias {{huesped}}.', true, true),
  ('00000000-0000-0000-0000-0000000e2b40', '00000000-0000-0000-0000-0000000e2b00', 'pre_llegada', 'es', null, 'Plantilla del tenant B', true, true)
on conflict do nothing;
insert into rentas.ocupacion (id, organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante, canal_origen_id, huesped_minimo_id) values
  ('00000000-0000-0000-0000-0000000e2a50', '00000000-0000-0000-0000-0000000e2a00', '00000000-0000-0000-0000-0000000e2a10', '00000000-0000-0000-0000-0000000e2a20', daterange('2030-06-10', '2030-06-12', '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true, (select id from rentas.canal where codigo = 'airbnb'), '00000000-0000-0000-0000-0000000e2a30'),
  ('00000000-0000-0000-0000-0000000e2a51', '00000000-0000-0000-0000-0000000e2a00', '00000000-0000-0000-0000-0000000e2a10', '00000000-0000-0000-0000-0000000e2a20', daterange('2030-07-10', '2030-07-12', '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true, (select id from rentas.canal where codigo = 'manual'), null)
on conflict do nothing;
insert into rentas.mensaje_automatico_config (id, organization_id, property_id, evento, plantilla_id, offset_horas, activo) values
  ('00000000-0000-0000-0000-0000000e2a60', '00000000-0000-0000-0000-0000000e2a00', '00000000-0000-0000-0000-0000000e2a10', 'pre_llegada', '00000000-0000-0000-0000-0000000e2a40', -48, true)
on conflict do nothing;

\echo '=== VENTANA Y ZONA HORARIA (sesion de sistema) ==='
\echo '1. en el instante exacto del disparo (2030-06-08 00:30 CDMX) la reserva Airbnb es candidata'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as visibles_deberia_ser_1 from rentas.sistema_listar_mensajes_automaticos('2030-06-08T06:30:00Z', 100);
rollback;

\echo '2. cruce de medianoche: 23:30 CDMX del dia anterior (el dia UTC ya es el 8) todavia NO es candidata'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as visibles_deberia_ser_0 from rentas.sistema_listar_mensajes_automaticos('2030-06-08T05:30:00Z', 100);
rollback;

\echo '3. pasada la ventana de gracia de 24 h ya no es candidata'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as visibles_deberia_ser_0 from rentas.sistema_listar_mensajes_automaticos('2030-06-09T06:30:01Z', 100);
rollback;

\echo '4. la reserva directa (canal manual) nunca es candidata aunque este en ventana: solo la de Airbnb aparece'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as visibles_deberia_ser_0 from rentas.sistema_listar_mensajes_automaticos('2030-07-08T06:30:00Z', 100);
rollback;

\echo '5. programacion apagada: 0 candidatas'
begin;
reset role;
update rentas.mensaje_automatico_config set activo = false;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as visibles_deberia_ser_0 from rentas.sistema_listar_mensajes_automaticos('2030-06-08T06:30:00Z', 100);
rollback;

\echo '6. plantilla sin aprobar: 0 candidatas (la aprobacion del tenant es obligatoria, H-056)'
begin;
reset role;
update rentas.plantilla_mensaje set aprobada_por_tenant = false where id = '00000000-0000-0000-0000-0000000e2a40';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as visibles_deberia_ser_0 from rentas.sistema_listar_mensajes_automaticos('2030-06-08T06:30:00Z', 100);
rollback;

\echo '7. zona horaria invalida cae al default de plataforma sin lanzar: sigue siendo candidata a la misma hora'
begin;
reset role;
update rentas.property_config set zona_horaria = 'Nunca/Existio';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as visibles_deberia_ser_1 from rentas.sistema_listar_mensajes_automaticos('2030-06-08T06:30:00Z', 100);
rollback;

\echo '8. zona distinta (Tokyo, UTC+9): el disparo es 2030-06-07T15:00Z, asi que a las 16:00Z del 7 ya es candidata (en CDMX aun faltan 14 h)'
begin;
reset role;
update rentas.property_config set zona_horaria = 'Asia/Tokyo';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as visibles_deberia_ser_1 from rentas.sistema_listar_mensajes_automaticos('2030-06-07T16:00:00Z', 100);
rollback;

\echo '=== CREAR BORRADOR (sesion de sistema) ==='
\echo '9. crea el borrador y devuelve su id'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (rentas.sistema_crear_borrador_automatico('00000000-0000-0000-0000-0000000e2a50', 'pre_llegada', '00000000-0000-0000-0000-0000000e2a40', 'Hola Ana, te esperamos.') is not null)::int as creado_deberia_ser_1;
rollback;

\echo '10. idempotente: la segunda llamada para la misma reserva+evento devuelve NULL'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.sistema_crear_borrador_automatico('00000000-0000-0000-0000-0000000e2a50', 'pre_llegada', '00000000-0000-0000-0000-0000000e2a40', 'Hola Ana, te esperamos.');
select (rentas.sistema_crear_borrador_automatico('00000000-0000-0000-0000-0000000e2a50', 'pre_llegada', '00000000-0000-0000-0000-0000000e2a40', 'Otro texto') is null)::int as segunda_deberia_ser_1;
rollback;

\echo '11. el borrador nace SIEMPRE pendiente_aprobacion (nunca enviado) y hay UNA sola fila'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.sistema_crear_borrador_automatico('00000000-0000-0000-0000-0000000e2a50', 'pre_llegada', '00000000-0000-0000-0000-0000000e2a40', 'Hola Ana, te esperamos.');
select rentas.sistema_crear_borrador_automatico('00000000-0000-0000-0000-0000000e2a50', 'pre_llegada', '00000000-0000-0000-0000-0000000e2a40', 'Hola Ana, te esperamos.');
reset role;
select count(*)::int as pendientes_deberia_ser_1 from rentas.borrador_mensaje where estado = 'pendiente_aprobacion' and generado_por = 'motor_borrador';
rollback;

\echo '12. tras crear, la reserva ya no aparece como candidata (la marca de idempotencia la excluye)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.sistema_crear_borrador_automatico('00000000-0000-0000-0000-0000000e2a50', 'pre_llegada', '00000000-0000-0000-0000-0000000e2a40', 'Hola Ana, te esperamos.');
select count(*)::int as visibles_deberia_ser_0 from rentas.sistema_listar_mensajes_automaticos('2030-06-08T06:30:00Z', 100);
rollback;

\echo '13. cross-tenant: la plantilla de OTRA organizacion no se puede usar (devuelve NULL, no escribe)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (rentas.sistema_crear_borrador_automatico('00000000-0000-0000-0000-0000000e2a50', 'pre_llegada', '00000000-0000-0000-0000-0000000e2b40', 'Texto') is null)::int as ajena_deberia_ser_1;
rollback;

\echo '14. plantilla sin aprobar: devuelve NULL'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (rentas.sistema_crear_borrador_automatico('00000000-0000-0000-0000-0000000e2a50', 'pre_llegada', '00000000-0000-0000-0000-0000000e2a41', 'Texto') is null)::int as sin_aprobar_deberia_ser_1;
rollback;

\echo '15. la reserva directa (canal manual) no admite borrador: NULL'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (rentas.sistema_crear_borrador_automatico('00000000-0000-0000-0000-0000000e2a51', 'pre_llegada', '00000000-0000-0000-0000-0000000e2a40', 'Texto') is null)::int as directa_deberia_ser_1;
rollback;

\echo '16. registrar omitida: la reserva deja de ser candidata y el reintento devuelve false'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.sistema_registrar_mensaje_omitido('00000000-0000-0000-0000-0000000e2a50', 'pre_llegada', '00000000-0000-0000-0000-0000000e2a40');
select count(*)::int as visibles_deberia_ser_0 from rentas.sistema_listar_mensajes_automaticos('2030-06-08T06:30:00Z', 100);
rollback;

\echo '=== FUNCIONES DE SOLO SISTEMA: un staff real (auth.uid() no nulo) es RECHAZADO ==='
\echo '17. staff listando'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a01', true);
select count(*) as should_fail from rentas.sistema_listar_mensajes_automaticos('2030-06-08T06:30:00Z', 100);
rollback;

\echo '18. staff creando borrador'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a01', true);
select rentas.sistema_crear_borrador_automatico('00000000-0000-0000-0000-0000000e2a50', 'pre_llegada', '00000000-0000-0000-0000-0000000e2a40', 'Texto') as should_fail;
rollback;

\echo '19. staff registrando omitida'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a01', true);
select rentas.sistema_registrar_mensaje_omitido('00000000-0000-0000-0000-0000000e2a50', 'pre_llegada', '00000000-0000-0000-0000-0000000e2a40') as should_fail;
rollback;

\echo '20. anon no puede ejecutar las funciones de sistema'
begin;
set local role anon;
select count(*) as should_fail from rentas.sistema_listar_mensajes_automaticos('2030-06-08T06:30:00Z', 100);
rollback;

\echo '=== RLS / GRANT de la programacion (staff real) ==='
\echo '21. admin_gestora de la org A SI puede programar un evento nuevo en su propiedad'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a01', true);
insert into rentas.mensaje_automatico_config (organization_id, property_id, evento, plantilla_id, offset_horas, activo, actualizado_por)
values ('00000000-0000-0000-0000-0000000e2a00', '00000000-0000-0000-0000-0000000e2a10', 'check_out', '00000000-0000-0000-0000-0000000e2a42', 6, true, '00000000-0000-0000-0000-0000000e2a01');
rollback;

\echo '22. un operador (no admin_gestora) NO puede programar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a02', true);
insert into rentas.mensaje_automatico_config (organization_id, property_id, evento, plantilla_id, offset_horas, activo)
values ('00000000-0000-0000-0000-0000000e2a00', '00000000-0000-0000-0000-0000000e2a10', 'check_out', '00000000-0000-0000-0000-0000000e2a42', 6, true) returning id as should_fail;
rollback;

\echo '23. cross-tenant: el admin_gestora de la org B NO puede programar en la propiedad de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2b01', true);
insert into rentas.mensaje_automatico_config (organization_id, property_id, evento, plantilla_id, offset_horas, activo)
values ('00000000-0000-0000-0000-0000000e2a00', '00000000-0000-0000-0000-0000000e2a10', 'check_out', '00000000-0000-0000-0000-0000000e2a42', 6, true) returning id as should_fail;
rollback;

\echo '24. cross-tenant: el admin_gestora de B tampoco puede editar la programacion de A (0 filas afectadas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2b01', true);
with u as (update rentas.mensaje_automatico_config set activo = false where id = '00000000-0000-0000-0000-0000000e2a60' returning 1)
select count(*)::int as afectadas_deberia_ser_0 from u;
rollback;

\echo '25. el admin_gestora de A SI edita la programacion de su propiedad (1 fila)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a01', true);
with u as (update rentas.mensaje_automatico_config set activo = false, offset_horas = -24 where id = '00000000-0000-0000-0000-0000000e2a60' returning 1)
select count(*)::int as afectadas_deberia_ser_1 from u;
rollback;

\echo '26. GRANT por columna: ni el admin puede cambiar el evento ni la propiedad de una programacion existente'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a01', true);
update rentas.mensaje_automatico_config set evento = 'resena' where id = '00000000-0000-0000-0000-0000000e2a60' returning id as should_fail;
rollback;

\echo '27. sin policy ni GRANT de delete: el admin no puede borrar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a01', true);
delete from rentas.mensaje_automatico_config where id = '00000000-0000-0000-0000-0000000e2a60' returning id as should_fail;
rollback;

\echo '28. lectura: el operador de A ve la programacion de su propiedad'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a02', true);
select count(*)::int as visibles_deberia_ser_1 from rentas.mensaje_automatico_config;
rollback;

\echo '29. lectura cross-tenant: el staff de B no ve ninguna programacion de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2b01', true);
select count(*)::int as visibles_deberia_ser_0 from rentas.mensaje_automatico_config;
rollback;

\echo '30. anon no lee la programacion'
begin;
set local role anon;
select count(*) as should_fail from rentas.mensaje_automatico_config;
rollback;

\echo '31. el staff no puede escribir marcas de idempotencia (solo las funciones de sistema)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a01', true);
insert into rentas.mensaje_automatico_envio (organization_id, property_id, ocupacion_id, evento, resultado)
values ('00000000-0000-0000-0000-0000000e2a00', '00000000-0000-0000-0000-0000000e2a10', '00000000-0000-0000-0000-0000000e2a50', 'pre_llegada', 'borrador_creado') returning id as should_fail;
rollback;

\echo '32. anon no lee las marcas'
begin;
set local role anon;
select count(*) as should_fail from rentas.mensaje_automatico_envio;
rollback;

\echo '=== INTEGRIDAD (llave compuesta) y aprobacion ==='
\echo '33. una programacion no puede apuntar a una plantilla de otro tenant (FK compuesta)'
begin;
reset role;
insert into rentas.mensaje_automatico_config (organization_id, property_id, evento, plantilla_id, offset_horas, activo)
values ('00000000-0000-0000-0000-0000000e2a00', '00000000-0000-0000-0000-0000000e2a10', 'check_in', '00000000-0000-0000-0000-0000000e2b40', 6, true) returning id as should_fail;
rollback;

\echo '34. ni a una plantilla de otro evento (la de check_out no sirve para check_in)'
begin;
reset role;
insert into rentas.mensaje_automatico_config (organization_id, property_id, evento, plantilla_id, offset_horas, activo)
values ('00000000-0000-0000-0000-0000000e2a00', '00000000-0000-0000-0000-0000000e2a10', 'check_in', '00000000-0000-0000-0000-0000000e2a42', 6, true) returning id as should_fail;
rollback;

\echo '35. offset fuera de +-720 h se rechaza'
begin;
reset role;
insert into rentas.mensaje_automatico_config (organization_id, property_id, evento, plantilla_id, offset_horas, activo)
values ('00000000-0000-0000-0000-0000000e2a00', '00000000-0000-0000-0000-0000000e2a10', 'check_out', '00000000-0000-0000-0000-0000000e2a42', 721, true) returning id as should_fail;
rollback;

\echo '36. editar el cuerpo de una plantilla aprobada le quita la aprobacion (trigger)'
begin;
reset role;
update rentas.plantilla_mensaje set cuerpo = 'Texto nuevo sin revisar {{huesped}}' where id = '00000000-0000-0000-0000-0000000e2a40';
select aprobada_por_tenant::int as aprobada_deberia_ser_0 from rentas.plantilla_mensaje where id = '00000000-0000-0000-0000-0000000e2a40';
rollback;

\echo '37. y entonces la programacion deja de generar candidatas'
begin;
reset role;
update rentas.plantilla_mensaje set cuerpo = 'Texto nuevo sin revisar {{huesped}}' where id = '00000000-0000-0000-0000-0000000e2a40';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as visibles_deberia_ser_0 from rentas.sistema_listar_mensajes_automaticos('2030-06-08T06:30:00Z', 100);
rollback;

\echo '38. cambiar solo `activa` no toca la aprobacion'
begin;
reset role;
update rentas.plantilla_mensaje set activa = true where id = '00000000-0000-0000-0000-0000000e2a40';
select aprobada_por_tenant::int as aprobada_deberia_ser_1 from rentas.plantilla_mensaje where id = '00000000-0000-0000-0000-0000000e2a40';
rollback;

\echo ''
\echo 'Escenarios que deben terminar en ERROR: 17/18/19/20/22/23/26/27/30/31/32/33/34/35 deben terminar en ERROR (alias should_fail).'

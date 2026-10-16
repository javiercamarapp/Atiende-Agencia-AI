-- Fixtures + assertions contra Postgres REAL (RLS/GRANT/auth.uid()/security definer reales -- el
-- repositorio en memoria de domain-rentas nunca los aplica) de
-- packages/domain-rentas/migrations/027_rentas_operar_tenant_nuevo.sql (Rn-18 reglas de comision de
-- canal configurables + sembrado por defecto; Rn-19 alta/edicion de propiedades, unidades y propietarios).
--
-- Qué demuestra (positivo, negativo, cross-tenant, anon):
--   A. reglas de comision: alta/edicion por admin_gestora, sembrado por defecto (trigger al crear el
--      perfil de la organizacion y bajo demanda, idempotente), validaciones (rango, ya neto => 0 pb,
--      fuente, canal), duplicado por alcance.
--   B. propiedades: alta con zona IANA real y moneda MXN/USD, edicion, nombre duplicado, moneda
--      inmutable si ya hay movimientos.
--   C. propietarios: alta/edicion, correo duplicado, propietario compartido con otra organizacion no editable.
--   D. unidades: alta/edicion, propietario de otra organizacion rechazado, nombre duplicado, rangos.
--   E. autorizacion: otra organizacion (cross-tenant), admin limitado a una property, contador,
--      solo-calendario, sesion de sistema y anon no pueden escribir; las tablas siguen sin
--      INSERT/UPDATE directo para authenticated.
--   F. definer con search_path fijo, EXECUTE revocado a public/anon, funciones internas sin EXECUTE para
--      authenticated, catalogo de entity_type de la bitacora.
--
-- Run vía scripts/verify-real-postgres-ci/run-gate.mjs (auto-descubierto en CI) o con ./run.sh. Cada
-- escenario corre en su propio `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000a1', 'rentas', 'Org A (operar tenant)', 'org-a-operar'),
  ('00000000-0000-0000-0000-0000000000a2', 'rentas', 'Org B (operar tenant, ajena)', 'org-b-operar')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'rentas', 'Casa Playa'),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a1', 'rentas', 'Casa Centro'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', 'rentas', 'Casa Ajena')
on conflict do nothing;

insert into rentas.property_config (property_id, organization_id, zona_horaria, moneda) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'America/Mexico_City', 'MXN'),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a1', 'America/Mexico_City', 'MXN'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', 'America/Cancun', 'MXN')
on conflict do nothing;

-- La Org A tiene perfil (como si se hubiera registrado): el trigger siembra sus 4 reglas por defecto.
-- La Org B NO tiene perfil: arranca sin ninguna regla (el caso de un tenant anterior a 027).
insert into rentas.organization_perfil (organization_id, tipo) values ('00000000-0000-0000-0000-0000000000a1', 'empresa_gestora') on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000011', 'admin-org-a-operar@example.com', 'Admin Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000012', 'solo-calendario-org-a-operar@example.com', 'Solo calendario Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000013', 'admin-org-b-operar@example.com', 'Admin Org B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-000000000014', 'admin-acotado-org-a-operar@example.com', 'Admin acotado Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000015', 'contador-org-a-operar@example.com', 'Contador Org A', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-0000000000a1', null, 'owner', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-0000000000a1', null, 'member', 'operador:solo_calendario'),
  ('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-0000000000a2', null, 'owner', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-0000000000a1', array['00000000-0000-0000-0000-0000000000b1']::uuid[], 'owner', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000000015', '00000000-0000-0000-0000-0000000000a1', null, 'viewer', 'contador')
on conflict do nothing;

insert into rentas.owner (id, name, email) values
  ('00000000-0000-0000-0000-0000000000f1', 'Propietaria A', 'prop-a@example.com'),
  ('00000000-0000-0000-0000-0000000000f2', 'Propietario B', 'prop-b@example.com'),
  ('00000000-0000-0000-0000-0000000000f3', 'Propietario compartido', 'prop-compartido@example.com')
on conflict do nothing;
insert into rentas.owner_organization (owner_id, organization_id) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a2'), ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a2')
on conflict do nothing;

insert into rentas.unidad (id, organization_id, property_id, owner_id, name, duracion_minima_noches) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000f1', 'Suite 1', 2),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000f2', 'Suite Ajena', 1)
on conflict do nothing;

-- Un movimiento financiero ya registrado en Casa Playa (PA1): su moneda deja de poder cambiarse.
insert into rentas.ocupacion (id, organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', daterange(current_date + 30, current_date + 34, '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true)
on conflict do nothing;
insert into rentas.reserva_financiero (organization_id, property_id, ocupacion_id, moneda, monto_bruto_centavos)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d1', 'MXN', 100000)
on conflict do nothing;

-- Ids fijos para que los escenarios de edicion no dependan de que RLS deje ver la fila al intentar localizarla.
update rentas.regla_comision_canal r set id = '00000000-0000-0000-0000-0000000000e1'
from rentas.canal c where c.id = r.canal_id and c.codigo = 'booking' and r.organization_id = '00000000-0000-0000-0000-0000000000a1' and r.property_id is null;
insert into rentas.unidad (id, organization_id, property_id, name, duracion_minima_noches)
values ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b3', 'Suite Centro', 1) on conflict do nothing;


\echo ''
\echo '=== A. reglas de comision de canal (Rn-18) ==='
\echo ''
\echo '--- 1. el trigger de rentas.organization_perfil sembro las 4 reglas globales por defecto de la Org A (airbnb ya neto, booking, vrbo, manual) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select count(*) as sembradas_deberia_ser_4 from rentas.regla_comision_canal where organization_id = '00000000-0000-0000-0000-0000000000a1' and property_id is null and fuente like 'default_sugerido%';
rollback;

\echo '--- 2. la regla sembrada de Airbnb es ya neto de comision con 0 pb ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select count(*) as airbnb_deberia_ser_1 from rentas.regla_comision_canal r join rentas.canal c on c.id = r.canal_id where r.organization_id = '00000000-0000-0000-0000-0000000000a1' and c.codigo = 'airbnb' and r.ya_neto_de_comision and r.comision_basis_points = 0;
rollback;

\echo '--- 3. el admin_gestora crea una regla de Booking ESPECIFICA de Casa Playa (2000 pb) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_regla_comision_canal('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'booking', false, 2000, 'contrato Booking 2027');
select count(*) as especifica_deberia_ser_1 from rentas.regla_comision_canal r join rentas.canal c on c.id = r.canal_id where r.organization_id = '00000000-0000-0000-0000-0000000000a1' and r.property_id = '00000000-0000-0000-0000-0000000000b1' and c.codigo = 'booking' and r.comision_basis_points = 2000;
rollback;

\echo '--- 4. la Org B (sin perfil, sin reglas) crea su regla global de Airbnb ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select rentas.crear_regla_comision_canal('00000000-0000-0000-0000-0000000000a2', null, 'airbnb', true, 0, 'confirmado por la gestora');
select count(*) as global_b_deberia_ser_1 from rentas.regla_comision_canal where organization_id = '00000000-0000-0000-0000-0000000000a2' and property_id is null;
rollback;

\echo '--- 5. el admin_gestora edita la regla global de Booking de la Org A (1800 pb, nueva fuente) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.actualizar_regla_comision_canal(r.id, false, 1800, 'contrato Booking firmado') from rentas.regla_comision_canal r join rentas.canal c on c.id = r.canal_id where r.organization_id = '00000000-0000-0000-0000-0000000000a1' and r.property_id is null and c.codigo = 'booking';
select count(*) as editada_deberia_ser_1 from rentas.regla_comision_canal r join rentas.canal c on c.id = r.canal_id where r.organization_id = '00000000-0000-0000-0000-0000000000a1' and r.property_id is null and c.codigo = 'booking' and r.comision_basis_points = 1800 and r.fuente = 'contrato Booking firmado';
rollback;

\echo '--- 6. sembrar bajo demanda en la Org B (sin reglas) crea las 4 por defecto ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select rentas.sembrar_reglas_comision_por_defecto('00000000-0000-0000-0000-0000000000a2');
select count(*) as org_b_deberia_ser_4 from rentas.regla_comision_canal where organization_id = '00000000-0000-0000-0000-0000000000a2' and property_id is null;
rollback;

\echo '--- 7. sembrar de nuevo en la Org A es idempotente: devuelve 0 y no duplica ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.sembrar_reglas_comision_por_defecto('00000000-0000-0000-0000-0000000000a1') as nuevas_deberia_ser_0;
rollback;

\echo '--- 8. duplicar el alcance (global, airbnb) de la Org A -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_regla_comision_canal('00000000-0000-0000-0000-0000000000a1', null, 'airbnb', true, 0, 'otra fuente') as should_fail;
rollback;

\echo '--- 9. comision de 10001 pb -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_regla_comision_canal('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b3', 'vrbo', false, 10001, 'fuente valida') as should_fail;
rollback;

\echo '--- 10. canal que ya entrega neto con 500 pb -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_regla_comision_canal('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b3', 'vrbo', true, 500, 'fuente valida') as should_fail;
rollback;

\echo '--- 11. fuente de 2 caracteres -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_regla_comision_canal('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b3', 'vrbo', false, 500, 'ab') as should_fail;
rollback;

\echo '--- 12. canal inexistente -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_regla_comision_canal('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b3', 'tripadvisor', false, 500, 'fuente valida') as should_fail;
rollback;

\echo '--- 13. un contador no crea reglas -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000015', true);
select rentas.crear_regla_comision_canal('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b3', 'vrbo', false, 500, 'fuente valida') as should_fail;
rollback;

\echo '--- 14. un rol de solo calendario no crea reglas -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000012', true);
select rentas.crear_regla_comision_canal('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b3', 'vrbo', false, 500, 'fuente valida') as should_fail;
rollback;

\echo '--- 15. cross-tenant: el admin de la Org B no crea una regla en la Org A -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select rentas.crear_regla_comision_canal('00000000-0000-0000-0000-0000000000a1', null, 'vrbo', false, 500, 'fuente valida') as should_fail;
rollback;

\echo '--- 16. cross-tenant: el admin de la Org A no crea una regla para una property de la Org B -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_regla_comision_canal('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', 'vrbo', false, 500, 'fuente valida') as should_fail;
rollback;

\echo '--- 17. el admin acotado a Casa Playa no crea una regla GLOBAL de la organizacion -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000014', true);
select rentas.crear_regla_comision_canal('00000000-0000-0000-0000-0000000000a1', null, 'vrbo', false, 500, 'fuente valida') as should_fail;
rollback;

\echo '--- 18. el admin acotado a Casa Playa no crea una regla para Casa Centro (fuera de su alcance) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000014', true);
select rentas.crear_regla_comision_canal('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b3', 'vrbo', false, 500, 'fuente valida') as should_fail;
rollback;

\echo '--- 19. cross-tenant: el admin de la Org B no edita una regla de la Org A (P0002) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select rentas.actualizar_regla_comision_canal('00000000-0000-0000-0000-0000000000e1', false, 100, 'fuente valida') as should_fail;
rollback;

\echo '--- 20. un contador no edita reglas -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000015', true);
select rentas.actualizar_regla_comision_canal('00000000-0000-0000-0000-0000000000e1', false, 100, 'fuente valida') as should_fail;
rollback;

\echo '--- 21. un contador no siembra las reglas por defecto -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000015', true);
select rentas.sembrar_reglas_comision_por_defecto('00000000-0000-0000-0000-0000000000a1') as should_fail;
rollback;

\echo '--- 22. cross-tenant: el admin de la Org B no siembra las reglas de la Org A -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select rentas.sembrar_reglas_comision_por_defecto('00000000-0000-0000-0000-0000000000a1') as should_fail;
rollback;

\echo '--- 23. la sesion de sistema (sin auth.uid) no crea reglas -- RECHAZADO ---'
begin;
set local role authenticated;
select rentas.crear_regla_comision_canal('00000000-0000-0000-0000-0000000000a1', null, 'vrbo', false, 500, 'fuente valida') as should_fail;
rollback;

\echo '--- 24. anon no ejecuta la funcion -- RECHAZADO ---'
begin;
set local role anon;
select rentas.crear_regla_comision_canal('00000000-0000-0000-0000-0000000000a1', null, 'vrbo', false, 500, 'fuente valida') as should_fail;
rollback;

\echo '--- 25. INSERT directo en rentas.regla_comision_canal: authenticated sigue sin escritura -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
with x as (insert into rentas.regla_comision_canal (organization_id, canal_id, fuente) select '00000000-0000-0000-0000-0000000000a1', id, 'directo' from rentas.canal limit 1 returning 1) select 1 as should_fail;
rollback;

\echo '--- 26. UPDATE directo en rentas.regla_comision_canal: authenticated sigue sin escritura -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
with x as (update rentas.regla_comision_canal set comision_basis_points = 1 where organization_id = '00000000-0000-0000-0000-0000000000a1' returning 1) select 1 as should_fail;
rollback;


\echo ''
\echo '=== B. propiedades (Rn-19) ==='
\echo ''
\echo '--- 27. el admin_gestora crea una propiedad con zona IANA y moneda USD; queda su configuracion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_propiedad('00000000-0000-0000-0000-0000000000a1', 'Casa Nueva', 'America/Cancun', 'USD');
select count(*) as nueva_deberia_ser_1 from core.property p join rentas.property_config c on c.property_id = p.id where p.organization_id = '00000000-0000-0000-0000-0000000000a1' and p.name = 'Casa Nueva' and p.status = 'active' and c.zona_horaria = 'America/Cancun' and c.moneda = 'USD';
rollback;

\echo '--- 28. la Org B (sin reglas) crea una propiedad: sus reglas por defecto quedan sembradas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select rentas.crear_propiedad('00000000-0000-0000-0000-0000000000a2', 'Casa B2', 'America/Mexico_City', 'MXN');
select count(*) as reglas_b_deberia_ser_4 from rentas.regla_comision_canal where organization_id = '00000000-0000-0000-0000-0000000000a2' and property_id is null;
rollback;

\echo '--- 29. zona horaria que no existe en el catalogo IANA -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_propiedad('00000000-0000-0000-0000-0000000000a1', 'Casa Zona', 'Marte/Olimpo', 'MXN') as should_fail;
rollback;

\echo '--- 30. moneda EUR (solo MXN/USD) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_propiedad('00000000-0000-0000-0000-0000000000a1', 'Casa Euro', 'America/Mexico_City', 'EUR') as should_fail;
rollback;

\echo '--- 31. nombre duplicado en la organizacion, sin distinguir mayusculas -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_propiedad('00000000-0000-0000-0000-0000000000a1', 'casa PLAYA', 'America/Mexico_City', 'MXN') as should_fail;
rollback;

\echo '--- 32. nombre de 1 caracter -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_propiedad('00000000-0000-0000-0000-0000000000a1', 'X', 'America/Mexico_City', 'MXN') as should_fail;
rollback;

\echo '--- 33. el admin acotado a una property no crea propiedades nuevas -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000014', true);
select rentas.crear_propiedad('00000000-0000-0000-0000-0000000000a1', 'Casa Acotada', 'America/Mexico_City', 'MXN') as should_fail;
rollback;

\echo '--- 34. un contador no crea propiedades -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000015', true);
select rentas.crear_propiedad('00000000-0000-0000-0000-0000000000a1', 'Casa Contador', 'America/Mexico_City', 'MXN') as should_fail;
rollback;

\echo '--- 35. cross-tenant: el admin de la Org B no crea una propiedad en la Org A -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select rentas.crear_propiedad('00000000-0000-0000-0000-0000000000a1', 'Casa Intrusa', 'America/Mexico_City', 'MXN') as should_fail;
rollback;

\echo '--- 36. anon no crea propiedades -- RECHAZADO ---'
begin;
set local role anon;
select rentas.crear_propiedad('00000000-0000-0000-0000-0000000000a1', 'Casa Anon', 'America/Mexico_City', 'MXN') as should_fail;
rollback;

\echo '--- 37. la sesion de sistema no crea propiedades -- RECHAZADO ---'
begin;
set local role authenticated;
select rentas.crear_propiedad('00000000-0000-0000-0000-0000000000a1', 'Casa Sistema', 'America/Mexico_City', 'MXN') as should_fail;
rollback;

\echo '--- 38. el admin_gestora edita nombre y zona horaria de Casa Centro (sin movimientos: moneda editable) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.actualizar_propiedad('00000000-0000-0000-0000-0000000000b3', 'Casa Centro Renovada', 'America/Tijuana', 'USD');
select count(*) as editada_deberia_ser_1 from core.property p join rentas.property_config c on c.property_id = p.id where p.id = '00000000-0000-0000-0000-0000000000b3' and p.name = 'Casa Centro Renovada' and c.zona_horaria = 'America/Tijuana' and c.moneda = 'USD';
rollback;

\echo '--- 39. D-DSD-07: cambiar la zona horaria de Casa Playa con una reserva vigente (fin >= hoy) -- RECHAZADO (55000) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.actualizar_propiedad('00000000-0000-0000-0000-0000000000b1', null, 'America/Merida', null) as should_fail;
rollback;

\echo '--- 39b. reenviar la MISMA zona (y cambiar solo el nombre) con una reserva vigente funciona: no es un cambio de zona ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.actualizar_propiedad('00000000-0000-0000-0000-0000000000b1', 'Casa Playa Mar', 'America/Mexico_City', null);
select count(*) as misma_zona_deberia_ser_1 from rentas.property_config where property_id = '00000000-0000-0000-0000-0000000000b1' and zona_horaria = 'America/Mexico_City' and moneda = 'MXN';
rollback;

\echo '--- 39c. cancelada la unica reserva, la zona de Casa Playa SI se puede cambiar y se conserva la moneda ---'
begin;
update rentas.ocupacion set estado = 'cancelado' where id = '00000000-0000-0000-0000-0000000000d1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.actualizar_propiedad('00000000-0000-0000-0000-0000000000b1', null, 'America/Merida', null);
select count(*) as zona_deberia_ser_1 from rentas.property_config where property_id = '00000000-0000-0000-0000-0000000000b1' and zona_horaria = 'America/Merida' and moneda = 'MXN';
rollback;

\echo '--- 39d. una ocupacion ya terminada (fin < hoy) no bloquea el cambio de zona ---'
begin;
insert into rentas.ocupacion (organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000c3', daterange(current_date - 10, current_date - 5, '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.actualizar_propiedad('00000000-0000-0000-0000-0000000000b3', null, 'America/Tijuana', null);
select count(*) as pasada_deberia_ser_1 from rentas.property_config where property_id = '00000000-0000-0000-0000-0000000000b3' and zona_horaria = 'America/Tijuana';
rollback;

\echo '--- 39e. un BLOQUEO vigente tambien impide cambiar la zona -- RECHAZADO (55000) ---'
begin;
insert into rentas.ocupacion (organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000c3', daterange(current_date + 2, current_date + 4, '[)'), 'bloqueo', 'MANTENIMIENTO', 'confirmado', true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.actualizar_propiedad('00000000-0000-0000-0000-0000000000b3', null, 'America/Tijuana', null) as should_fail;
rollback;

\echo '--- 40. cambiar la moneda de una propiedad con movimientos financieros (55000) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.actualizar_propiedad('00000000-0000-0000-0000-0000000000b1', null, null, 'USD') as should_fail;
rollback;

\echo '--- 41. zona horaria invalida al editar -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.actualizar_propiedad('00000000-0000-0000-0000-0000000000b3', null, 'No/Existe', null) as should_fail;
rollback;

\echo '--- 42. renombrar a un nombre que ya usa otra propiedad de la organizacion -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.actualizar_propiedad('00000000-0000-0000-0000-0000000000b3', 'Casa Playa', null, null) as should_fail;
rollback;

\echo '--- 43. cross-tenant: el admin de la Org B no edita una propiedad de la Org A (P0002) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select rentas.actualizar_propiedad('00000000-0000-0000-0000-0000000000b1', 'Hackeada', null, null) as should_fail;
rollback;

\echo '--- 44. el admin acotado a Casa Playa no edita Casa Centro (fuera de su alcance) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000014', true);
select rentas.actualizar_propiedad('00000000-0000-0000-0000-0000000000b3', 'Otra', null, null) as should_fail;
rollback;

\echo '--- 45. el admin acotado a Casa Playa si edita Casa Playa ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000014', true);
select rentas.actualizar_propiedad('00000000-0000-0000-0000-0000000000b1', 'Casa Playa Norte', null, null);
select count(*) as acotado_deberia_ser_1 from core.property where id = '00000000-0000-0000-0000-0000000000b1' and name = 'Casa Playa Norte';
rollback;

\echo '--- 46. un contador no edita propiedades -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000015', true);
select rentas.actualizar_propiedad('00000000-0000-0000-0000-0000000000b1', 'Contador', null, null) as should_fail;
rollback;

\echo '--- 47. UPDATE directo de core.property: authenticated sigue sin escritura -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
with x as (update core.property set name = 'directo' where id = '00000000-0000-0000-0000-0000000000b1' returning 1) select 1 as should_fail;
rollback;


\echo ''
\echo '=== C. propietarios (Rn-19) ==='
\echo ''
\echo '--- 48. el admin_gestora crea un propietario con correo; queda vinculado a su organizacion y en minusculas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_propietario('00000000-0000-0000-0000-0000000000a1', 'Nuevo Propietario', 'Nuevo.Prop@Example.com');
select count(*) as nuevo_deberia_ser_1 from rentas.owner o join rentas.owner_organization oo on oo.owner_id = o.id where oo.organization_id = '00000000-0000-0000-0000-0000000000a1' and o.name = 'Nuevo Propietario' and o.email = 'nuevo.prop@example.com';
rollback;

\echo '--- 49. un propietario sin correo es valido ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_propietario('00000000-0000-0000-0000-0000000000a1', 'Sin Correo', null);
select count(*) as sin_correo_deberia_ser_1 from rentas.owner o join rentas.owner_organization oo on oo.owner_id = o.id where oo.organization_id = '00000000-0000-0000-0000-0000000000a1' and o.name = 'Sin Correo' and o.email is null;
rollback;

\echo '--- 50. nombre de 1 caracter -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_propietario('00000000-0000-0000-0000-0000000000a1', 'X', null) as should_fail;
rollback;

\echo '--- 51. correo sin arroba -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_propietario('00000000-0000-0000-0000-0000000000a1', 'Mal Correo', 'no-es-correo') as should_fail;
rollback;

\echo '--- 52. correo ya usado por otro propietario de la misma organizacion -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_propietario('00000000-0000-0000-0000-0000000000a1', 'Duplicada', 'PROP-A@example.com') as should_fail;
rollback;

\echo '--- 53. un contador no crea propietarios -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000015', true);
select rentas.crear_propietario('00000000-0000-0000-0000-0000000000a1', 'Contador Prop', null) as should_fail;
rollback;

\echo '--- 54. el admin acotado no crea propietarios (recurso de la organizacion) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000014', true);
select rentas.crear_propietario('00000000-0000-0000-0000-0000000000a1', 'Acotado Prop', null) as should_fail;
rollback;

\echo '--- 55. cross-tenant: el admin de la Org B no crea un propietario en la Org A -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select rentas.crear_propietario('00000000-0000-0000-0000-0000000000a1', 'Intruso', null) as should_fail;
rollback;

\echo '--- 56. anon no crea propietarios -- RECHAZADO ---'
begin;
set local role anon;
select rentas.crear_propietario('00000000-0000-0000-0000-0000000000a1', 'Anon Prop', null) as should_fail;
rollback;

\echo '--- 57. el admin_gestora edita nombre y correo de su propietario ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.actualizar_propietario('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', 'Propietaria A Editada', 'nueva-a@example.com');
select count(*) as editado_deberia_ser_1 from rentas.owner where id = '00000000-0000-0000-0000-0000000000f1' and name = 'Propietaria A Editada' and email = 'nueva-a@example.com';
rollback;

\echo '--- 58. quitar el correo de un propietario ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.actualizar_propietario('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', null, null, true);
select count(*) as sin_correo_deberia_ser_1 from rentas.owner where id = '00000000-0000-0000-0000-0000000000f1' and email is null and name = 'Propietaria A';
rollback;

\echo '--- 59. un propietario compartido con otra organizacion no se edita desde aqui (42501) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.actualizar_propietario('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f3', 'Cambiado', null) as should_fail;
rollback;

\echo '--- 60. cross-tenant: el admin de la Org A no edita un propietario de la Org B (P0002) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.actualizar_propietario('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f2', 'Cambiado', null) as should_fail;
rollback;

\echo '--- 61. cross-tenant: el admin de la Org B no edita un propietario de la Org A pasando SU organizacion (P0002) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select rentas.actualizar_propietario('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000f1', 'Cambiado', null) as should_fail;
rollback;

\echo '--- 62. cross-tenant: el admin de la Org B no edita un propietario de la Org A pasando la organizacion de A (42501) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select rentas.actualizar_propietario('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', 'Cambiado', null) as should_fail;
rollback;

\echo '--- 63. un contador no edita propietarios -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000015', true);
select rentas.actualizar_propietario('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', 'Cambiado', null) as should_fail;
rollback;

\echo '--- 64. correo ya usado por otro propietario al editar -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.actualizar_propietario('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', null, 'prop-compartido@example.com') as should_fail;
rollback;

\echo '--- 65. INSERT directo en rentas.owner: authenticated sigue sin escritura -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
with x as (insert into rentas.owner (name) values ('directo') returning 1) select 1 as should_fail;
rollback;


\echo ''
\echo '=== D. unidades (Rn-19) ==='
\echo ''
\echo '--- 66. el admin_gestora crea una unidad en Casa Playa con propietario y estancia minima 3 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_unidad('00000000-0000-0000-0000-0000000000b1', 'Suite 2', '00000000-0000-0000-0000-0000000000f1', 3);
select count(*) as nueva_deberia_ser_1 from rentas.unidad where property_id = '00000000-0000-0000-0000-0000000000b1' and organization_id = '00000000-0000-0000-0000-0000000000a1' and name = 'Suite 2' and owner_id = '00000000-0000-0000-0000-0000000000f1' and duracion_minima_noches = 3;
rollback;

\echo '--- 67. una unidad sin propietario es valida ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_unidad('00000000-0000-0000-0000-0000000000b1', 'Suite Libre', null, 1);
select count(*) as libre_deberia_ser_1 from rentas.unidad where property_id = '00000000-0000-0000-0000-0000000000b1' and name = 'Suite Libre' and owner_id is null;
rollback;

\echo '--- 68. cross-tenant: asignar el propietario de la Org B a una unidad de la Org A -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_unidad('00000000-0000-0000-0000-0000000000b1', 'Suite Mal', '00000000-0000-0000-0000-0000000000f2', 1) as should_fail;
rollback;

\echo '--- 69. nombre de unidad duplicado dentro de la property -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_unidad('00000000-0000-0000-0000-0000000000b1', 'Suite 1', null, 1) as should_fail;
rollback;

\echo '--- 70. estancia minima 0 -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_unidad('00000000-0000-0000-0000-0000000000b1', 'Suite Cero', null, 0) as should_fail;
rollback;

\echo '--- 71. estancia minima 366 -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_unidad('00000000-0000-0000-0000-0000000000b1', 'Suite Larga', null, 366) as should_fail;
rollback;

\echo '--- 72. cross-tenant: el admin de la Org A no crea unidades en una property de la Org B -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.crear_unidad('00000000-0000-0000-0000-0000000000b2', 'Suite Intrusa', null, 1) as should_fail;
rollback;

\echo '--- 73. el admin acotado a Casa Playa no crea unidades en Casa Centro -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000014', true);
select rentas.crear_unidad('00000000-0000-0000-0000-0000000000b3', 'Suite Fuera', null, 1) as should_fail;
rollback;

\echo '--- 74. el admin acotado a Casa Playa si crea unidades en Casa Playa ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000014', true);
select rentas.crear_unidad('00000000-0000-0000-0000-0000000000b1', 'Suite Acotada', null, 1);
select count(*) as acotada_deberia_ser_1 from rentas.unidad where property_id = '00000000-0000-0000-0000-0000000000b1' and name = 'Suite Acotada';
rollback;

\echo '--- 75. un contador no crea unidades -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000015', true);
select rentas.crear_unidad('00000000-0000-0000-0000-0000000000b1', 'Suite Contador', null, 1) as should_fail;
rollback;

\echo '--- 76. anon no crea unidades -- RECHAZADO ---'
begin;
set local role anon;
select rentas.crear_unidad('00000000-0000-0000-0000-0000000000b1', 'Suite Anon', null, 1) as should_fail;
rollback;

\echo '--- 77. el admin_gestora edita nombre, propietario y estancia minima de una unidad ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.actualizar_unidad('00000000-0000-0000-0000-0000000000c1', 'Suite Principal', '00000000-0000-0000-0000-0000000000f3', false, 4);
select count(*) as editada_deberia_ser_1 from rentas.unidad where id = '00000000-0000-0000-0000-0000000000c1' and name = 'Suite Principal' and owner_id = '00000000-0000-0000-0000-0000000000f3' and duracion_minima_noches = 4;
rollback;

\echo '--- 78. quitar el propietario de una unidad ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.actualizar_unidad('00000000-0000-0000-0000-0000000000c1', null, null, true, null);
select count(*) as sin_prop_deberia_ser_1 from rentas.unidad where id = '00000000-0000-0000-0000-0000000000c1' and owner_id is null and name = 'Suite 1' and duracion_minima_noches = 2;
rollback;

\echo '--- 79. cross-tenant: el admin de la Org B no edita una unidad de la Org A (P0002) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select rentas.actualizar_unidad('00000000-0000-0000-0000-0000000000c1', 'Hackeada', null, false, null) as should_fail;
rollback;

\echo '--- 80. cross-tenant: asignar a una unidad de la Org A el propietario de la Org B al editar -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.actualizar_unidad('00000000-0000-0000-0000-0000000000c1', null, '00000000-0000-0000-0000-0000000000f2', false, null) as should_fail;
rollback;

\echo '--- 81. el admin acotado a Casa Playa no edita una unidad de Casa Centro (fuera de su alcance) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000014', true);
select rentas.actualizar_unidad('00000000-0000-0000-0000-0000000000c3', 'Fuera', null, false, null) as should_fail;
rollback;

\echo '--- 82. un contador no edita unidades -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000015', true);
select rentas.actualizar_unidad('00000000-0000-0000-0000-0000000000c1', 'Contador', null, false, null) as should_fail;
rollback;

\echo '--- 83. UPDATE directo en rentas.unidad: authenticated sigue sin escritura -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
with x as (update rentas.unidad set name = 'directo' where id = '00000000-0000-0000-0000-0000000000c1' returning 1) select 1 as should_fail;
rollback;


\echo ''
\echo '=== E. definer, EXECUTE y bitacora ==='
\echo ''
\echo '--- 84. las 12 funciones nuevas son security definer con search_path fijo ---'
begin;
set local role authenticated;
select count(*) as definer_deberia_ser_12 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'rentas' and p.proname in ('es_admin_gestora','sembrar_reglas_comision_base','organization_perfil_sembrar_reglas','sembrar_reglas_comision_por_defecto','crear_regla_comision_canal','actualizar_regla_comision_canal','crear_propiedad','actualizar_propiedad','crear_propietario','actualizar_propietario','crear_unidad','actualizar_unidad') and p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=pg_catalog, rentas, core, pg_temp%' or c like 'search_path=pg_catalog, core, pg_temp%');
rollback;

\echo '--- 85. ninguna de las 12 es ejecutable por PUBLIC ---'
begin;
set local role authenticated;
select count(*) as public_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'rentas' and p.proname in ('es_admin_gestora','sembrar_reglas_comision_base','organization_perfil_sembrar_reglas','sembrar_reglas_comision_por_defecto','crear_regla_comision_canal','actualizar_regla_comision_canal','crear_propiedad','actualizar_propiedad','crear_propietario','actualizar_propietario','crear_unidad','actualizar_unidad') and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE');
rollback;

\echo '--- 86. ninguna de las 12 es ejecutable por anon ---'
begin;
set local role authenticated;
select count(*) as anon_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'rentas' and p.proname in ('es_admin_gestora','sembrar_reglas_comision_base','organization_perfil_sembrar_reglas','sembrar_reglas_comision_por_defecto','crear_regla_comision_canal','actualizar_regla_comision_canal','crear_propiedad','actualizar_propiedad','crear_propietario','actualizar_propietario','crear_unidad','actualizar_unidad') and has_function_privilege('anon', p.oid, 'execute');
rollback;

\echo '--- 87. las 3 funciones internas (guard, sembrado base, trigger) no son ejecutables por authenticated ---'
begin;
set local role authenticated;
select count(*) as internas_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'rentas' and p.proname in ('es_admin_gestora','sembrar_reglas_comision_base','organization_perfil_sembrar_reglas') and has_function_privilege('authenticated', p.oid, 'execute');
rollback;

\echo '--- 88. las 9 funciones publicas si son ejecutables por authenticated ---'
begin;
set local role authenticated;
select count(*) as publicas_deberia_ser_9 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'rentas' and p.proname in ('es_admin_gestora','sembrar_reglas_comision_base','organization_perfil_sembrar_reglas','sembrar_reglas_comision_por_defecto','crear_regla_comision_canal','actualizar_regla_comision_canal','crear_propiedad','actualizar_propiedad','crear_propietario','actualizar_propietario','crear_unidad','actualizar_unidad') and has_function_privilege('authenticated', p.oid, 'execute');
rollback;

\echo '--- 89. la bitacora acepta los entity_type nuevos (propiedad, unidad, propietario, regla_comision) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.record_audit_log('00000000-0000-0000-0000-0000000000a1', 'propiedad.creada', 'propiedad', '00000000-0000-0000-0000-0000000000b1', 'nombre', null, 'Casa Playa');
select rentas.record_audit_log('00000000-0000-0000-0000-0000000000a1', 'unidad.creada', 'unidad', '00000000-0000-0000-0000-0000000000c1', 'nombre', null, 'Suite 1');
select rentas.record_audit_log('00000000-0000-0000-0000-0000000000a1', 'propietario.creado', 'propietario', '00000000-0000-0000-0000-0000000000f1', 'nombre', null, 'Propietaria A');
select rentas.record_audit_log('00000000-0000-0000-0000-0000000000a1', 'regla_comision.creada', 'regla_comision', null, 'bps', null, '1500');
select count(*) as bitacora_deberia_ser_4 from rentas.audit_log where organization_id = '00000000-0000-0000-0000-0000000000a1' and entity_type in ('propiedad','unidad','propietario','regla_comision');
rollback;

\echo '--- 90. la bitacora sigue rechazando un entity_type fuera de catalogo -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.record_audit_log('00000000-0000-0000-0000-0000000000a1', 'x.y', 'inventado', null, null, null, null) as should_fail;
rollback;

\echo '--- 91. la bitacora sigue rechazando a un rol sin techo minimo (solo calendario) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000012', true);
select rentas.record_audit_log('00000000-0000-0000-0000-0000000000a1', 'propiedad.creada', 'propiedad', null, null, null, null) as should_fail;
rollback;


\echo ''
\echo 'listo -- los escenarios marcados RECHAZADO (should_fail) deben terminar en ERROR y los de valor (deberia_ser_N) en el N indicado.'

-- Stripe por plan, uso reportado, cobranza y cola de CFDI (packages/db/migrations/0106) contra Postgres REAL.
-- Alias `should_fail` = debe terminar en ERROR; `_deberia_ser_N` = valor esperado. Datos ficticios.
-- Sujetos: c401 owner de A, c402 owner de B, c403 superadmin. Organizaciones A y B (restaurantes).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, timezone) values
  ('00000000-0000-0000-0000-00000000b401', 'restaurantes', 'Resto A st', 'resto-a-st', 'America/Merida'),
  ('00000000-0000-0000-0000-00000000b402', 'restaurantes', 'Resto B st', 'resto-b-st', 'America/Merida')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-00000000c401', 'st-owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-00000000c402', 'st-owner-b@example.com', 'Owner B', 'seed'),
  ('00000000-0000-0000-0000-00000000c403', 'st-super@example.com', 'Super', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-00000000c401', '00000000-0000-0000-0000-00000000b401', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-00000000c402', '00000000-0000-0000-0000-00000000b402', null, 'owner', 'owner')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-00000000c403') on conflict do nothing;
insert into core.organization_plan (organization_id, plan_id) values ('00000000-0000-0000-0000-00000000b401', 'restaurantes-pro') on conflict do nothing;

\echo '1. el superadmin fija el precio de Stripe de la sucursal del plan Pro'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c403', true);
select core.superadmin_set_plan_stripe_precio('00000000-0000-0000-0000-00000000c403', 'restaurantes-pro', 'sucursal', 'price_ABCDEFGH1234', null);
select count(*)::int as precio_deberia_ser_1 from jsonb_array_elements(core.plan_stripe_precios_para_org('00000000-0000-0000-0000-00000000c403', '00000000-0000-0000-0000-00000000b401')->'precios');
rollback;

\echo '2. un precio medido sin meter se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c403', true);
select core.superadmin_set_plan_stripe_precio('00000000-0000-0000-0000-00000000c403', 'restaurantes-pro', 'minuto_voz_excedente', 'price_ABCDEFGH1234', null) as should_fail;
rollback;

\echo '3. un id que no es de precio de Stripe se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c403', true);
select core.superadmin_set_plan_stripe_precio('00000000-0000-0000-0000-00000000c403', 'restaurantes-pro', 'sucursal', 'prod_XYZ', null) as should_fail;
rollback;

\echo '4. un owner no fija precios de Stripe'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c401', true);
select core.superadmin_set_plan_stripe_precio('00000000-0000-0000-0000-00000000c401', 'restaurantes-pro', 'sucursal', 'price_ABCDEFGH1234', null) as should_fail;
rollback;

\echo '5. el owner de B no ve los precios del plan de A (null)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c402', true);
select (core.plan_stripe_precios_para_org('00000000-0000-0000-0000-00000000c402', '00000000-0000-0000-0000-00000000b401') is null)::int as cruzado_null_deberia_ser_1;
rollback;

\echo '6. uso reportado: el primer reporte manda todo; el segundo, solo la diferencia'
begin;
select core.cobro_uso_reportar('00000000-0000-0000-0000-00000000b401', '2026-11-05', 'minuto_voz', 100);
select core.cobro_uso_reportar('00000000-0000-0000-0000-00000000b401', '2026-11-20', 'minuto_voz', 130)::int as delta_deberia_ser_30;
rollback;

\echo '7. uso reportado: un total menor no devuelve nada (0)'
begin;
select core.cobro_uso_reportar('00000000-0000-0000-0000-00000000b401', '2026-11-05', 'minuto_voz', 100);
select core.cobro_uso_reportar('00000000-0000-0000-0000-00000000b401', '2026-11-06', 'minuto_voz', 90)::int as delta_deberia_ser_0;
rollback;

\echo '8. uso reportado: un usuario (aun superadmin) no puede reportar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c403', true);
select core.cobro_uso_reportar('00000000-0000-0000-0000-00000000b401', '2026-11-05', 'minuto_voz', 100) as should_fail;
rollback;

\echo '9. cobranza: el primer pago fallido deja la cuenta en aviso'
begin;
select core.cobranza_registrar_evento('00000000-0000-0000-0000-00000000b401', 'pago_fallido', 'in_ABCDEFGH1234', 1, 3480000)->>'nuevo' = 'aviso' as x;
select (estado = 'aviso')::int as aviso_deberia_ser_1 from core.cobranza_estado where organization_id = '00000000-0000-0000-0000-00000000b401';
rollback;

\echo '10. cobranza: el tercer fallo sugiere pausa (no pausa nada)'
begin;
select core.cobranza_registrar_evento('00000000-0000-0000-0000-00000000b401', 'pago_fallido', 'in_ABCDEFGH1234', 1, 100);
select core.cobranza_registrar_evento('00000000-0000-0000-0000-00000000b401', 'pago_fallido', 'in_ABCDEFGH1234', 2, 100);
select core.cobranza_registrar_evento('00000000-0000-0000-0000-00000000b401', 'pago_fallido', 'in_ABCDEFGH1234', 3, 100);
select (estado = 'pausa_sugerida' and (select status from core.organization where id = '00000000-0000-0000-0000-00000000b401') <> 'suspended')::int as sugerida_sin_pausar_deberia_ser_1 from core.cobranza_estado where organization_id = '00000000-0000-0000-0000-00000000b401';
rollback;

\echo '11. cobranza: el pago deja la cuenta al corriente'
begin;
select core.cobranza_registrar_evento('00000000-0000-0000-0000-00000000b401', 'pago_fallido', 'in_ABCDEFGH1234', 1, 100);
select core.cobranza_registrar_evento('00000000-0000-0000-0000-00000000b401', 'pagada', 'in_ABCDEFGH1234', null, null);
select (estado = 'al_corriente' and intentos_fallidos = 0)::int as al_corriente_deberia_ser_1 from core.cobranza_estado where organization_id = '00000000-0000-0000-0000-00000000b401';
rollback;

\echo '12. cobranza: un usuario no registra eventos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c401', true);
select core.cobranza_registrar_evento('00000000-0000-0000-0000-00000000b401', 'pagada', null, null, null) as should_fail;
rollback;

\echo '13. cobranza: el owner de B no ve la cobranza de A (null)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c402', true);
select (core.cobranza_de_organizacion('00000000-0000-0000-0000-00000000c402', '00000000-0000-0000-0000-00000000b401') is null)::int as cruzado_null_deberia_ser_1;
rollback;

\echo '14. CFDI: una factura pagada se encola una sola vez'
begin;
select core.cfdi_suscripcion_encolar('00000000-0000-0000-0000-00000000b401', 'in_ABCDEFGH1234', 3000000, 480000, null);
select core.cfdi_suscripcion_encolar('00000000-0000-0000-0000-00000000b401', 'in_ABCDEFGH1234', 3000000, 480000, null)::int as repetida_deberia_ser_0;
rollback;

\echo '15. CFDI: queda pendiente de PAC (nada se timbra sin credenciales)'
begin;
select core.cfdi_suscripcion_encolar('00000000-0000-0000-0000-00000000b401', 'in_ABCDEFGH1234', 3000000, 480000, null);
select count(*)::int as pendiente_deberia_ser_1 from core.cfdi_suscripcion_solicitud where estado = 'pendiente_pac';
rollback;

\echo '16. CFDI: un usuario no encola'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c403', true);
select core.cfdi_suscripcion_encolar('00000000-0000-0000-0000-00000000b401', 'in_ABCDEFGH1234', 1, 0, null) as should_fail;
rollback;

\echo '17. CFDI: un owner no lista pendientes (0 filas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c401', true);
select count(*)::int as owner_no_lista_deberia_ser_0 from core.cfdi_suscripcion_pendientes('00000000-0000-0000-0000-00000000c401');
rollback;

\echo '18. anon no lee precios de Stripe'
begin;
set local role anon;
select core.plan_stripe_precios_para_org(null, '00000000-0000-0000-0000-00000000b401') as should_fail;
rollback;

\echo 'los escenarios 2/3/4/8/12/16/18 deben terminar en ERROR'

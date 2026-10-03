-- SA-L-37/38/41 (migracion 0049) -- verificacion contra Postgres REAL del modelo de datos del Cerebro de ventas.
-- Cada escenario corre en su propio `begin; ... rollback;`. Alias `should_fail` = debe terminar en ERROR;
-- alias `..._deberia_ser_N` = el ultimo valor (entero) esperado (ver scripts/verify-real-postgres-ci/run-gate.mjs).
-- Sesion de usuario real = rol authenticated con request.jwt.claim.sub = su id. Datos ficticios.
\set ON_ERROR_STOP off
\pset pager off

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f7a01', 'owner-cer-a@example.com', 'Owner Cerebro', 'seed'),
  ('00000000-0000-0000-0000-0000000f7c00', 'sa-cer@example.com', 'Superadmin Cerebro', 'seed'),
  ('00000000-0000-0000-0000-0000000f7c01', 'sa2-cer@example.com', 'Superadmin Cerebro 2', 'seed'),
  ('00000000-0000-0000-0000-0000000f7c02', 'sa-fin-cer@example.com', 'Superadmin Finanzas', 'seed')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values
  ('00000000-0000-0000-0000-0000000f7c00'), ('00000000-0000-0000-0000-0000000f7c01'), ('00000000-0000-0000-0000-0000000f7c02')
on conflict do nothing;
insert into core.cfo_zone_role (staff_user_id, rol, reason) values ('00000000-0000-0000-0000-0000000f7c02', 'finanzas', 'Rol restringido de prueba para la verificacion');
-- Prospecto de ejemplo (sin datos de contacto) y uno con base de licitud.
insert into core.prospecto (id, empresa, vertical, estado) values
  ('00000000-0000-0000-0000-0000000f7d01', 'Taqueria Ficticia', 'restaurantes', 'nuevo');
insert into core.prospecto (id, empresa, vertical, estado, telefono, base_licitud, consentimiento_en) values
  ('00000000-0000-0000-0000-0000000f7d02', 'Hotel Ficticio', 'hoteles', 'nuevo', '5555550100', 'interes_declarado', now());

\echo '=== MODELO: CHECKs de core.prospecto ==='
\echo '1. con telefono y sin base de licitud NO se inserta (CHECK, la fila no es legado)'
begin;
insert into core.prospecto (empresa, vertical, telefono) values ('Sin base', 'citas', '5555550101') returning 1 as should_fail;
rollback;

\echo '1b. con base fuente_publica_b2b y telefono SI se inserta'
begin;
insert into core.prospecto (empresa, vertical, telefono, base_licitud) values ('Con base', 'citas', '5555550101', 'fuente_publica_b2b');
select count(*)::int as filas_deberia_ser_1 from core.prospecto where empresa = 'Con base';
rollback;

\echo '1c. sin datos de contacto y sin base SI se inserta'
begin;
insert into core.prospecto (empresa, vertical) values ('Solo empresa', 'citas');
select count(*)::int as filas_deberia_ser_1 from core.prospecto where empresa = 'Solo empresa';
rollback;

\echo '2. interes_declarado sin consentimiento_en NO se guarda'
begin;
insert into core.prospecto (empresa, vertical, base_licitud) values ('Sin fecha', 'citas', 'interes_declarado') returning 1 as should_fail;
rollback;

\echo '3. base de licitud fuera del catalogo NO se guarda'
begin;
insert into core.prospecto (empresa, vertical, base_licitud) values ('Base rara', 'citas', 'por_default') returning 1 as should_fail;
rollback;

\echo '4. un score fuera de 0-100 NO se guarda'
begin;
update core.prospecto set score_ajuste = 101 where id = '00000000-0000-0000-0000-0000000f7d01' returning 1 as should_fail;
rollback;

\echo '5. latitud sin longitud NO se guarda'
begin;
update core.prospecto set lat = 19.4 where id = '00000000-0000-0000-0000-0000000f7d01' returning 1 as should_fail;
rollback;

\echo '6. un prospecto no puede ser duplicado de si mismo'
begin;
update core.prospecto set duplicado_de = id where id = '00000000-0000-0000-0000-0000000f7d01' returning 1 as should_fail;
rollback;

\echo '7. senales debe ser un arreglo json'
begin;
update core.prospecto set senales = '{"tipo":"x"}'::jsonb where id = '00000000-0000-0000-0000-0000000f7d01' returning 1 as should_fail;
rollback;

\echo '=== PERSONA DE CONTACTO: evidencia obligatoria, nada deducido por patron ==='
\echo '8. el superadmin agrega una persona con evidencia y origen verificable'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.add_prospecto_persona_for_superadmin('00000000-0000-0000-0000-0000000f7c00', '00000000-0000-0000-0000-0000000f7d02', 'Ana Ficticia', 'Gerente', 'correo', 'ana@example.com', 'sitio_web_oficial', 'alta', 'https://example.com/equipo');
reset role;
select count(*)::int as personas_deberia_ser_1 from core.prospecto_contacto_persona where prospecto_id = '00000000-0000-0000-0000-0000000f7d02';
rollback;

\echo '8b. sin evidencia_url se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.add_prospecto_persona_for_superadmin('00000000-0000-0000-0000-0000000f7c00', '00000000-0000-0000-0000-0000000f7d02', 'Ana Ficticia', 'Gerente', 'correo', 'ana@example.com', 'sitio_web_oficial', 'alta', '') as should_fail;
rollback;

\echo '8c. evidencia que no es una URL se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.add_prospecto_persona_for_superadmin('00000000-0000-0000-0000-0000000f7c00', '00000000-0000-0000-0000-0000000f7d02', 'Ana Ficticia', 'Gerente', 'correo', 'ana@example.com', 'sitio_web_oficial', 'alta', 'lo vi por ahi') as should_fail;
rollback;

\echo '8d. un origen deducido por patron NO existe en la lista cerrada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.add_prospecto_persona_for_superadmin('00000000-0000-0000-0000-0000000f7c00', '00000000-0000-0000-0000-0000000f7d02', 'Ana Ficticia', 'Gerente', 'correo', 'ana.ficticia@example.com', 'patron', 'baja', 'https://example.com/equipo') as should_fail;
rollback;

\echo '8e. un correo con forma invalida se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.add_prospecto_persona_for_superadmin('00000000-0000-0000-0000-0000000f7c00', '00000000-0000-0000-0000-0000000f7d02', 'Ana Ficticia', 'Gerente', 'correo', 'ana-sin-arroba', 'sitio_web_oficial', 'alta', 'https://example.com/equipo') as should_fail;
rollback;

\echo '8f. un prospecto SIN base de licitud no admite personas de contacto'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.add_prospecto_persona_for_superadmin('00000000-0000-0000-0000-0000000f7c00', '00000000-0000-0000-0000-0000000f7d01', 'Ana Ficticia', 'Gerente', 'correo', 'ana@example.com', 'sitio_web_oficial', 'alta', 'https://example.com/equipo') as should_fail;
rollback;

\echo '8g. agregar una persona deja un evento de enriquecimiento sin PII'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.add_prospecto_persona_for_superadmin('00000000-0000-0000-0000-0000000f7c00', '00000000-0000-0000-0000-0000000f7d02', 'Ana Ficticia', 'Gerente', 'correo', 'ana@example.com', 'sitio_web_oficial', 'alta', 'https://example.com/equipo');
reset role;
select count(*)::int as eventos_deberia_ser_1 from core.prospecto_evento where prospecto_id = '00000000-0000-0000-0000-0000000f7d02' and tipo = 'enriquecimiento' and detalle::text not like '%@%' and detalle::text not like '%Ficticia%';
rollback;

\echo '8h. staff comun NO puede agregar personas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7a01', true);
select core.add_prospecto_persona_for_superadmin('00000000-0000-0000-0000-0000000f7a01', '00000000-0000-0000-0000-0000000f7d02', 'Ana Ficticia', 'Gerente', 'correo', 'ana@example.com', 'sitio_web_oficial', 'alta', 'https://example.com/equipo') as should_fail;
rollback;

\echo '=== EVENTOS: cada cambio de etapa escribe uno ==='
\echo '9. cambiar de etapa escribe un cambio_etapa con la etapa anterior y la nueva'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.update_prospecto_for_superadmin('00000000-0000-0000-0000-0000000f7c00', '00000000-0000-0000-0000-0000000f7d01', 'contactado', null);
reset role;
select count(*)::int as eventos_deberia_ser_1 from core.prospecto_evento where prospecto_id = '00000000-0000-0000-0000-0000000f7d01' and tipo = 'cambio_etapa' and detalle = '{"de":"nuevo","a":"contactado"}'::jsonb and actor_id = '00000000-0000-0000-0000-0000000f7c00';
rollback;

\echo '9b. editar solo las notas NO escribe un cambio_etapa'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.update_prospecto_for_superadmin('00000000-0000-0000-0000-0000000f7c00', '00000000-0000-0000-0000-0000000f7d01', null, 'una nota');
reset role;
select count(*)::int as eventos_deberia_ser_0 from core.prospecto_evento where prospecto_id = '00000000-0000-0000-0000-0000000f7d01' and tipo = 'cambio_etapa';
rollback;

\echo '9c. la funcion de update conserva el caller-binding'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.update_prospecto_for_superadmin('00000000-0000-0000-0000-0000000f7c01', '00000000-0000-0000-0000-0000000f7d01', 'demo', null) as should_fail;
rollback;

\echo '9d. un tipo de evento fuera del catalogo NO se guarda'
begin;
insert into core.prospecto_evento (prospecto_id, tipo) values ('00000000-0000-0000-0000-0000000f7d01', 'envio_automatico') returning 1 as should_fail;
rollback;

\echo '=== GUARDAR PROSPECTO DEL CEREBRO ==='
\echo '10. alta con base de licitud: guarda campos nuevos y scores, y escribe el evento de alta'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.save_prospecto_cerebro_for_superadmin('00000000-0000-0000-0000-0000000f7c00', null,
  '{"empresa":"Cafe Ficticio","vertical":"restaurantes","subtipo":"cafeteria","tamano":"s1","telefono":"5555550102","base_licitud":"fuente_publica_b2b","senales":[{"tipo":"menu_en_linea","valor":"si","fuente":"sitio","url":"https://example.com/menu","observado_en":"2026-09-20"}]}'::jsonb,
  '{"ajuste":40,"urgencia":null,"cierre":null,"completitud":55,"explicacion":{"version":"t"},"version":"reglas-v1/tax-1"}'::jsonb);
reset role;
select count(*)::int as filas_deberia_ser_1 from core.prospecto where empresa = 'Cafe Ficticio' and subtipo = 'cafeteria' and score_ajuste = 40 and score_urgencia is null and score_completitud = 55 and score_version = 'reglas-v1/tax-1' and jsonb_array_length(senales) = 1 and creado_por = '00000000-0000-0000-0000-0000000f7c00';
rollback;

\echo '10b. alta con telefono y SIN base de licitud se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.save_prospecto_cerebro_for_superadmin('00000000-0000-0000-0000-0000000f7c00', null, '{"empresa":"Cafe Ficticio","vertical":"restaurantes","telefono":"5555550102"}'::jsonb, null) as should_fail;
rollback;

\echo '10c. alta sin contacto y sin base SI se guarda'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.save_prospecto_cerebro_for_superadmin('00000000-0000-0000-0000-0000000f7c00', null, '{"empresa":"Cafe Sin Contacto","vertical":"restaurantes"}'::jsonb, null);
reset role;
select count(*)::int as filas_deberia_ser_1 from core.prospecto where empresa = 'Cafe Sin Contacto';
rollback;

\echo '10d. editar: una clave ausente conserva el valor y una clave null lo limpia'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.save_prospecto_cerebro_for_superadmin('00000000-0000-0000-0000-0000000f7c00', '00000000-0000-0000-0000-0000000f7d02', '{"zona":"Centro","municipio":"Cuauhtemoc"}'::jsonb, null);
select core.save_prospecto_cerebro_for_superadmin('00000000-0000-0000-0000-0000000f7c00', '00000000-0000-0000-0000-0000000f7d02', '{"zona":null}'::jsonb, null);
reset role;
select count(*)::int as filas_deberia_ser_1 from core.prospecto where id = '00000000-0000-0000-0000-0000000f7d02' and zona is null and municipio = 'Cuauhtemoc' and telefono = '5555550100';
rollback;

\echo '10e. una clave desconocida en p_datos NO toca columnas de sistema (organization_id, creado_por)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.save_prospecto_cerebro_for_superadmin('00000000-0000-0000-0000-0000000f7c00', '00000000-0000-0000-0000-0000000f7d01', '{"organization_id":"00000000-0000-0000-0000-0000000f6a00","creado_por":"00000000-0000-0000-0000-0000000f7c01","score_ajuste":99}'::jsonb, null);
reset role;
select count(*)::int as filas_deberia_ser_1 from core.prospecto where id = '00000000-0000-0000-0000-0000000f7d01' and organization_id is null and creado_por is null and score_ajuste is null;
rollback;

\echo '10f. editar una fila legado no exige base mientras no cambie el contacto; cambiarlo si la exige'
begin;
insert into core.prospecto (id, empresa, vertical, telefono, contacto_legado) values ('00000000-0000-0000-0000-0000000f7d03', 'Legado Ficticio', 'citas', '5555550103', true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.save_prospecto_cerebro_for_superadmin('00000000-0000-0000-0000-0000000f7c00', '00000000-0000-0000-0000-0000000f7d03', '{"zona":"Norte"}'::jsonb, null);
reset role;
select count(*)::int as filas_deberia_ser_1 from core.prospecto where id = '00000000-0000-0000-0000-0000000f7d03' and zona = 'Norte';
rollback;

begin;
insert into core.prospecto (id, empresa, vertical, telefono, contacto_legado) values ('00000000-0000-0000-0000-0000000f7d03', 'Legado Ficticio', 'citas', '5555550103', true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.save_prospecto_cerebro_for_superadmin('00000000-0000-0000-0000-0000000f7c00', '00000000-0000-0000-0000-0000000f7d03', '{"telefono":"5555550199"}'::jsonb, null) as should_fail;
rollback;

\echo '10g. editar un prospecto inexistente falla con P0002'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.save_prospecto_cerebro_for_superadmin('00000000-0000-0000-0000-0000000f7c00', '00000000-0000-0000-0000-0000000f7dff', '{"zona":"Norte"}'::jsonb, null) as should_fail;
rollback;

\echo '10h. listar devuelve los prospectos con las columnas nuevas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select count(*)::int as filas_deberia_ser_2 from core.list_prospectos_cerebro_for_superadmin('00000000-0000-0000-0000-0000000f7c00') where id in ('00000000-0000-0000-0000-0000000f7d01', '00000000-0000-0000-0000-0000000f7d02');
rollback;

\echo '=== TAXONOMIA ==='
\echo '11. la semilla trae las 6 verticales en version 1, marcadas propuesta'
begin;
select count(*)::int as semilla_deberia_ser_6 from core.cerebro_taxonomia where version = 1 and estado_validacion = 'propuesta_validar_con_javier';
rollback;

\echo '11b. los mensajes base de la semilla no traen cifras prometidas'
begin;
select count(*)::int as con_cifras_deberia_ser_0 from core.cerebro_taxonomia where mensajes_base::text ~* '([0-9][0-9.,]*\s*%|\$\s*[0-9]|[0-9]\s*(mxn|pesos))';
rollback;

\echo '11c. el superadmin lista la taxonomia con el plan y el precio leidos de core.plan'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select count(*)::int as con_precio_deberia_ser_3 from core.list_cerebro_taxonomia_for_superadmin('00000000-0000-0000-0000-0000000f7c00') where vigente and plan_precio_asiento_mxn_centavos is not null;
rollback;

\echo '11d. rentas, licitaciones y despachos quedan sin precio (precio por definir)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select count(*)::int as sin_precio_deberia_ser_3 from core.list_cerebro_taxonomia_for_superadmin('00000000-0000-0000-0000-0000000f7c00') where vigente and plan_precio_asiento_mxn_centavos is null and plan_precio_base_mxn_centavos is null;
rollback;

\echo '12. editar la taxonomia crea la version 2 y la marca vigente; la 1 queda como historial'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.save_cerebro_taxonomia_for_superadmin('00000000-0000-0000-0000-0000000f7c00', 'restaurantes', '{"icp":{"descripcion":"nuevo icp","subtipos_objetivo":["taqueria"],"tamanos_objetivo":["s1"]}}'::jsonb, 'restaurantes-estandar', 'ajuste del ICP', false);
select count(*)::int as vigentes_deberia_ser_1 from core.list_cerebro_taxonomia_for_superadmin('00000000-0000-0000-0000-0000000f7c00') where vertical = 'restaurantes' and version = 2 and vigente and icp ->> 'descripcion' = 'nuevo icp' and jsonb_array_length(senales) > 0 and nota_cambio = 'ajuste del ICP';
rollback;

\echo '12b. la version 1 sigue intacta tras editar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.save_cerebro_taxonomia_for_superadmin('00000000-0000-0000-0000-0000000f7c00', 'restaurantes', '{"icp":{"descripcion":"nuevo icp"}}'::jsonb, 'restaurantes-estandar', null, false);
reset role;
select count(*)::int as v1_intacta_deberia_ser_1 from core.cerebro_taxonomia where vertical = 'restaurantes' and version = 1 and icp ->> 'descripcion' <> 'nuevo icp';
rollback;

\echo '12c. un mensaje base que promete cifras se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.save_cerebro_taxonomia_for_superadmin('00000000-0000-0000-0000-0000000f7c00', 'restaurantes', '{"mensajes_base":[{"canal":"whatsapp","variante":"A","texto":"Hola, aumenta tus ventas 30% con atiende.ai"}]}'::jsonb, 'restaurantes-estandar', null, false) as should_fail;
rollback;

\echo '12d. un plan de OTRA vertical se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.save_cerebro_taxonomia_for_superadmin('00000000-0000-0000-0000-0000000f7c00', 'restaurantes', '{}'::jsonb, 'hoteles-estandar', null, false) as should_fail;
rollback;

\echo '12e. una vertical invalida se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.save_cerebro_taxonomia_for_superadmin('00000000-0000-0000-0000-0000000f7c00', 'gasolineras', '{}'::jsonb, null, null, false) as should_fail;
rollback;

\echo '12f. dos versiones iguales de la misma vertical no existen (unique)'
begin;
insert into core.cerebro_taxonomia (vertical, version, subtipos, rangos_tamano, senales, icp, objeciones, mensajes_base) values ('restaurantes', 1, '[]', '{}', '[]', '{}', '[]', '[]') returning 1 as should_fail;
rollback;

\echo '12g. marcar validada guarda estado validada'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.save_cerebro_taxonomia_for_superadmin('00000000-0000-0000-0000-0000000f7c00', 'citas', '{}'::jsonb, 'citas-estandar', 'validada por Javier', true);
select count(*)::int as validadas_deberia_ser_1 from core.list_cerebro_taxonomia_for_superadmin('00000000-0000-0000-0000-0000000f7c00') where vertical = 'citas' and version = 2 and estado_validacion = 'validada';
rollback;

\echo '=== AUTORIZACION: caller-binding, staff comun, finanzas, anon ==='
\echo '13. caller-binding: leer con el id de otro superadmin se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select * from core.list_prospectos_cerebro_for_superadmin('00000000-0000-0000-0000-0000000f7c01') as should_fail;
rollback;

\echo '13b. staff comun NO lista prospectos ni taxonomia ni eventos ni personas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7a01', true);
select * from core.list_prospectos_cerebro_for_superadmin('00000000-0000-0000-0000-0000000f7a01') as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7a01', true);
select * from core.list_cerebro_taxonomia_for_superadmin('00000000-0000-0000-0000-0000000f7a01') as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7a01', true);
select * from core.list_prospecto_eventos_for_superadmin('00000000-0000-0000-0000-0000000f7a01', '00000000-0000-0000-0000-0000000f7d01', 10) as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7a01', true);
select * from core.list_prospecto_personas_for_superadmin('00000000-0000-0000-0000-0000000f7a01', '00000000-0000-0000-0000-0000000f7d01') as should_fail;
rollback;

\echo '13c. staff comun NO guarda prospectos ni taxonomia'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7a01', true);
select core.save_prospecto_cerebro_for_superadmin('00000000-0000-0000-0000-0000000f7a01', null, '{"empresa":"X","vertical":"citas"}'::jsonb, null) as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7a01', true);
select core.save_cerebro_taxonomia_for_superadmin('00000000-0000-0000-0000-0000000f7a01', 'citas', '{}'::jsonb, null, null, false) as should_fail;
rollback;

\echo '13d. caller-binding en escritura: id de otro superadmin se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.save_cerebro_taxonomia_for_superadmin('00000000-0000-0000-0000-0000000f7c01', 'citas', '{}'::jsonb, null, null, false) as should_fail;
rollback;

\echo '13e. el superadmin de finanzas (solo lectura) NO escribe pero SI lee'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c02', true);
select core.save_cerebro_taxonomia_for_superadmin('00000000-0000-0000-0000-0000000f7c02', 'citas', '{}'::jsonb, null, null, false) as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c02', true);
select count(*)::int as filas_deberia_ser_6 from core.list_cerebro_taxonomia_for_superadmin('00000000-0000-0000-0000-0000000f7c02') where vigente;
rollback;

\echo '13f. anon NO ejecuta ninguna funcion nueva'
begin;
set local role anon;
select * from core.list_prospectos_cerebro_for_superadmin('00000000-0000-0000-0000-0000000f7c00') as should_fail;
rollback;

begin;
set local role anon;
select core.save_cerebro_taxonomia_for_superadmin('00000000-0000-0000-0000-0000000f7c00', 'citas', '{}'::jsonb, null, null, false) as should_fail;
rollback;

begin;
set local role anon;
select core.save_prospecto_cerebro_for_superadmin('00000000-0000-0000-0000-0000000f7c00', null, '{"empresa":"X","vertical":"citas"}'::jsonb, null) as should_fail;
rollback;

\echo '13g. una sesion de sistema (sin sub) tampoco ejecuta las funciones de superadmin'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from core.list_cerebro_taxonomia_for_superadmin('00000000-0000-0000-0000-0000000f7c00') as should_fail;
rollback;

\echo '13h. cross-tenant: un usuario con membresia de organizacion pero no superadmin no ve nada del cerebro'
begin;
insert into core.organization (id, vertical, name, slug, status) values ('00000000-0000-0000-0000-0000000f7b00', 'citas', 'Cerebro Org', 'org-cerebro-a', 'active') on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values ('00000000-0000-0000-0000-0000000f7a01', '00000000-0000-0000-0000-0000000f7b00', null, 'owner', 'owner') on conflict do nothing;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7a01', true);
select * from core.list_prospectos_cerebro_for_superadmin('00000000-0000-0000-0000-0000000f7a01') as should_fail;
rollback;

\echo '=== TABLAS SIN ACCESO DIRECTO Y FUNCIONES ENDURECIDAS ==='
\echo '14. un usuario autenticado (incluso superadmin) no lee las tablas nuevas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select * from core.cerebro_taxonomia as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select * from core.prospecto_evento as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select * from core.prospecto_contacto_persona as should_fail;
rollback;

\echo '14b. un usuario autenticado no inserta directo en la taxonomia'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
insert into core.cerebro_taxonomia (vertical, version, subtipos, rangos_tamano, senales, icp, objeciones, mensajes_base) values ('citas', 9, '[]', '{}', '[]', '{}', '[]', '[]') returning 1 as should_fail;
rollback;

\echo '14c. anon no lee las tablas nuevas'
begin;
set local role anon;
select * from core.prospecto_evento as should_fail;
rollback;

\echo '14d. RLS habilitado y cero policies en las 3 tablas nuevas'
begin;
select count(*)::int as rls_deberia_ser_3 from pg_class where oid in ('core.cerebro_taxonomia'::regclass, 'core.prospecto_evento'::regclass, 'core.prospecto_contacto_persona'::regclass) and relrowsecurity;
rollback;

begin;
select count(*)::int as policies_deberia_ser_0 from pg_policies where schemaname = 'core' and tablename in ('cerebro_taxonomia', 'prospecto_evento', 'prospecto_contacto_persona');
rollback;

\echo '14e. ningun rol de la aplicacion tiene privilegios de tabla en las 3 tablas nuevas'
begin;
select count(*)::int as privilegios_deberia_ser_0 from information_schema.role_table_grants where table_schema = 'core' and table_name in ('cerebro_taxonomia', 'prospecto_evento', 'prospecto_contacto_persona') and grantee in ('anon', 'authenticated', 'public');
rollback;

\echo '14f. anon no tiene EXECUTE en ninguna funcion nueva'
begin;
select count(*)::int as anon_deberia_ser_0 from pg_proc p where p.pronamespace = 'core'::regnamespace and p.proname in ('list_prospectos_cerebro_for_superadmin', 'save_prospecto_cerebro_for_superadmin', 'list_prospecto_personas_for_superadmin', 'add_prospecto_persona_for_superadmin', 'list_prospecto_eventos_for_superadmin', 'list_cerebro_taxonomia_for_superadmin', 'save_cerebro_taxonomia_for_superadmin') and has_function_privilege('anon', p.oid, 'execute');
rollback;

\echo '14g. todas las funciones nuevas son definer con search_path fijo'
begin;
select count(*)::int as sin_search_path_deberia_ser_0 from pg_proc p where p.pronamespace = 'core'::regnamespace and p.proname in ('list_prospectos_cerebro_for_superadmin', 'save_prospecto_cerebro_for_superadmin', 'list_prospecto_personas_for_superadmin', 'add_prospecto_persona_for_superadmin', 'list_prospecto_eventos_for_superadmin', 'list_cerebro_taxonomia_for_superadmin', 'save_cerebro_taxonomia_for_superadmin', 'update_prospecto_for_superadmin') and (not p.prosecdef or p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'));
rollback;

\echo '=== EVENTOS: lectura ==='
\echo '15. el superadmin lee la linea de tiempo de un prospecto (mas reciente primero)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.update_prospecto_for_superadmin('00000000-0000-0000-0000-0000000f7c00', '00000000-0000-0000-0000-0000000f7d01', 'contactado', null);
select core.update_prospecto_for_superadmin('00000000-0000-0000-0000-0000000f7c00', '00000000-0000-0000-0000-0000000f7d01', 'demo', null);
select count(*)::int as eventos_deberia_ser_2 from core.list_prospecto_eventos_for_superadmin('00000000-0000-0000-0000-0000000f7c00', '00000000-0000-0000-0000-0000000f7d01', 50) where tipo = 'cambio_etapa';
rollback;

\echo '15b. el superadmin lee las personas de un prospecto'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.add_prospecto_persona_for_superadmin('00000000-0000-0000-0000-0000000f7c00', '00000000-0000-0000-0000-0000000f7d02', 'Ana Ficticia', 'Gerente', 'correo', 'ana@example.com', 'sitio_web_oficial', 'alta', 'https://example.com/equipo');
select count(*)::int as personas_deberia_ser_1 from core.list_prospecto_personas_for_superadmin('00000000-0000-0000-0000-0000000f7c00', '00000000-0000-0000-0000-0000000f7d02');
rollback;

\echo '=== COMPATIBILIDAD: las funciones anteriores siguen funcionando ==='
\echo '16. list_prospectos_for_superadmin (0012) sigue devolviendo filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select count(*)::int as filas_deberia_ser_2 from core.list_prospectos_for_superadmin('00000000-0000-0000-0000-0000000f7c00') where id in ('00000000-0000-0000-0000-0000000f7d01', '00000000-0000-0000-0000-0000000f7d02');
rollback;

\echo '16b. create_prospecto_for_superadmin (0012) sin datos de contacto sigue funcionando'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.create_prospecto_for_superadmin('00000000-0000-0000-0000-0000000f7c00', 'Solo Empresa Legada', 'citas', null, null, null, null, null, null);
select count(*)::int as filas_deberia_ser_1 from core.list_prospectos_for_superadmin('00000000-0000-0000-0000-0000000f7c00') where empresa = 'Solo Empresa Legada';
rollback;

\echo '16c. create_prospecto_for_superadmin (0012) con telefono y sin base de licitud ya NO guarda (23514)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7c00', true);
select core.create_prospecto_for_superadmin('00000000-0000-0000-0000-0000000f7c00', 'Con Telefono Legado', 'citas', null, null, '5555550104', null, null, null) as should_fail;
rollback;

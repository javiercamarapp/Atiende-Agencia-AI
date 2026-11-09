-- Fixtures + escenarios contra Postgres REAL del seed de la cuenta demo de rentas (Rn-33): el bloque plpgsql REAL del seed
-- (packages/domain-rentas/src/seed/rentas-demo.ts, generado abajo como public.seed_rentas_demo()) contra TODAS las migraciones reales,
-- con RLS/GRANT/auth.uid() reales. Cada escenario corre en su propio `begin; ... rollback;` y ejecuta el seed dentro de la transaccion;
-- el gate (scripts/verify-real-postgres-ci/run-gate.mjs) evalua UN valor por escenario: el alias `..._deberia_ser_N` (o `should_fail`).
--
--   A. Resultado: 3 propiedades, 5 unidades, 3 propietarios, 21 reservas (8 importadas de los .ics + 13 directas), 3 feeds (1 en cuarentena),
--      1 conflicto abierto, 5 tareas (1 vencida), 1 incidencia, 5 plantillas (2 aprobadas), 2 borradores pendientes, 4 reglas de comision
--      confirmadas, 9 movimientos financieros coherentes; todo ficticio y marcado (slug demo-).
--   B. Lo que ven el Resumen, los reportes, el monitor y el checklist de onboarding (Rn-36): las MISMAS consultas que los repositorios,
--      ejecutadas como el staff autenticado del dueño (RLS real), devuelven datos.
--   C. Idempotencia: dos ejecuciones no duplican nada; no pisa lo que el usuario ya edito (regla de comision, plantilla aprobada).
--   D. Aislamiento y seguridad: aborta si el slug es de otra vertical o si el correo del dueño no existe; otra organizacion no ve nada; anon no lee;
--      borrar la organizacion demo se lleva TODO lo suyo (cascada) sin tocar a otra organizacion.
\set ON_ERROR_STOP off
\pset pager off

-- Fixtures persistentes: el staff dueño de la demo, una organizacion ajena con su propio staff.
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000d1', 'duena@example.test', 'Duena Demo', 'seed'),
  ('00000000-0000-0000-0000-0000000000d2', 'intruso@example.test', 'Intruso Demo', 'seed')
on conflict do nothing;
insert into core.organization (id, vertical, name, slug) values ('00000000-0000-0000-0000-0000000000a9', 'rentas', 'Org ajena (verify seed rentas)', 'org-ajena-verify-seed-rentas') on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values ('00000000-0000-0000-0000-0000000000b9', '00000000-0000-0000-0000-0000000000a9', 'rentas', 'Propiedad ajena') on conflict do nothing;
insert into rentas.property_config (property_id, organization_id, zona_horaria, moneda) values ('00000000-0000-0000-0000-0000000000b9', '00000000-0000-0000-0000-0000000000a9', 'America/Merida', 'MXN') on conflict do nothing;
insert into rentas.organization_perfil (organization_id, tipo) values ('00000000-0000-0000-0000-0000000000a9', 'empresa_gestora') on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a9', null, 'owner', 'admin_gestora')
on conflict do nothing;

\echo ''
\echo '=== A. Resultado del seed ==='
\echo ''
\echo '--- A1. 3 propiedades, 5 unidades y 3 propietarios en la organizacion demo ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from core.property where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 3 and (select count(*) from rentas.unidad where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 5 and (select count(*) from rentas.owner_organization where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 3)::int as catalogo_correcto_deberia_ser_1;
rollback;
\echo '--- A2. 21 reservas: 8 importadas de los .ics (canal airbnb/booking/vrbo) y 13 directas (canal manual); todas confirmadas ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from rentas.ocupacion o join rentas.canal c on c.id = o.canal_origen_id where o.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and o.capa = 'reserva' and c.codigo <> 'manual' and o.estado = 'confirmado') = 8 and (select count(*) from rentas.ocupacion o join rentas.canal c on c.id = o.canal_origen_id where o.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and o.capa = 'reserva' and c.codigo = 'manual' and o.estado = 'confirmado') = 13)::int as reservas_correctas_deberia_ser_1;
rollback;
\echo '--- A3. 8 eventos importados registrados (uno por reserva de .ics) y 3 feeds: 2 al dia y 1 en cuarentena ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from rentas.evento_canal_importado where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 8 and (select count(*) from rentas.canal_feed_externo where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 3 and (select count(*) from rentas.canal_feed_externo where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and en_cuarentena_desde is not null) = 1 and (select count(*) from rentas.canal_feed_externo where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and url_importacion not like 'https://calendarios.demo.invalid/%') = 0)::int as feeds_correctos_deberia_ser_1;
rollback;
\echo '--- A4. un conflicto abierto (capa cruzada: reserva importada de Airbnb contra un bloqueo de mantenimiento) y un bloqueo ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from rentas.conflicto_calendario where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and resuelto_en is null and tipo = 'capa_cruzada') = 1 and (select count(*) from rentas.ocupacion where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and capa = 'bloqueo' and razon = 'MANTENIMIENTO') = 1)::int as conflicto_correcto_deberia_ser_1;
rollback;
\echo '--- A5. 5 tareas (1 vencida, 1 completada con checklist completo) y 1 incidencia abierta ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from rentas.tarea_operativa where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 5 and (select count(*) from rentas.tarea_operativa where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and estado not in ('completada','cancelada') and sla_vence_en < now()) = 1 and (select count(*) from rentas.checklist_item_tarea c join rentas.tarea_operativa t on t.id = c.tarea_id where t.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and t.estado = 'completada' and not c.completado) = 0 and (select count(*) from rentas.incidencia_mantenimiento where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and estado = 'abierta') = 1)::int as tareas_correctas_deberia_ser_1;
rollback;
\echo '--- A6. 5 plantillas (2 aprobadas por el tenant), 2 conversaciones con su borrador pendiente de aprobacion ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from rentas.plantilla_mensaje where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 5 and (select count(*) from rentas.plantilla_mensaje where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and aprobada_por_tenant) = 2 and (select count(*) from rentas.borrador_mensaje b join rentas.conversacion c on c.id = b.conversacion_id where c.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and b.estado = 'pendiente_aprobacion' and b.generado_por = 'agente_llm') = 2)::int as mensajeria_correcta_deberia_ser_1;
rollback;
\echo '--- A7. reglas de comision: las 4 sugeridas quedan confirmadas con fuente de demo (ninguna default_sugerido) ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from rentas.regla_comision_canal where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 4 and (select count(*) from rentas.regla_comision_canal where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and fuente like 'default\_sugerido%') = 0 and (select count(*) from rentas.regla_comision_canal where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and fuente like 'Demo:%') = 4)::int as reglas_correctas_deberia_ser_1;
rollback;
\echo '--- A8. 9 movimientos financieros coherentes: neto = recibido - comision del gestor - gastos - impuestos; las lineas de gasto suman lo que dice el movimiento ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from rentas.reserva_financiero where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 9 and (select count(*) from rentas.reserva_financiero where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and neto_centavos <> monto_recibido_centavos - comision_gestor_centavos - gastos_centavos - impuestos_centavos) = 0 and (select count(*) from rentas.reserva_financiero rf where rf.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and rf.gastos_centavos <> coalesce((select sum(lg.monto_centavos) from rentas.linea_gasto lg where lg.reserva_financiero_id = rf.id), 0)) = 0)::int as finanzas_coherentes_deberia_ser_1;
rollback;
\echo '--- A9. todo es ficticio y esta marcado: slug demo-, nombre (demo), correos @example.test, contactos con lada 00, ningun movimiento en una reserva futura ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from core.organization where id = (select id from core.organization where slug = 'demo-rentas-gestora') and slug like 'demo-%' and name like '%(demo)') = 1 and (select count(*) from rentas.owner o join rentas.owner_organization oo on oo.owner_id = o.id where oo.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and o.email not like '%@example.test') = 0 and (select count(*) from rentas.guest_minimo where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and contacto not like '+52 00 %') = 0 and (select count(*) from rentas.reserva_financiero rf join rentas.ocupacion o on o.id = rf.ocupacion_id where rf.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and upper(o.rango) > current_date + 1) = 0)::int as demo_marcada_deberia_ser_1;
rollback;
\echo '--- A10. la consola de superadmin cuenta la cuenta como demo (criterio slug demo-%) y el dueño quedo como admin_gestora de acceso total ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from core.organization where vertical = 'rentas' and slug like 'demo-%' and id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 1 and (select count(*) from core.membership where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and user_id = '00000000-0000-0000-0000-0000000000d1' and vertical_role = 'admin_gestora' and platform_role = 'owner' and property_ids is null) = 1)::int as marca_y_dueno_deberia_ser_1;
rollback;

\echo ''
\echo '=== B. Lo que ven el Resumen, los reportes, el monitor y el checklist (consultas de los repositorios, como el staff autenticado) ==='
\echo ''
\echo '--- B1. Resumen: llegadas y salidas de HOY en la zona de Casa del Mar (Cancun): llega 1 (Booking) y sale 1 (Airbnb) ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
select (select count(*) filter (where lower(o.rango) = (now() at time zone 'America/Cancun')::date) * 10 + count(*) filter (where upper(o.rango) = (now() at time zone 'America/Cancun')::date) from rentas.ocupacion o where o.property_id = (select p.id from core.property p where p.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and p.name = 'Casa del Mar (demo)') and o.capa = 'reserva' and o.estado = 'confirmado' and (lower(o.rango) = (now() at time zone 'America/Cancun')::date or upper(o.rango) = (now() at time zone 'America/Cancun')::date)) as llegadas_x10_mas_salidas_deberia_ser_11;
rollback;
\echo '--- B2. Resumen: tareas pendientes y vencidas de Casa del Mar (2 pendientes, 1 vencida) ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
select (count(*) filter (where t.estado not in ('completada', 'cancelada')) * 10 + count(*) filter (where t.estado not in ('completada', 'cancelada') and t.sla_vence_en is not null and t.sla_vence_en < now())) as pendientes_x10_mas_vencidas_deberia_ser_21 from rentas.tarea_operativa t where t.property_id = (select p.id from core.property p where p.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and p.name = 'Casa del Mar (demo)');
rollback;
\echo '--- B3. Resumen: borradores por aprobar (1 en Casa del Mar) y el ultimo generado por el agente ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
select count(*) filter (where b.estado = 'pendiente_aprobacion') as borradores_pendientes_deberia_ser_1 from rentas.borrador_mensaje b join rentas.conversacion c on c.id = b.conversacion_id where c.property_id = (select p.id from core.property p where p.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and p.name = 'Casa del Mar (demo)');
rollback;
\echo '--- B4. Monitor: los 2 feeds de Casa del Mar estan activos y sin cuarentena ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
select count(*) as feeds_sanos_deberia_ser_2 from rentas.canal_feed_externo cfe join rentas.canal c on c.id = cfe.canal_id join rentas.unidad u on u.id = cfe.unidad_id where cfe.property_id = (select p.id from core.property p where p.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and p.name = 'Casa del Mar (demo)') and cfe.activo and cfe.en_cuarentena_desde is null;
rollback;
\echo '--- B5. Monitor: el feed de Vrbo del Loft esta en cuarentena con su motivo ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
select count(*) as feeds_en_cuarentena_deberia_ser_1 from rentas.canal_feed_externo cfe join rentas.canal c on c.id = cfe.canal_id where cfe.property_id = (select p.id from core.property p where p.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and p.name = 'Loft Centro (demo)') and c.codigo = 'vrbo' and cfe.en_cuarentena_desde is not null and cfe.motivo_cuarentena is not null and cfe.intentos_fallidos_consecutivos = 6;
rollback;
\echo '--- B6. Monitor: el listado de conflictos (misma consulta que listarConflictos) devuelve el abierto con sus dos ocupaciones ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
select count(*) as conflictos_abiertos_deberia_ser_1 from (select k.id from rentas.conflicto_calendario k join rentas.unidad u on u.id = k.unidad_id join rentas.ocupacion a on a.id = k.ocupacion_a_id left join rentas.canal ca on ca.id = a.canal_origen_id left join rentas.ocupacion b on b.id = k.ocupacion_b_id left join rentas.canal cb on cb.id = b.canal_origen_id where k.property_id = (select p.id from core.property p where p.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and p.name = 'Casa del Mar (demo)') and k.resuelto_en is null and ca.codigo = 'airbnb' and b.razon = 'MANTENIMIENTO' order by (k.resuelto_en is not null), k.detectado_en desc, k.id limit 50) q;
rollback;
\echo '--- B7. Reportes: el reporte de ocupacion de Casa del Mar (misma consulta que cargarDatosReporte, ultimos 60 dias) trae 5 reservas con su movimiento financiero ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
select count(*) as reservas_con_movimiento_deberia_ser_5 from rentas.ocupacion o join rentas.unidad u on u.id = o.unidad_id left join rentas.canal c on c.id = o.canal_origen_id left join rentas.reserva_financiero rf on rf.ocupacion_id = o.id where o.property_id = (select p.id from core.property p where p.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and p.name = 'Casa del Mar (demo)') and o.capa = 'reserva' and o.estado = 'confirmado' and o.rango && daterange(((now() at time zone 'America/Cancun')::date - 60), ((now() at time zone 'America/Cancun')::date + 1), '[)') and rf.id is not null;
rollback;
\echo '--- B8. Reportes: el dueño ve las 21 reservas de la organizacion demo y la ocupacion del mes en Casa del Mar es mayor que cero ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
select ((select count(*) from rentas.ocupacion where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and capa = 'reserva') = 21 and (select count(*) from rentas.ocupacion o where o.property_id = (select p.id from core.property p where p.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and p.name = 'Casa del Mar (demo)') and o.capa = 'reserva' and o.estado = 'confirmado' and o.rango && daterange(date_trunc('month', now() at time zone 'America/Cancun')::date, (date_trunc('month', now() at time zone 'America/Cancun') + interval '1 month')::date, '[)')) > 0)::int as reportes_con_datos_deberia_ser_1;
rollback;
\echo '--- B9. Checklist Rn-36 (mismas consultas del repositorio): iCal 3 activos (1 en cuarentena) y 2 sincronizados, 5 de 5 unidades con tarifa, 4 reglas confirmadas, 1 propiedad con acceso activo, 3 propietarios, 2 plantillas aprobadas ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
select ((select count(*) filter (where activo) from rentas.canal_feed_externo where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 3 and (select count(*) filter (where activo and en_cuarentena_desde is null and ultima_sincronizacion_exitosa_en is not null) from rentas.canal_feed_externo where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 2 and (select count(*) filter (where activo and en_cuarentena_desde is not null) from rentas.canal_feed_externo where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 1 and (select count(distinct unidad_id) from rentas.tarifa_base where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = (select count(*) from rentas.unidad where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) and (select count(*) from rentas.regla_comision_canal where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and fuente not like 'default\_sugerido%') = 4 and (select count(*) from rentas.acceso_politica where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and activo) = 1 and (select count(*) from rentas.owner_organization where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 3 and (select count(*) from rentas.plantilla_mensaje where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and aprobada_por_tenant and activa) = 2)::int as checklist_con_datos_deberia_ser_1;
rollback;
\echo '--- B10. Checklist: el staff (solo el dueño, sin invitaciones) queda PENDIENTE: 1 miembro y 0 invitaciones pendientes ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', true);
select ((select count(*) from core.membership where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 1 and (select count(*) from core.staff_invite where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and status = 'pending') = 0)::int as staff_pendiente_deberia_ser_1;
rollback;
\echo '--- B11. Checklist: una organizacion NUEVA nace con 4 reglas sugeridas y NINGUNA cuenta como confirmada (el punto no nace hecho) ---'
begin;
select public.seed_rentas_demo();
select ((select count(*) from rentas.regla_comision_canal where organization_id = '00000000-0000-0000-0000-0000000000a9') = 4 and (select count(*) from rentas.regla_comision_canal where organization_id = '00000000-0000-0000-0000-0000000000a9' and fuente not like 'default\_sugerido%') = 0)::int as reglas_sugeridas_no_cuentan_deberia_ser_1;
rollback;

\echo ''
\echo '=== C. Idempotencia ==='
\echo ''
\echo '--- C1. ejecutar el seed dos veces NO duplica reservas, huespedes, movimientos ni lineas de gasto (22 ocupaciones, 13 huespedes, 9 movimientos, 5 gastos) ---'
begin;
select public.seed_rentas_demo();
select public.seed_rentas_demo();
select (select count(*) from rentas.ocupacion where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) * 1000000 + (select count(*) from rentas.guest_minimo where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) * 10000 + (select count(*) from rentas.reserva_financiero where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) * 100 + (select count(*) from rentas.linea_gasto lg join rentas.reserva_financiero rf on rf.id = lg.reserva_financiero_id where rf.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) as ocupaciones_huespedes_movimientos_gastos_deberia_ser_22130905;
rollback;
\echo '--- C2. ni tareas, conversaciones, borradores o plantillas (5 tareas, 2 conversaciones, 2 borradores, 5 plantillas) ---'
begin;
select public.seed_rentas_demo();
select public.seed_rentas_demo();
select (select count(*) from rentas.tarea_operativa where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) * 1000000 + (select count(*) from rentas.conversacion where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) * 10000 + (select count(*) from rentas.borrador_mensaje b join rentas.conversacion c on c.id = b.conversacion_id where c.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) * 100 + (select count(*) from rentas.plantilla_mensaje where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) as tareas_conversaciones_borradores_plantillas_deberia_ser_5020205;
rollback;
\echo '--- C3. ni propiedades, unidades, propietarios, feeds, tarifas, eventos importados o la politica de acceso ---'
begin;
select public.seed_rentas_demo();
select public.seed_rentas_demo();
select ((select count(*) from core.property where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 3 and (select count(*) from rentas.unidad where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 5 and (select count(*) from rentas.owner o join rentas.owner_organization oo on oo.owner_id = o.id where oo.organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 3 and (select count(*) from rentas.canal_feed_externo where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 3 and (select count(*) from rentas.tarifa_base where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 5 and (select count(*) from rentas.tarifa_temporada where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 1 and (select count(*) from rentas.evento_canal_importado where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 8 and (select count(*) from rentas.acceso_politica where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 1 and (select count(*) from rentas.regla_comision_canal where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora')) = 4)::int as sin_duplicados_deberia_ser_1;
rollback;
\echo '--- C4. NO pisa lo que el usuario ya edito: una regla de comision con su propia fuente y una plantilla con otro cuerpo se conservan al re-ejecutar ---'
begin;
select public.seed_rentas_demo();
update rentas.regla_comision_canal set comision_basis_points = 1234, fuente = 'Mi contrato firmado' where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and canal_id = (select id from rentas.canal where codigo = 'booking');
update rentas.plantilla_mensaje set cuerpo = 'Mi texto propio para {{huesped}}' where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and evento = 'check_in';
update rentas.plantilla_mensaje set aprobada_por_tenant = true where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and evento = 'check_in';
select public.seed_rentas_demo();
select ((select count(*) from rentas.regla_comision_canal where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and comision_basis_points = 1234 and fuente = 'Mi contrato firmado') = 1 and (select count(*) from rentas.plantilla_mensaje where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and evento = 'check_in' and cuerpo = 'Mi texto propio para {{huesped}}' and aprobada_por_tenant) = 1)::int as ediciones_del_usuario_conservadas_deberia_ser_1;
rollback;
\echo '--- C5. una reserva que el usuario cancelo no se reinserta al re-ejecutar (la llave es el external_id, no las fechas) ---'
begin;
select public.seed_rentas_demo();
update rentas.ocupacion set estado = 'cancelado' where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and external_id = 'demo-dir-d2';
select public.seed_rentas_demo();
select ((select count(*) from rentas.ocupacion where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and external_id = 'demo-dir-d2') = 1 and (select estado from rentas.ocupacion where organization_id = (select id from core.organization where slug = 'demo-rentas-gestora') and external_id = 'demo-dir-d2') = 'cancelado')::int as no_reinserta_deberia_ser_1;
rollback;

\echo ''
\echo '=== D. Aislamiento y seguridad ==='
\echo ''
\echo '--- D1. si el slug demo ya existe en OTRA vertical el seed ABORTA sin tocarla ---'
begin;
insert into core.organization (vertical, name, slug) values ('citas', 'Ocupa el slug', 'demo-rentas-gestora');
select public.seed_rentas_demo() as should_fail;
rollback;

\echo '--- D2. si el correo del dueño no existe el seed ABORTA (no crea credenciales) ---'
begin;
select public.seed_rentas_demo_sin_duena() as should_fail;
rollback;

\echo '--- D3. anon no puede leer nada de rentas (sin GRANT) ---'
begin;
select public.seed_rentas_demo();
set local role anon;
select count(*) as should_fail from rentas.ocupacion;
rollback;

\echo '--- D4. cross-tenant: el staff de OTRA organizacion no ve ninguna reserva, feed, movimiento, tarea, plantilla, conversacion ni borrador de la demo ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d2', true);
select (select count(*) from rentas.ocupacion) + (select count(*) from rentas.canal_feed_externo) + (select count(*) from rentas.reserva_financiero) + (select count(*) from rentas.tarea_operativa) + (select count(*) from rentas.plantilla_mensaje where aprobada_por_tenant) + (select count(*) from rentas.conversacion) + (select count(*) from rentas.borrador_mensaje) + (select count(*) from rentas.unidad) + (select count(*) from rentas.owner) as filas_ajenas_visibles_deberia_ser_0;
rollback;
\echo '--- D5. cross-tenant: el staff de otra organizacion tampoco ve las propiedades ni la politica de acceso de la demo ---'
begin;
select public.seed_rentas_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d2', true);
select (select count(*) from core.property where name like '%(demo)') + (select count(*) from rentas.acceso_politica) + (select count(*) from rentas.regla_comision_canal where organization_id <> '00000000-0000-0000-0000-0000000000a9') as propiedades_ajenas_visibles_deberia_ser_0;
rollback;
\echo '--- D6. la limpieza (limpiar_rentas_demo) se lleva TODO lo de la demo -- organizacion en cascada y propietarios huerfanos -- y no toca a la otra organizacion ---'
begin;
select public.seed_rentas_demo();
select public.limpiar_rentas_demo();
select ((select count(*) from core.organization where slug = 'demo-rentas-gestora') + (select count(*) from core.property where name like '%(demo)') + (select count(*) from rentas.ocupacion) + (select count(*) from rentas.unidad) + (select count(*) from rentas.owner) + (select count(*) from rentas.guest_minimo) + (select count(*) from rentas.reserva_financiero) + (select count(*) from rentas.linea_gasto) + (select count(*) from rentas.tarea_operativa) + (select count(*) from rentas.conversacion) + (select count(*) from rentas.plantilla_mensaje) + (select count(*) from rentas.canal_feed_externo) = 0 and (select count(*) from core.organization where id = '00000000-0000-0000-0000-0000000000a9') = 1 and (select count(*) from rentas.regla_comision_canal where organization_id = '00000000-0000-0000-0000-0000000000a9') = 4)::int as demo_borrada_y_ajena_intacta_deberia_ser_1;
rollback;

\echo '--- D7. un propietario compartido con OTRA organizacion se conserva al limpiar (solo se borran los que eran exclusivos de la demo) ---'
begin;
select public.seed_rentas_demo();
insert into rentas.owner_organization (owner_id, organization_id) select o.id, '00000000-0000-0000-0000-0000000000a9' from rentas.owner o where o.email = 'ana.propietaria@example.test';
select public.limpiar_rentas_demo();
select ((select count(*) from rentas.owner) = 1 and (select count(*) from rentas.owner where email = 'ana.propietaria@example.test') = 1)::int as propietario_compartido_conservado_deberia_ser_1;
rollback;

\echo '--- D8. limpiar sin demo cargada no hace nada ni falla ---'
begin;
select public.limpiar_rentas_demo();
select (select count(*) from core.organization where id = '00000000-0000-0000-0000-0000000000a9') as organizacion_ajena_intacta_deberia_ser_1;
rollback;

\echo ''
\echo '==> listo -- los escenarios marcados con should_fail deben terminar en ERROR; los demas devuelven el valor indicado en el alias.'

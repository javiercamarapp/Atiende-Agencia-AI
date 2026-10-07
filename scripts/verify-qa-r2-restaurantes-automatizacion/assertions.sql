-- QA adversarial R2 (lente automatizacion), restaurantes. Escenarios contra Postgres real (todas las migraciones).
-- Salida: una linea `RESULTADO <id> OK|DEFECTO <detalle>` por escenario. Sesion de SISTEMA = sin request.jwt.claim.sub
-- (auth.uid() nulo), igual que `withAppSession({ userId: null })` del tick.
\set QUIET on

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a001', 'restaurantes', 'QA R2 Automatizacion', 'qa-r2-auto')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-00000000a001', 'Merida (PM, cierra 01:00)'),
  ('00000000-0000-0000-0000-00000000a0a2', '00000000-0000-0000-0000-00000000a001', 'Cancun'),
  ('00000000-0000-0000-0000-00000000a0a3', '00000000-0000-0000-0000-00000000a001', 'Saturacion')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria) values
  ('00000000-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-00000000a001', 'merida', 'America/Merida'),
  ('00000000-0000-0000-0000-00000000a0a2', '00000000-0000-0000-0000-00000000a001', 'cancun', 'America/Cancun'),
  ('00000000-0000-0000-0000-00000000a0a3', '00000000-0000-0000-0000-00000000a001', 'saturacion', 'America/Merida')
on conflict do nothing;

insert into restaurantes.products (id, organization_id, name, price) values
  ('00000000-0000-0000-0000-00000000a0c1', '00000000-0000-0000-0000-00000000a001', 'Gringa de pastor', 85),
  ('00000000-0000-0000-0000-00000000a0c2', '00000000-0000-0000-0000-00000000a001', 'Agua de horchata', 35)
on conflict do nothing;
insert into restaurantes.branch_products (property_id, product_id, price, is_available) values
  ('00000000-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-00000000a0c1', 85, true),
  ('00000000-0000-0000-0000-00000000a0a2', '00000000-0000-0000-0000-00000000a0c2', 35, true)
on conflict do nothing;

-- =====================================================================================================================
-- S1. "Agotado hasta manana" y el DIA DE NEGOCIO (PM abre 12:00-01:00). El staff marca el producto agotado el SABADO
--     10-oct-2026 a las 23:30 de Merida (UTC-6): la API (autopiloto.ts) calcula hasta = dia CALENDARIO local + 1 = 2026-10-11.
--     El tick de las 00:10 del domingo (06:10Z) ya ve fecha local 2026-10-11 >= hasta y lo REPONE mientras el turno del
--     sabado sigue abierto hasta la 01:00 -> el agente vuelve a vender lo que cocina ya no tiene en la ultima hora.
-- =====================================================================================================================
update restaurantes.branch_products set is_available = false, agotado_hasta = date '2026-10-11'
 where property_id = '00000000-0000-0000-0000-00000000a0a1' and product_id = '00000000-0000-0000-0000-00000000a0c1';
-- Cancun (UTC-5): marcado el sabado 23:40 local; tick a las 00:05 del domingo (05:05Z).
update restaurantes.branch_products set is_available = false, agotado_hasta = date '2026-10-11'
 where property_id = '00000000-0000-0000-0000-00000000a0a2' and product_id = '00000000-0000-0000-0000-00000000a0c2';

-- Cancun primero: el tick de las 06:10Z (01:10 en Cancun) tambien repondria el de Cancun.
select 'RESULTADO S1b-agotado-cancun-00:05 ' || case when n = 0 then 'OK'
       else 'DEFECTO se repuso a las 00:05 del domingo (Cancun, UTC-5) con el turno del sabado abierto (repuestos=' || n || ')' end
  from (select count(*) as n from restaurantes.agotados_reponer(timestamptz '2026-10-11 05:05:00+00')
         where property_id = '00000000-0000-0000-0000-00000000a0a2') x;
select 'RESULTADO S1a-agotado-merida-00:10 ' || case when n = 0 then 'OK (sigue agotado durante el turno del sabado)'
       else 'DEFECTO se repuso a las 00:10 del domingo con el turno del sabado abierto hasta la 01:00 (repuestos=' || n || ')' end
  from (select count(*) as n from restaurantes.agotados_reponer(timestamptz '2026-10-11 06:10:00+00')
         where property_id = '00000000-0000-0000-0000-00000000a0a1') x;

-- =====================================================================================================================
-- S2. Saturacion: `tiempo_entrega_muestras.abiertos` cuenta TODOS los pedidos abiertos de la historia (sin ventana).
--     Pedidos olvidados (en_camino que el repartidor no cerro, recoger sin hora que nadie marco) se acumulan por dias y
--     dejan la sucursal "saturada" para siempre: +extra minutos a cada cliente y la propuesta de pausar la sucursal.
-- =====================================================================================================================
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, canal, hora_recogida)
select '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a3', 'Olvidado ' || g, '99900000' || lpad(g::text, 2, '0'), 100,
       case when g <= 8 then 'en_camino' else 'listo_para_recoger' end, '[]', case when g <= 8 then 'whatsapp' else 'web' end,
       timestamptz '2026-10-07 01:00:00+00' - make_interval(days => 1 + (g % 3)), case when g <= 8 then 'domicilio' else 'recoger' end, null
  from generate_series(1, 12) g;

select 'RESULTADO S2-abiertos-historicos ' || case when abiertos = 0 then 'OK'
       else 'DEFECTO abiertos=' || abiertos || ' a las 19:00 de hoy con 0 pedidos de hoy (son de hace 2 a 4 dias): con umbral1=10 la sucursal queda saturada para siempre' end
  from (select (restaurantes.tiempo_entrega_muestras('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a3', 'domicilio',
                timestamptz '2026-10-08 01:00:00+00', 30)->>'abiertos')::int as abiertos) x;

-- =====================================================================================================================
-- S3. Pedido para RECOGER sin hora de recogida (el storefront web no la manda nunca; el agente la deja opcional) que
--     queda en listo_para_recoger: ni el barrido de estados sin clic (no_recogido exige hora_recogida) ni las alertas
--     operativas (entrega_tardia solo mira preparando/en_camino) lo tocan JAMAS. Se queda en el tablero de cocina.
-- =====================================================================================================================
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, canal, hora_recogida) values
  ('00000000-0000-0000-0000-00000000a0d1', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'Recoge web', '9991112233', 170,
   'listo_para_recoger', '[]', 'web', timestamptz '2026-10-07 18:00:00+00', 'recoger', null);

select 'RESULTADO S3a-recoger-sin-hora-estados ' || case when n > 0 then 'OK'
       else 'DEFECTO listo_para_recoger desde hace 7 h sin hora_recogida: 0 candidatos de no_recogido/completado (queda abierto para siempre)' end
  from (select count(*) as n from restaurantes.autopiloto_candidatos_estados(timestamptz '2026-10-08 01:00:00+00', 1000)
         where order_id = '00000000-0000-0000-0000-00000000a0d1') x;
select 'RESULTADO S3b-recoger-sin-hora-avisos ' || case when n > 0 then 'OK'
       else 'DEFECTO ninguna alerta operativa para el pedido listo para recoger hace 7 h' end
  from (select count(*) as n from restaurantes.avisos_operativos_candidatos(timestamptz '2026-10-08 01:00:00+00')
         where order_id = '00000000-0000-0000-0000-00000000a0d1') x;

-- =====================================================================================================================
-- S4. Pedido PENDING que nadie acepta (sin POS o con la aceptacion automatica apagada, su valor por omision): no hay alerta
--     operativa (entrega_tardia excluye pending) aunque lleve 2 h; el cliente espera sin que nadie lo sepa.
-- =====================================================================================================================
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, canal) values
  ('00000000-0000-0000-0000-00000000a0d2', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'Sin aceptar', '9991112244', 240,
   'pending', '[]', 'whatsapp', timestamptz '2026-10-07 23:00:00+00', 'domicilio');
select 'RESULTADO S4-pending-sin-aceptar ' || case when n > 0 then 'OK'
       else 'DEFECTO pedido pending desde hace 2 h: ninguna alerta (entrega_tardia solo cubre preparando/en_camino)' end
  from (select count(*) as n from restaurantes.avisos_operativos_candidatos(timestamptz '2026-10-08 01:00:00+00')
         where order_id = '00000000-0000-0000-0000-00000000a0d2') x;

-- =====================================================================================================================
-- S5. Tiempo prometido aprendido a medianoche: la franja "hora +-1" no da la vuelta al dia. A las 00:20 de Merida las 25
--     entregas de las 23:xx (misma noche de negocio) no cuentan (|23-0| = 23), asi que despues de medianoche el agente
--     cae al texto fijo aunque haya muestras de sobra.
-- =====================================================================================================================
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, canal)
select '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'Muestra ' || g, '99800000' || lpad(g::text, 2, '0'), 120,
       'completado', '[]', 'whatsapp',
       -- sabados anteriores 23:10 de Merida (05:10Z del domingo), entregados 40 min despues
       timestamptz '2026-10-04 05:10:00+00' - make_interval(days => 7 * (g % 5)), timestamptz '2026-10-04 05:50:00+00' - make_interval(days => 7 * (g % 5)), 'domicilio'
  from generate_series(1, 25) g;
select 'RESULTADO S5-muestras-cruce-medianoche ' || case when n >= 20 then 'OK'
       else 'DEFECTO a las 00:20 del domingo (turno del sabado) solo ' || n || ' muestras de las 25 entregas de las 23:xx de sabados anteriores' end
  from (select jsonb_array_length(restaurantes.tiempo_entrega_muestras('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'domicilio',
               timestamptz '2026-10-11 06:20:00+00', 30)->'muestras') as n) x;

-- Cobertura (debe dar OK hoy): a las 11:00 del domingo (17:00Z) el agotado de Merida SI se repone (ya es otro dia de negocio).
update restaurantes.branch_products set is_available = false, agotado_hasta = date '2026-10-11'
 where property_id = '00000000-0000-0000-0000-00000000a0a1' and product_id = '00000000-0000-0000-0000-00000000a0c1';
select 'RESULTADO C1-agotado-se-repone-de-dia ' || case when n = 1 then 'OK' else 'DEFECTO no se repuso (n=' || n || ')' end
  from (select count(*) as n from restaurantes.agotados_reponer(timestamptz '2026-10-11 17:00:00+00')
         where property_id = '00000000-0000-0000-0000-00000000a0a1') x;
select 'RESULTADO C2-agotado-idempotente ' || case when n = 0 then 'OK' else 'DEFECTO se repuso dos veces (n=' || n || ')' end
  from (select count(*) as n from restaurantes.agotados_reponer(timestamptz '2026-10-11 17:05:00+00')) x;

-- =====================================================================================================================
-- S6. Cierre del dia con turno que cruza la medianoche (PM 12:00-01:00). Sabado 3-oct-2026: 2 pedidos a las 21:00 y
--     2 pedidos a las 00:30 del domingo (06:30Z), todos del TURNO DEL SABADO. generar_cierre('dia', '2026-10-03') corta a
--     medianoche calendario: la ultima hora del turno se va al cierre del domingo. El cierre del sabado y el del domingo
--     quedan mal (y son inmutables: `on conflict do nothing`).
-- =====================================================================================================================
insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000a0a4', '00000000-0000-0000-0000-00000000a001', 'Cierre PM') on conflict do nothing;
insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria) values
  ('00000000-0000-0000-0000-00000000a0a4', '00000000-0000-0000-0000-00000000a001', 'cierre-pm', 'America/Merida') on conflict do nothing;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, canal) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a4', 'Cena 1', '9997770001', 300, 'entregado', '[]', 'whatsapp', timestamptz '2026-10-04 03:00:00+00', timestamptz '2026-10-04 03:40:00+00', 'domicilio'),
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a4', 'Cena 2', '9997770002', 300, 'entregado', '[]', 'whatsapp', timestamptz '2026-10-04 03:05:00+00', timestamptz '2026-10-04 03:45:00+00', 'domicilio'),
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a4', 'Trasnoche 1', '9997770003', 500, 'entregado', '[]', 'voice', timestamptz '2026-10-04 06:30:00+00', timestamptz '2026-10-04 07:00:00+00', 'domicilio'),
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a4', 'Trasnoche 2', '9997770004', 500, 'entregado', '[]', 'whatsapp', timestamptz '2026-10-04 06:40:00+00', timestamptz '2026-10-04 07:05:00+00', 'domicilio');
select 'RESULTADO S6-cierre-dia-de-negocio ' || case when pedidos = 4 then 'OK'
       else 'DEFECTO el cierre del sabado cuenta ' || pedidos || ' de los 4 pedidos del turno (ventas_centavos=' || ventas || '); los de 00:30-00:40 se van al domingo' end
  from (select (c.datos->>'pedidos')::int as pedidos, (c.datos->>'ventas_centavos') as ventas
          from restaurantes.generar_cierre('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a4', 'dia', date '2026-10-03') c) x;

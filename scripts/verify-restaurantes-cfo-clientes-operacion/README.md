# verify-restaurantes-cfo-clientes-operacion

Verificacion contra Postgres real de `packages/domain-restaurantes/migrations/082_cfo_clientes_agente_operacion.sql`
(espejo: `supabase/migrations/20240101000392_082_cfo_clientes_agente_operacion.sql`): SQL de clientes, agente (embudo y costos), operacion
(entregas, repartidores, colonias), comandas del POS y agotados del modulo CFO de restaurantes (`restaurantes.cfo_*`, sobre la 081).

Corpus pequeno, con valores calculados a mano (organizaciones A con 3 sucursales: A1 con corte 01:00, A2 sin corte, A3 Auckland; B ajena; C, D y E para
concentracion, mediana y cohortes). Cubre:

- Clientes: bordes de activo/dormido/perdido (60/61 y 120/121 dias), frecuente (3 pedidos en 90 dias si, 2 no, el del dia 90 no cuenta), nuevo/recurrente,
  recuperado con envio de campana 13 dias antes (si) y 15 (no), concentracion top 10 %, mediana de dias entre pedidos, cohortes con recompra 30/60/90,
  altas por semana, segmento por hora; ruido que NO cuenta (cancelado, falso, demo, programado, por_aprobar).
- Agente: embudo de WhatsApp (demo fuera) y voz (preview fuera), costo de voz + telefonia contra `voz_kpis_diarios` (035) del mismo dia, la categoria
  `voz` NO se suma, sin `fx_rate` los centavos son NULL, 0 eventos de Meta => costo NULL, fila «No asignado» solo para organizacion completa o sistema.
- Operacion: entregas (el `completado` cuenta), percentiles nearest-rank, repartidores (nombre de staff solo si es de la organizacion), colonias con
  k-anonimato (4 pedidos => `(otras)`, 5 => se muestra), comandas del POS en todos sus estados y modo apagado, agotados con venta de 28 dias.
- Aditividad: consolidado == union de sucursales (+ «No asignado»); `Σ clientes de sucursales − conjunto = multi_sucursal`.
- Seguridad con el rol REAL `authenticated`: owner, admin sin acotar, admin acotado, staff, repartidor, otra organizacion, anon, sistema con sucursal
  ajena; rangos de 401 dias y parametros invalidos (22023); helpers cerrados; sin DML directo; funciones STABLE y corriendo en transaccion READ ONLY.
- `cfo_venta_lean` == `cfo_pedidos_base` pedido por pedido; `cfo_zonas` == `voz_zona_horaria`/`dia_negocio_corte`.
- Rendimiento: 20 000 pedidos (2 000 clientes), cada una de las 12 funciones en menos de 2 s.
- Grants, SECURITY DEFINER, search_path, COMMENT, sin PII en las firmas, idempotencia y base sin migrar (42883 recuperable con subtransaccion).

- Manual: `scripts/verify-restaurantes-cfo-clientes-operacion/run.sh` (levanta un Postgres efimero con `initdb`; `VERIFY_PGPORT` fija el puerto).
- CI: lo descubre automaticamente `scripts/verify-real-postgres-ci/run-gate.mjs` (mismo contrato de 3 archivos). Con un Postgres propio:
  `PGPORT=<puerto> node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-restaurantes-cfo-clientes-operacion`.

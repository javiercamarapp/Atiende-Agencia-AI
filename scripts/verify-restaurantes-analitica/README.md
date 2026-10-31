# verify-restaurantes-analitica

Verificacion contra Postgres real de las migraciones `160`-`163` de `packages/domain-restaurantes/migrations/` (espejos `supabase/migrations/20240101000460`-`463`):
analitica del dueno de restaurantes (F7), solo lectura salvo el costo por producto.

- `analitica_demanda`: matriz dia de la semana x hora x canal x origen, tendencia semanal, ticket (promedio, mediana, p90), mezcla de pago y entrega real contra la promesa.
- `analitica_zonas`: venta y tiempo de entrega real por colonia con k-anonimato (>= 5 pedidos y >= 5 clientes, el resto es «(otras)»; «sin colonia / recoge»).
- `analitica_productos`, `analitica_costo_producto_guardar`: mas vendidos, margen solo con costo capturado, pares con soporte/confianza/lift y bandera «en el menu» / oportunidad.
- `analitica_combo_sugerir`: gancho de sugerencia de combo para el agente (solo sistema). Solo promociones de cortesia vigentes en la sucursal, canal, dia y horario.
- `analitica_ratios`: conteos para los ratios (ticket, frecuencia, recompra 14/30/60, cancelacion, pedidos grandes, conversion chat->pedido, primera respuesta, agente vs
  escalado, costo por conversacion). Los porcentajes se calculan en `packages/domain-restaurantes/src/analitica/ratios.ts`.
- `analitica_alertas_candidatos`, `analitica_pregunta_estado`: ETA prometido > 60 min y «¿ya salio?» sin contestar (solo sistema, sin PII).

Corpus SINTETICO con valores calculados a mano (cabecera de `assertions.sql`). Cada escenario termina en UN `count(*)` entero con el alias `<nombre>_deberia_ser_<N>` o en
`should_fail`. Cubre owner, admin acotado, staff, repartidor, otra organizacion (cross-tenant), anon, sucursal ajena, rangos invalidos, privacidad (k), costos, vigencia
de promociones, ventanas de alerta y la postura de seguridad (SECURITY DEFINER con search_path fijo, sin permisos para anon, tabla de costos cerrada).

- Manual: `scripts/verify-restaurantes-analitica/run.sh` (Postgres efimero con `initdb`; `VERIFY_PGPORT` fija el puerto). Aplica 160-163 una segunda vez (idempotencia).
- CI: lo descubre `scripts/verify-real-postgres-ci/run-gate.mjs` (contrato de 3 archivos).

NOTA: este corpus se escribio en una maquina sin Postgres; el primer corrimiento real es el del CI.

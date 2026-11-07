# Analítica del dueño (F7)

Pestañas del CFO (`/restaurantes/:org/cfo/demanda|zonas|combos|ratios`), solo owner/admin (acción `cfo.ver`). SQL en las migraciones 160-163 de
`packages/domain-restaurantes/migrations/`; dominio puro en `packages/domain-restaurantes/src/analitica/`; rutas en
`apps/api/src/routes/verticals/restaurantes/analitica.ts` (`/v1/restaurantes/:propertyId/admin/analitica/{demanda,zonas,productos,ratios}`).

- **Demanda**: pedidos por día de la semana (ISO) y hora, por sucursal, canal y origen; picos = las dos horas con más pedidos; refuerzo = celdas en o sobre el percentil 80;
  vie–dom; tendencia semanal (la variación solo compara semanas completas); ticket promedio/mediana/p90; mezcla de pago; entrega real contra la promesa
  (`orders.estimated_delivery_at`). Con menos de 28 días con venta se avisa que no hay estacionalidad.
- **Zonas**: venta y tiempo real de entrega por colonia, k = 5 (pedidos y clientes); `(otras)` y `sin colonia / recoge`. No hay mapa geográfico: no existen coordenadas por colonia.
- **Productos y combos**: más vendidos, margen solo con costo capturado (`PUT .../productos/:id/costo`, solo dueño/admin de toda la organización), pares con soporte/confianza/lift y
  estado «en el menú» (promoción de cortesía vigente) u oportunidad.
- **Sugerencia de combo para el agente**: `consultarComboSugerido` (`analitica/servidor.ts`) → `restaurantes.analitica_combo_sugerir`. Devuelve `null` si no hay una promoción de cortesía
  vigente (sucursal, canal, día, horario, tope) cuyo disparador esté en el borrador y cuyo producto regalado esté disponible. Nunca trae precios: el monto lo da `cotizar_pedido`.
  El hook NO está conectado todavía a las herramientas del agente (ver huecos en el reporte de la rama).
- **Ratios**: definiciones exactas en `DEFINICIONES_RATIOS` (`analitica/ratios.ts`); el panel las muestra.
- **Alertas**: `restaurantes.pedido.eta_alta` y `restaurantes.chat.ya_salio_sin_respuesta` por el mecanismo de avisos (`emitirNotificacion`), dentro del tick de 5 min.

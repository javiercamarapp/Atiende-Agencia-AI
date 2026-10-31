# verify-restaurantes-historico

Verificacion, contra un Postgres **real**, de `packages/domain-restaurantes/migrations/140_historial_importacion_perfil.sql`,
`141_historial_fusion_duplicados.sql` y `142_historial_segmentos_rfm_cuentas.sql`. Todos los datos son SINTETICOS.

## Que demuestra

- **A) `importar_historial`**: la vista previa no escribe; aplicar crea clientes nuevos con origen `importacion_historica` y telefono de 10 digitos;
  NO pisa el nombre ni mueve `order_count`/`last_order_at`; NO crea pedidos ni consentimiento de marketing; solo guarda categorias de queja validas;
  idempotente (segunda corrida: 0 creadas, todo sin cambio); una fila con numero invalido se rechaza sin tumbar el lote; un titular suprimido por ARCO
  no se reimporta; otra organizacion, staff no admin, sesion de sistema, anon y huella invalida son rechazados.
- **B) `cliente_perfil_historico`**: solo sistema; null sin historial y entre organizaciones.
- **C) ARCO**: `historial_exportar` / `historial_borrar` (solo owner/admin; borrar elimina el resumen y el domicilio historico).
- **D) `historial_fusionar_duplicados`**: vista previa sin escribir; fusiona por ultimos 10 digitos, suma pedidos, mueve pedidos y domicilios sin duplicar,
  el consentimiento mas restrictivo gana, queda registro de la fusion; otra organizacion y staff rechazados.
- **E) `historial_segmentos`**: segmentos, reactivables (nunca con queja abierta), cuentas de kilo y candidatas a evento; alias de 8 caracteres; roles.

Convencion del gate: cada escenario termina en un unico `count(*)` entero con alias `deberia_ser_N`, o en `should_fail`.

```
scripts/verify-restaurantes-historico/run.sh
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-restaurantes-historico
```

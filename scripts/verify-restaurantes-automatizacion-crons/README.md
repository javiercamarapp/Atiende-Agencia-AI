# verify-restaurantes-automatizacion-crons

Lote QA R1 (lente automatizacion, restaurantes), migracion 041, contra un Postgres **efimero** con TODAS las migraciones
reales. Cada escenario termina en error si el comportamiento no es el esperado (el gate de CI, `run-gate.mjs`, lo
descubre solo):

- S1/S1b (QA-04): la purga cuenta las llamadas procesadas, con o sin `caller_hash`.
- S2 (QA-05): la purga vacia `orders.call_transcript/call_recording_url`, `messaging_outbox.payload` y
  `staff_order_notification.message` vencidos; conserva lo reciente, lo pendiente de enviar y a un titular con ARCO abierto.
- S2b/S2c: un staff autenticado y `anon` no pueden ejecutar la purga de sistema.
- S3 (QA-02): `pos_comanda_promovidos_sin_comanda` devuelve solo promovidos vivos, sin comanda, con la bandera encendida.
- S3b/S3c: staff y `anon` no la ejecutan.

Uso manual: `bash /Users/javiercamaraportepetit/atiende-loop/heavy.sh scripts/verify-restaurantes-automatizacion-crons/run.sh`

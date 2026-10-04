# verify-qa-restaurantes-automatizacion

QA adversarial ronda 1, lente **automatizacion** de la vertical restaurantes (crons, purgas, promociones, KPIs de voz).
Corre contra un Postgres **efimero local** con TODAS las migraciones reales; nunca toca la base real.

Cada escenario imprime `veredicto`: `OK` o `DEFECTO QA-restaurantes-R1-automatizacion-NN: ...` (ver
`~/atiende-loop/work/qa/restaurantes/ronda-1-automatizacion.md` para el detalle de cada defecto).

- S1 (04): la purga procesa llamadas sin `caller_hash` pero las reporta como 0; el cron corta su bucle de lotes.
- S2 (05): datos personales fuera del alcance de la purga (`orders.call_transcript`/`call_recording_url`, `messaging_outbox.payload`, bandeja de staff).
- S3 (08): llamada sin cierre queda "en curso" para siempre.
- S4 (07): un programado vencido hace horas entra a cocina sin marca ni aviso.
- S5 (cobertura): cruce de anio (Merida) y hora repetida del horario de verano de Tijuana.
- S6 (cobertura): dos ejecuciones solapadas del cron de promocion promueven cada pedido una sola vez.

Uso: `bash ~/atiende-loop/heavy.sh scripts/verify-qa-restaurantes-automatizacion/run.sh`

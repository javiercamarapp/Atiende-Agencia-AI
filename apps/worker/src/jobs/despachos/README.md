# Vertical: despachos (worker)

Primer job real de este vertical (hallazgo de auditoría, severidad ALTA:
"ningún job en `apps/worker/src/jobs` para despachos, a diferencia de
citas/hoteles/licitaciones/rentas/restaurantes").

- `cobranza-reminders.ts` — `runCobranzaReminderSweep`: barrido transversal
  (todas las organizaciones activas, todas sus properties) que decide qué
  cuenta por cobrar tiene HOY un recordatorio de cobranza pendiente
  (`etapaRecordatorioCobranzaHoy`, motor puro de
  `packages/domain-despachos/src/cobranza/engine.ts`) y encola el correo real
  (`@atiende/domain-despachos::tryEnqueueCollectionReminderEmail`) cuando la
  cuenta tiene un contacto de correo capturado. Expuesto por
  `POST /internal/despachos/cobranza-reminders` (ver
  `apps/api/src/routes/verticals/despachos/notifications.ts`).

El escalamiento MANUAL de un vencimiento (`POST .../vencimientos/:id/escalar`) es una acción puntual del panel
(`apps/api/src/routes/verticals/despachos/vencimientos.ts`; su correo se encola inline en esa ruta). El barrido
AUTOMÁTICO diario lo hace `vencimientos-barrido.ts` (D-26, ver abajo), con avisos in-app y sin correo.

## efos-69b-ingestion.ts (D-04, lista 69-B del SAT)

`runEfos69bIngestion(withRepo, source, periodo)` parsea una edicion del CSV publico "Listado
completo 69-B" y la persiste via `repo.ingestarListaEfos` (funcion SQL `despachos.efos_ingestar_periodo`,
solo sesion de sistema, idempotente por periodo y SHA-256). Falla ENTERA si el archivo es invalido.

- **Sin llamadas al SAT**: la fuente es un adaptador (`Efos69bSource`). Hoy: subida manual por
  `POST /internal/despachos/efos-69b/ingestar?periodo=YYYY-MM` (secreto interno, cuerpo = CSV, tope 4 MB
  por el limite de cuerpo de las funciones de Vercel) y `FixtureEfos69bSource` (pruebas).
- **Descarga automatica (D-28)**: `efos-69b-http-source.ts` (`HttpEfos69bSource`) baja el CSV publico con streaming y
  tope de tamano (40 MB), y `efos-69b-descarga.ts` (`runEfos69bDescarga`) lo ingiere y alerta los CFDI afectados. Corre
  en el cron mensual `/internal/despachos/efos-69b/descarga` (dia 3, 07:40 UTC), dentro de la funcion pero fuera del cuerpo
  de una peticion, asi que no aplica el tope de 4 MB. La URL se configura con `EFOS_69B_URL`; el valor por defecto es
  la ruta historica del SAT y esta **NO VERIFICADO**.
- Requiere la migracion 014. Sin ella la ruta responde 503 y la validacion de CFDI muestra la lista como
  "no disponible" (nunca como "emisor limpio").

## cfdi-estatus-sat.ts (D-27, estatus del CFDI ante el SAT)

`runCfdiEstatusSatSweep(withUnidad, sat, opciones)` consulta el servicio PUBLICO ConsultaCFDIService (puerto
`ConsultaCfdiSatPort`, adaptador SOAP `ConsultaCfdiSatSoap` en `@atiende/domain-despachos`). Los mas antiguos primero
(`system_cfdi_pendientes_estatus_sat`, migracion 022), tope por corrida (60) y presupuesto de tiempo (22 s). La consulta
va fuera de la transaccion; cada resultado se registra en SU transaccion. Un timeout/red/XML ilegible solo anota el
intento (el CFDI conserva su estado; jamas pasa a "vigente" por error). Cron diario `/internal/despachos/cfdi-estatus-sat` (prioridad: nunca consultados, cancelacion en proceso, recientes y vigentes de la ventana de ejercicios; tope por cliente).
El SAT tiene limites de frecuencia **no documentados** y la salida de red desde Vercel hacia el SAT **no esta verificada**.

## vencimientos-barrido.ts (D-26, hueco del calendario fiscal)

`runVencimientosBarridoSistema(withUnidad)`: por cada cliente con ficha genera las obligaciones del periodo EN CURSO
(misma logica que `POST .../vencimientos/calcular`) y escala las que vencen hoy/manana o ya vencieron
(`decidirEscalamiento`). Emite `despachos.fiscal.vencimiento_proximo` / `_vencido` con dedupe diario por property. Una
transaccion por cliente; idempotente. NO encola correo de escalamiento (solo avisos in-app): el correo sigue saliendo del
boton del panel. Cron diario `/internal/despachos/vencimientos-barrido`.

# verify-hoteles-agentes-aprobaciones

Verificación contra Postgres REAL (mismo patrón que `scripts/verify-hoteles-tickets-sla/`) de
`packages/domain-hoteles/migrations/035_hoteles_agentes_aprobaciones.sql` (H-03: catálogo de agentes
con kill switch y presupuesto por property, costo acumulado, guardrails, políticas de acción, cola de
aprobaciones humanas y plantillas de WhatsApp versionadas).

```
scripts/verify-hoteles-agentes-aprobaciones/run.sh        # manual, Postgres efímero local
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-hoteles-agentes-aprobaciones
```

En CI lo ejecuta automáticamente el gate `Postgres real` (auto-descubre `scripts/verify-*`).

## Qué prueba (85 escenarios)

- Kill switch y presupuesto: pausar exige motivo y deja rastro; reanudar limpia; solo owner/gm escriben;
  columnas protegidas por GRANT de columna; cross-tenant y anon denegados; housekeeping/maintenance no ven.
- Costo acumulado y compuerta (`record_agent_usage`, `agent_gate`): solo sesión de sistema, aditivo, valida
  negativos/mes/agente; un usuario no puede escribirlos ni leer la compuerta.
- Guardrails: normalización (minúsculas, sin acentos, sin duplicados), rangos y ventana horaria; topes duros en el
  borde exacto (30% / 30.01%, $5,000.00 / +1 centavo, 200 / 201 destinatarios); palabras bloqueadas como palabra
  completa (no subcadena); agente pausado y cola llena bloquean.
- Políticas: gm no habilita ejecución automática (solo el dueño); contenido para el huésped siempre humano;
  auto bajo umbral en el borde exacto.
- Decidir: motivo obligatorio, roles por política (owner siempre), maker-checker, anti-replay (decidida no se
  vuelve a decidir), cross-tenant (P0002), expiración con reloj de usuario no rebobinable, guardrail vigente al aprobar.
- Consumir: una sola vez (replay = 55000), solo aprobadas, expiración, guardrail endurecido después de aprobar,
  horario de envío (08:00 inclusivo / 21:00 exclusivo, zona de la property, zona inválida cae al default).
- Inmutabilidad de lo propuesto y de los terminales aun con privilegios de servicio; sin INSERT/UPDATE/DELETE directos.
- Plantillas: versionado, validaciones, ciclo estricto, separación de funciones, una sola aprobada vigente,
  texto inmutable, palabra bloqueada.
- Metaverificaciones: `search_path` fijo en toda función definer, sin EXECUTE a anon/public, sin policies abiertas.
- Base sin migrar: con la tabla ausente (42P01) un SAVEPOINT recupera la transacción.

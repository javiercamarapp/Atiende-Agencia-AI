# verify-hoteles-reservar-publico

Verificación contra Postgres REAL (mismo patrón que `scripts/verify-hoteles-reservas-agente/`) de
`packages/domain-hoteles/migrations/044_hoteles_reservar_directo_publico.sql` (H-42: motor de reservas directo público del hotel:
canal `web` sobre `booking_hold`, anticipo opcional, pago que confirma la reserva `directo_web`, estado y cancelación por token).

```
scripts/verify-hoteles-reservar-publico/run.sh        # manual, Postgres efímero local (incluye concurrencia real)
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-hoteles-reservar-publico
```

En CI lo ejecuta automáticamente el gate `Postgres real` (auto-descubre `scripts/verify-*`).

## Qué prueba (28 escenarios)

- Política del canal web: fail-closed sin fila y sin opt-in (`web_enabled`); escritura por columna solo owner/gm; frontdesk, otro tenant y anon no.
- Hold web: precio recalculado en la base (un total distinto no crea hold), guardia de piso/techo, consentimiento y correo obligatorios,
  retención sin sobreventa, idempotencia por llave, SIN dedupe cruzado entre llaves (un token nunca apunta al hold de otra persona), topes por
  teléfono, correo y hotel, expiración sin cron.
- Pago: capturado confirma y crea la reserva `directo_web` sin doble conteo de inventario; fallido es reintentable; pago tardío no crea reserva;
  la confirmación del staff marca el pago como manual.
- Cancelación: hold abierto sin penalidad; confirmada con `cancellation_policy` (dentro y fuera de ventana, y sin política); reembolso solicitado
  y marcado procesado una sola vez; ya en check-in no se cancela en línea; todo idempotente.
- Aislamiento: cross-tenant y canal (un hold de WhatsApp no se ve por la vía web), solo sistema (staff y anon reciben 42501).
- Integridad: CHECK de coherencia, sin escritura directa del canal de la reserva, triggers anti-tamper, funciones definer con `search_path` fijo
  y sin EXECUTE para public/anon, consulta del KPI de room-nights directas.
- Concurrencia real (solo `run.sh`, dos conexiones): dos holds web por la última habitación (1 gana, 1 rechazo) y la misma llave en paralelo.

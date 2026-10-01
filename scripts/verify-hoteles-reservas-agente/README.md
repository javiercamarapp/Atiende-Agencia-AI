# verify-hoteles-reservas-agente

Verificación contra Postgres REAL (mismo patrón que `scripts/verify-hoteles-grupos/`) de
`packages/domain-hoteles/migrations/037_hoteles_agente_reservas.sql` (H-25: agente de reservas por WhatsApp y voz:
disponibilidad, cotización con guardia de precio, hold con expiración, aprobación humana o registro de link de pago,
estado y cancelación por el huésped).

```
scripts/verify-hoteles-reservas-agente/run.sh        # manual, Postgres efímero local (incluye concurrencia real)
node scripts/verify-real-postgres-ci/run-gate.mjs scripts/verify-hoteles-reservas-agente
```

En CI lo ejecuta automáticamente el gate `Postgres real` (auto-descubre `scripts/verify-*`).

## Qué prueba (39 escenarios)

- Cotización: centavos enteros desde `rate_plan` + `tax_config`, redondeo half-up, CTA/CTD/estancia mínima, moneda, guardia de
  piso/techo de `pricing_rule`, noche sin tarifa o sin inventario.
- Fechas: salida <= llegada, pasada, más de 365 días, más de 14 noches, nulas, y la fecha local de la property (CDMX vs Tijuana).
- Política: fail-closed sin fila; solo owner/gm la escriben; GRANT por columna; RLS de lectura; cross-tenant y anon.
- Hold: retiene cada noche, todo o nada, SIN sobreventa, idempotencia, precio calculado por la base (descuento pedido rechazado),
  tope por contacto y por hotel, expiración sin cron, solo sesión de sistema.
- Staff: aprobar/rechazar/cancelar/confirmar con rol real; link de pago solo registrado (sin PAN); la reserva se crea sin doble
  conteo de inventario.
- Huésped: estado y cancelación solo con id + teléfono; una confirmada se deriva a una persona.
- Integridad: sin escritura directa, triggers anti-tamper, bitácora inmutable, CHECKs, funciones definer con search_path fijo
  y sin EXECUTE para public/anon.

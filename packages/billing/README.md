# @atiende/billing

Motor de billing unificado de la plataforma: doble riel de cobro (Stripe +
transferencia/CLABE), CFDI 4.0, modelo per-seat generalizable a cualquier
vertical, y verificación cross-tenant de webhooks con ledger anti-replay.

Construido en la rama `feat/fusion-motor-billing-unificado` como el dominio
más repetido del análisis de los 5 repos origen — existían 4 implementaciones
independientes antes de este paquete. No se acopla a ningún otro paquete del
monorepo (`core-tenancy`, `core-auth`, `domain-*`): todo lo que necesita del
mundo exterior entra por interfaces inyectables (`LedgerStore`,
`TenantLookup`, `FacturaStore`, `PacClient`, `StripeClient`), así que las
decisiones de producto aún abiertas (facturación por organización vs. por
property, planes compartidos vs. independientes por vertical — ver la nota de
cierre original de este README) no bloquean su construcción ni su uso.

## Qué se portó de dónde

| Módulo | Patrón real portado | Repo de referencia |
|---|---|---|
| `ledger.ts` | `marcarEvento`/`ordenAplicado`/`sellarOrden` — el ledger anti-reordenamiento por entidad (RES-11, BACK-C4-1) | `~/likida.ai/src/lib/saas/suscripcion.ts` |
| `tenant-verification.ts` | "Defense-in-depth contra metadata-replay cross-tenant" — nunca confiar en el `tenant_id` del payload sin re-derivarlo | `~/GitHub-repos-backup/atiende.ai/atiende-ai/src/app/api/webhook/stripe/route.ts` |
| `per-seat.ts` | Modelo per-doctor (1 seat = 1 suscripción/cobro), generalizado a cualquier vertical | `~/GitHub-repos-backup/atiende.ai/atiende-ai/src/lib/billing/per-doctor.ts` |
| `iva.ts` | De qué lado del precio está el IVA (`desglosarPrecio`/`desgloseCuadra`) | `~/likida.ai/src/lib/saas/iva.ts` |
| `rails/transfer-rail.ts` | CLABE (dígito verificador 3-7-1), referencia determinista, `conciliar` compare-and-set | `~/likida.ai/src/lib/saas/transferencia.ts` |
| `rails/stripe-rail.ts` | Validación de price (recurrente/activo/MXN/>$0), checkout per-seat con metadata `tenant_id` | `~/likida.ai/src/lib/saas/suscripcion.ts` (`guardarPriceDePlan`) + patrón per-doctor de atiende.ai |
| `cfdi/catalogs.ts`, `cfdi/rfc.ts` | Catálogos SAT (UsoCFDI, FormaPago, MetodoPago, TipoComprobante, RegimenFiscal) y regex de RFC | `~/Desktop/supabase/despachos/b2b_ai/cfdi/catalogs.py`, `.../b2b_ai/common/rfc.py` |
| `cfdi/validator.ts` | Validación aritmética determinista (concepto, subtotal, IVA, total, tolerancia 2¢) | `~/Desktop/supabase/despachos/b2b_ai/cfdi/validator.py` |
| `cfdi/issuer.ts` | Timbrado sin desglose = rechazo; reserva antes de llamar al PAC | `~/likida.ai/src/lib/saas/facturapi.ts` + `transferencia.ts` (`timbrarFactura`) |

## Las tres garantías que los tests ejercen

1. **Un webhook con `tenant_id` falseado se rechaza** (`tests/tenant-verification.spec.ts`,
   `tests/webhook-integration.spec.ts`): si el customer del evento no coincide
   con el customer registrado del tenant (o, en primer checkout, el email no
   cruza contra el owner), el evento se rechaza antes de tocar ningún dato.
2. **El ledger nunca permite un cobro duplicado por reordenamiento**
   (`tests/ledger.spec.ts`, `tests/webhook-integration.spec.ts`): un evento
   reintentado (mismo id) es un no-op; un evento más viejo que el último ya
   aplicado a la misma entidad se descarta con `'fuera_de_orden'` sin volver
   a cobrar.
3. **El cálculo per-seat funciona igual de bien para verticales distintas**
   (`tests/per-seat.spec.ts`, `tests/webhook-integration.spec.ts`): la misma
   función `calcularPerSeat`, sin ifs por vertical, produce el cobro correcto
   tanto para hoteles (habitación) como para citas-reservaciones
   (doctor/proveedor) y restaurantes (agente de voz) a partir de su propia
   `SeatVerticalConfig`.

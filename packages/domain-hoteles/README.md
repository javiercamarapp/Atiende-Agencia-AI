# @atiende/domain-hoteles

Fase 1 de la migración del vertical hoteles — construido (ver `docs/REQUISITOS.md`
para el detalle de diseño y el commit que lo introdujo).

Subconjunto real (no la totalidad de `hoteles/packages/domain-hotel`, 34 archivos)
portado para sostener los 3 flujos elegidos:

- `folioEngine.ts` — cálculo de cargos por concepto, autorización de descuentos, la
  guarda anti-fraude de identidad de un cargo a habitación (REQ-AB-012:
  `assertRoomChargeIdentityVerified`/`ROOM_CHARGE_CONCEPTS_REQUIRING_IDENTITY`) y las
  reglas de cierre de folio.
- `taxes.ts` / `money.ts` — IVA/ISH paramétricos por property + redondeo centralizado.
- `fnbAllergyGuard.ts` — guardia de alergias de F&B (REQ-AB-004): sin confirmación
  humana de cocina, ningún endpoint puede afirmar que un platillo es seguro.
- `quote.ts` — motor de cotización determinista (REQ-REV-001/REQ-RES-002), guardia
  anti-alucinación de precio: `parseQuoteInput` nunca hace spread del body de entrada,
  arma el objeto campo por campo desde las columnas reales de `hoteles.rate_plan` — un
  precio "sugerido" externo es estructuralmente imposible que llegue a `computeQuote`.
  Adaptación deliberada del origen: sin `zod` (ninguna otra ruta/paquete de
  atiende-fusion lo usa), la misma garantía se logra por construcción del objeto.
- `overbooking.ts` — soporte de dominio de disponibilidad (sin ruta propia expuesta).
- `roles.ts` — mapeo `HOTEL_ROLES` (8 roles finos) -> `platformRole`/`verticalRole` de
  `@atiende/core-tenancy` (ver diseño Fase 1 §2 — decisión propia de este paquete, no
  1:1 con restaurantes por tener un rol de origen más plano).

Adaptadores duales (mismo patrón que `@atiende/domain-restaurantes`):
`InMemoryHotelesRepository` (tests, dev sin Postgres real) y
`PostgresHotelesRepository` (producción, sobre `TenantDbSession`).

Migraciones SQL reales en `migrations/` (schema `hoteles.*`, requiere
`packages/db/migrations/0001_core_schema.sql` aplicada antes) — incluye el port
literal del índice único parcial anti-doble-captura de night-audit
(`charge_folio_stay_date_hospedaje_idx`) y de la función `mark_charge_reversed()`
(SECURITY DEFINER). Idempotencia genérica de mutaciones de dinero/F&B vía
`hoteles.idempotency_key`, scope `charge.create|charge.discount|charge.reverse|
charge.transfer|folio.split|payment.create` — mismo patrón que
`restaurantes.create_order_idempotent`, cada vertical mantiene su propia tabla.

Explícitamente fuera de esta fase (ver diseño Fase 1 §6): agente de voz ElevenLabs,
dashboards de KPIs/ROI/P&L, panel de superadmin, `mensajeria.ts`/`agent-core` completo
de hoteles, máquina de estados completa de reservas, housekeeping, night-audit, CFDI,
identidad/MRZ, fraude, reputación, UGC, disponibilidad como ruta propia.

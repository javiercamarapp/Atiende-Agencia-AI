# verify-rentas-operar-tenant-nuevo

Verificación contra Postgres real de
`packages/domain-rentas/migrations/027_rentas_operar_tenant_nuevo.sql`
(Rn-18 reglas de comisión de canal configurables con sembrado por defecto; Rn-19 alta y edición de
propiedades, unidades y propietarios).

Se auto-descubre en CI (`scripts/verify-real-postgres-ci/run-gate.mjs`); a mano:
`scripts/verify-rentas-operar-tenant-nuevo/run.sh` (requiere `initdb`/`pg_ctl`/`psql`).

## Qué cubre (91 escenarios en `assertions.sql`)

- A. reglas de comisión (1-26): sembrado por defecto por trigger y bajo demanda (idempotente), alta
  global y por property, edición, validaciones (rango 0-10000 pb, "ya neto" implica 0 pb, fuente,
  canal), duplicado por alcance, y los rechazos de otra organización, admin acotado a una property,
  contador, solo-calendario, sesión de sistema, anon, INSERT/UPDATE directo.
- B. propiedades (27-47): alta con zona IANA real y moneda MXN/USD (EUR y zonas inventadas se rechazan),
  nombre duplicado sin distinguir mayúsculas, edición, moneda inmutable si ya hay movimientos
  financieros, alcance por property, cross-tenant.
- C. propietarios (48-65): alta/edición, correo duplicado, un propietario compartido con otra
  organización no es editable, cross-tenant en ambos sentidos.
- D. unidades (66-83): alta/edición, propietario de otra organización rechazado, nombre duplicado,
  estancia mínima 1-365, alcance por property, cross-tenant.
- E. definer y bitácora (84-91): las 12 funciones son `security definer` con `search_path` fijo, sin
  EXECUTE para public/anon, las 3 internas sin EXECUTE para authenticated, y el catálogo de
  `entity_type` de la bitácora acepta los tipos nuevos y sigue rechazando el resto.

## Qué NO cubre

- La concurrencia real de dos altas simultáneas con el mismo nombre (cada escenario corre en una sola
  transacción; el `unique (property_id, name)` de `rentas.unidad` es la red de seguridad final).
- La lógica TypeScript: la cubren las pruebas de `@atiende/domain-rentas`, `apps/api` y `apps/web`.

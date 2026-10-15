# seed-demo-cuenta -- cuenta demo FICTICIA «El Tizón Norteño»

Cadena ficticia de taquerías de estilo norteño para demostraciones: **6 sucursales** (Monterrey x2, Guadalajara, Ciudad de México, Puebla, Tijuana),
**289 productos** en 21 categorías, 95 colonias de reparto, 5 promociones, 22 entradas de conocimiento y un agente de WhatsApp (perfil `generico`).
Nada es real: marca, teléfonos (bloque `555 01xx`), correos (`.example`) y direcciones están inventados, y no comparte datos con la cuenta real de PM
(lo vigila `packages/domain-restaurantes/tests/demo-cuenta-originalidad.spec.ts`).

```
# Dry-run (por omisión): valida la definición e imprime el plan; no abre ninguna conexión.
npx vite-node scripts/seed-demo-cuenta/seed-demo-cuenta.ts

# Escribir en una base LOCAL/de pruebas ya migrada:
SEED_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/atiende_demo \
  npx vite-node scripts/seed-demo-cuenta/seed-demo-cuenta.ts -- --apply
```

## Dónde vive cada pieza

- `packages/domain-restaurantes/src/seed/demo-cuenta/*.ts`: la definición (datos puros y tipados), `plan.ts` (valida y arma el plan; lanza `DemoCuentaError` si una invariante se rompe) y `sql.ts` (renderiza el bloque plpgsql idempotente).
- Slug de la organización: `demo-cadena`. El plan **rechaza** el slug `demo-restaurantes` (la «Taquería Demo»): este seed no la toca ni la borra.

## Salvaguardas

- Sin `--apply` nunca escribe. Solo lee `SEED_DATABASE_URL` (a propósito **no** `DATABASE_URL`) y comparte las reglas de `target-safety.ts` con el seed de PM: imprime la base, la marca `(local)`/`(REMOTA)` y exige `--confirm-host=<host exacto>` si no es local.
- Antes de escribir comprueba que el esquema tenga las columnas que el seed usa (mismo preflight que PM, más `demo_organization`); si faltan, lista las migraciones y sale con código 3.
- Todo en una sola transacción, acotado a la organización `demo-cadena`; si ese slug existe en otra vertical, aborta.
- Sin secretos ni usuarios: no crea credenciales ni membresías. La voz se carga **deshabilitada** (sin gasto de proveedores). No genera pedidos.

## Idempotencia

Re-ejecutar repara lo que el seed controla (nombres, precios, horarios, minimos, cobertura, alcance de promociones) y **no** pisa decisiones del dueño:
no vuelve a prender un producto agotado, no reactiva la voz, no reinicia contadores de promociones, no sobrescribe conocimiento ni textos del agente editados y no borra productos que el dueño haya agregado.
Lo que el plan deja de vender en una sucursal se retira de `branch_products` (acotado a la organización y a productos del plan).

## Pendiente (hueco conocido)

- El seed **no se ha ejecutado contra ningún Postgres**: el SQL solo está probado como texto (forma, guardas, determinismo). Falta un `scripts/verify-*` contra Postgres real que lo corra dos veces (como `verify-restaurantes-seed-pm`).
- No incluye volumen de pedidos ficticios.

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

## Generar un archivo `.sql` para pegar en el SQL Editor de Supabase (`--emit-sql`)

Sin credenciales, sin `SEED_DATABASE_URL`, sin resetear ninguna contraseña y **sin abrir ninguna conexión**: el comando solo escribe un archivo.

```
npx vite-node scripts/seed-demo-cuenta/seed-demo-cuenta.ts -- --emit-sql=demo-cuenta.sql [--owner-email=correo@existente]
```

El archivo es `begin; preflight de esquema; seed idempotente; comprobación de conteos; commit;` seguido de un `SELECT` de verificación (una fila por concepto:
organizaciones, sucursales, productos, precios por sucursal, alcohol sin domicilio, promociones, zonas de reparto, conocimiento y voz). Los datos viajan como JSON
entre dollar-quotes (`$dc$`): comillas, `$$` o `;` en un texto no pueden inyectar SQL, y si un dato contiene un delimitador reservado la emisión se aborta.
El SQL del paso 1-N es el mismo de `--apply` (`sql.ts`), sin copia. Los comentarios de arriba del archivo dicen qué hace, que es idempotente y que no borra
nada ni toca otras organizaciones (la «Taquería Demo» vieja `demo-restaurantes` y la cuenta real de PM quedan intactas).

`--owner-email=<correo>` (opcional) da membresía `owner` a un usuario de staff que **ya exista** con ese correo; nunca crea usuarios ni credenciales. Sin esa opción la
cuenta queda sin dueño y se puede asignar después regenerando el archivo con el correo y pegándolo otra vez (es idempotente). `--emit-sql` no se combina con `--apply`.

Pasos exactos:

1. Genere el archivo (ver arriba). Imprime la ruta, el tamaño y su `sha256`.
2. Revíselo: abra el `.sql`; los comentarios del inicio resumen lo que hace y todo lo demás es el mismo seed que valida el CI.
3. En Supabase: **SQL Editor → New query**, pegue el archivo **completo** (ejecuta con el rol `postgres`) y pulse **Run**.
4. Verifique: el resultado final es la tabla `metrica / obtenido / esperado / ok`; deben salir `organizaciones 1`, `sucursales 6`, `productos 289`,
   `precios_por_sucursal 1666`, `productos_alcohol_sin_domicilio 33`, `promociones 5`, `zonas_de_reparto 101`, `conocimiento_publicado 22`, `voz_deshabilitada 6`, todas con `ok = true`.
   Si falta una migración, el script se detiene en el preflight con la lista de migraciones y no escribe nada; si un conteo crítico queda corto, revierte todo.

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

## Verificación contra Postgres real

`scripts/verify-restaurantes-seed-demo-cuenta/` ejecuta el bloque REAL del seed contra todas las migraciones en el gate de Postgres real del CI
(`postgres-real-gate.yml`): 6 sucursales, 289 productos, 1666 precios, voz deshabilitada con `voice_id`, idempotencia (dos corridas, misma huella de conteos),
la Taquería Demo vieja intacta y rechazo de un slug de otra vertical. Los escenarios E1 y E2 ejecutan el archivo de `--emit-sql` (sin su `begin`/`commit`, byte a byte):
E1 lo corre dos veces seguidas y exige los conteos exactos; E2 lo corre con un nombre, una descripción y un saludo que traen comillas, `$$`, `$1`, `;`, `--` y barras, más `--owner-email`
de un usuario existente (los textos quedan literales, hay una sola membresía owner y el esquema `core` sigue ahí). `assertions.sql` es generado
(`npx vite-node scripts/verify-restaurantes-seed-demo-cuenta/generar-assertions.ts`) y un test de vitest falla si se desincroniza.

## Pendiente (hueco conocido)

- No incluye volumen de pedidos ficticios.

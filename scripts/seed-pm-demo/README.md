# seed-pm-demo -- cuenta demo "Los Taquitos de PM" (R-01)

Seed **repetible e idempotente** de la organizacion demo del primer cliente real (6 sucursales). No es una
migracion: es un script que se ejecuta a mano, y **nunca contra la base real sin el OK del dueño del proyecto**.

```
# Dry-run (por defecto): valida los datos e imprime el plan; no abre ninguna conexion.
node --experimental-strip-types scripts/seed-pm-demo/seed-pm-demo.ts

# Escribir en una base LOCAL/de pruebas ya migrada:
SEED_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/atiende_demo \
  node --experimental-strip-types scripts/seed-pm-demo/seed-pm-demo.ts --apply [--owner-email=correo@ya-existente]
```

Salvaguardas (`packages/domain-restaurantes/src/seed/target-safety.ts`, con tests):
- Sin `--apply` nunca escribe. Solo lee `SEED_DATABASE_URL` (a proposito **no** `DATABASE_URL`).
- Imprime la base objetivo (host:puerto/base, sin usuario ni contraseña) y la marca `(local)` o `(REMOTA)`.
- Contra una base que no sea local exige `--confirm-host=<host exacto>`.
- Antes de escribir comprueba que existan las migraciones 022, 023, 025 y 027 y, si faltan, lista cuales y sale con codigo 3.
- Todo ocurre en una sola transaccion (`begin`/`commit`) y dentro de la organizacion `los-taquitos-de-pm`; si ese slug ya
  existe en otra vertical, aborta sin tocarla. No crea usuarios ni credenciales (`--owner-email` solo enlaza a un usuario
  de staff que YA existe).

## Que carga

| Dato | Detalle |
| --- | --- |
| Sucursales | 6 (T1 Prolongacion Montejo, T2 Francisco de Montejo, T3 Pensiones, T4 pendiente, T7 Victory Platz, T8 Victory Altabrisa). T4 queda **inactiva y sin menu** (sin direccion ni telefono). T3 no tiene coordenadas. |
| Menu | 251 productos en 24 categorias (245 + 6 de comida regional). Menu grande (T1, T7, T8) = todo; menu chico (T2, T3) = sin comida regional. Precios iguales en todas las sucursales. |
| Alcohol | 42 productos marcados `no_domicilio` (por producto, no por categoria). |
| Politica | Una franja 12:00-01:00 todos los dias, pedido minimo a domicilio $200, propina solo con tarjeta. |
| Promocion | `LUNES2X1PM`: 2x1 en tacos al pastor, lunes, **solo recoger**. El combo del martes (nachos + 2 aguas de cortesia) no se carga: necesita otro tipo de promocion. |
| Zonas conocidas | Un punto por sucursal con coordenadas (el mapa de colonias del dueño sigue pendiente; no se inventan). Sin cobertura de entrega configurada. |
| Agente | Voz **deshabilitada** (`habilitado = false`, sin gasto de proveedores) con `comportamiento` (voz y trato, reglas duras, seguridad y datos del negocio, <= 8000 caracteres) y saludo por sucursal. `data/agente/` guarda el prompt, las herramientas y las 68 evals del experto; el seed los valida (herramientas mencionadas en el prompt, ids unicos). |

Los datos salen de `pm-datos.json` del paquete PM (cuestionario del dueño + repo `lostaquitosdepm`), **recortado**: sin
volumenes de pedidos ni datos operativos internos. Lo que el dueño aun no entrego (hora de cambio de turno, numeros de WhatsApp por
sucursal, coordenadas de T3, mapa de colonias, catalogo de SoftRestaurant) no se inventa.

## Pruebas

- `packages/domain-restaurantes/tests/seed-pm-demo.spec.ts`: plan e invariantes, datos invalidos, SQL, salvaguardas de la CLI,
  sincronia de `assertions.sql` y consistencia de las evals del agente contra el motor real de pedidos.
- `scripts/verify-restaurantes-seed-pm/`: ejecuta el bloque real del seed dos veces contra Postgres real (todas las migraciones)
  dentro del gate de CI (`run-gate.mjs` lo descubre solo).

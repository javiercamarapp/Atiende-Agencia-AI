# seed-pm-demo -- cuenta demo "Los Taquitos de PM" (R-01)

Seed **repetible e idempotente** de la organizacion demo del primer cliente real (7 sucursales). No es una
migracion: es un script que se ejecuta a mano, y **nunca contra la base real sin el OK del dueño del proyecto**.

```
# Dry-run (por defecto): valida los datos e imprime el plan; no abre ninguna conexion.
node --experimental-strip-types scripts/seed-pm-demo/seed-pm-demo.ts

# Escribir en una base LOCAL/de pruebas ya migrada:
SEED_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/atiende_demo \
  node --experimental-strip-types scripts/seed-pm-demo/seed-pm-demo.ts --apply [--owner-email=correo@ya-existente]
```

Con `--demo` la cuenta se carga como **demo**: slug `los-taquitos-de-pm-demo`, nombre "Los Taquitos de PM (demo)" y marca en
`restaurantes.demo_organization` (migracion 037: la exige el preflight). Es la cuenta que atiende el widget publico `/demo/:orgSlug`
y la que borra `limpiar-demo.ts`. Sin `--demo` el seed se comporta como siempre (la cuenta real de PM, sin marca). El runbook
completo de carga y limpieza esta en `docs/demo-pm/runbook.md`; el comando unico que encadena seed, volumen del perfil T7, limpieza de ensayos y
verificacion es `npm run demo:pm` (`demo-pm.mjs`; la verificacion de solo lectura es `verificar-demo.ts`, `npm run demo:verificar`).

Salvaguardas (`packages/domain-restaurantes/src/seed/target-safety.ts`, con tests):
- Sin `--apply` nunca escribe. Solo lee `SEED_DATABASE_URL` (a proposito **no** `DATABASE_URL`).
- Imprime la base objetivo (host:puerto/base, sin usuario ni contraseña) y la marca `(local)` o `(REMOTA)`.
- Contra una base que no sea local exige `--confirm-host=<host exacto>`.
- Antes de escribir comprueba que existan las migraciones 022, 023, 025, 027, 031, 033 y 038 (y la 037 con `--demo`) y, si faltan, lista cuales y sale con codigo 3.
- Todo ocurre en una sola transaccion (`begin`/`commit`) y dentro de la organizacion `los-taquitos-de-pm`; si ese slug ya
  existe en otra vertical, aborta sin tocarla. No crea usuarios ni credenciales (`--owner-email` solo enlaza a un usuario
  de staff que YA existe).

## Que carga

| Dato | Detalle |
| --- | --- |
| Sucursales | 7: T1 Prolongacion Montejo (activa), T2 Francisco de Montejo, T3 Pensiones (activa), T4 Galerias, T5 Playa (Chicxulub), T7 Garcia Lavin (Victory Platz) y T8 Victory Altabrisa. **T7 queda ACTIVA (fase 1 del agente, decision de Javier del 2-oct-2026) con la lista T1-2026**; T2 y T8 llevan catalogo provisional (`provisional_P5`) pero siguen inactivas; T4 inactiva y sin pedidos (P9); T5 inactiva (fuera de temporada, solo recoger) pero con su catalogo. T3 no tiene coordenadas (no se inventan). |
| Menu | 279 productos en 25 categorias (237 del menu impreso + 40 fracciones de kilo + Extra Salsa y Extra Piña). **Precio y catalogo por sucursal**: cada producto lleva `precios_por_sucursal` (T1 278, T2 263, T3 251, T5 262, T7 278, T8 278) con su `fuente_precio`: `impreso` (item del menu impreso, ligado por una prueba), `lista_t1_2026` (T7 = lista T1-2026), `provisional_P5` (T2 y T8), `proporcional_kilo` (1/4, 1/2, 3/4, 1.5 y 2 kg = precio del kilo de la misma sucursal x fraccion, redondeo a $0.50) y `decision_2oct` (Extra Salsa y Extra Piña a $19, solo T1, T2, T7 y T8). Sin llave de precio la sucursal no vende el producto. `products.price` es solo el precio de referencia (T1). |
| Alcohol | 42 productos marcados `no_domicilio` (por producto, no por categoria). |
| Politica | Una franja 12:00-01:00 todos los dias, pedido minimo a domicilio $200, propina solo con tarjeta. |
| Promocion | `LUNES2X1PM`: 2x1 en tacos al pastor, lunes, **solo recoger**. El combo del martes (nachos + 2 aguas de cortesia) no se carga: pendiente de datos P13 (el tipo `cortesia` de la migracion 031 ya permite modelarlo). Con **alcance por sucursal** (migracion 038, `promotions.property_ids`): solo vale en T2, T3 y T4, nunca en T1, T7 ni T8 (P6); el preflight exige la 038 antes de cargarla (sin ella el 2x1 valdria en todas). |
| Zonas conocidas | Un punto por sucursal con coordenadas reales (las aproximadas de T5 no entran) (el mapa de colonias del dueño sigue pendiente; no se inventan). Sin cobertura de entrega configurada. |
| Agente de WhatsApp | Perfil `taqueria_pm` en `whatsapp_agent_config` (organizacion): tono formal (usted), tiempos por omision de T7 (domicilio de 60 a 75 min, pico de 75 a 90; recoger de 25 a 35 min, pico de 45 a 60), salsas incluidas y promocion anunciada (solo el lunes 2x1 cargado; el combo del martes NO se promete). El nombre del asistente queda vacio (el dueño no lo definio). Re-ejecutar no pisa lo que el dueño edite. Las reglas duras (alcohol sin domicilio, minimo $200, propina solo con tarjeta, bistec en ordenes de 3) viven en el prompt y en las herramientas. |
| Pendientes del dueño | `pendientes_dueno` en los datos (cambio de turno, WhatsApp por sucursal, coordenadas de T3, mapa de colonias, catalogo de SoftRestaurant, nombre del asistente, combo del martes, identidad de T4, mas las preguntas P1-P25 para Javier con su `estado`; `P5` en `resuelta` es lo que habilita cargar T2, T7 y T8): se muestran en el checklist de onboarding del panel y NO se inventan. |
| Agente | Voz **deshabilitada** (`habilitado = false`, sin gasto de proveedores) con `comportamiento` (voz y trato, reglas duras, seguridad y datos del negocio, <= 8000 caracteres) y saludo por sucursal. `data/agente/` guarda el prompt, las herramientas y las 68 evals del experto; el seed los valida (herramientas mencionadas en el prompt, ids unicos). |

Los datos salen de `pm-datos.json` del paquete PM (cuestionario del dueño + repo `lostaquitosdepm`), **recortado**: sin
volumenes de pedidos ni datos operativos internos. Lo que el dueño aun no entrego (hora de cambio de turno, numeros de WhatsApp por
sucursal, coordenadas de T3, mapa de colonias, catalogo de SoftRestaurant) no se inventa.

## Pruebas

- `packages/domain-restaurantes/tests/seed-pm-demo.spec.ts`: plan e invariantes, datos invalidos, SQL, salvaguardas de la CLI,
  sincronia de `assertions.sql` y consistencia de las evals del agente contra el motor real de pedidos.
- `scripts/verify-restaurantes-seed-pm/`: ejecuta el bloque real del seed dos veces contra Postgres real (todas las migraciones)
  dentro del gate de CI (`run-gate.mjs` lo descubre solo).

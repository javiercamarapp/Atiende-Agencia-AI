# seed-rentas-demo -- cuenta demo de rentas (Rn-33)

Seed **repetible e idempotente** de una gestora de rentas vacacionales demo para paneles de demostracion, pruebas y el recorrido E2E:
**Gestora Demo Rentas (demo)**. No es una migracion (esta tarea no agrega SQL): es un script que se ejecuta a mano, y **nunca contra la
base real sin el OK de Javier**. Necesita el esquema de rentas hasta la migracion 027 (el preflight lista lo que falte y sale con codigo 3).

```
# Dry-run (por defecto): valida los datos, parsea los .ics de fixtures/ e imprime el plan; no abre ninguna conexion.
node --experimental-strip-types scripts/seed-rentas-demo/seed-rentas-demo.ts [--dry-run]

# Escribir en una base LOCAL/de pruebas ya migrada (exige --confirmar Y --owner-email):
SEED_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/atiende_demo \
  node --experimental-strip-types scripts/seed-rentas-demo/seed-rentas-demo.ts --confirmar --owner-email=correo@ya-existente

# Quitar la demo (dry-run por defecto):
SEED_DATABASE_URL=postgresql://... node --experimental-strip-types scripts/seed-rentas-demo/limpiar-demo.ts --confirmar
```

## Salvaguardas (`args.ts`, con tests)

- Sin `--confirmar` nunca escribe (dry-run). Escribir exige tambien `--owner-email` (correo de un usuario de staff que **ya existe**: el seed
  no crea usuarios ni credenciales y aborta si no existe; queda como `admin_gestora` de la cuenta demo). Solo lee `SEED_DATABASE_URL`
  (a proposito **no** `DATABASE_URL`).
- Imprime la base objetivo (host:puerto/base, sin usuario ni contraseña) marcada `(local)` o `(REMOTA)`. **Una base que no es local se trata como
  produccion**: aborta salvo `--confirm-host=<host exacto>` **y** `--confirmar-produccion`. No se corre contra la base real sin el OK de Javier.
- Todo ocurre en UNA transaccion. Si el slug `demo-rentas-gestora` ya existe en otra vertical, aborta sin tocarlo.
- Escribe como el rol del operador (como `seed-pm-demo` y `seed-citas-demo`), no con el JWT de un usuario: es un script de operador, no una ruta de
  la aplicacion; las tablas con RLS se verifican en `scripts/verify-rentas-seed` leyendo como el staff autenticado.

## Marca de cuenta demo (sin SQL)

No hay tabla `is_demo` para rentas (esta tarea no agrega migraciones). La marca equivalente es el **slug `demo-rentas-gestora`** (la consola de
superadmin cuenta como demo toda organizacion con slug `demo-%`, ver `core.get_consola_organizaciones_for_superadmin`) mas el nombre
"(demo)" en la organizacion y en cada propiedad, el apellido "Demo" en las personas y los correos `@example.test`. Si mas adelante se
agrega una tabla de marca para rentas (como `citas.demo_organization`), el seed debe escribirla.

## Que carga

| Dato | Detalle |
| --- | --- |
| Gestora | 1 organizacion `empresa_gestora`, el correo del dueño como `admin_gestora` de acceso total |
| Propiedades | Casa del Mar (Cancun), Loft Centro (CDMX), Villa Los Pinos (Merida) |
| Unidades | 5: Depto 1 y Depto 2, Loft A, Villa y Cabaña; cada una con su propietario y su tarifa base (Depto 1 con una temporada) |
| Propietarios | 3 ficticios (`@example.test`) |
| Feeds iCal | 3 (Airbnb y Booking de Depto 1, Vrbo del Loft **en cuarentena**); URLs `.invalid`: nunca consultan internet |
| Reservas | 8 **importadas** de los `.ics` de `fixtures/` (parseados con el parser real) + 13 directas, pasadas, de hoy y futuras |
| Conflicto | 1 abierto: la reserva de Airbnb `demo-abnb-0003` cruza con un bloqueo de mantenimiento |
| Tareas / incidencia | 5 tareas (1 vencida, 1 completada con checklist) y 1 incidencia abierta |
| Mensajeria | 5 plantillas (2 aprobadas) y 2 conversaciones con su borrador de IA pendiente de aprobacion |
| Finanzas | 4 reglas de comision confirmadas (valores ilustrativos, la fuente lo dice) y 9 movimientos de reservas ya terminadas, calculados con el motor real |
| Acceso | politica de liberacion activa en Casa del Mar |

Las fechas son **offsets en dias respecto de HOY** en la zona horaria de cada propiedad (los `.ics` toman el 2026-01-05 como "hoy"), asi
siempre hay llegadas y salidas de hoy, reservas pasadas con movimiento y futuras. Nada incluye PII real: personas con apellido "Demo",
correos `@example.test` y contactos con lada `00` (inexistente en Mexico).

## Idempotencia

Correrlo dos veces no duplica nada: propietarios por correo, propiedades por nombre, unidades por (propiedad, nombre), feeds por
(unidad, canal), ocupaciones por (unidad, `external_id`), plantillas por (evento, idioma). Las tablas sin llave natural (tareas, incidencias,
conversaciones) solo se siembran si la organizacion demo aun no tiene filas. **No pisa lo que el usuario edito**: una regla de comision que ya no
es "sugerida", una plantilla modificada o una reserva cancelada se conservan.

## Quitar la demo

`limpiar-demo.ts` borra la organizacion `demo-rentas-gestora` (todo lo suyo cae en cascada) **y los propietarios que solo eran de ella**:
`rentas.owner` es global y sin ese paso quedarian huerfanos (hallazgo del verify). Un propietario compartido con otra organizacion se conserva.

## Pruebas

- `packages/domain-rentas/tests/seed-rentas-demo.spec.ts`: plan e invariantes, datos invalidos, SQL, salvaguardas de la CLI y sincronia de
  `scripts/verify-rentas-seed/assertions.sql`.
- `scripts/verify-rentas-seed/`: ejecuta el bloque real del seed contra Postgres real (todas las migraciones): conteos, que el Resumen, los
  reportes, el monitor y el checklist de onboarding devuelvan datos como el staff autenticado (RLS real), idempotencia, aislamiento y limpieza.
  Corre en el gate de CI (`run-gate.mjs` lo descubre solo).
- `apps/web/e2e/mock-api/fixtures`: fixtures equivalentes para el recorrido Playwright de rentas.

# seed-citas-demo -- cuentas demo de citas (C-27)

Seed **repetible e idempotente** de dos negocios demo de citas para presentar el producto sin datos reales: **Clinica Dental
Sonrisa (demo)** y **Barberia El Filo (demo)**. No es una migracion: es un script que se ejecuta a mano, y **nunca contra la base
real sin el OK del dueño del proyecto**. Requiere la migracion `030_citas_demo_organization` (espejo `20240101000279`).

```
# Dry-run (por defecto): valida los datos e imprime el plan; no abre ninguna conexion.
node --experimental-strip-types scripts/seed-citas-demo/seed-citas-demo.ts

# Escribir en una base LOCAL/de pruebas ya migrada (exige --confirmar Y --owner-email):
SEED_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/atiende_demo \
  node --experimental-strip-types scripts/seed-citas-demo/seed-citas-demo.ts --confirmar --owner-email=correo@ya-existente [--fecha-base=YYYY-MM-DD]

# Limpieza (dry-run por defecto; solo borra organizaciones marcadas como demo):
SEED_DATABASE_URL=postgresql://... node --experimental-strip-types scripts/seed-citas-demo/limpiar-demo.ts --todas
SEED_DATABASE_URL=postgresql://... node --experimental-strip-types scripts/seed-citas-demo/limpiar-demo.ts --org-slug=barberia-el-filo-demo --confirmar --confirm-host=<host>
```

Salvaguardas (`args.ts`, con tests):
- Sin `--confirmar` nunca escribe ni borra. Escribir exige tambien `--owner-email` (correo de un usuario de staff que **ya existe**: el
  seed no crea usuarios ni credenciales y aborta si no existe). Solo lee `SEED_DATABASE_URL` (a proposito **no** `DATABASE_URL`).
- Imprime la base objetivo (host:puerto/base, sin usuario ni contraseña) y la marca `(local)` o `(REMOTA)`; contra una base que no
  sea local exige `--confirm-host=<host exacto>`.
- Antes de escribir comprueba que existan las tablas/funciones que necesita (migracion 030 incluida) y, si faltan, lista cuales y sale con codigo 3.
- Todo ocurre en una sola transaccion (`begin`/`commit`). Si el slug ya existe en otra vertical, o en citas **sin** marca demo, aborta
  sin tocarlo.
- La limpieza llama a `citas.demo_limpiar`, que **solo** opera sobre organizaciones marcadas en `citas.demo_organization` (y la CLI
  se niega antes de llamarla). Nunca toca otra organizacion.

## Que carga

| Dato | Clinica Dental Sonrisa (demo) | Barberia El Filo (demo) |
| --- | --- | --- |
| Slug / rubro / zona | `clinica-dental-sonrisa-demo` / dental / America/Merida | `barberia-el-filo-demo` / barberia / America/Merida |
| Servicios | Limpieza dental, Consulta de valoracion, Resina o empaste, Blanqueamiento | Corte de cabello, Arreglo de barba, Corte y barba, Afeitado clasico |
| Profesionales y horario | Dra. Ana Lozano (L-V 9-14 y 16-19), Dr. Luis Pech (Ma-Sa 10-18), Dra. Marisol Canche (L/Mi/V 9-15) | Beto (Ma-Sa 10-20), Chuy (L-V 11-19), Memo (Ju-Sa 12-21) |
| Excepciones | 3 (dia cerrado, medio dia, dia inhabil) | 2 (dia de descanso, salida temprano) |
| Clientes ficticios | 10, telefonos `5200xxxxxx` (lada reservada que no existe en Mexico), correos `@example.test` | 10, igual |
| Citas | 25: completed, no_show y cancelled en las 3 semanas pasadas; confirmed, pending y cancelled en las 2 siguientes | 24, igual |
| Lista de espera | 5 (active, notified, fulfilled, cancelled, expired) | 5, igual |

Las citas se ubican por **semana relativa al lunes de la fecha base** (por omision hoy, en la zona horaria del negocio) y dia de la
semana, asi cada cita cae siempre en un dia y una hora en que su profesional atiende, sin importar cuando se corra el seed. La
semana en curso queda libre para probar agendar. Cada cita lleva una llave de idempotencia determinista: **re-ejecutar no duplica ni
mueve las ya sembradas** (para refrescar las fechas: limpiar y volver a sembrar). Nada incluye PII real; los profesionales y
clientes son inventados.

Diferencias con `seed-pm-demo/`: no hay `ejecutar.mjs` ni `pg-session.ts` porque este seed no importa repositorios de la aplicacion
(solo el plan puro y SQL), asi que corre directo con `--experimental-strip-types`.

## Pruebas

- `packages/domain-citas/tests/seed-citas-demo.spec.ts`: plan e invariantes, datos invalidos, SQL, salvaguardas de la CLI (sin banderas
  no escribe, `--confirmar` exige `--owner-email`, base remota exige `--confirm-host`), limpieza que no toca organizaciones no demo y
  sincronia de `scripts/verify-citas-demo/assertions.sql`.
- `scripts/verify-citas-demo/`: ejecuta el bloque real del seed dos veces contra Postgres real (todas las migraciones) dentro del gate
  de CI (`run-gate.mjs` lo descubre solo).

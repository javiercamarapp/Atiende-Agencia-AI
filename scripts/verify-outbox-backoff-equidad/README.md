# verify-outbox-backoff-equidad

Verificación contra Postgres **real** de
`packages/db/migrations/0030_outbox_backoff_y_equidad_por_tenant.sql` (PL-07): backoff
exponencial del correo del outbox y equidad por tenant en los
`claim_*_outbox_batch` de las 6 verticales. Corre a mano con `run.sh` (necesita
`initdb`/`pg_ctl`/`psql`) y automáticamente en CI vía
`scripts/verify-real-postgres-ci/run-gate.mjs` (auto-descubierto: tiene los 3 archivos
`bootstrap.sql` + `post-migrations.sql` + `assertions.sql`).

## Qué demuestra

Cada escenario de `assertions.sql` corre en su propio `begin; ... rollback;` y se
autoverifica con bloques `DO` que lanzan una excepción con la vertical y el motivo si algo
no cumple (un escenario sin error = pasa):

1. `core.outbox_backoff_seconds`: 60 s * 2^(n-1), tope de 6 h, nulos/bajos -> 60 s.
2. Correo, equidad por tenant: A con 12 filas viejas, B con 2 y C con 1; lote de 6 ->
   A 3 / B 2 / C 1 (antes: A 6). El segundo lote se llena con la única organización que
   queda.
3. Correo, un solo tenant con pendientes: el lote se llena igual; `p_limit = 0` no reclama.
4. Correo, backoff: tras `failed` la fila queda fuera de la cola con
   `next_attempt_at = now() + 60 s`, vencida la espera es reclamable, el segundo fallo deja
   120 s; completar como `sent` no mueve `next_attempt_at`.
5. Correo, compatibilidad: una fila `failed` anterior a la migración (espera ya vencida) se
   sigue reclamando; con `attempts >= 5` no.
6. WhatsApp (citas, hoteles, restaurantes): misma equidad por tenant.
7. WhatsApp: `next_attempt_at` futuro y lease vigente no se reclaman; lease vencido sí.
8. Negativo / anon: staff con `auth.uid()` real y el rol `anon` reciben 42501 al reclamar o
   completar en las 6 verticales.
9. Cross-tenant: `authenticated` (staff) y `anon` no pueden leer las tablas del outbox.

Las 6 verticales son citas, despachos, hoteles, licitaciones, rentas y restaurantes; el
canal WhatsApp existe solo en citas, hoteles y restaurantes.

## Evidencia antes/después

Ver el cuerpo del PR: con la migración 222 sin aplicar, los escenarios 1, 2, 4, 5 y 6 fallan
(`A=6`, "la fila fallida se reclamó sin respetar el backoff", falta la columna
`next_attempt_at` en despachos/licitaciones); con ella aplicada pasan todos.

## Qué NO cubre

- Concurrencia entre dos corridas simultáneas del claim (`for update of ... skip locked`
  con el filtro de elegibilidad repetido): el gate usa una conexión por escenario. Se
  comprobó a mano con dos sesiones `psql` (ver PR), no está en el gate automático.

# verify-flujos-staff

Primera verificación sistemática, contra Postgres **real**, de los flujos de
**STAFF AUTENTICADO** (sesión con `auth.uid()` real + una membership real con rol
en una organización/property) — a diferencia de
`scripts/verify-core-rls-sesion-sistema/`, `scripts/verify-flujos-sistema/`,
`scripts/verify-flujos-sistema-2/` y `scripts/verify-hoteles-night-audit-sistema/`,
que ya habían cerrado (y siguen cubriendo, sin regresión) los mismos huecos pero
para la sesión de **sistema** (`auth.uid()` NULL, crons/workers/webhooks). Léanse
esos README primero para el patrón/metodología completa que este directorio no
repite.

Cubre hoteles (recepción, de punta a punta — la vertical de mayor impacto,
priorizada explícitamente) + restaurantes + citas (las 2 siguientes en
prioridad). rentas/despachos/licitaciones quedan **fuera** de este PR — ver
"Pendiente para un segundo PR" abajo.

Corre a mano vía `run.sh` y automáticamente en cada PR/push vía
`.github/workflows/postgres-real-gate.yml` (descubierto solo por
`scripts/verify-real-postgres-ci/run-gate.mjs`, que enumera cualquier
`scripts/verify-*/` con los 3 archivos de este contrato).

## Qué demuestra este script (38 escenarios)

Fixtures: 2 organizaciones de hoteles (A ejercitada de punta a punta, B para el
control cross-tenant) + 2 de restaurantes + 2 de citas, cada una con su property y
staff real; además, en A de hoteles y de citas, un staff real **sin acceso** a la
property A1 (membership real, `property_ids` acotado a otra property que no
existe en los fixtures) para el "caso negativo con un rol sin permiso" que pide la
tarea; en A de restaurantes, un `staff_user` real **sin ninguna fila** en
`core.membership` (esta vertical no tiene roles finos para menú/pedidos — ver
"Decisión de diseño" abajo).

1. **(1-11) Hoteles — recepción de punta a punta**: crear reserva (con reserva de
   disponibilidad real, `book_availability`) → check-in (confirmada -> check_in)
   → asegurar folio primario → cargo manual → pago → reverso de cargo
   (`mark_charge_reversed`, el original queda `reversed_by`) → check-out completo
   (check_in -> en_estancia -> check_out) → cancelar OTRA reserva + liberar
   disponibilidad (`release_availability`, el inventario vuelve a 0) → alta +
   lista de turno de housekeeping → lectura del tablero (`listReservations`).
   **Antes de este PR, TODOS estos pasos fallaban contra Postgres real** — ver
   "Verificado ANTES/DESPUÉS" abajo.
2. **(12-17) Controles de hoteles**: un staff real de la organización A **sin
   acceso** a la property A1 no puede crear una reserva ahí (rol sin permiso,
   RLS real); un staff real de la organización B no ve ni puede actualizar
   (0 filas, sin error) las reservas de la property A1 (cross-tenant); `anon`
   sigue sin acceso; límite deliberado: `hoteles.reservation_status_event` SIGUE
   siendo append-only — un INSERT directo por staff real SIGUE bloqueado (el fix
   es `SECURITY DEFINER` en el TRIGGER, nunca una policy de insert para staff) —
   y el mismo staff SÍ puede LEER esa bitácora de su property (confirma que el
   trigger arreglado escribe por el camino correcto).
3. **(18-26) Restaurantes**: alta de categoría → alta de producto → un pedido ya
   "recibido" (simulando la llegada por WhatsApp/voz bajo sesión de sistema, ya
   cubierta por `scripts/verify-flujos-sistema*`) avanza por sus 3 estados hasta
   `entregado` → asignación de repartidor → alta de promoción (catálogo, sí es
   staff) — **22b documenta que la REDENCIÓN en sí
   (`restaurantes.increment_promotion_uses`) es EXCLUSIVA de sesión de sistema**
   desde `packages/domain-restaurantes/migrations/018_restaurantes_caller_binding_fase3.sql`
   (trabajo de otro agente, prefijos `...000147`-`...000151`, "caller binding" —
   ver ese archivo: el único caller real siempre fue el checkout público,
   `createOrder`, sesión de sistema; un `authenticated` de cualquier organización
   podía antes agotar el `max_uses` de la promoción de un competidor por RPC
   directo, sin haber creado ningún pedido — cerrado en esa migración, no en
   ésta). El escenario 22 original de este PR asumía (incorrectamente, antes de
   que esa migración de main llegara durante la verificación) que la redención
   era un paso de staff — se corrigió aquí para reflejar el comportamiento real
   una vez rebaseado. Controles: un `staff_user` real sin ninguna membership no
   puede dar de alta una categoría; un staff real de la organización B no ve ni
   puede actualizar el pedido de la organización A (cross-tenant); `anon` sigue
   sin acceso.
4. **(27-37) Citas**: alta de servicio → alta de profesional + asignación al
   servicio → alta de horario (`availability_rules`) → agendar
   (`create_appointment_from_panel`) → confirmar → completar → marcar no-show (una
   cita distinta) — las 4 últimas vía las funciones `_from_panel`
   (`SECURITY DEFINER`, `migrations/015_property_scoped_panel_access.sql`).
   Controles: **reagendar sigue siendo EXCLUSIVO del agente/sistema** — el panel
   de staff no tiene ese botón por diseño (`reschedule_appointment_idempotent`
   rechaza incluso a un staff real, `apps/api/src/routes/verticals/citas/
   appointments-lifecycle.ts` documenta que "el panel no tiene botón de
   reagendar"; la tarea pedía ejercitar "reagendar" para citas — este es el
   resultado honesto: NO es una operación de staff, y así se documenta, en vez de
   omitirla en silencio); un staff sin acceso a la property A1 no puede agendar
   ahí (rol sin permiso); un staff de la organización B no puede confirmar una
   cita de la organización A (cross-tenant); `anon` sigue sin acceso.

## El bug real que este PR arregla (hoteles — 3 causas raíz, 1 migración)

`packages/domain-hoteles/migrations/025_reserva_lifecycle_staff_grants.sql`
(mirror `supabase/migrations/20240101000153_...`) — el comentario de cabecera de
esa migración trae el análisis completo de cada uno; resumen:

1. **`hoteles.reservation_log_status_event()`/`..._on_insert()`** (triggers AFTER
   de `migrations/005_reservas_estado.sql`) corrían `SECURITY INVOKER`, no
   `SECURITY DEFINER`, **aunque el propio comentario de esa migración ya
   afirmaba lo contrario** ("las triggers arriba corren como el dueño de la
   función"). Efecto real: CUALQUIER INSERT o UPDATE de status en
   `hoteles.reservation` por un staff autenticado real disparaba el trigger
   AFTER, que intentaba escribir en `hoteles.reservation_status_event` bajo el
   rol DEL STAFF — esa tabla solo tiene policy de SELECT (bitácora append-only,
   por diseño nunca escribible directo por staff) — así que el INSERT del
   trigger violaba RLS y la transacción COMPLETA revertía. **Literalmente no se
   podía crear una reserva desde recepción, ni hacer NINGUNA transición de
   estado (confirmar, check-in, check-out, cancelar, no-show), contra Postgres
   real.**
2. **`hoteles.reservation_status_transition`** (catálogo estático de los 8 pares
   `from_status`/`to_status` válidos, sin RLS habilitado — no es dato de
   tenant) nunca tuvo `GRANT SELECT` a `authenticated`. Efecto real: en cuanto se
   arregla el Bug 1, la MISMA transacción vuelve a fallar aquí — cualquier
   UPDATE de status (por staff, o por sesión de sistema, que corre bajo el MISMO
   rol `authenticated`) sigue roto.
3. **`hoteles.availability`** (`migrations/003_availability.sql`) solo tenía
   `GRANT SELECT` a `authenticated`, nunca `GRANT UPDATE`, aunque su única
   función de escritura — `book_availability()`/`release_availability()` — es
   explícitamente `SECURITY INVOKER` por diseño ("corre con el rol de quien
   llama para que las políticas RLS de `hoteles.availability` sigan aplicando",
   comentario original de 003). Efecto real: `POST .../reservas` (crear reserva)
   y la liberación de inventario al cancelar/no-show fallaban siempre para
   staff real — **ya documentado como "hallazgo adyacente, fuera de alcance" por
   `packages/domain-hoteles/migrations/023_night_audit_sistema_escritura.sql`**
   (ver también `scripts/verify-hoteles-night-audit-sistema/README.md`), este PR
   lo cierra. Confirmado contra Postgres real: incluso el `select ... for
   update` DENTRO de `book_availability()` ya fallaba con "permission denied for
   table availability" (un `for update` exige privilegio UPDATE, no solo
   SELECT) — antes de llegar al `update` explícito de la función.

Los 3 bugs, juntos, significaban que **la máquina de estados de reservas de
recepción — el flujo más básico de la vertical de mayor impacto de este repo —
estaba completamente rota contra Postgres real**, aunque los ~4,800 tests
unitarios (repositorio en memoria) pasan en verde, porque ninguno ejercita
GRANTs/RLS reales.

## Verificado ANTES/DESPUÉS del fix (evidencia real)

`run.sh` acepta `FLUJOS_STAFF_SKIP_FIX=1` para reproducir el estado ANTES del fix
(aplica las 144 migraciones reales EXCEPTO la de este PR). Resultados reales de
correr `FLUJOS_STAFF_SKIP_FIX=1 ./run.sh` (ANTES) vs `./run.sh` (DESPUÉS):

| Escenario | ANTES del fix | DESPUÉS del fix |
|---|---|---|
| 1 (crear reserva) | `ERROR: new row violates row-level security policy for table "reservation_status_event"` | `1` |
| 2 (book_availability) | mismo `ERROR` (la reserva ni se crea) | `1` |
| 3 (check-in) | mismo `ERROR` (nunca llega a la transición) | `1` |
| 4-7 (folio/cargo/pago/reverso) | mismo `ERROR` (la reserva de la que dependen ni se crea) | `1`/`1`/`1`/`1` |
| 8 (check-out) | mismo `ERROR` | `1` |
| 9 (cancelar + liberar disponibilidad) | `ERROR: permission denied for table availability` (aquí SÍ se distingue del resto: el `book_availability` inicial del escenario es lo que falla primero) | `1` |
| 10 (housekeeping) | `1` (sin dependencia del fix — no toca `reservation`) | `1` |
| 11 (tablero) | mismo `ERROR` que 1 (la reserva que se lista ni se crea) | `1` |
| 12/13/15 (rol sin permiso, cross-tenant lectura, anon) | Idéntico a después — confirma que `FLUJOS_STAFF_SKIP_FIX=1` solo quita las 3 piezas relevantes, nada más | Sin cambio |
| 14 (cross-tenant update) | mismo `ERROR` que 1 (la reserva fixture del escenario ni se crea) | `1` |
| 16 (límite deliberado, bitácora append-only) | `ERROR` (mismo mensaje, sin cambio real — la tabla nunca tuvo policy de insert para staff, antes ni después) | `ERROR` (sin cambio) |
| 17 (staff lee su bitácora) | mismo `ERROR` que 1 | `1` |
| 18-37 (restaurantes/citas completas) | Idéntico a después — confirma que el `SKIP_FIX` de este PR (una sola migración, exclusiva de hoteles) no afecta ninguna otra vertical | Sin cambio |

Corrido también vía el gate real de CI localmente
(`PGHOST=127.0.0.1 PGPORT=<puerto> node scripts/verify-real-postgres-ci/run-gate.mjs`,
Postgres 17 local): **las 15 verificaciones existentes + esta nueva
(`verify-flujos-staff: 38/38 escenarios OK`) pasan, sin regresión en ninguna**
(406 escenarios totales, 0 fallos).

## Nota de metodología (relevante para quien extienda este script)

Varios de los primeros intentos de escribir los escenarios 1-3-9-17 encadenaban,
dentro de una MISMA sentencia SQL, un `with cte as (insert into
hoteles.reservation ... returning id) update hoteles.reservation set status =
... where id = (select id from cte)` — ese patrón **no ve, de forma fiable, la
fila que la CTE hermana acaba de insertar en la MISMA tabla** (confirmado incluso
como `postgres`, sin RLS de por medio: todas las sub-sentencias de escritura de
un `WITH` comparten un único snapshot de la transacción, así que un `UPDATE`/
`SELECT` que vuelve a escanear la tabla base no ve la fila insertada por su CTE
hermana dentro de la MISMA sentencia — a diferencia de encadenar un INSERT hacia
OTRA tabla vía `insert into hoteles.folio (...) select ... from nueva`, que SÍ
funciona siempre porque consume directamente las filas de salida de la CTE, sin
re-escanear nada). La solución en los escenarios afectados: la fila usa un `id`
literal y el INSERT/UPDATE/SELECT subsiguientes van en sentencias TOP-LEVEL
separadas (cada `;` nueva sí ve el efecto de la anterior, vía el contador de
comandos de la transacción). Esto es una limitación real de Postgres con CTEs de
escritura encadenadas al mismo tiempo, no un bug de esta app ni de este fix — se
deja documentado aquí para que el siguiente PR de esta serie no lo redescubra a
mano.

## Pendiente para un segundo PR

**rentas, despachos, licitaciones** — ejercitados solo por el barrido estático de
Parte 1 (ver el reporte del PR para la tabla completa), no por recorridos de
punta a punta como este script. Prioridad sugerida para el siguiente PR,
según impacto de producto:

1. **rentas** (dinero de propietarios): alta de propiedad/unidad, reserva,
   bloqueo, tarifa, **statement de propietario** (dinero real, el de mayor
   riesgo si algo está roto en silencio).
2. **despachos** (cartera/cobranza, dinero de clientes del despacho): cliente,
   factura/cuenta por cobrar, evento de cobranza, **cierre mensual**.
3. **licitaciones** (menor riesgo de dinero directo, más flujo documental/
   decisión): alta manual de licitación, decisión go/no-go, aprobación,
   documento.

El barrido estático de Parte 1 (GRANT/policy) no encontró, en estas 3
verticales, el mismo patrón de "GRANT de tabla completo faltante" que causó el
bug de hoteles — los hallazgos ahí fueron o bien deuda menor (grants/policies
sin código que los ejerza hoy) o bien ya cubiertos por funciones
`SECURITY DEFINER` con `GRANT EXECUTE` correcto (ver la tabla del reporte del
PR) — pero esto NO reemplaza ejercitar las sentencias SQL reales que emite cada
`postgres-repository.ts` bajo sesión de staff, como sí se hizo aquí para hoteles/
restaurantes/citas. Ese es exactamente el trabajo que falta.

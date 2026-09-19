# verify-flujos-staff-parte-2

Segunda verificación sistemática, contra Postgres **real**, de los flujos de
**STAFF AUTENTICADO** (sesión con `auth.uid()` real + membership real) — Parte 2 de
`scripts/verify-flujos-staff/` (Parte 1, PR #151), que cubrió hoteles + restaurantes +
citas y dejó explícitamente pendientes **rentas + despachos + licitaciones** (ver su
propio README, sección "Pendiente para un segundo PR").

Cubre, en el mismo orden de prioridad que el propio README de Parte 1 documentó:

1. **rentas** — statement de propietario (`POST/GET .../owners/:ownerId/statements`,
   `finanzas-statements.ts`) + payout de canal/conciliación
   (`POST/GET .../payouts`, `finanzas-payouts.ts`) — dinero real de terceros, el de
   mayor riesgo si algo falla en silencio.
2. **despachos** — cierre mensual (`cierre-mensual.ts`: abrir período, completar
   tarea, cerrar período) + cartera de cobranza (`cobranza.ts`/repo `receivable`) —
   dinero de clientes del despacho.
3. **licitaciones** — decisión go/no-go (`goNoGo.ts`) + aprobación de documento de
   empresa (`companyData.ts`) — menor riesgo de dinero directo, más flujo
   documental/decisión. `expediente_approval` (aprobar el expediente completo) se
   confirmó SIN ningún llamador real en `PostgresLicitacionesRepository` (mismo
   hallazgo que Parte 1 ya documentó como "deuda muerta" para esta misma tabla) — no
   se ejercita aquí porque no hay ninguna sentencia SQL real que reproducir; la
   "aprobación" real que sí ejercita el panel de staff es `company_document.
   approval_status` vía `companyData.ts`.

Más el **endurecimiento pendiente de #151** (obligatorio en esta tarea):
`hoteles.availability` tenía `GRANT UPDATE` de **tabla completa** para `authenticated`
(migración 025) — ver la sección "El hallazgo real" abajo.

## Qué demuestra este script (42 escenarios)

Fixtures: 2 organizaciones por vertical (A ejercitada de punta a punta, B para el
control cross-tenant) + un staff sin acceso a la property/rol insuficiente por
vertical, mismo patrón exacto que Parte 1.

1. **(1-14) Rentas**: admin_gestora genera un owner statement (insert
   `owner_statement`+`owner_statement_linea`) → contador (solo lectura) lo lee →
   importa un payout de canal + su línea de conciliación → lee su detalle → lee los
   movimientos financieros del período (`findMovimientosPeriodoParaOwner`) →
   encuentra al propietario con unidades en su property
   (`findOwnerConUnidadesEnProperty`). Controles: contador (rol sin permiso, solo
   lectura) no puede escribir ni el statement ni el payout; staff con membership real
   pero `property_ids` que no cubre la property tampoco puede; cross-tenant (org B no
   ve ni puede tocar los datos de A); `anon` sin acceso.
2. **(15-26) Despachos**: admin abre un período de cierre con su checklist (insert
   `periodo_cierre`+`periodo_cierre_tarea`) → completa una tarea → cierra el período
   (`CERRAR_PERIODO_ROLES=["admin"]`) → registra una cuenta por cobrar real sobre un
   CFDI ya ingestado → lista la cartera pendiente. Controles: staff sin acceso a la
   property (rol sin permiso), cross-tenant, `anon`.
3. **(27-36) Licitaciones**: rol de decisión (`owner`, dentro de `GO_NO_GO_ROLES`)
   registra una decisión "go" y la misma operación actualiza `tender.status` → un
   `writer` (dentro de `WRITE_ROLES` pero fuera de `GO_NO_GO_ROLES`) captura y
   aprueba un documento de empresa (`company_document.approval_status`). Controles:
   `viewer` no puede decidir ni escribir; `writer` tampoco puede decidir (decidir es
   más estricto que redactar — GO_NO_GO_ROLES ⊊ WRITE_ROLES); cross-tenant; `anon`.
4. **(37-42) Endurecimiento hoteles.availability** (ver sección siguiente).

## El hallazgo real que este PR cierra (hoteles, endurecimiento de #151)

`packages/domain-hoteles/migrations/025_reserva_lifecycle_staff_grants.sql` (PR
#151) otorgó `grant update on hoteles.availability to authenticated` **a nivel de
tabla completa**, para que `book_availability()`/`release_availability()`
(`SECURITY INVOKER` por diseño) pudieran volver a funcionar. El cuerpo de #151
afirmó "no se le da a nadie un UPDATE arbitrario de columnas" citando solo la
policy de RLS — sin notar que el GRANT en sí era de tabla completa, no de columna.
Confirmado contra Postgres real (escenario 39, con
`FLUJOS_STAFF_PARTE2_SKIP_FIX=1`): un staff con acceso a la property SÍ podía hacer
`update hoteles.availability set total_rooms = 999 where ...` directo — la única
columna que `book_availability`/`release_availability` tocan de verdad es
`booked_rooms` (+ `updated_at`); ninguna de las dos toca `total_rooms` (el
inventario base) jamás.

**Arreglo** (`packages/domain-hoteles/migrations/
026_availability_column_level_update_grant.sql`): revoca el `UPDATE` de tabla
completa y otorga `UPDATE` a nivel de **columna**, solo sobre `booked_rooms` y
`updated_at`. La policy de RLS de UPDATE que 025 ya creó
(`core.has_property_access(auth.uid(), property_id)`) se deja intacta — este PR
solo acota QUÉ COLUMNAS puede tocar ese UPDATE ya autorizado, nunca amplía QUIÉN.
Un `select ... for update` (el que ambas funciones ejecutan internamente) solo
exige privilegio UPDATE sobre AL MENOS UNA columna de la tabla bloqueada, así que
`book_availability`/`release_availability` siguen funcionando exactamente igual
(escenarios 37/38, regresión).

## Verificado ANTES/DESPUÉS del endurecimiento (evidencia real)

`run.sh` acepta `FLUJOS_STAFF_PARTE2_SKIP_FIX=1` para reproducir el estado ANTES del
endurecimiento (aplica todas las migraciones reales EXCEPTO la 026). Resultados
reales de correr `FLUJOS_STAFF_PARTE2_SKIP_FIX=1 ./run.sh` (ANTES) vs `./run.sh`
(DESPUÉS):

| Escenario | ANTES del endurecimiento | DESPUÉS |
|---|---|---|
| 37 (book_availability sigue funcionando) | `1` | `1` |
| 38 (release_availability sigue funcionando) | `1` | `1` |
| 39 (UPDATE directo de `total_rooms` por staff con acceso) | `UPDATE 1` — **el staff SÍ podía pisar el inventario base directo** | `ERROR: permission denied for table availability` |
| 40 (SELECT de disponibilidad) | `1` | `1` |
| 41 (cross-tenant, UPDATE de property ajena) | `0` filas | `0` filas (sin cambio) |
| 42 (anon) | `ERROR` (sin cambio) | `ERROR` (sin cambio) |

Corrido también contra el gate real completo de CI localmente
(`PGHOST=127.0.0.1 PGPORT=<puerto> node scripts/verify-real-postgres-ci/run-gate.mjs`,
Postgres 17 local): las 20 verificaciones `scripts/verify-*/` existentes (incluida
`verify-flujos-staff` de Parte 1, 38/38, sin regresión) + esta nueva
(`verify-flujos-staff-parte-2: 42/42 escenarios OK`) pasan, exit code 0.

## Nota de metodología (mismo gotcha de CTEs que Parte 1, aplicado a un WITH CHECK de RLS)

Los primeros intentos de los escenarios 1/8/15 (que ejercitan flujos donde el repo
real hace 2 `await` SEPARADOS — insertar la fila "padre" y LUEGO, en un query aparte,
insertar cada fila "hija") combinaban ambos INSERTs en un único
`with nuevo as (insert ... returning id) insert into <hija> select ... from nuevo`.
Ese patrón produce un falso `ERROR: new row violates row-level security policy`
en la tabla hija: su policy de INSERT hace su PROPIO `exists (select 1 from
<padre> where ...)` — un re-escaneo de la tabla padre que la CTE hermana acaba
de insertar DENTRO DE LA MISMA sentencia, que Postgres no garantiza que vea (mismo
principio que el README de Parte 1 ya documentó para UPDATE/SELECT encadenados,
aquí se confirma que también aplica al `WITH CHECK` de una policy RLS). La
solución, igual que Parte 1: id literal + 2 sentencias TOP-LEVEL separadas,
reproduciendo EXACTAMENTE los 2 `await` reales del repositorio.

## Qué NO se encontró (barrido negativo, también es trabajo real)

Los 36 escenarios de rentas/despachos/licitaciones (1-36) pasan con el código YA
existente en `main`, sin ninguna migración nueva — confirma, ejercitando las
sentencias SQL REALES (no solo un barrido estático de catálogo), que el patrón de
"GRANT de tabla completo faltante" que rompió hoteles en Parte 1 NO se repite en
estas 3 verticales. Quedan como cobertura de regresión permanente.

## Pendiente

- `licitaciones.expediente_approval` (aprobar el expediente COMPLETO, distinto de
  aprobar un documento de empresa suelto) sigue sin ningún llamador real en
  `PostgresLicitacionesRepository` — deuda ya documentada por Parte 1, no se
  reintroduce aquí.
- Ningún hallazgo adicional de "GRANT de tabla completo pero solo columna X se
  escribe realmente" fuera de `hoteles.availability` — no se auditaron
  exhaustivamente TODAS las funciones `SECURITY INVOKER` de las 6 verticales contra
  ese patrón específico (fuera del alcance de esta tarea, que pidió el
  endurecimiento de un hallazgo ya identificado).

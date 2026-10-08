# .github/workflows

Dos workflows, deliberadamente separados (no se mezclan responsabilidades en
un solo job): `postgres-real-gate.yml` (Postgres real, RLS/GRANT) y
`ci-checks.yml` (typecheck/lint/tests en memoria/build). Ambos disparan en
`pull_request`, en `push` a `main`, y manualmente (`workflow_dispatch`), y
corren en paralelo — ninguno espera al otro. **No son los mismos triggers en
el detalle:** `postgres-real-gate.yml` dispara siempre; `ci-checks.yml` tiene
`paths` con exclusiones (ver abajo) y NO dispara para un diff que solo toca
`**/*.md`/`docs/**` fuera de `docs/DEPLOY.md` y
`supabase/migrations/README.md`.

## Workflows de plataforma agregados en PL-11

Todos son seguros ante forks: ninguno usa `pull_request_target`, ninguno usa secretos,
todos declaran `permissions: contents: read`, y ninguno despliega ni toca Vercel/Supabase.

- `secret-scan.yml` — gitleaks sobre el historial COMPLETO en cada PR y push a `main`
  (el repo es público). Binario de la release oficial con versión y sha256 fijados en
  el propio workflow; configuración en `/.gitleaks.toml` (reglas por defecto + una
  excepción estrecha, solo `generic-api-key`/`stripe-access-token` bajo `tests/`, para
  17 falsos positivos medidos el 30-sep-2026 sobre 1345 commits). Para subir de versión:
  cambiar `GITLEAKS_VERSION` y `GITLEAKS_SHA256` (sale de `gitleaks_<v>_checksums.txt`).
- `coverage.yml` — `npm run test:coverage` (la suite completa con v8) y falla si baja
  del umbral de `vitest.config.ts`; sube `coverage-summary.json`/`lcov.info` como
  artefacto y deja el resumen en el job. Es aparte de `ci-checks.yml` a propósito (duplica
  el costo de la suite). Informativo mientras no se marque como check requerido.
- `smoke-post-deploy.yml` — tras un despliegue a Producción (`deployment_status` con
  `state=success`) o a mano (`workflow_dispatch` con `base_url`), corre
  `scripts/smoke-post-deploy/smoke.ts` contra esa URL: `/health`, cabeceras, login con
  credenciales inexistentes (401), guarda de Origin (403), `/auth/me` sin token (401) y la
  SPA. Local: `npm run smoke:post-deploy -- https://tu-dominio`. Hace checkout de la rama
  por defecto, no de la rama del evento.

Fuera de workflows: `/.github/CODEOWNERS` (rutas sensibles; solo obliga revisión si la
protección de `main` exige "Code Owners") y `/.github/dependabot.yml` (npm y Actions, semanal,
agrupado, tope de 3 y 2 PRs abiertos; ningún PR se fusiona solo).

## Workflows de plataforma agregados en PL-12

Mismas reglas que PL-11: ninguno usa `pull_request_target`, ninguno usa secretos, ninguno despliega ni toca
Vercel/Supabase, todos declaran `permissions: contents: read` (con las dos excepciones indicadas abajo).

- `codeql.yml` — CodeQL (`javascript-typescript`, `build-mode: none`, suite `security-extended`) en cada PR, en
  cada push a `main` y los lunes 09:17 UTC. El job de análisis agrega `security-events: write` (necesario para
  subir resultados); en un PR desde un fork el token es de solo lectura, el análisis corre y la subida se omite.
  No activar a la vez el "default setup" de code scanning desde la UI (hoy está sin configurar).
- `clock-guard.yml` — guard anti-bombas de tiempo: `npm run test:clock-guard` (config
  `vitest.clock-guard.config.ts`, 19 specs con relojes simulados: `hoyFechaNegocio`, `servidor-hoy` de
  rentas/hoteles/despachos/licitaciones/citas, zona horaria, fin de mes) bajo `TZ` = `UTC`, `America/Merida`,
  `America/Mexico_City` y `Pacific/Kiritimati`. Dispara en PR/push a `main` con `paths` de código, semanal
  (domingo 08:43 UTC) y a mano. Para agregar una spec sensible al reloj, súmala a `SPECS_SENSIBLES_AL_RELOJ`;
  un test de `packages/db/tests/ci-pl12-guards.spec.ts` verifica que cada ruta listada exista. Local:
  `TZ=America/Merida npm run test:clock-guard -- --maxWorkers=2`.
- `prod-health.yml` — cada 15 minutos hace `GET /health` (público) a la URL de la variable de repositorio
  `PROD_BASE_URL` (no es secreto; sin ella el job sale en verde sin hacer nada) con 3 intentos; en rojo si no
  responde 200 con `{ok:true}` o tarda más de 8 s, con el motivo en el resumen del job. Con la variable
  `PROD_HEALTH_OPEN_ISSUE=true` además abre/comenta/cierra un issue `salud-produccion` (por eso el job declara
  `issues: write`; apagado por defecto porque un issue público anuncia la caída). NO envía alertas por los
  canales de la app: el despachador `ALERTAS_*`/`SENTRY_DSN` (docs/CREDENCIALES.md) se configura en Vercel.
- Trinquete de lint: no es un workflow aparte sino un paso nuevo de `ci-checks.yml` (`npm run lint:ratchet`,
  `scripts/lint-ratchet/`): falla si las advertencias de ESLint superan `scripts/lint-ratchet/baseline.json`
  (hoy 0). El baseline solo baja: `node --experimental-strip-types scripts/lint-ratchet/ratchet.ts --update`
  lo baja si hay menos, nunca lo sube.
- Fuera de workflows: `docs/ROLLBACK.md` + `scripts/rollback/rollback.sh` (rollback MANUAL de Vercel por
  Javier, nunca desde CI).
- `e2e.yml` — pruebas de navegador (Playwright, solo chromium con cache) de `apps/web` contra el build estatico
  y una API simulada en loopback (`apps/web/e2e/mock-api`): `pull_request` (con `paths`) y `workflow_dispatch`,
  sin secretos, `permissions: contents: read`, `timeout-minutes: 25`, reporte y trazas como artefacto 7 dias.
  **No es un check requerido y NO entra al agregador `ci-checks`**; informativo hasta medir el flake. Guia:
  `docs/QA-E2E.md`.

## ci-checks.yml

Agregado 19-sep-2026, para cerrar un hueco que `postgres-real-gate.yml` (ver
abajo) documentaba explícitamente en su propio comentario de cabecera desde
que existe: **ningún** workflow de este repo corría `npm run typecheck`,
`npm run lint` ni `npm run test:unit` — ese tier corría solo a mano por quien
hacía el cambio, así que un PR con "tests en verde" era solo la palabra local
de quien lo construyó. Corre en tres jobs sobre `ubuntu-latest` (sin matriz):

| Job | Nombre del check | Pasos | `timeout-minutes` |
|---|---|---|---|
| `estatico` | `typecheck + lint + build de apps/web` | `npm ci` → typecheck → lint → trinquete de lint → build de `apps/web` | 15 |
| `unit-shard` (x3) | `test:unit (shard i/3)` | `npm ci` → `npm run test:unit -- --shard=i/3` (matrix, en paralelo) | 25 |
| `unit` | `test:unit` | agregador de los 3 shards (`if: always()`) | 5 |
| `ci-checks` | `typecheck + lint + test:unit + build de apps/web` | agregador (`needs` de los dos anteriores, `if: always()`): falla si alguno no terminó en `success` | 5 |

El job agregador conserva el nombre histórico del check, de modo que una
protección de rama que lo exija (hoy `main` no tiene protección ni rulesets,
verificado con `gh api .../branches/main/protection` y `.../rulesets`) sigue
resolviendo sin cambiar nada. Usa `if: always()` porque un job dependiente
"skipped" cuenta como exitoso para la protección de rama.

Medición (corridas `success` de este workflow, duración por paso en segundos,
tres corridas `success` recientes, antes de partir el job):

| Paso | Segundos |
|---|---|
| `npm ci` | 4-8 |
| typecheck | 62-100 |
| lint | 16-27 |
| trinquete de lint | 16-26 |
| `test:unit` | 451-677 |
| build de `apps/web` | 15-24 |

Es decir, `test:unit` es ~80-85% del tiempo del job; typecheck+lint+build es
~2-3 min. Con el job único, una corrida lenta rozaba el límite de 15 min
(corridas completas de 10 a 15.4 min según la carga del runner, y una cancelada por
`timeout-minutes` en el paso final de build, resuelta con `gh run rerun --failed`). Al partir: el tiempo de
pared pasa a ser el de `unit` (~8-11 min) en vez de la suma, y el límite de
`unit` sube a 25 min. El costo extra son ~15 s de `npm ci` + checkout por
duplicado (Actions es gratis en repos públicos).

Cachés evaluadas: el caché de npm (`cache: npm` de `actions/setup-node`) ya
existía y `npm ci` solo toma 4-8 s, así que no hay más que ganar ahí. No se
cachean `.tsbuildinfo`, el caché de vitest ni la salida del build de
`apps/web`: el typecheck son ~1-1.5 min y el build ~20 s (ganancia marginal),
y el costo dominante (`test:unit`) no se acelera con un caché de resultados
sin riesgo de ocultar un test roto. Sin secretos en ningún caché.

Frugal a propósito: `concurrency` con
`cancel-in-progress` por rama (solo para `pull_request`; en `push` a `main`
no cancela, para que dos merges seguidos no dejen el primer commit sin
veredicto propio), `permissions: contents: read`,
cache de npm, `paths` con exclusiones para cambios solo de docs/markdown
(con re-inclusiones explícitas de `docs/DEPLOY.md`,
`supabase/migrations/README.md`, `apps/**` y `packages/**` para no burlar los
guards de `docs-migration-count-guard.spec.ts` y `workspace-source-guard.spec.ts`
— ver el comentario de cabecera del propio workflow), sin servicios externos
ni secretos.

**Limitación conocida si algún día se vuelve check requerido:** si este check
("typecheck + lint + test:unit + build de apps/web") se marca como
obligatorio en la protección de la rama `main`, un PR cuyo diff completo cae
en la exclusión de `paths` (solo `**/*.md`/`docs/**` fuera de las
re-inclusiones) nunca dispara el workflow, y GitHub deja ese check en estado
"Expected"/pendiente para siempre — nunca en verde ni en rojo, bloqueando el
merge indefinidamente. Es una limitación conocida de GitHub Actions con
`paths`/`paths-ignore` + checks requeridos, no un bug de este repo. Hoy
(19-sep-2026) `main` no tiene ninguna protección de rama configurada, así que
esto no bloquea nada todavía; queda anotado aquí para quien active protección
de rama más adelante.

## postgres-real-gate.yml

Es **solo de tests contra Postgres real** — no tiene ningún paso de build,
deploy, publicación, ni integración con Vercel u otro servicio con costo o
efectos de producción. Dispara en `pull_request`, en `push` a `main`, y
manualmente (`workflow_dispatch`).

### Qué cubre

Cierra el hallazgo de la auditoría final de 20 rubros (rubros 9 y 20): el 0% de
la suite de tests de este monorepo (4089+ specs) ejercitaba Postgres real — todo
corría contra el repositorio en memoria de cada `domain-<vertical>`, que nunca
aplica RLS ni GRANT. Este job:

1. Levanta un Postgres real (servicio `postgres:16` de GitHub Actions).
2. Aplica, en orden, las migraciones reales de `supabase/migrations/`.
3. Corre `scripts/verify-real-postgres-ci/run-gate.mjs`, que ejecuta como gate
   automático (pass/fail por escenario, sin lectura humana de salida) cada
   `scripts/verify-*/assertions.sql` existente — se descubren solos (ver
   "Agregar un `verify-*` nuevo" abajo), así que esta lista se desactualiza
   fácil; al 19-sep-2026 son:
   - `scripts/verify-outbox-grants/` (GRANT + autorización del email outbox,
     6 verticales).
   - `scripts/verify-rentas-cron-rls/` (escape hatch de sesión-de-sistema en
     RLS para los crons de `domain-rentas`).
   - `scripts/verify-llm-usage-budget-guard/` (control de gasto de LLM del
     superadmin).
   - `scripts/verify-superadmin-caller-binding/` (12 funciones
     `*_for_superadmin` atadas a `auth.uid()`).
   - `scripts/verify-caller-binding-fase2/` (14 funciones más de `core` con el
     mismo patrón).
   - `scripts/verify-rentas-break-glass/` (acceso auditado de superadmin a
     reservas de rentas).
   - `scripts/verify-superadmin-facturacion/` (lecturas de MRR/reconciliación
     de la suscripción SaaS).
   - `scripts/verify-hoteles-sql-critico/` (trigger del gate de revenue,
     índice anti-doble-captura de night-audit, `mark_charge_reversed()`, RLS
     de reputación).
   - `scripts/verify-restaurantes-sql/` (RPC/reglas SQL que el repositorio
     Postgres real de restaurantes usa, incluida la zona conocida sin
     GRANT/policy que esta verificación encontró).
   - `scripts/verify-restaurantes-canales-escritura/` (el rol y la sesion exactos de
     produccion -- `authenticated`, `auth.uid()` NULL -- crean cliente, direccion, aviso y
     pedido por cada canal; el INSERT/UPDATE directo sigue denegado; migracion 048).
   - `scripts/verify-superadmin-salud/` (latidos de crons, salud de colas
     `messaging_outbox`, última corrida por fuente de licitaciones).
   - `scripts/verify-superadmin-mfa-switches-orgs/` (MFA TOTP del superadmin con
     funciones solo-sistema, interruptores de plataforma y gestión de organizaciones
     en dos pasos; ver `docs/SUPERADMIN_SEGURIDAD.md`).
   - `scripts/verify-superadmin-costos-planes/` (costo por evento por organización,
     tipo de cambio, catálogo de planes y asignación en dos pasos; ver
     `docs/SUPERADMIN_COSTOS_PLANES.md`).
   - `scripts/verify-superadmin-cfo/` (dashboard ejecutivo CFO: lectura con
     caller-binding, entradas de alerta y foto mensual de solo-sistema, formula
     de ingreso sin inventar precios; ver `docs/SUPERADMIN_CFO.md`).
   - `scripts/verify-superadmin-contratos/` (contrato por cliente: versiones
     inmutables, vigencias traslapadas rechazadas en la base, enmiendas, rol
     `finanzas` de solo lectura y sin acceso directo; ver
     `docs/SUPERADMIN_CONTRATOS.md`).
   - `scripts/verify-superadmin-gestion-organizaciones/` (doble control para
     suspender con contrato vigente, cambio de plan atado al contrato, un solo
     uso y vencimiento, bitácora append-only; ver
     `docs/SUPERADMIN_ORGANIZACIONES.md`).

Ver `scripts/verify-real-postgres-ci/README.md` para el detalle de cómo el
runner deriva el resultado esperado de cada escenario, y el `README.md` de cada
`scripts/verify-*/` para el alcance exacto de lo que cada uno verifica.

### Sharding y plantillas de base (7-oct-2026)

**Problema medido** (run de `main` 37503996161, 6-oct): el job único tardó 2.847 s (47 min; otros
runs de `main`: 47-86 min) mientras los demás jobs del mismo run duran 30-143 s. El log trae la
causa: por cada una de las ~154-170 carpetas `scripts/verify-*/`, `run-gate.mjs` creaba una base
nueva y aplicaba `bootstrap.sql` + las ~300 migraciones (~16 s de ~18 s por carpeta, mediana
17,8 s); los escenarios de la carpeta eran el ~10 %. Con ~7 PRs en vuelo y cada push reiniciándolo
era el cuello de botella del loop.

**Diseño**:

1. *Plantillas*: `run-gate.mjs` construye una base plantilla por `bootstrap.sql` distinto (hoy 7
   variantes; 159 de 170 carpetas comparten la misma) con bootstrap + todas las migraciones, y cada
   carpeta hace `create database … template …` (copia exacta del estado) y luego aplica SU
   `post-migrations.sql` y sus escenarios, igual que antes. Mismo SQL, mismo orden, mismas
   aserciones. `--no-template` restituye el camino antiguo.
2. *Shards*: `postgres-real-gate-shard` corre `run-gate.mjs --shard i/6` en una matrix (`fail-fast:
   false`). El reparto es determinista por costo (nº de escenarios + constante por carpeta,
   voraz de mayor a menor); no hay duraciones por carpeta guardadas, y el log muestra que el costo
   por carpeta es casi constante, por eso este estimador. N=6: con plantillas cada shard trabaja
   ~28 carpetas (~1-3 s cada una) + hasta 7 plantillas (~16 s c/u) y paga ~1 min de `npm ci`/setup;
   más shards solo añaden setup repetido, menos dejaría un shard dominado por las plantillas.
3. *Agregador*: el job `postgres-real-gate` conserva el nombre del check
   «Migraciones reales + assertions RLS/GRANT contra Postgres real» (`needs` + `if: always()`, como
   `unit` en `ci-checks.yml`): falla si el resultado de los shards no es `success` (fallido,
   cancelado u omitido) Y, además, descarga el reporte JSON que cada shard sube y ejecuta
   `run-gate.mjs --verify-reports`, que exige: los 6 reportes presentes, cada carpeta descubierta
   ejecutada en exactamente un shard, ninguna sobrante, ninguna con fallo.
4. *Cobertura idéntica*: antes de correr, cada shard recalcula la partición completa y aborta si
   alguna carpeta queda sin shard o en dos (`assertExactPartition`). `node
   scripts/verify-real-postgres-ci/run-gate.mjs --list-shards 6` imprime el reparto y comprueba la
   partición sin tocar Postgres. Ninguna aserción se debilita ni se omite.
5. *Concurrencia*: grupo `${{ github.workflow }}-${{ github.event.pull_request.number ||
   github.ref }}` con `cancel-in-progress` solo en `pull_request`: un push nuevo al mismo PR
   cancela el gate anterior de ese PR; PRs distintos y `main` nunca se cancelan entre sí (antes no
   había `concurrency` en este workflow).

**Si cambias N** (hoy 6): edita la matrix `shard: [1..N]` y el `/N` del paso; el agregador lo detecta
solo (exige los N reportes que declaran los propios shards, y cobertura exacta). Los otros jobs del
workflow (concurrencia, savepoint, eval-copiloto, …) no cambian.

**Revertir**: revertir el commit del PR restaura el job único (la ejecución local sin argumentos
sigue funcionando igual en ambos casos).

### Qué NO cubre

- `npm run typecheck`, `npm run lint` y `npm run test:unit` — desde
  19-sep-2026 corren en `ci-checks.yml` (ver arriba), workflow separado de
  este.
- `npm run test:integration` sigue **sin ningún trigger de CI** — ni este
  workflow ni `ci-checks.yml` lo corren; sigue corriéndose a mano por quien
  hace el cambio. Agregarlo es una decisión de plataforma más amplia (qué
  runner, si necesita su propio servicio de Postgres o Redis, tiempo de
  corrida), fuera del alcance del hallazgo que motivó `ci-checks.yml`.
- No ejercita ninguna tabla/función/policy de las 6 verticales que no esté ya
  cubierta por un `scripts/verify-*/assertions.sql` existente. No es un fuzz ni
  un test de regresión general del esquema — es exactamente, y solamente, lo
  que cada `assertions.sql` documenta que verifica.
- No corre contra un proyecto Supabase real ni contra staging/producción — el
  Postgres del job es efímero, vive solo durante el job, y se descarta al
  terminar.

### Agregar un `verify-*` nuevo

`run-gate.mjs` descubre automáticamente cualquier `scripts/verify-<algo>/` que
tenga `bootstrap.sql` + `post-migrations.sql` + `assertions.sql` — no hace falta
tocar este workflow. Ver `scripts/verify-real-postgres-ci/README.md` para el
contrato exacto que esos 3 archivos deben cumplir.

# Cobertura de tests unitarios

Hasta el 19-sep-2026 era literalmente imposible medir el % de cobertura de
este repo: `@vitest/coverage-v8` no estaba instalado. Ya lo está — este
documento explica cómo correrla, qué mide (y qué NO mide) y de dónde sale el
umbral configurado en `vitest.config.ts`.

## Cómo correrla

```
npm run test:coverage
```

Corre exactamente la misma suite que `npm run test:unit` (mismo
`vitest.config.ts`, mismos ~440 archivos de test), pero instrumentada con
`@vitest/coverage-v8` (provider `v8`, nativo de Node — no Istanbul). Imprime
un resumen en terminal (`text-summary`) y deja dos artefactos en `coverage/`
(ignorado por git, no se versiona):

- `coverage/coverage-summary.json` — números exactos por archivo y agregados,
  para leer con un script (así es como se generan los "5 mejores / 10 peores
  por workspace" cuando alguien pida ese desglose — no se recalculan a mano).
- `coverage/lcov-report/index.html` — reporte navegable línea por línea.

**No hay ningún número de cobertura escrito aquí a propósito** (mismo
criterio que `docs/DEPLOY.md`/`supabase/migrations/README.md` con el conteo
de migraciones, protegido por
`packages/db/tests/docs-migration-count-guard.spec.ts`): un % fijo en un
documento se pudre en cuanto alguien agrega o quita un test, y nadie lo
actualiza a mano de forma confiable. El número real de hoy sale de correr el
comando de arriba.

`npm run test:unit` / `npm test` **no** activan la instrumentación (no pasan
`--coverage`) — siguen corriendo a la misma velocidad de siempre. Correr con
cobertura toma sensiblemente más tiempo que sin ella (instrumentación v8 por
archivo); en una máquina sin otra carga, cuenta con roughly el doble de
duración.

## Qué mide (y qué NO)

Cobertura de **statements/lines, branches y functions** sobre el código
fuente real de cada workspace:

- `apps/*/src/**` (api, web, worker)
- `packages/*/src/**` (todo `packages/core-*`, `domain-*`, `agent-core`,
  `billing`, `db`, `ui`, `whatsapp-gateway`)
- `packages/mcp-servers/*/src/**`

Se excluyen (ver el `coverage.exclude` comentado en `vitest.config.ts` para
la lista exacta y el porqué de cada entrada): tests y fixtures, `*.d.ts`,
barriles de solo re-export (`index.ts` que únicamente hacen
`export * from "./x"` / `export { a, b } from "./x"`, verificados uno por uno
— no excluidos solo por llamarse `index.ts`), tipos puros sin lógica en
tiempo de ejecución, y los dobles de prueba deterministas que simulan
servicios externos (p. ej. `fake-graph-client.ts`, `fake-provider.ts`,
`fake-pac-adapter.ts` — nunca tocan la red, existen solo para que los tests
no dependan de credenciales reales).

**Advertencia honesta, la más importante de este documento:** toda esta
suite corre contra **repositorios en memoria**
(`packages/*/src/in-memory-*.ts` — implementaciones reales con las mismas
restricciones de integridad que las migraciones SQL, pero sin Postgres
detrás), no contra una base de datos real. Un % de cobertura alto aquí
**no certifica que el SQL ni las políticas RLS estén probados**. Eso lo
cubre un mecanismo aparte: el gate de Postgres real
(`scripts/verify-*/`, que corre en CI vía
`.github/workflows/postgres-real-gate.yml`), que ya destapó bugs reales
invisibles para esta suite unitaria — el ejemplo documentado en el README
raíz ("Problemas conocidos": sesión de sistema sin acceso a `core.property`)
es exactamente ese tipo de bug: los tests en memoria nunca aplican RLS real,
así que un 100% de cobertura de líneas en ese código igual habría pasado en
verde con el bug presente.

En resumen: cobertura alta = la lógica de TypeScript se ejecutó bajo test.
Cobertura alta ≠ el SQL/RLS/GRANT reales están probados.

## El umbral

`vitest.config.ts` fija `coverage.thresholds` (lines/statements/branches/
functions) como un **trinquete anti-regresión**, no como una meta
aspiracional: se calculó tomando la cobertura real medida el 19-sep-2026 y
restando ~2 puntos porcentuales a cada métrica, redondeando hacia abajo. La
suite falla (`test:coverage` sale con código != 0) si algún PR hace bajar la
cobertura global por debajo de ese piso; no exige que suba.

Los valores exactos viven en `vitest.config.ts` (bloque `coverage.thresholds`,
con el comentario que dice de qué corrida salieron) — no se repiten aquí para
no duplicar una fuente de verdad que se puede leer directo del config.

### Cómo subirlo

1. Corre `npm run test:coverage` y anota el resumen (`text-summary`) o abre
   `coverage/lcov-report/index.html`.
2. Si la cobertura real subió de forma sostenida (no por una corrida
   puntual), edita `coverage.thresholds` en `vitest.config.ts` a ~2 puntos
   por debajo del nuevo número medido, redondeando hacia abajo — mismo
   criterio que el umbral original.
3. Actualiza el comentario junto al bloque `thresholds` con la fecha y los
   números de esa corrida (mismo patrón que este documento: el dato vive en
   un comentario fechado, no como verdad permanente).
4. No subas el umbral por encima de lo medido "porque debería poder
   lograrse" — eso convierte el trinquete en una meta aspiracional y rompe
   builds por una razón distinta a una regresión real.

## Gaps reales conocidos (no exhaustivo, ver el reporte para el detalle completo)

La brecha más grande del repo hoy es `apps/web`: casi todos los componentes
de página (`src/verticals/*/pages/*.tsx`, los `*Shell.tsx`, varias
`lib/*-client.ts`) tienen 0% porque **casi no hay tests de componentes React**
(hallazgo de auditoría ya conocido — ver el histórico de `README.md`); los
pocos `*.spec.tsx` que existen cubren un puñado de páginas de superadmin y
los `*-shell-mobile-nav.spec.tsx`. Esto es un déficit de tests, no un
problema de configuración de cobertura.

## CI

El workflow existente (`.github/workflows/postgres-real-gate.yml`) **no**
corre `test:unit` ni `test:coverage` — solo el gate de Postgres real. Esta
tarea no le agregó cobertura al CI actual (decisión de costo/tiempo del
dueño del repo, fuera de alcance aquí); ver la descripción del PR que
introdujo este documento para una propuesta concreta de job opcional.

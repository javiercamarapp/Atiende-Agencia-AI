# Reglas de la casa (Atiende-Agencia-AI)

Monorepo npm workspaces: `apps/{web,api,worker}` + `packages/*`. Repo **público**. Reglas cortas y verificables; el detalle vive en los
documentos enlazados. Si una regla choca con una petición explícita de Javier, gana Javier.

## Dato duro

- **Mergear a `main` despliega al instante a Producción (Vercel)**, incluido `vercel.json` (crons). La base Supabase real va **por detrás** del código:
  nadie aplica migraciones al fusionar. No fusiones, no apliques SQL a la base real ni toques la configuración de Vercel sin OK explícito de Javier.
- Nunca escribas valores de secretos (código, docs, PRs, commits, chats). Repo público: los hallazgos de seguridad se describen como
  disponibilidad o defensa en profundidad, sin receta de explotación. Rotación: `docs/runbooks/ROTACION-DE-LLAVES.md`.

## Base de datos y migraciones

- Migración en `packages/<paquete>/migrations/NNN_nombre.sql` con el siguiente número **interno** libre de ese paquete, más su **espejo byte-idéntico** en
  `supabase/migrations/<prefijo>_NNN_nombre.sql` (prefijo único y creciente; ver `supabase/migrations/README.md`). Verifica: `npm run verify:migration-versions`.
- SQL: nunca `using (true)`; nunca `GRANT` a `anon`; `GRANT` a nivel columna cuando solo se escriben algunas; toda función `security definer` con `set search_path` fijo y
  `revoke` de `public`; funciones de superadmin exigen `auth.uid() = p_caller_id`; las de solo sistema, `auth.uid() is null`. Cada GRANT, policy o función lleva su justificación
  de seguridad en el comentario, y un `scripts/verify-<tema>/` contra Postgres real (positivo, negativo, cross-tenant, anon) en el gate de CI.
- **Compatibilidad con la base sin migrar**: todo TypeScript nuevo debe seguir funcionando contra la base vieja. Captura SQLSTATE `42883`, `42P01` y `42703` y cae al camino
  anterior o a un vacío honesto ("no disponible aún"), nunca a un 500. Dentro de una transacción compartida (`dbSession` / `engine.withAppSession`) el fallback exige
  `SAVEPOINT`: usa `runWithSavepointFallback` de `@atiende/db` (`packages/db/src/savepoint-fallback.ts`; por fila en un lote, un savepoint por fila). Pruébalo con `AbortAwareFakeSession` (`packages/db/tests/support/`).
  Barridos de cron: una transacción por unidad.

## Git y PRs

- Commits **atómicos y significativos** por causa raíz (tests separados del fix; migración, backend y frontend por separado). **Sin squash** (merge o rebase que preserve autoría), sin commits vacíos ni de relleno,
  sin force-push. Usa solo la identidad git ya configurada.
- Rama desde `origin/main`; si `main` avanza, trae `origin/main` con **merge**. Abre el PR con el primer push útil; el cuerpo lleva resumen, evidencia antes/después, justificación de seguridad
  y **orden de despliegue**, y cada afirmación debe coincidir exactamente con el diff.
- El CI corre typecheck + lint + `test:unit` + build de `apps/web` en cada push; un PR no está terminado hasta que su CI esté en verde. Verifica el CI de `main` tras cada merge.
- Un cambio que toca `vercel.json` o crons lo dice en el PR (el merge lo despliega): `docs/CRONS.md`, tope de 40 crons del plan Pro (`apps/api/tests/vercel-crons-contrato.spec.ts`).

## Producto

- **Notificaciones**: todo evento importante del ciclo (algo nuevo que atender, un fallo, algo por vencer, una aprobación pendiente, un umbral de costo, un cierre) emite una notificación in-app con
  `emitirNotificacion` (`@atiende/db`): tipo, severidad, categoría, enlace a la pantalla origen, **clave de dedupe**, sin PII en el texto. Se agrega al catálogo `CATALOGO_NOTIFICACIONES`
  (`packages/db/src/notificaciones/catalogo.ts`). Ver `docs/NOTIFICACIONES.md`.
- **Diseño idéntico a Likida**: toda pantalla, botón, pop-up y recuadro nuevo o tocado usa los componentes de `packages/ui` y el mismo lenguaje de Likida (tipografía, tamaños, márgenes, composición compacta,
  tarjetas, barra superior por página con icono + nombre), **conservando el azul de Atiende**; excepciones: el título de categoría del sidebar (mono de Atiende) y el logo. Sin estilos nuevos inventados.
  Guards: `docs/diseno-ux-guard.md` (`web-ds-v2-guard`, formato único `es-MX` con trinquete).
  **Overlays (UNI-R0)**: pop-ups, listas desplegables, toasts, campana y estados salen de `@atiende/ui` (`Dialog`/`FormDialog`/`FormDialogElegante`/`ConfirmDialog`, `Selector`, `notify`, `CentroNotificaciones`, `Panel`, `EstadoVacio`); nunca Radix/sonner directo, `alert()`, `role="dialog"` ni `fixed inset-0` a mano. Catálogo vivo: `/dev/catalogo` (solo `vite dev`).
- **Nada de maquetas**: ningún control sin backend real detrás (endpoint con RLS/roles/validación/bitácora, estados de carga, error y vacío, y prueba). Lo que dependa de credenciales u otro PR se oculta o
  muestra un estado honesto "no disponible aún: requiere X" y se declara como hueco conocido. Los dobles solo existen en tests y en la API simulada de e2e.

## Verificación (esta Mac tiene poca RAM)

- Solo los tests de lo que tocas, **siempre con tope de workers y sin watch**: `npx vitest run <ruta> --maxWorkers=2`.
- Antes de dar un PR por terminado: `npm run typecheck`, `npm run lint` y tu `scripts/verify-*` si aplica (pesados: de uno en uno). La suite completa `npm run test:unit` la corre el CI, no tu máquina;
  si necesitas correrla: `npm run test:unit -- --maxWorkers=2`.
- e2e de navegador: `npm run test:e2e` corre contra el build estático y una **API simulada** (`apps/web/e2e/mock-api`), nunca contra la base real ni Vercel (`docs/QA-E2E.md`).
- Un test que tarda más de 2 minutos o un worker de vitest que pasa de ~1 GB es un bucle o una fuga: mátalo, arréglalo y corre solo ese archivo.

## Documentos clave

`README.md` · `docs/DEPLOY.md` · `docs/CRONS.md` · `docs/CREDENCIALES.md` · `docs/NOTIFICACIONES.md` · `docs/PRIVACIDAD-PLATAFORMA.md` · `docs/ROLLBACK.md` ·
`docs/RESPALDO-Y-RESTAURACION.md` · `docs/QA-E2E.md` · `docs/runbooks/INCIDENTES.md` · `docs/runbooks/ROTACION-DE-LLAVES.md` · `docs/runbooks/DR.md`

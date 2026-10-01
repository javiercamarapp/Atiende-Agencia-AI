# Estrategia de e2e de navegador con Playwright (PL-12) — DISEÑO, no activo

**Estado: solo diseño.** No se instaló ninguna dependencia (`@playwright/test` NO está en `package.json` ni en
`package-lock.json`) ni existe workflow de e2e. Instalar Playwright agrega ~200 MB de navegadores y una
dependencia nueva a un repo público: **requiere el visto bueno de Javier**. Los archivos de `e2e/` llevan
sufijo `.example` precisamente para que ni `tsc`, ni ESLint, ni Vitest ni ningún workflow los recojan.

## Qué huecos cubre (y cuáles no)

La suite actual (`npm run test:unit`, ~5 200 tests) corre en Node/jsdom con repositorios en memoria; el gate de
Postgres real cubre SQL/RLS; `smoke-post-deploy` cubre la API desplegada. Nada ejercita **un navegador real
contra la SPA de `apps/web`**: enrutado, sesión por cookie, CSP, formularios, layouts móviles. Eso es lo que
cubriría e2e. Fuera de alcance: lógica de negocio (ya probada abajo), carga/rendimiento y pruebas visuales.

## Pirámide propuesta (de más a menos)

1. **Humo de navegador (primero, el único que se activaría al inicio)** — 3 a 5 recorridos, < 2 min:
   la SPA carga sin errores de consola, `/login` rechaza credenciales inexistentes con mensaje visible, una ruta
   protegida redirige a login sin sesión, y la página no viola la CSP `Report-Only` (escuchar `securitypolicyviolation`).
2. **Recorridos por rol** — un recorrido feliz por vertical (citas, hoteles, restaurantes, rentas, despachos,
   licitaciones) y por el panel superadmin, con sesión sembrada. Se agregan de uno en uno, solo cuando el humo
   sea estable.
3. **Responsive** — mismo recorrido a 390×844 y 1280×800 (las shells móviles ya tienen tests de componente).

## Contra qué corre (sin tocar producción)

- **Nunca contra Producción ni contra la base real de Supabase.** El job levantaría el entorno local:
  Postgres efímero (el mismo servicio y migraciones que `postgres-real-gate.yml`), `apps/api` y `apps/web`
  (`npm run build --workspace apps/web` + `vite preview`), todo en el runner. Los usuarios se siembran con el
  seed de pruebas existente, con credenciales desechables generadas en el job.
- Alternativa más barata para el primer paso: humo contra el build estático de `apps/web` con la API
  simulada (`page.route`), sin Postgres. Decisión pendiente de Javier.
- Sin secretos: ni claves de WhatsApp/Stripe/Resend (los adaptadores falsos ya existen en el repo).

## Reglas de diseño de los tests

- Localizadores por rol/etiqueta accesible (`getByRole`, `getByLabel`), nunca por CSS frágil; si falta una
  etiqueta accesible, se arregla la UI.
- Relojes: `page.clock` de Playwright para fijar "hoy" y probar 23:30 America/Merida y fin de mes/año en la UI
  (mismo espíritu que `clock-guard.yml`); `timezoneId` explícito por proyecto.
- Sin `waitForTimeout`; esperas por aserciones. Un test = un recorrido independiente (estado propio, sin orden).
- Reintentos: 0 en local, 1 en CI; el flake se arregla, no se esconde. Trazas/capturas solo en el primer reintento.
- Sin tests contra servicios de terceros reales.

## Integración con CI (cuando se apruebe)

- Workflow `e2e.yml` aparte (no dentro de `ci-checks.yml`): `pull_request` (nunca `pull_request_target`),
  `permissions: contents: read`, `timeout-minutes: 15`, cache de navegadores de Playwright, `paths` acotado a
  `apps/web/**`, `apps/api/**`, `packages/**` y `e2e/**`. Sube `playwright-report/` como artefacto (retención 7 días).
- Primero informativo (no check requerido) durante 2 semanas; promover a requerido solo con tasa de flake < 1 %.
- Costo: gratis en repo público; presupuesto objetivo ≤ 5 min por corrida.

## Para activarlo (pasos, todos requieren OK de Javier)

1. `npm i -D @playwright/test` (dependencia nueva, revisar `npm audit` y el tamaño del lockfile).
2. Renombrar `e2e/playwright.config.ts.example` → `e2e/playwright.config.ts` y `e2e/tests/*.spec.ts.example`
   → `*.spec.ts`; agregar `"e2e/**/*.ts"` al `tsconfig` (o un tsconfig propio) y excluir `e2e/` de
   `vitest.config.ts` (su `include` ya no lo recoge) y de ESLint si hiciera falta.
3. Copiar `e2e/e2e.yml.example` a `.github/workflows/e2e.yml`.
4. Script `npm run test:e2e` = `playwright test -c e2e/playwright.config.ts`.

## Esqueleto (inactivo)

`e2e/README.md`, `e2e/playwright.config.ts.example`, `e2e/tests/humo.spec.ts.example`, `e2e/e2e.yml.example`.

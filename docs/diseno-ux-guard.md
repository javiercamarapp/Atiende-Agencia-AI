# Guard estatico del DS v2 (diseno-ux PR-12)

Un solo guard impide que reaparezcan en `apps/web/src` los patrones que el plan de diseno-ux retiro. Baseline 0, sin lista de excepciones.

## Donde vive

| Archivo | Que hace |
|---|---|
| `apps/web/tests/test-utils/ds-v2-guard-reglas.ts` | Unica fuente de verdad: lista `REGLAS`, `REGLAS_DELEGACION`, el quitador de comentarios y el cargador de fuentes. |
| `apps/web/tests/web-ds-v2-guard.spec.ts` | Escanea todo `apps/web/src` (`.ts`/`.tsx`, sin comentarios) y exige 0 infractores por regla. |
| `apps/web/tests/web-ds-v2-guard-sanidad.spec.ts` | Prueba que cada regla falla de verdad (fixtures que la violan) y que el escaneo de punta a punta senala el archivo correcto. |

Corre dentro de `npm run test:unit`, por lo que el CI del repo lo ejecuta en cada push. Para correrlo solo:

```bash
npx vitest run apps/web/tests/web-ds-v2-guard.spec.ts apps/web/tests/web-ds-v2-guard-sanidad.spec.ts --maxWorkers=2
```

## Reglas

| Regla | Sustituto correcto |
|---|---|
| `window.confirm` / `confirm("...")` | `useConfirm` |
| `text-[Npx]` | escala `text-2xs/xs/sm/base` |
| paleta cruda de Tailwind (`bg-green-500`, `text-white`, ...) | tokens, `StatusBadge`, `Callout` |
| hex literal (`#ff00aa`) | tokens `hsl(var(--...))` |
| `style={{...}}` | clases |
| `<select>`, `<textarea>`, `type="checkbox"` crudos | `Selector` (lista de Radix; `NativeSelect` solo donde aun no se migra), `Textarea`, `Checkbox` |
| `function formatMoney` en `pages/` | `formatMoney` de `@atiende/ui` |
| `function fmtMoney` o `toLocaleString("es-MX", { minimumFractionDigits` en `verticals/hoteles/pages/` (alcance heredado del guard de hoteles) | `formatMoney` de `@atiende/ui` |
| `ModalFormularioLateral` | `FormDialog` |
| `@radix-ui/react-(dialog\|alert-dialog\|popover\|select\|dropdown-menu\|tooltip)` importado directo en `apps/web/src` (UNI-R0) | `Dialog`, `Popover`, `Select`/`Selector`, `DropdownMenu`, `Tooltip` de `@atiende/ui` |
| `import ... from "sonner"` directo (UNI-R0) | `notify` / `Toaster` de `@atiende/ui` |
| `window.alert(...)`, `aria-modal`, `<dialog>` (UNI-R0) | `Dialog`, `ConfirmDialog`, `notify` |
| En `verticals/restaurantes`: `role="dialog\|alertdialog\|listbox\|tooltip"`, `fixed inset-0`, `<datalist>` (UNI-R0) | `FormDialog`, `FormDialogElegante`, `Dialog`, `Selector`, `Popover` |
| `<table>` crudo | `Table` / `DataTable` |
| `<Badge>` | `StatusBadge` |
| `className="... p-6"` | `PageContainer` |
| tokens heredados retirados (`bg-gold`, `text-terracotta`, `sand`, `olive`, `cream`, `shadow-glow`, `bg-gradient-hero`) | tokens v2 |
| `variant="hero\|gold\|terracotta"` de `Button` | variantes vigentes |

Reglas de delegacion: `verticals/restaurantes/dashboard-client.ts` y `verticals/despachos/lib/format.ts` deben importar de `@atiende/ui` y no reimplementar el formato (`toLocaleString` / `Intl.NumberFormat`).

## Consolidacion de los guards por vertical

Se borraron `restaurantes|hoteles|rentas|despachos|licitaciones|superadmin-ds-v2-guard.spec.ts`. Comparacion regla por regla contra el global:

- Las 10 reglas comunes de los 6 guards (confirm, text-[px], paleta, hex, style, select, textarea, checkbox, formatMoney, p-6) ya estaban en el global.
- `ModalFormularioLateral` y `<Badge>` (en despachos, rentas, licitaciones, superadmin) ya estaban en el global.
- Reglas que SOLO existian en un guard por vertical y se movieron al global: `fmtMoney`/`toLocaleString` en paginas de hoteles (con `alcance` propio: aplicarla a todas las paginas fallaba en `superadmin/pages/BreakGlass.tsx` y `rentas/pages/OwnerPortalDashboard.tsx`, que formatean moneda con sufijo, y `despachos/pages/Dashboard.tsx`, un porcentaje; los dos primeros ya figuran como pendientes en `diseno-ux-inventario-restante.md`), delegacion de `dashboard-client` (restaurantes) y de `lib/format` (despachos).
- Los minimos de archivos por vertical (40/30/30/30/30/25) se conservan en el global como "escanea al menos N archivos en <area>".
- Diferencia de alcance a favor del global: las reglas `soloPaginas` usaban `startsWith("pages")` por vertical; el global usa cualquier directorio `pages/`, mas amplio.
- Alcance nuevo: dos reglas anti-regresion para los legados ya retirados (tokens `gold/terracotta/sand/olive/cream`, `shadow-glow`, `gradient-hero`, variantes de `Button`), que hoy no tienen ningun uso.

## Por que vitest y no ESLint ni un script

Se evaluo moverlo a `eslint.config.js` o a `scripts/verify-ds-v2-guard.mjs` y se decidio dejarlo como spec de vitest:

- Ya corre en el CI con `npm run test:unit`; un script o una regla de ESLint duplicaria la ejecucion.
- Las reglas son expresiones regulares sobre texto sin comentarios (cadenas de clases, hex, JSX); `no-restricted-syntax` opera sobre el AST y no ve el contenido de `className` ni cadenas de forma comoda.
- La prueba de sanidad con fixtures vive junto al guard y se ejecuta con el mismo runner.

## Legados

`gold/terracotta/sand/olive/cream`, `shadow-glow`, los gradientes y las variantes `hero|gold|terracotta` de `Button` ya estaban retirados en `packages/ui` (solo quedan menciones en comentarios que explican el retiro). `GOLD` en `restaurantes` es un nivel de cliente (dato), no un token de color, y `hero` en `login.css`/`VerticalLogin` es una clase propia del login de marca: no se tocaron. `ModalFormularioLateral` solo aparece en comentarios.

## Fuera de alcance (pendiente)

- La bandera `?ds=v2` (`inicializarTemaV2`) se retiro en UNI-0 (spec de diseno Atiende = Likida): los tokens de Likida aplican directo en claro y oscuro.
- No cubiertos por el guard (ver `docs/diseno-ux-inventario-restante.md` seccion 2): `<input type="radio">`, `<button>` de tarjeta, anchos `w-[Npx]`, CSS de `pages/login.css`.

## Formato unico de numeros y fechas (PL-19, trinquete)

`apps/web/tests/formato-unico-guard.spec.ts` cuenta las llamadas `toLocaleString|toLocaleDateString|toLocaleTimeString` de
`apps/web/src`, `packages/ui/src` y `packages/domain-*/src` (sin comentarios ni los formateadores canonicos:
`formatMoney.ts`, `formato-preset.ts`, `lib/formato-fecha.ts`). El numero **no puede subir** por encima de
`apps/web/tests/formato-unico-baseline.json` y **puede bajar** (al bajar, el test pide bajar el baseline; nunca subirlo). Ninguna
llamada puede fijar un locale distinto de `es-MX` (se tolera `en-CA`, modismo para `YYYY-MM-DD`). Las pantallas nuevas usan
`formatMoney` / `resolverFormato` de `@atiende/ui` o `lib/formato-fecha.ts`. Sanidad: `formato-unico-guard-sanidad.spec.ts`.

## Familia unica de overlays (UNI-R0)

Todo pop-up, lista desplegable, toast y estado sale de `@atiende/ui`; ver el inventario y las decisiones en
`pm/paridad-visual/unificacion-overlays.md` (fuera del repo) y el catalogo vivo en `/dev/catalogo` (solo `vite dev`).

- Modales: `Dialog` (`size` sm/md/lg/xl, `DialogHeader icono tono`), `FormDialog` (riel + franja, el del repo suelto `ModalFormularioLateral`), `FormDialogElegante` (`ModalFormularioElegante`), `ConfirmDialog`/`useConfirm` (peligro con icono) y `Sheet`. Recetas compartidas en `packages/ui/src/components/ui/superficies.ts`.
- Listas: `Selector` (acepta `<option>`/`<optgroup>`/`onChange`, sobre `Select` de Radix) o `Select*` compuesto. `NativeSelect` queda solo en las zonas aun no migradas; el guard de restaurantes lo prohibira en el PR de migracion.
- Avisos: `notify.success|info|warning|error|cargando|promise` (barra de autocierre, pausa al cursor, maximo 3 apilados). La campana abre `CentroNotificaciones` (popover) via `CampanaNotificaciones` de `apps/web`.
- Recuadros y estados: `Panel` (tarjeta de seccion), `Card`, `EstadoVacio` (fila de Likida por defecto; centrado dentro de restaurantes via `VarianteEstadoVacioProvider`, o con `variante="centrado"`), `EstadoCargando`, `Skeleton`, `EstadoError`.
- Graficas: `GRAFICA_TEMA` (constantes sobre tokens del aspecto del repo suelto).
- Movimiento: todo bajo `prefers-reduced-motion` (bloque global de `index.css` + `motion-reduce:` en las listas).

## Ambito visual de restaurantes (UNI-R0b)

El aspecto del repo suelto (paleta, botones en pildora, overlays) se aplica solo a restaurantes con `html[data-ambito="restaurantes"]`
(`useAmbitoVertical` en `RestaurantesShell`); el sidebar repone la paleta de Likida con `data-ambito-base`. Reglas nuevas del guard
(`apps/web/tests/test-utils/ds-v2-guard-reglas.ts`, baseline 0, con casos de sanidad):

- **Color funcional literal en restaurantes**: `rgb()/rgba()/hsl()/hsla()` con numeros u `oklch()/oklab()/lab()/lch()` en `verticals/restaurantes/` (solo `hsl(var(--token))`).
  Se suma a las reglas globales de paleta cruda de Tailwind, hex literal y `text-[Npx]`, que ya cubren restaurantes.
- **Variante `rest:` o `data-ambito` a mano en `apps/web/src`**: el ambito lo aplican los primitivos de `@atiende/ui`, no las pantallas.

Pruebas del ambito (no son parte del guard de `apps/web`):

| Archivo | Que fija |
|---|---|
| `packages/ui/tests/tokens-restaurantes.spec.ts` | Valores exactos del original (claro y oscuro), contraste WCAG AA con los valores reales de `index.css`, que `[data-ambito-base]` repone Likida token a token, que toda regla `rest:` compilada lleva el prefijo del ambito, que ninguna clase `rest:` usa paleta cruda/hex/`text-[Npx]` (con casos negativos) y que el CSS de toasts esta acotado al atributo. |
| `packages/ui/tests/ambito-restaurantes.spec.tsx` | `useAmbitoVertical`, y las recetas de Button (variantes y tamanos del original), campos y overlays. |
| `apps/web/e2e/tests/restaurantes/uni-r0b-ambito.spec.ts` | Estilos computados en un navegador real (claro, oscuro, 375 px): paleta, sidebar en Likida, pildora, velo, titulos, campos y que citas no cambia. |

Los specs de Likida (`tokens-likida`, `ui-ds-v2-button`, `ui-primitivos-accion-likida`) siguen con sus aserciones originales: por eso el
Button y los campos reciben el repo suelto por clases `ambito-*` de `index.css` y no por utilidades en el `className`, y la variante
`rest:` vive en un plugin aparte (el preset conserva su unico plugin y no define `addVariant`).

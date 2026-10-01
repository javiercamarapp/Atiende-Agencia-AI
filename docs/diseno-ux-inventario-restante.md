# Inventario de violaciones del DS v2 en `apps/web/src` (base del guard de PR-12)

Medido el 1-oct-2026 sobre `apps/web/src` (todo, fuera de `packages/ui`), antes y despues de PR-11. La fuente de verdad ejecutable es el guard `apps/web/tests/web-ds-v2-guard.spec.ts`: es el mismo conjunto de reglas de los guards por vertical, aplicado a TODO `apps/web/src`, sin comentarios, y falla si reaparece una sola ocurrencia. Para reproducir el conteo: `npx vitest run apps/web/tests/web-ds-v2-guard.spec.ts --maxWorkers=2` (hoy: 14 pruebas, todas en verde = baseline 0).

## 1. Conteo antes / despues (ocurrencias por regla)

"Antes" = `origin/main` en `3c916e37` (con superadmin #279 ya fusionado), contado con las mismas expresiones regulares del guard sobre el codigo sin comentarios. "Despues" = esta rama.

| Regla (patron del guard) | Antes | Despues |
|---|---:|---:|
| `window.confirm(` / `confirm("...")` | 0 | 0 |
| `text-[Npx]` (tamano arbitrario) | 118 | 0 |
| `style={{` (estilo inline) | 34 | 0 |
| Paleta cruda de Tailwind (`bg-/text-/border-...-(green|amber|red|...|white|black)`) | 17 | 0 |
| Color hexadecimal literal en `.ts/.tsx` | 10 | 0 |
| `<select>` crudo | 13 | 0 |
| `<textarea>` crudo | 0 | 0 |
| `type="checkbox"` crudo | 5 | 0 |
| `<table>` crudo (regla nueva en el guard global) | 6 | 0 |
| `<Badge>` con colores propios | 23 | 0 |
| `ModalFormularioLateral` | 8 | 0 (componente retirado) |
| `className="...p-6"` de pagina | 4 | 0 |
| `function formatMoney(` dentro de `pages/` | 0 | 0 |

Antes, por zona (suma de ocurrencias de las reglas anteriores salvo `<table>`: 240):

| Zona | Antes | Despues |
|---|---:|---:|
| `verticals/citas` (shell + 12 paginas) | 128 | 0 |
| `shell/*` (aceptar invitacion, elegir organizacion, sin organizacion, selector de vertical) | 51 | 0 |
| `components/` (`VerticalLogin`, `ModalFormularioLateral`, `BotonChatDatos`) | 23 | 0 |
| `pages/` (404, Terminos, Privacidad) | 9 | 0 |
| `verticals/restaurantes` (`<Badge>`) | 15 | 0 |
| `verticals/hoteles` (`<Badge>`) | 9 | 0 |
| `verticals/despachos`, `verticals/licitaciones` (heuristica `gap-4 p-4` + `formatMoney`, ver 2) | 5 | 0 (ver 2) |
| `verticals/rentas`, `superadmin/` | 0 | 0 |

Las verticales de restaurantes, hoteles, rentas, despachos y licitaciones y el superadmin ya estaban limpios de todo salvo lo de la tabla; `verticals/citas` no habia pasado por ninguna de PR-5..PR-10 (solo su shell, en PR-4).

## 2. Lo que NO se migro, con motivo (fuera de las reglas del guard)

| Hallazgo (medido con `grep`) | Donde | Motivo |
|---|---|---|
| 3 funciones `formatMoney` locales | `verticals/despachos/lib/format.ts`, `verticals/licitaciones/lib/format.ts`, `verticals/restaurantes/dashboard-client.ts` | No duplican el formateo: envuelven `formatMoney` de `@atiende/ui` (numerico, sin moneda) para anteponer `$`, manejar `null` ("—") o la moneda ISO de la convocatoria. Viven en `lib/`, no en paginas; el guard solo las prohibe en `pages/`. Unificarlas exige un `formatMoney` con moneda en `@atiende/ui` (decision de producto/API). |
| 3 `<input type="radio">` crudos | `despachos/pages/Conciliacion.tsx` (2), `licitaciones/pages/PropuestaTecnica.tsx` (1) | `@atiende/ui` no tiene primitivo de radio; crearlo es un cambio de `packages/ui`, fuera del alcance de PR-11. |
| 4 `<button>` crudos | `rentas/components/calendario-vistas.tsx`, `restaurantes/voz/SelectorVoz.tsx`, `restaurantes/pages/Conversaciones.tsx`, `components/VerticalLogin.tsx` | Son tarjetas/filas clicables o el boton de pildora del login (`login-btn`, CSS propio de `login.css`), no botones de accion; `Button` es una pildora con alto fijo y no sirve como contenedor de tarjeta. |
| ~164 anchos `w-[Npx]` y 5 `h-[Npx]` arbitrarios, 4 `rounded-[Npx]` | repartidos | No estan en la lista de reglas de PR-12 (son medidas de layout, no tamanos de texto ni colores). |
| 3 `font-size: Npx` y 4 hex en `pages/login.css`; sombra con `rgb()` en `SeleccionarVertical`, `bg-[conic-gradient(...)]` en `SelectorVoz` | CSS/clases con tokens `hsl(var(--...))` o colores de marca de la lamina de login | El guard escanea `.ts/.tsx`; el CSS de login es de marca (Fraunces/IBM Plex) y se migra junto con el login v2 cuando Javier apruebe el aspecto en preview. |
| Aspecto v2 apagado por defecto | `?ds=v2` (bandera `inicializarTemaV2`) | Se retira en PR-12 tras la revision de Javier en preview; este PR no la toca. |

## 3. Recomendacion para el guard de PR-12

1. Promover `apps/web/tests/web-ds-v2-guard.spec.ts` a regla de lint o dejarlo como esta (ya corre en `npm run test:unit` y por tanto en el CI): baseline 0, sin lista de excepciones.
2. Borrar los 6 guards por vertical (`restaurantes|hoteles|rentas|despachos|licitaciones|superadmin-ds-v2-guard.spec.ts`), que son subconjunto del global.
3. Si se quiere cubrir lo de la seccion 2, el orden de costo es: radio en `@atiende/ui` (3 sitios) -> `formatMoney` con moneda (3 envoltorios) -> `button` de tarjeta.

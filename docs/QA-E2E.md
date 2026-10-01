# QA E2E de navegador (Playwright + API simulada)

Paso 1 del plan de QA E2E: infraestructura y un humo por vertical. Los recorridos completos de los pasos siguientes
se escriben encima de esto, sin tocar la infraestructura.

## Que es y que NO es

- Pruebas de **navegador real (Chromium)** sobre `apps/web` (la SPA de las 6 verticales + superadmin + paginas publicas).
- Corren contra el **build estatico** (`vite build` + `vite preview`) y una **API simulada** (`apps/web/e2e/mock-api`)
  que vive en loopback. **Nunca** contra la base real, Supabase, Vercel ni produccion; no usan secretos ni credenciales.
- No prueban SQL/RLS ni la logica del servidor (eso es el gate de Postgres real y las pruebas del API). Un E2E verde
  contra la API simulada demuestra que **la SPA** hace lo correcto con respuestas bien formadas, no que el backend real
  responda igual.

## Correr en local

```bash
npm ci
npm run e2e:browsers -w @atiende/web     # una vez: descarga solo chromium (~200 MB)
npm run test:e2e                         # todo (build + API simulada + pruebas), 2 workers
npm run test:e2e -- humo-citas           # un archivo
npm run test:e2e -- --project=movil-claro -g "cancelar"
npm run test:e2e:ui                      # modo UI de Playwright (depurar paso a paso)
```

Variables (todas opcionales): `E2E_SKIP_BUILD=1` reutiliza `apps/web/dist-e2e` (el build tarda segundos, pero evita
repetirlo en cada corrida), `E2E_WORKERS` (2 por defecto: la Mac de desarrollo es compartida), `E2E_WEB_PORT` (4173),
`E2E_API_PORT` (8788), `E2E_API_LATENCY_MS` (latencia base de la API simulada), `E2E_LISTAR_SIN_FIXTURE=1` (imprime las
rutas que la pagina pidio y ninguna fixture atendio).

Si tienes memoria justa, construye antes con el semaforo del repo de trabajo y corre con `E2E_SKIP_BUILD=1`:
`VITE_API_BASE_URL=http://127.0.0.1:8788 npx vite build --outDir dist-e2e --emptyOutDir` (en `apps/web`).

Reporte y trazas: `apps/web/playwright-report/` y `apps/web/test-results/` (ignorados por git). Trace y captura solo
se guardan cuando una prueba falla: `npx playwright show-trace apps/web/test-results/<prueba>/trace.zip`.

## Proyectos (viewport y tema)

| Proyecto | Viewport | `colorScheme` | Que corre |
|---|---|---|---|
| `escritorio-claro` | 1280x800 | light | todo |
| `movil-claro` | 375x812 | light | todo |
| `escritorio-oscuro` | 1280x800 | dark | solo pruebas con `@oscuro` en el titulo |
| `movil-oscuro` | 375x812 | dark | solo pruebas con `@oscuro` en el titulo |

En los proyectos oscuros el helper `page` fija `localStorage["atiende-tema"]="sistema"`, de modo que el `ThemeSelector`
del shell aplica `html.dark` siguiendo `prefers-color-scheme`. Marca con `@oscuro` solo lo que cambia de verdad con el
tema; no dupliques recorridos enteros.

## La API simulada (`apps/web/e2e/mock-api`)

Servidor Node sin dependencias (`node --experimental-strip-types e2e/mock-api/main.ts`), solo `127.0.0.1`.

- **Login como la SPA**: el helper `iniciarSesion(vertical, rol)` abre `/:vertical/auth/google/callback?code=<escenario>~<persona>`;
  la SPA canjea el codigo (`POST /auth/exchange-code`), lee `GET /auth/me` y guarda su sesion, exactamente como en
  produccion. `iniciarSesion("superadmin")` entra al back office.
- **Personas** (`personas.ts`): `<vertical>-<rol>` con roles `owner`, `admin`, `staff`, `finanzas`, y
  `plataforma-superadmin`. Correos `@example.test` (dominio reservado), organizaciones y UUID sinteticos.
- **Aislamiento por escenario**: cada prueba recibe un escenario propio (fixture `mock`); los tokens lo llevan, asi que
  el estado mutable (un POST se refleja en el siguiente GET), las fallas inyectadas y el registro de peticiones no se
  mezclan entre pruebas que corren en paralelo. Las peticiones sin sesion (magic link) caen en el escenario `anon`:
  filtralas por un dato unico (p. ej. el correo).
- **Fixtures por vertical** (`fixtures/*.ts`): `restaurantes`, `hoteles`, `rentas`, `despachos`, `licitaciones`, `citas`,
  `superadmin` y `comun` (campana, "Chatea con tus datos" reportado como no disponible). La forma de cada respuesta
  copia los tipos de `apps/web/src/verticals/<vertical>/lib/*-client.ts` (ojo: citas usa snake_case en el cable).
  Una ruta puede exigir `roles` (otros roles reciben 403, como el servidor real).
- **Ruta sin fixture = 404 honesto** (`{ code: "mock_sin_fixture" }`), registrado como `sinFixture`. La SPA lo muestra
  como estado de error; **no es un fallo del producto**: es el backlog de cobertura de la API simulada
  (`E2E_LISTAR_SIN_FIXTURE=1` o el adjunto `sin-fixture` del reporte). Agrega la fixture cuando el recorrido la necesite.
- **Control desde la prueba** (`ClienteMock`, fixture `mock`):

  ```ts
  await mock.inyectarFalla({ metodo: "GET", ruta: "/admin/branches", status: 503, veces: 1 }); // 4xx/5xx; `ruta` subcadena o /regex/
  await mock.configurar({ latenciaMs: 700 });                                                  // latencia por peticion
  const escrituras = await mock.escrituras();    // todo lo que no es GET (sin /auth/*): "Cancelar no hizo DELETE"
  await mock.buscar({ metodo: "DELETE", ruta: "/staff/miembros/" });
  ```

Lo que **no** simula todavia (huecos conocidos): el storefront publico `/pedir/*`, SSE/Realtime de la agenda, el portal de
propietarios de rentas y el portal de cliente de despachos, y la mayor parte de las pantallas secundarias (ver
`E2E_LISTAR_SIN_FIXTURE=1` por vertical).

## Helpers (`apps/web/e2e/helpers`)

| Archivo | Para que |
|---|---|
| `fixtures.ts` | `test` extendido: `mock`, `vigilante`, `iniciarSesion`, tema por proyecto |
| `vigilante.ts` | consola y red: `pageerror`, `console.error` y respuestas 5xx fallan; 4xx sin fixture se anotan |
| `navegacion.ts` | Sidebar de escritorio (acordeon de grupos) y barra movil + hoja "Mas": `seccionesDelPanel`, `irASeccion` |
| `dialogos.ts` | `afirmarCancelarNoEscribe`: Cancelar y Escape cierran y **no** disparan ninguna escritura |
| `ds.ts` | un solo `<main>`, skip link, claro/oscuro (`html.dark`), sin scroll horizontal |
| `humo.ts` | `recorrerSecciones`: plantilla del recorrido humo de una vertical |

## Agregar un recorrido

1. Crea `apps/web/e2e/tests/<recorrido>.spec.ts`; importa `test`/`expect` de `../helpers/fixtures.ts` (nunca de
   `@playwright/test` directo: perderias el aislamiento y el vigilante).
2. Entra con `await iniciarSesion("<vertical>", "<rol>")`. Un recorrido = un estado propio: no dependas del orden.
3. Si la pantalla pide datos que no hay, agrega la fixture en `mock-api/fixtures/<vertical>.ts` copiando la forma del
   cliente; devuelve datos plausibles y fijos (o relativos a "ahora" si la pantalla filtra por fecha).
4. Para acciones, afirma sobre el **registro de peticiones**, no solo sobre la UI:
   `await expect.poll(async () => (await mock.buscar({ metodo: "POST", ruta: "/cancel" })).length).toBe(1)`.
5. Cierra con `vigilante.verificar()` (cero errores de consola y cero 5xx). Un 5xx esperado se declara con
   `vigilante.permitirRespuesta5xx(/ruta/)`.
6. Corre `npm run test:e2e -- <archivo>` en escritorio y movil antes de empujar.

Plantillas: `tests/humo-restaurantes.spec.ts` (menu completo por rol + confirm destructivo),
`tests/humo-citas.spec.ts` (cancelar cita), `tests/humo-despachos.spec.ts` (cierre mensual irreversible con texto de
confirmacion y rol `admin`), `tests/humo-superadmin.spec.ts` (dialogo con motivo),
`tests/errores-y-latencia.spec.ts` (fallas e inyeccion).

## Convenciones

- Localizadores por rol y nombre accesible (`getByRole`, `getByLabel`, `getByText`); si falta un nombre accesible,
  se arregla la UI, no se usa CSS fragil. El unico XPath aceptado es el de acotar una fila repetida (ver restaurantes/Staff).
- Sin `waitForTimeout`: esperas por aserciones web-first y `expect.poll`.
- Titulos en espanol, con etiqueta de grupo (`@humo`, `@ds`, `@errores`) y `@oscuro` solo donde aplique.
- Datos ficticios: dominio `example.test`, telefonos `+52999555xxxx`, ningun literal con forma de credencial.
- Las pruebas no corrigen codigo del producto: cuando una prueba revela un defecto real, se reporta con el formato de
  abajo y, mientras no se corrija, se documenta con `test.fail(true, "<ID>: ...")` (falla si "pasa", avisando que ya se
  puede quitar) en vez de debilitar la asercion.

## Formato de informe de fallas

Un hallazgo por entrada (issue, PR o `hallazgos-<carril>.md`); clave de deduplicacion = ruta + sintoma.

```
ID: BUG-E2E-NNN
Severidad: critica | alta | media | baja            (critica = flujo principal roto o perdida de datos)
Vertical / pantalla: citas / Agenda  (/citas/:org/agenda)
Proyecto: movil-claro | escritorio-claro | ...      Rol: owner
Pasos: 1) iniciarSesion  2) ...  3) ...
Esperado: ...
Observado: ...   (mensaje exacto de la consola / respuesta HTTP si aplica)
Evidencia: archivo de la prueba:linea, traza (`trace.zip`), captura
Causa probable: archivo:linea del producto (solo si se verifico)
Estado: abierto | test.fail documentado | corregido en PR #N
```

Defectos conocidos:

- **BUG-E2E-001 (media, accesibilidad)**: al cerrar un confirm de `useConfirm` (AlertDialog) o un `FormDialog` abierto sin
  `<Trigger>`, el foco cae en `<body>` en vez de volver al boton que lo abrio (WCAG 2.4.3). Reproduce en
  `humo-restaurantes.spec.ts` (test marcado `test.fail`). Causa probable: Radix devuelve el foco a `triggerRef`, que no
  existe aqui; arreglo en `packages/ui/src/components/ConfirmDialog.tsx` / `FormDialog.tsx` (guardar y restaurar
  `document.activeElement` en `onCloseAutoFocus`). No corregido en este paso.
- **BUG-E2E-002 (resuelto en UNI-4)**: en escritorio cada pantalla de panel tenia dos `<h1>` (el de la cabecera del shell y el
  de la pagina). Ahora la barra superior (`BarraPagina`) pinta el nombre de la pagina en un `<p>` y el unico `<h1>` es el de
  la pagina; si una pagina no pinta ninguno, la barra hace de encabezado de nivel 1 hasta que aparezca. Lo cubren
  `ds-shell.spec.ts` y `barra-pagina.spec.ts` (el nombre de cada pagina de las 7 consolas y un solo `<h1>` por pantalla).

## CI

`.github/workflows/e2e.yml`: `pull_request` (con `paths`) y manual; instala solo chromium con cache; `timeout-minutes: 25`;
sin secretos y sin `pull_request_target`. **No es un check requerido y no forma parte de `ci-checks`**: informativo hasta
medir la tasa de flake (objetivo < 1 % antes de promoverlo). Reintentos: 0 en local, 1 en CI.

## Lo que sigue (pasos siguientes del plan)

Recorridos completos por vertical encima de esta base (restaurantes: pedido a entrega; hoteles: reserva a check-out;
rentas: reserva a liquidacion; citas: cita a no-show; despachos: CFDI a cierre; licitaciones: go/no-go a contrato) y la
cobertura de fixtures que cada uno exija. Un E2E contra Postgres real + API real sigue siendo una decision pendiente.

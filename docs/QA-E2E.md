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

Lo que **no** simula todavia (huecos conocidos): SSE/Realtime de la agenda, el portal de
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

## Recorrido completo de restaurantes (qa-e2e-restaurantes)

Base del protocolo de cierre por vertical. Archivos en `apps/web/e2e/tests/restaurantes/` (helpers en `helpers/recorrido.ts`):

| Archivo | Que demuestra |
|---|---|
| `recorrido-restaurantes-roles.spec.ts` | owner y admin ven los 21 destinos del menu, staff solo los de operacion, el repartidor aterriza en Mis entregas; un staff que fuerza `/staff` o `/auditoria` ve la restriccion sin pedir datos ni escribir; un 403 del servidor es un estado de error manejado; sin sesion se manda al login |
| `recorrido-restaurantes-controles.spec.ts` | camino feliz de los controles principales: cada uno hace la peticion exacta al mock (metodo, ruta, cuerpo) y la pantalla refleja el estado nuevo |
| `recorrido-restaurantes-controles-2.spec.ts` | segunda tanda: Conversaciones (Tomar, nota, Devolver, Marcar como resuelta), Turnos (Agregar/Quitar), Productos "no a domicilio", Pedidos para recoger hasta Entregado |
| `recorrido-restaurantes-avisos-cierres.spec.ts` | Avisos (R-16): apagar un aviso propio y el de otra persona, tiempo de gracia (valido e invalido), staff sin matriz; Cierre del dia (R-42): Generar y cambiar a resumen semanal, staff con restriccion sin pedir datos |
| `recorrido-restaurantes-dialogos.spec.ts` | confirmaciones y formularios: Cancelar/Volver/Cerrar y Escape NO hacen ninguna escritura (vigilante de red); confirmar hace exactamente una en Cancelado, Quitar zona, Dar de baja, Borrar chat y Volver al perfil por defecto; los formularios prueban Cerrar/Escape y, solo en Editar vigencia, tambien el PATCH al guardar |
| `recorrido-restaurantes-errores.spec.ts` | 18 pantallas con 503 inyectado: EstadoError con Reintentar y recuperacion; sesion vencida manda al login; latencia alta muestra "Cargando" |
| `recorrido-restaurantes-resumen-copiloto.spec.ts` | Resumen: 7 KPIs en orden, "—" sin dato (no un 0), pildoras con su destino; Copiloto: pregunta libre, abort con Detener, rol con acceso |
| `recorrido-restaurantes-controles.spec.ts` (puerta R-33) | el Resumen consulta `GET /onboarding/gate`: banner sin bloqueo; con bloqueo redirige a Primeros pasos y "Ir al panel de todos modos" la omite en la sesion |
| `viaje-restaurantes-pedido.spec.ts` | viaje encadenado con DOS sesiones: Primeros pasos, crear producto, pedido nuevo a preparando, asignar repartidor, el repartidor (otra sesion) lo marca en camino y entregado, el owner lo ve en Historial, Copiloto, cerrar sesion |
| `matriz-restaurantes-visual.spec.ts` | las 21 paginas en claro, oscuro, escritorio y movil (los 4 proyectos): sin desborde horizontal, sin errores de consola ni 5xx, un solo `<main>`, a lo mucho un `<h1>` (una pagina sin `<h1>` no se marca como defecto) |

La API simulada de restaurantes vive en `mock-api/fixtures/restaurantes.ts` (humo, Copiloto, repartidor), `restaurantes-panel.ts` (panel con
estado y escrituras: un POST/PATCH se refleja en el GET siguiente). El control
`POST /__mock/escenarios/:id/estado` (`mock.agregarAEstado`) siembra un dato nuevo (p. ej. un pedido que "llega" mientras se mira el panel).

### Cobertura de controles (honesta)

El inventario `docs/diseno-ux-recorrido-botones-restaurantes.md` lista 184 sitios JSX por pantalla, no por identificador, asi que la cobertura se
mide por pantalla. **No se alcanza el 95 % pedido**: queda en deuda lo marcado "Pendiente".

| Pantalla | Cubierto por spec | Pendiente |
|---|---|---|
| Resumen | periodo, Actualizar, KPIs, pildoras, error | tarjetas de agentes y sparklines (solo se afirma que pintan) |
| Pedidos | tabs, Actualizar ahora, Marcar Preparando, Listo para recoger y Entregado, Cancelado (confirm), repartidor, Vista previa | auto-impresion, Imprimir/Reimprimir, Avisar al cliente |
| Historial | filtro por estado, error | filtros de fecha, Cargar mas |
| Productos | Nueva categoria, Nuevo producto, precio por sucursal, Disponible, Popular, casillas "no a domicilio" (producto y categoria), error | — |
| Promociones | crear, Editar vigencia, Activar/Desactivar | tipo/canal/dias/productos del formulario |
| Clientes | busqueda, ficha, Volver a clientes, error (BUG-E2E-REST-002) | — |
| Sucursales | Editar/Guardar/Cancelar | Reglas de pedido (turnos, minimos, propina, zonas, puentes, numero) |
| Staff | Invitar, Revocar (confirm), rol, Dar de baja (confirm) | — |
| Configuracion | WhatsApp, zona horaria, Agregar/Quitar zona (confirm), Volver al perfil por defecto (confirm) | el resto de la seccion del agente de WhatsApp |
| Conversaciones | Tomar, nota, Devolver, Marcar como resuelta | Enviar respuesta, callbacks |
| Avisos | apagar aviso propio y ajeno, tiempo de gracia, vista del staff, error | sonido en el navegador |
| Cierre del dia | Generar, tipo dia/semana, restriccion de staff, error | detalle por canal y por dia (solo se afirma que pinta) |
| Turnos | Guardar turnos, Agregar/Quitar turno | doble turno |
| Auditoria | filtro por tipo | fechas, Cargar mas |
| Privacidad | Guardar configuracion, error (BUG-E2E-REST-003) | panel ARCO |
| Agente de voz | pinta sano (matriz) | todos los controles |
| Repartidor | Marcar en camino/entregado (viaje), incidencia (spec previa), tema (BUG-E2E-REST-004) | Mapa y Llamar |
| Copiloto | pregunta, abort, historial, Borrar chat (confirm) | Fijar, renombrar |

### Defectos encontrados (sin corregir; cada uno es un `test.fail` que avisa cuando se corrija)

| ID | Pantalla | Sintoma | Donde | Spec |
|---|---|---|---|---|
| BUG-E2E-001 (previo) | confirmaciones y formularios | el foco cae en `<body>` al cerrar el dialogo | `packages/ui` (`useConfirm` sin Trigger) | humo-restaurantes y dialogos |
| BUG-E2E-REST-001 | /repartidor | sin landmark `<main>` ni "Saltar al contenido" (queda fuera del shell) | `pages/Repartidor.tsx` | roles |
| BUG-E2E-REST-002 | Clientes | la falla de carga se pinta como EstadoError SIN boton Reintentar | `pages/Clientes.tsx:68` y `:121` | errores |
| BUG-E2E-REST-003 | Privacidad | la falla de carga de la configuracion es texto suelto, sin EstadoError ni Reintentar | `pages/Privacidad.tsx:119` | errores |
| BUG-E2E-REST-004 | /repartidor | ignora el modo oscuro del sistema (`<html>` sin clase `dark`; el tema lo aplica solo el shell) | ruta `/repartidor` | matriz visual |

Notas de la matriz visual: el movil usa el Pixel 7 de la config (375x812); el 390x844 del encargo no se agrego como proyecto para no tocar la config compartida.

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

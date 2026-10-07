# Recorrido de botones de hoteles (seccion 7 del plan diseno-ux) - PR-6

Alcance: `apps/web/src/verticals/hoteles/**` en la rama `feat/front-ds-v2-hoteles` (PR #264). Plantilla: `docs/diseno-ux-recorrido-botones-restaurantes.md` (PR #260) y seccion 7.3 de `diseno-ux.md`.

## Metodo y limites (leer primero)

- **Estatico.** Para cada `<Button>`, `<button>`, `<Link>`, pestana (`TabsTrigger`), `<form>`, selector, casilla y `ConfirmDialog` de `pages/*.tsx` un script (Python, regex sobre el JSX) extrae el evento (`onClick`/`onSubmit`/`onChange`/`onConfirm`/`to`), sigue las funciones locales hasta las funciones de cliente de `lib/*-client.ts` y las traduce a `METODO ruta` leyendo el `fetchJson`/`sendJson` de cada cliente. Los botones de envio (`type="submit"`) heredan el efecto del `<form>` que los contiene. El script no se versiona (es una herramienta de revision, no codigo del producto); la tabla de abajo es su salida **completa** (244 controles, 0 sin resolver tras el ajuste del script) y se reviso por muestreo (ver "Verificacion manual").
- **No se ejecuto contra el backend real.** "Efecto" significa que el handler llega a esa llamada de cliente y a esa ruta, no que el servidor responda. Hay pruebas de componente (`vitest` + jsdom, fetch simulado) en `apps/web/tests/hoteles-*` para el Shell (nav movil, selector de hotel, logout, chat), Tickets, Housekeeping, Mantenimiento, Reservas, Folio, CFDI, Dashboard, Fraude, Identidad, P&L, Agentes y Revenue; no se audito control por control cuales de esos controles tienen clic automatizado. Las pantallas **sin ninguna prueba de componente que las importe** son Catalogo, PedidosFnb y Reputacion (`grep "pages/<X>.tsx" apps/web/tests`): para ellas solo existe la lectura estatica de esta tabla.
- **Estado por control:** CABLEADO = handler real que llega a un cliente/ruta, a una navegacion o a un estado de UI. No se encontro ningun control RETIRAR ni CABLEAR-PENDIENTE: ninguno es `disabled` fijo ni "Pronto" (el unico "Pronto" de la vertical es la etiqueta honesta de "Chatea con tus datos" cuando el backend responde `available:false`, ver `hoteles-rentas-data-chat-shell.spec.tsx`).
- Columna "Deshab. si": condicion de `disabled` del control (solo por condicion, nunca fijo). Vacia = nunca deshabilitado.

## Shell, navegacion y login (revisado a mano)

| Control | Efecto | Estado |
|---|---|---|
| Sidebar (escritorio): Dashboard, Reservas, Housekeeping*, Tickets, Mantenimiento, Asistencia, Fraude, CFDI, Pedidos F&B*, Reputacion*, Identidad*, Aprobaciones*, P&L*, Revenue*, Catalogo*, Agentes* (* = solo roles que ya los veian: `*_NAV_ROLES`) | navega a `/hoteles/:orgSlug/<seccion>`; las 16 rutas existen en `App.tsx` (lineas 891-908) | CABLEADO |
| BottomNav movil: Inicio, Reservas, Mant., Asistencia + "Mas" | los 4 navegan; "Mas" abre la hoja con TODAS las secciones del rol (prueba `hoteles-shell-mobile-nav`) | CABLEADO |
| Selector "Hotel activo" (solo con 2+ hoteles; Sidebar y MobileHeader) | `selectBranch`: guarda `atiende.hoteles.selectedProperty.<org>` y remonta la pagina (`key=propertyId`) | CABLEADO |
| Menu de cuenta movil: campana, "Chatea con tus datos", tema, "Cerrar sesion" | `POST /auth/logout` (best-effort), limpia `atiende.hoteles.session`, redirige a `/hoteles/login` | CABLEADO |
| Campana de notificaciones (header) | `GET /notifications`, marcar leida(s) (`useNotifications`) | CABLEADO |
| "Chatea con tus datos" | `POST .../chat-datos` (solo owner/gm; si el servidor responde `available:false` o 403 queda como "Pronto" honesto) | CABLEADO |
| Sesion expirada (`SESSION_EXPIRED_EVENT`) | limpia sesion y redirige a login (filtrado por vertical) | CABLEADO |
| Login: "Continuar con Google" | redirige a `urlIniciarGoogleLogin(api, "hoteles")`; deshabilitado con motivo visible mientras Google no este configurado | CABLEADO |
| Login: "Continuar con correo" | `iniciarMagicLink(api, correo, "hoteles")`; validacion de correo, error por `notify`, estado "enviado" con "Usar otro correo" | CABLEADO |
| Login: Terminos de Servicio / Aviso de Privacidad | enlaces a `/terminos` y `/privacidad` | CABLEADO |

## Actualizacion UNI-C gestion (paginas de gestion de hoteles al estandar Likida)

Alcance: `Revenue`, `RevenueHerramientas`, `Pl`, `Cfdi`, `CfdiListado`, `Fraude`, `Identidad`, `Privacidad`, `Reputacion`, `Agentes`, `Aprobaciones` y `Grupos` (`apps/web/src/verticals/hoteles/pages/`). **Cero cambios de logica de negocio y de llamadas de red**: cada control sigue llegando a la misma funcion de `lib/*-client.ts` y a la misma ruta. Lo que cambia es el contenedor (dialogo en lugar de formulario en linea), la confirmacion previa y la pantalla que la contiene.

**Las tablas por pagina de abajo son la salida historica del script de PR-6 (lineas y conteos de ANTES de este cambio).** Para estas 12 paginas las lineas ya no coinciden: varias secciones se movieron a `components/{revenue,grupos,identidad,privacidad}/*` y `components/CfdiComprobantes.tsx`. Esta seccion es la fuente vigente de lo que cambio.

### Medicion (mismas 12 paginas, `origin/main` antes vs. esta rama)

| Patron | Antes | Despues |
|---|---|---|
| `<h1>` sueltos | 10 | 0 (todas con `PageHeader`, que pinta el unico `<h1>`) |
| `<label>`/`<Label>` crudos | 98 | 0 (103 `FormField`) |
| `window.prompt` | 21 | 0 (`useConfirm`: Cancelar/Escape nunca ejecutan) |
| `toast.` directo | 42 | 0 (`notify.*`) |
| `<Table>` crudo | 4 | 2 (las dos tablas del estado de resultados USALI de `Pl`, que son un calculo con totales y no un listado) |
| `DataTable` | 8 | 21 |
| `FormDialog` (altas y ediciones) | 0 | 17 |
| llamadas a `toLocale*String` (baseline del guard de formato) | 108 | 100 (`formato-unico-baseline.json`) |
| Lineas de la pagina mas grande | 976 (`Privacidad`) | 505 (`Agentes`); `Revenue` 751 -> 198, `Identidad` 792 -> 58, `Privacidad` 976 -> 93, `Grupos` 598 -> 385 |

### Controles nuevos o con comportamiento distinto

| Pagina | Control | Antes | Ahora | Prueba |
|---|---|---|---|---|
| Fraude | Confirmar / Descartar alerta | `window.prompt` de nota | `useConfirm` con nota opcional (confirmar fraude en tono de peligro) | `hoteles-fraude-page` |
| CFDI (hotel y folio) | Cancelar CFDI | formulario en linea en la tarjeta | `FormDialog` compartido (`CfdiCancelarDialog`); Cerrar/Escape no cancelan; el error del PAC se ve dentro del dialogo | `hoteles-cfdi-listado-page`, `hoteles-cfdi-page` |
| P&L | Registrar gasto | formulario que se despliega | `FormDialog` (la fecha por defecto se recarga cada vez que se abre) | `hoteles-pl-page` |
| Revenue | Registrar backtest, Registrar evento, Capturar tarifa | formularios en linea | tres `FormDialog` con la validacion dentro del dialogo | `hoteles-revenue-page` |
| Revenue | Aprobar recomendacion; Promover a autopilot | ejecutaba directo | piden confirmacion (Volver/Escape no escriben) | `hoteles-revenue-page` |
| Reputacion | Capturar resena; Ver detalle / responder | formulario y panel en linea | `FormDialog` de captura y de detalle | `hoteles-reputacion-page` (spec nuevo; antes no habia ninguno) |
| Reputacion | Responder; Ejecutar / Descartar accion sugerida | ejecutaba directo | piden confirmacion | `hoteles-reputacion-page` |
| Agentes | Editar politica; Nueva plantilla | formulario en linea | `FormDialog` | `hoteles-agentes-page` |
| Aprobaciones | Nueva solicitud | pestana "Nueva solicitud" | boton en la cabecera que abre `FormDialog` | `hoteles-agentes-page` |
| Grupos | Nueva cotizacion; Agregar huesped | pestana y formulario en linea | `FormDialog` (`NuevaCotizacionDialog`, `RoomingCard`) | `hoteles-grupos-page` |
| Identidad | Capturar identidad | formulario en linea | `FormDialog` (`CapturaIdentidadDialog`) | `hoteles-identidad-page` |
| Identidad | Revelar, Bloquear, Solicitar purga, Retencion legal (3 pasos), Acceso excepcional, Aprobar/Rechazar purga, Marcar como reportado | `window.prompt` | `useConfirm`; motivos de 10+ caracteres validados en el dialogo | `hoteles-identidad-page` |
| Privacidad | Publicar version nueva del aviso; Registrar solicitud ARCO; Enlace «Mis datos»; Reportar incidente | formularios en linea | `FormDialog` | `hoteles-identidad-page` |
| Privacidad | Revocar consentimiento, avanzar/prorrogar ARCO, contener/notificar/cerrar incidente, liberar retencion, decidir acceso excepcional | `window.prompt` | `useConfirm` (en cadena donde eran varios prompts) | `hoteles-identidad-page` |

Fuera de esta tabla no cambia ningun control: los que no se nombran mantienen el efecto de la tabla historica de abajo.

## Paginas (salida completa del script)




### Agentes.tsx (21 controles)

| Linea | Tipo | Control | Evento | Efecto | Deshab. si | Estado |
|---|---|---|---|---|---|---|
| 254 | Boton | «a.activo ? "Pausar" : "Reanudar"» | clic | `actualizarAgente` → PUT /hoteles/{propertyId}/agentes/{clave} | busy === a.clave | CABLEADO |
| 257 | Boton | Presupuesto | clic | `actualizarAgente` → PUT /hoteles/{propertyId}/agentes/{clave} | busy === a.clave | CABLEADO |
| 261 | Boton | Quitar tope | clic | `actualizarAgente` → PUT /hoteles/{propertyId}/agentes/{clave} | busy === a.clave | CABLEADO |
| 287 | Boton | Editar | clic | estado local de la UI |  | CABLEADO |
| 327 | Boton | Enviar a revisión | clic | `accionPlantilla` → POST /hoteles/{propertyId}/agentes/plantillas/{id}/{accion} | busy === p.id | CABLEADO |
| 333 | Boton | Aprobar | clic | `accionPlantilla` → POST /hoteles/{propertyId}/agentes/plantillas/{id}/{accion} | busy === p.id | CABLEADO |
| 336 | Boton | Rechazar | clic | `accionPlantilla` → POST /hoteles/{propertyId}/agentes/plantillas/{id}/{accion} | busy === p.id | CABLEADO |
| 342 | Boton | Archivar | clic | `accionPlantilla` → POST /hoteles/{propertyId}/agentes/plantillas/{id}/{accion} | busy === p.id | CABLEADO |
| 382 | Pestana | Agentes |  | cambia de pestaña (estado local) |  | CABLEADO |
| 383 | Pestana | Guardrails |  | cambia de pestaña (estado local) |  | CABLEADO |
| 384 | Pestana | Políticas |  | cambia de pestaña (estado local) |  | CABLEADO |
| 385 | Pestana | Plantillas WhatsApp |  | cambia de pestaña (estado local) |  | CABLEADO |
| 399 | Formulario | (formulario) | envio | `guardarGuardrails` → PUT /hoteles/{propertyId}/agentes/guardrails |  | CABLEADO |
| 412 | Boton | «busy === "guardrails" ? "Guardando…" : "» |  | (envio del formulario de la linea 399) `guardarGuardrails` → PUT /hoteles/{propertyId}/agentes/guardrails | busy === "guardrails" | CABLEADO |
| 432 | Formulario | (formulario) | envio | `guardarPolitica` → PUT /hoteles/{propertyId}/agentes/politicas/{accion} |  | CABLEADO |
| 435 | Selector | (selector) | cambio | estado local de la UI |  | CABLEADO |
| 451 | Boton | Guardar política |  | (envio del formulario de la linea 432) `guardarPolitica` → PUT /hoteles/{propertyId}/agentes/politicas/{accion} | busy === `pol-${edicion.accion | CABLEADO |
| 454 | Boton | Cancelar | clic | estado local de la UI |  | CABLEADO |
| 469 | Formulario | (formulario) | envio | `crearPlantilla` → POST /hoteles/{propertyId}/agentes/plantillas |  | CABLEADO |
| 472 | Selector | (selector) | cambio | estado local de la UI |  | CABLEADO |
| 489 | Boton | Crear borrador |  | (envio del formulario de la linea 469) `crearPlantilla` → POST /hoteles/{propertyId}/agentes/plantillas | busy === "plantilla" | CABLEADO |

### Aprobaciones.tsx (9 controles)

| Linea | Tipo | Control | Evento | Efecto | Deshab. si | Estado |
|---|---|---|---|---|---|---|
| 196 | Boton | {«aprobar: "Aprobar", rechazar: "Rechazar"»[acc]} | clic | `ejecutarAprobacion` → POST /hoteles/{propertyId}/aprobaciones/{id}/ejecutar; `decidirAprobacion` → POST /hoteles/{propertyId}/aprobaciones/{id}/{accion} | busy === a.id | CABLEADO |
| 207 | Boton | Bitácora | clic | `fetchAprobacion` → GET /hoteles/{propertyId}/aprobaciones/{id} |  | CABLEADO |
| 243 | Pestana | Por decidir |  | cambia de pestaña (estado local) |  | CABLEADO |
| 244 | Pestana | Historial |  | cambia de pestaña (estado local) |  | CABLEADO |
| 245 | Pestana | Nueva solicitud |  | cambia de pestaña (estado local) |  | CABLEADO |
| 276 | Formulario | (formulario) | envio | `proponerAprobacion` → POST /hoteles/{propertyId}/aprobaciones |  | CABLEADO |
| 279 | Selector | (selector) | cambio | estado local de la UI |  | CABLEADO |
| 304 | Boton | «busy === "proponer" ? "Enviando…" : "Env» |  | (envio del formulario de la linea 276) `proponerAprobacion` → POST /hoteles/{propertyId}/aprobaciones | busy === "proponer" | CABLEADO |
| 321 | Boton | Cerrar | clic | estado local de la UI |  | CABLEADO |

### Asistencia.tsx (6 controles)

| Linea | Tipo | Control | Evento | Efecto | Deshab. si | Estado |
|---|---|---|---|---|---|---|
| 143 | Boton | «fichando === "entrada" ? "Registrando…" » | clic | `checkIn` → POST /hoteles/{propertyId}/asistencia/checar; `fetchAttendance` → GET /hoteles/{propertyId}/asistencia${query ?  | fichando !== null | CABLEADO |
| 153 | Boton | «fichando === "salida" ? "Registrando…" :» | clic | `checkIn` → POST /hoteles/{propertyId}/asistencia/checar; `fetchAttendance` → GET /hoteles/{propertyId}/asistencia${query ?  | fichando !== null | CABLEADO |
| 283 | Formulario | (formulario) | envio | `upsertStaffSchedule` → POST /hoteles/{propertyId}/asistencia/horarios |  | CABLEADO |
| 311 | Boton | «savingSchedule ? "Guardando…" : "Guardar» |  | (envio del formulario de la linea 283) `upsertStaffSchedule` → POST /hoteles/{propertyId}/asistencia/horarios | savingSchedule | CABLEADO |
| 329 | Boton | «consultandoCruce ? "Calculando…" : "Calc» | clic | `fetchCrossCheck` → GET /hoteles/{propertyId}/asistencia/cruce?{toString} | consultandoCruce | CABLEADO |
| 332 | Boton | «exportando ? "Exportando…" : "Exportar C» | clic | `fetchStpsExportCsv` → GET /hoteles/{propertyId}/asistencia/exportar-stps | exportando | CABLEADO |

### Catalogo.tsx (11 controles)

| Linea | Tipo | Control | Evento | Efecto | Deshab. si | Estado |
|---|---|---|---|---|---|---|
| 223 | Formulario | (formulario) | envio | `updatePropertyTimezone` → PUT /hoteles/{propertyId}/configuracion |  | CABLEADO |
| 226 | Selector | cat-zona-horaria | cambio | estado local de la UI |  | CABLEADO |
| 236 | Boton | «guardandoZona ? "Guardando…" : "Guardar » |  | (envio del formulario de la linea 223) `updatePropertyTimezone` → PUT /hoteles/{propertyId}/configuracion | guardandoZona | CABLEADO |
| 257 | Formulario | (formulario) | envio | `createRoomType` → POST /hoteles/{propertyId}/tipos-habitacion; `fetchAllRooms` → GET /hoteles/{propertyId}/habitaciones; `fetchRoomTypes` → GET /hoteles/{propertyId}/tipos-habitacion |  | CABLEADO |
| 267 | Boton | «creandoTipo ? "Creando…" : "Crear tipo d» |  | (envio del formulario de la linea 257) `createRoomType` → POST /hoteles/{propertyId}/tipos-habitacion; `fetchAllRooms` → GET /hoteles/{propertyId}/habitaciones; `fetchRoomTypes` → GET /hoteles/{propertyId}/tipos-habitacion | creandoTipo | CABLEADO |
| 288 | Formulario | (formulario) | envio | `createRoom` → POST /hoteles/{propertyId}/tipos-habitacion/{roomTypeId}/habitaciones; `fetchAllRooms` → GET /hoteles/{propertyId}/habitaciones; `fetchRoomTypes` → GET /hoteles/{propertyId}/tipos-habitacion |  | CABLEADO |
| 291 | Selector | cat-tipo-habitacion | cambio | estado local de la UI |  | CABLEADO |
| 307 | Boton | «creandoHabitacion ? "Creando…" : "Crear » |  | (envio del formulario de la linea 288) `createRoom` → POST /hoteles/{propertyId}/tipos-habitacion/{roomTypeId}/habitaciones; `fetchAllRooms` → GET /hoteles/{propertyId}/habitaciones; `fetchRoomTypes` → GET /hoteles/{propertyId}/tipos-habitacion | creandoHabitacion | CABLEADO |
| 323 | Formulario | (formulario) | envio | `createRateRange` → POST /hoteles/{propertyId}/tarifas |  | CABLEADO |
| 326 | Selector | cat-tipo-tarifa | cambio | estado local de la UI |  | CABLEADO |
| 352 | Boton | «creandoTarifa ? "Sembrando…" : "Crear ta» |  | (envio del formulario de la linea 323) `createRateRange` → POST /hoteles/{propertyId}/tarifas | creandoTarifa | CABLEADO |

### Cfdi.tsx (13 controles)

| Linea | Tipo | Control | Evento | Efecto | Deshab. si | Estado |
|---|---|---|---|---|---|---|
| 224 | Boton | Cancelar CFDI | clic | estado local de la UI | busy | CABLEADO |
| 230 | Boton | Consultar estado real ante el PAC | clic | `consultarEstadoCfdi` → POST /hoteles/{propertyId}/cfdi/{cfdiId}/consultar-estado; `fetchFolio` → GET /hoteles/{propertyId}/folios/{folioId}; `fetchCfdisByFolio` → GET /hoteles/{propertyId}/folios/{folioId}/cfdi | busy | CABLEADO |
| 239 | Formulario | (formulario) | envio | `cancelarCfdi` → POST /hoteles/{propertyId}/cfdi/{cfdiId}/cancelar; `fetchFolio` → GET /hoteles/{propertyId}/folios/{folioId}; `fetchCfdisByFolio` → GET /hoteles/{propertyId}/folios/{folioId}/cfdi |  | CABLEADO |
| 240 | Selector | (selector) | cambio | estado local de la UI |  | CABLEADO |
| 251 | Boton | Confirmar cancelación |  | (envio del formulario de la linea 239) `cancelarCfdi` → POST /hoteles/{propertyId}/cfdi/{cfdiId}/cancelar; `fetchFolio` → GET /hoteles/{propertyId}/folios/{folioId}; `fetchCfdisByFolio` → GET /hoteles/{propertyId}/folios/{folioId}/cfdi | busy | CABLEADO |
| 254 | Boton | Cerrar | clic | estado local de la UI | busy | CABLEADO |
| 269 | Formulario | (formulario) | envio | `emitirCfdiHospedaje` → POST /hoteles/{propertyId}/folios/{folioId}/cfdi; `fetchFolio` → GET /hoteles/{propertyId}/folios/{folioId}; `fetchCfdisByFolio` → GET /hoteles/{propertyId}/folios/{folioId}/cfdi |  | CABLEADO |
| 272 | Casilla | (casilla) | cambio | estado local de la UI | esGlobal | CABLEADO |
| 276 | Casilla | (casilla) | cambio | estado local de la UI | esExtranjero | CABLEADO |
| 280 | Casilla | (casilla) | cambio | estado local de la UI |  | CABLEADO |
| 291 | Selector | cfdi-metodo-pago | cambio | estado local de la UI |  | CABLEADO |
| 296 | Boton | «busy ? "Timbrando…" : "Timbrar CFDI"» |  | (envio del formulario de la linea 269) `emitirCfdiHospedaje` → POST /hoteles/{propertyId}/folios/{folioId}/cfdi; `fetchFolio` → GET /hoteles/{propertyId}/folios/{folioId}; `fetchCfdisByFolio` → GET /hoteles/{propertyId}/folios/{folioId}/cfdi | busy | CABLEADO |
| 317 | Boton | Timbrar complemento de pago | clic | `emitirCfdiPago` → POST /hoteles/{propertyId}/folios/{folioId}/cfdi/pago; `fetchFolio` → GET /hoteles/{propertyId}/folios/{folioId}; `fetchCfdisByFolio` → GET /hoteles/{propertyId}/folios/{folioId}/cfdi | busy | CABLEADO |

### CfdiListado.tsx (8 controles)

| Linea | Tipo | Control | Evento | Efecto | Deshab. si | Estado |
|---|---|---|---|---|---|---|
| 103 | Formulario | (formulario) | envio | navega (react-router) |  | CABLEADO |
| 106 | Boton | Ir al folio |  | (envio del formulario de la linea 103) navega (react-router) |  | CABLEADO |
| 131 | Enlace | «c.folioId» |  | navega a /hoteles/:orgSlug/folios/${c.folioId}/cfdi |  | CABLEADO |
| 145 | Boton | Cancelar CFDI | clic | estado local de la UI | busy | CABLEADO |
| 150 | Formulario | (formulario) | envio | `cancelarCfdi` → POST /hoteles/{propertyId}/cfdi/{cfdiId}/cancelar; `fetchCfdisByProperty` → GET /hoteles/{propertyId}/cfdi |  | CABLEADO |
| 151 | Selector | (selector) | cambio | estado local de la UI |  | CABLEADO |
| 162 | Boton | Confirmar cancelación |  | (envio del formulario de la linea 150) `cancelarCfdi` → POST /hoteles/{propertyId}/cfdi/{cfdiId}/cancelar; `fetchCfdisByProperty` → GET /hoteles/{propertyId}/cfdi | busy | CABLEADO |
| 165 | Boton | Cerrar | clic | estado local de la UI | busy | CABLEADO |

### Dashboard.tsx (9 controles)

| Linea | Tipo | Control | Evento | Efecto | Deshab. si | Estado |
|---|---|---|---|---|---|---|
| 143 | Pestana | «opt.label» |  | cambia de pestaña (estado local) |  | CABLEADO |
| 170 | Boton | Ver P&L completo (por departamento + gastos) | ? | envuelve un enlace (asChild): ver la fila Link siguiente |  | CABLEADO |
| 171 | Enlace | Ver P&L completo (por departamento + gastos) |  | navega a /hoteles/:orgSlug/pl |  | CABLEADO |
| 269 | Boton | Ir a Reservas | ? | envuelve un enlace (asChild): ver la fila Link siguiente |  | CABLEADO |
| 270 | Enlace | Ir a Reservas |  | navega a /hoteles/:orgSlug/reservas |  | CABLEADO |
| 285 | Boton | Ir a Mantenimiento | ? | envuelve un enlace (asChild): ver la fila Link siguiente |  | CABLEADO |
| 286 | Enlace | Ir a Mantenimiento |  | navega a /hoteles/:orgSlug/mantenimiento |  | CABLEADO |
| 307 | Boton | Ir a Pedidos F&B | ? | envuelve un enlace (asChild): ver la fila Link siguiente |  | CABLEADO |
| 308 | Enlace | Ir a Pedidos F&B |  | navega a /hoteles/:orgSlug/pedidos-fnb |  | CABLEADO |

### Folio.tsx (14 controles)

| Linea | Tipo | Control | Evento | Efecto | Deshab. si | Estado |
|---|---|---|---|---|---|---|
| 169 | Boton | CFDI de este folio | ? | envuelve un enlace (asChild): ver la fila Link siguiente |  | CABLEADO |
| 170 | Enlace | CFDI de este folio |  | navega a /hoteles/:orgSlug/folios/${folioId}/cfdi |  | CABLEADO |
| 200 | Boton | Reversar | clic | `reverseCharge` → POST /hoteles/{propertyId}/folios/{folioId}/cargos/{chargeId}/reverso; `fetchFolio` → GET /hoteles/{propertyId}/folios/{folioId} | busy | CABLEADO |
| 211 | Formulario | (formulario) | envio | `addCharge` → POST /hoteles/{propertyId}/folios/{folioId}/cargos; `fetchFolio` → GET /hoteles/{propertyId}/folios/{folioId} |  | CABLEADO |
| 216 | Selector | (selector) | cambio | estado local de la UI |  | CABLEADO |
| 223 | Boton | Agregar |  | (envio del formulario de la linea 211) `addCharge` → POST /hoteles/{propertyId}/folios/{folioId}/cargos; `fetchFolio` → GET /hoteles/{propertyId}/folios/{folioId} | busy | CABLEADO |
| 231 | Formulario | (formulario) | envio | `addDiscount` → POST /hoteles/{propertyId}/folios/{folioId}/descuentos; `fetchFolio` → GET /hoteles/{propertyId}/folios/{folioId} |  | CABLEADO |
| 236 | Boton | Aplicar |  | (envio del formulario de la linea 231) `addDiscount` → POST /hoteles/{propertyId}/folios/{folioId}/descuentos; `fetchFolio` → GET /hoteles/{propertyId}/folios/{folioId} | busy | CABLEADO |
| 260 | Formulario | (formulario) | envio | `addPayment` → POST /hoteles/{propertyId}/folios/{folioId}/pagos; `fetchFolio` → GET /hoteles/{propertyId}/folios/{folioId} |  | CABLEADO |
| 264 | Selector | (selector) | cambio | estado local de la UI |  | CABLEADO |
| 268 | Boton | Registrar |  | (envio del formulario de la linea 260) `addPayment` → POST /hoteles/{propertyId}/folios/{folioId}/pagos; `fetchFolio` → GET /hoteles/{propertyId}/folios/{folioId} | busy | CABLEADO |
| 278 | Boton | Cerrar folio (saldo en cero) | clic | abre dialogo / estado local de la UI | busy | CABLEADO |
| 281 | Boton | Cerrar como cuenta por cobrar | clic | abre dialogo / estado local de la UI | busy | CABLEADO |
| 287 | Dialogo de confirmacion | dialogo: pendingClose === "cuenta_por_cobrar" ? "Cerrar com | confirmar | `closeFolio` → POST /hoteles/{propertyId}/folios/{folioId}/cerrar; `fetchFolio` → GET /hoteles/{propertyId}/folios/{folioId} |  | CABLEADO |

### Fraude.tsx (4 controles)

| Linea | Tipo | Control | Evento | Efecto | Deshab. si | Estado |
|---|---|---|---|---|---|---|
| 97 | Boton | «scanning ? "Escaneando…" : "Ejecutar esc» | clic | `runFraudScan` → POST /hoteles/{propertyId}/fraude/escaneos; `fetchFraudAlerts` → GET /hoteles/{propertyId}/fraude/alertas{qs} | scanning | CABLEADO |
| 106 | Pestana | «f === "todas" ? "Todas" : FRAUD_ALERT_ST» |  | cambia de pestaña (estado local) |  | CABLEADO |
| 136 | Boton | Confirmar | clic | `resolveFraudAlert` → POST /hoteles/{propertyId}/fraude/alertas/{alertId}/{decision}; `fetchFraudAlerts` → GET /hoteles/{propertyId}/fraude/alertas{qs} | busyId === a.id | CABLEADO |
| 139 | Boton | Descartar | clic | `resolveFraudAlert` → POST /hoteles/{propertyId}/fraude/alertas/{alertId}/{decision}; `fetchFraudAlerts` → GET /hoteles/{propertyId}/fraude/alertas{qs} | busyId === a.id | CABLEADO |

### Housekeeping.tsx (7 controles)

| Linea | Tipo | Control | Evento | Efecto | Deshab. si | Estado |
|---|---|---|---|---|---|---|
| 160 | Boton | «busy === "generar" ? "Generando…" : "Gen» | clic | `generarDia` → POST /hoteles/{propertyId}/housekeeping/tareas/generar | busy === "generar" | CABLEADO |
| 187 | Pestana | Tablero |  | cambia de pestaña (estado local) |  | CABLEADO |
| 188 | Pestana | Reporte diario |  | cambia de pestaña (estado local) |  | CABLEADO |
| 230 | Boton | «ACCION_LABELS[a]» | clic | `accionTarea` → POST /hoteles/{propertyId}/housekeeping/tareas/{taskId}/{accion} | busy === h.tarea?.id | CABLEADO |
| 235 | Boton | Marcar sucia | clic | `marcarSucia` → POST /hoteles/{propertyId}/housekeeping/habitaciones/{roomId}/sucia | busy === h.roomId | CABLEADO |
| 240 | Boton | Inhabilitar | clic | `inhabilitar` → POST /hoteles/{propertyId}/housekeeping/fuera-de-servicio | busy === h.roomId | CABLEADO |
| 245 | Boton | Rehabilitar | clic | `rehabilitar` → POST /hoteles/{propertyId}/housekeeping/fuera-de-servicio/{id}/rehabilitar | busy === h.roomId | CABLEADO |

### Identidad.tsx (27 controles)

| Linea | Tipo | Control | Evento | Efecto | Deshab. si | Estado |
|---|---|---|---|---|---|---|
| 83 | Pestana | Bóveda |  | cambia de pestaña (estado local) |  | CABLEADO |
| 84 | Pestana | Purgas |  | cambia de pestaña (estado local) |  | CABLEADO |
| 85 | Pestana | Registro migratorio |  | cambia de pestaña (estado local) |  | CABLEADO |
| 86 | Pestana | Privacidad |  | cambia de pestaña (estado local) |  | CABLEADO |
| 278 | Boton | Ocultar | clic | estado local de la UI |  | CABLEADO |
| 286 | Boton | Acceso excepcional | clic | `requestAccesoExcepcional` → POST /hoteles/{propertyId}/privacidad/identidades/{identidadId}/acceso-excepcional | busyId === it.id | CABLEADO |
| 289 | Boton | Retención legal | clic | `placeRetencion` → POST /hoteles/{propertyId}/privacidad/identidades/{identidadId}/retencion | busyId === it.id | CABLEADO |
| 297 | Boton | Revelar | clic | `revealIdentidad` → POST /hoteles/{propertyId}/tickets/identidad/{id}/revelar | busyId === it.id | CABLEADO |
| 302 | Boton | Marcar verificada | clic | `verifyIdentidad` → POST /hoteles/{propertyId}/tickets/identidad/{id}/verificar; `fetchIdentidades` → GET /hoteles/{propertyId}/tickets/identidad${estado ?  | busyId === it.id | CABLEADO |
| 307 | Boton | Retención legal | clic | `placeRetencion` → POST /hoteles/{propertyId}/privacidad/identidades/{identidadId}/retencion | busyId === it.id | CABLEADO |
| 312 | Boton | Bloquear | clic | `blockIdentidad` → POST /hoteles/{propertyId}/privacidad/identidades/{identidadId}/bloquear; `fetchIdentidades` → GET /hoteles/{propertyId}/tickets/identidad${estado ?  | busyId === it.id | CABLEADO |
| 317 | Boton | Solicitar purga | clic | `requestPurga` → POST /hoteles/{propertyId}/tickets/identidad/{id}/solicitar-purga | busyId === it.id | CABLEADO |
| 450 | Formulario | (formulario) | envio | `captureIdentidad` → POST /hoteles/{propertyId}/tickets/identidad |  | CABLEADO |
| 453 | Selector | ident-huesped | cambio | estado local de la UI |  | CABLEADO |
| 464 | Selector | ident-reserva | cambio | estado local de la UI | !guestId | CABLEADO |
| 475 | Selector | ident-tipo | cambio | estado local de la UI |  | CABLEADO |
| 534 | Casilla | (casilla) | cambio | estado local de la UI |  | CABLEADO |
| 547 | Casilla | (casilla) | cambio | estado local de la UI |  | CABLEADO |
| 557 | Casilla | (casilla) | cambio | estado local de la UI |  | CABLEADO |
| 564 | Selector | consent-canal | cambio | estado local de la UI |  | CABLEADO |
| 574 | Selector | consent-metodo | cambio | estado local de la UI |  | CABLEADO |
| 583 | Casilla | (casilla) | cambio | estado local de la UI |  | CABLEADO |
| 593 | Boton | «saving ? "Cifrando…" : "Capturar identid» |  | (envio del formulario de la linea 450) `captureIdentidad` → POST /hoteles/{propertyId}/tickets/identidad | saving \|\| !guestId \|\| !plan.valido \|\| consentIncom | CABLEADO |
| 667 | Boton | Aprobar purga | clic | `decidePurga` → POST /hoteles/{propertyId}/tickets/identidad-purgas/{solicitudId}/decidir; `fetchIdentidades` → GET /hoteles/{propertyId}/tickets/identidad${estado ?  | busyId === p.id | CABLEADO |
| 670 | Boton | Rechazar | clic | `decidePurga` → POST /hoteles/{propertyId}/tickets/identidad-purgas/{solicitudId}/decidir; `fetchIdentidades` → GET /hoteles/{propertyId}/tickets/identidad${estado ?  | busyId === p.id | CABLEADO |
| 755 | Boton | Crear registro | clic | `createMigratorio` → POST /hoteles/{propertyId}/tickets/registro-migratorio; `fetchIdentidades` → GET /hoteles/{propertyId}/tickets/identidad${estado ?  | busyId === c.id | CABLEADO |
| 782 | Boton | Marcar como reportado | clic | `reportMigratorio` → POST /hoteles/{propertyId}/tickets/registro-migratorio/{id}/reportar; `fetchIdentidades` → GET /hoteles/{propertyId}/tickets/identidad${estado ?  | busyId === r.id | CABLEADO |

### Mantenimiento.tsx (6 controles)

| Linea | Tipo | Control | Evento | Efecto | Deshab. si | Estado |
|---|---|---|---|---|---|---|
| 115 | Boton | «!showForm &&» «showForm ? "Cancelar" : "Nuevo ticket"» | clic | estado local de la UI |  | CABLEADO |
| 124 | Formulario | (formulario) | envio | `createTicket` → POST /hoteles/{propertyId}/mantenimiento/tickets; `fetchTickets` → GET /hoteles/{propertyId}/tickets${q ?  |  | CABLEADO |
| 141 | Selector | mant-severidad | cambio | estado local de la UI |  | CABLEADO |
| 159 | Boton | «creating ? "Creando…" : "Crear ticket"» |  | (envio del formulario de la linea 124) `createTicket` → POST /hoteles/{propertyId}/mantenimiento/tickets; `fetchTickets` → GET /hoteles/{propertyId}/tickets${q ?  | creating | CABLEADO |
| 170 | Pestana | «f === "todos" ? "Todos" : TICKET_STATUS_» |  | cambia de pestaña (estado local) |  | CABLEADO |
| 203 | Boton | «busyId === t.id ? "…" : "Cerrar ticket"» | clic | `closeTicket` → POST /hoteles/{propertyId}/mantenimiento/tickets/{ticketId}/cerrar; `fetchTickets` → GET /hoteles/{propertyId}/tickets${q ?  | busyId === t.id | CABLEADO |

### PedidosFnb.tsx (8 controles)

| Linea | Tipo | Control | Evento | Efecto | Deshab. si | Estado |
|---|---|---|---|---|---|---|
| 179 | Boton | «!showForm &&» «showForm ? "Cancelar" : "Tomar pedido"» | clic | estado local de la UI |  | CABLEADO |
| 189 | Formulario | (formulario) | envio | `crearPedidoFnb` → POST /hoteles/{propertyId}/pedidos-fnb; `fetchPedidosFnb` → GET /hoteles/{propertyId}/pedidos-fnb |  | CABLEADO |
| 201 | Boton | (sin texto: icono) | clic | abre dialogo / estado local de la UI | draftItems.length <= 1 | CABLEADO |
| 206 | Boton | + Agregar platillo | clic | abre dialogo / estado local de la UI |  | CABLEADO |
| 221 | Casilla | (casilla) | cambio | estado local de la UI |  | CABLEADO |
| 229 | Boton | «creating ? "Enviando…" : "Tomar pedido"» |  | (envio del formulario de la linea 189) `crearPedidoFnb` → POST /hoteles/{propertyId}/pedidos-fnb; `fetchPedidosFnb` → GET /hoteles/{propertyId}/pedidos-fnb | creating | CABLEADO |
| 283 | Boton | «busyId === p.id ? "…" : "Confirmar en co» | clic | `confirmarCocinaFnb` → POST /hoteles/{propertyId}/pedidos-fnb/{orderId}/confirmar-cocina; `fetchPedidosFnb` → GET /hoteles/{propertyId}/pedidos-fnb | busyId === p.id | CABLEADO |
| 288 | Boton | «busyId === p.id ? "…" : "Asegurar seguri» | clic | `asegurarSeguridadFnb` → POST /hoteles/{propertyId}/pedidos-fnb/{orderId}/asegurar-seguridad; `fetchPedidosFnb` → GET /hoteles/{propertyId}/pedidos-fnb | busyId === p.id \|\| !p.puedeAsegurarSeguridad | CABLEADO |

### Pl.tsx (6 controles)

| Linea | Tipo | Control | Evento | Efecto | Deshab. si | Estado |
|---|---|---|---|---|---|---|
| 290 | Formulario | (formulario) | envio | `createPlExpense` → POST /hoteles/{propertyId}/pl/gastos |  | CABLEADO |
| 294 | Selector | pl-departamento | cambio | estado local de la UI |  | CABLEADO |
| 305 | Selector | pl-categoria | cambio | estado local de la UI |  | CABLEADO |
| 327 | Boton | «creating ? "Registrando…" : "Registrar g» |  | (envio del formulario de la linea 290) `createPlExpense` → POST /hoteles/{propertyId}/pl/gastos | creating | CABLEADO |
| 433 | Pestana | «opt.label» |  | cambia de pestaña (estado local) |  | CABLEADO |
| 455 | Boton | «!showForm &&» «showForm ? "Cancelar" : "Registrar gasto» | clic | estado local de la UI |  | CABLEADO |

### Privacidad.tsx (31 controles)

| Linea | Tipo | Control | Evento | Efecto | Deshab. si | Estado |
|---|---|---|---|---|---|---|
| 115 | Pestana | Aviso y consentimientos |  | cambia de pestaña (estado local) |  | CABLEADO |
| 116 | Pestana | ARCO |  | cambia de pestaña (estado local) |  | CABLEADO |
| 117 | Pestana | Incidentes |  | cambia de pestaña (estado local) |  | CABLEADO |
| 118 | Pestana | Retención y bloqueo |  | cambia de pestaña (estado local) |  | CABLEADO |
| 258 | Formulario | (formulario) | envio | `publishAviso` → POST /hoteles/{propertyId}/privacidad/avisos; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/privacidad/consentimientos |  | CABLEADO |
| 280 | Boton | «saving ? "Publicando…" : "Publicar versi» |  | (envio del formulario de la linea 258) `publishAviso` → POST /hoteles/{propertyId}/privacidad/avisos; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/privacidad/ | saving | CABLEADO |
| 291 | Formulario | (formulario) | envio | `saveVentanaBloqueo` → PUT /hoteles/{propertyId}/tickets/configuracion; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/privacidad/consentimientos |  | CABLEADO |
| 296 | Boton | Guardar |  | (envio del formulario de la linea 291) `saveVentanaBloqueo` → PUT /hoteles/{propertyId}/tickets/configuracion; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/pr |  | CABLEADO |
| 327 | Boton | Revocar consentimiento | clic | `revokeConsentimiento` → POST /hoteles/{propertyId}/privacidad/consentimientos/{id}/revocar; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/privacidad/consentim |  | CABLEADO |
| 419 | Formulario | (formulario) | envio | `openArco` → POST /hoteles/{propertyId}/privacidad/arco; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/privacidad/consentimientos |  | CABLEADO |
| 422 | Selector | arco-derecho | cambio | estado local de la UI |  | CABLEADO |
| 432 | Selector | arco-canal | cambio | estado local de la UI |  | CABLEADO |
| 453 | Boton | «saving ? "Registrando…" : "Registrar sol» |  | (envio del formulario de la linea 419) `openArco` → POST /hoteles/{propertyId}/privacidad/arco; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/privacidad/consen | saving \|\| solicitante.trim().length < 2 | CABLEADO |
| 484 | Boton | Pasar a revisión | clic | `advanceArco` → POST /hoteles/{propertyId}/privacidad/arco/{id}/avanzar; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/privacidad/consentimientos |  | CABLEADO |
| 490 | Boton | Procedente | clic | `advanceArco` → POST /hoteles/{propertyId}/privacidad/arco/{id}/avanzar; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/privacidad/consentimientos |  | CABLEADO |
| 493 | Boton | Improcedente | clic | `advanceArco` → POST /hoteles/{propertyId}/privacidad/arco/{id}/avanzar; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/privacidad/consentimientos |  | CABLEADO |
| 499 | Boton | Marcar ejecutada | clic | `advanceArco` → POST /hoteles/{propertyId}/privacidad/arco/{id}/avanzar; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/privacidad/consentimientos |  | CABLEADO |
| 504 | Boton | Prórroga (+«a.prorrogaDisponible.dias» d) | clic | `extendArco` → POST /hoteles/{propertyId}/privacidad/arco/{id}/prorroga; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/privacidad/consentimientos |  | CABLEADO |
| 596 | Formulario | (formulario) | envio | `reportIncidente` → POST /hoteles/{propertyId}/privacidad/incidentes; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/privacidad/consentimientos |  | CABLEADO |
| 599 | Selector | inc-tipo | cambio | estado local de la UI |  | CABLEADO |
| 609 | Selector | inc-severidad | cambio | estado local de la UI |  | CABLEADO |
| 624 | Casilla | (casilla) | cambio | estado local de la UI |  | CABLEADO |
| 628 | Boton | «saving ? "Registrando…" : "Reportar inci» |  | (envio del formulario de la linea 596) `reportIncidente` → POST /hoteles/{propertyId}/privacidad/incidentes; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/priv | saving \|\| titulo.trim().length < 3 \|\| descripcion. | CABLEADO |
| 672 | Boton | Marcar contenido | clic | `actIncidente` → POST /hoteles/{propertyId}/privacidad/incidentes/{id}/accion; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/privacidad/consentimientos |  | CABLEADO |
| 677 | Boton | Registrar notificación al titular | clic | `actIncidente` → POST /hoteles/{propertyId}/privacidad/incidentes/{id}/accion; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/privacidad/consentimientos |  | CABLEADO |
| 681 | Boton | Cerrar incidente | clic | `actIncidente` → POST /hoteles/{propertyId}/privacidad/incidentes/{id}/accion; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/privacidad/consentimientos |  | CABLEADO |
| 787 | Boton | Liberar retención | clic | `releaseRetencion` → POST /hoteles/{propertyId}/privacidad/retenciones/{id}/liberar; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/privacidad/consentimientos |  | CABLEADO |
| 818 | Boton | Aprobar acceso | clic | `decideAcceso` → POST /hoteles/{propertyId}/privacidad/accesos-excepcionales/{id}/decidir; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/privacidad/consentimie |  | CABLEADO |
| 821 | Boton | Rechazar acceso | clic | `decideAcceso` → POST /hoteles/{propertyId}/privacidad/accesos-excepcionales/{id}/decidir; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/privacidad/consentimie |  | CABLEADO |
| 827 | Boton | Revelar documento (un solo uso) | clic | `revealAccesoExcepcional` → POST /hoteles/{propertyId}/privacidad/accesos-excepcionales/{id}/revelar; `fetchConfiguracion` → GET /hoteles/{propertyId}/privacidad/configuracion; `fetchAvisos` → GET /hoteles/{propertyId}/privacidad/avisos; `fetchConsentimientos` → GET /hoteles/{propertyId}/privacidad/ |  | CABLEADO |
| 841 | Boton | Ocultar | clic | estado local de la UI |  | CABLEADO |

### Reputacion.tsx (13 controles)

| Linea | Tipo | Control | Evento | Efecto | Deshab. si | Estado |
|---|---|---|---|---|---|---|
| 183 | Boton | Capturar reseña | clic | estado local de la UI |  | CABLEADO |
| 192 | Pestana | Reseñas |  | cambia de pestaña (estado local) |  | CABLEADO |
| 193 | Pestana | Métricas |  | cambia de pestaña (estado local) |  | CABLEADO |
| 203 | Formulario | (formulario) | envio | `createGuestReview` → POST /hoteles/{propertyId}/reputacion/resenas; `fetchGuestReviews` → GET /hoteles/{propertyId}/reputacion/resenas{qs} |  | CABLEADO |
| 219 | Selector | resena-source | cambio | estado local de la UI |  | CABLEADO |
| 233 | Selector | resena-stay | cambio | estado local de la UI |  | CABLEADO |
| 245 | Boton | Capturar y clasificar |  | (envio del formulario de la linea 203) `createGuestReview` → POST /hoteles/{propertyId}/reputacion/resenas; `fetchGuestReviews` → GET /hoteles/{propertyId}/reputacion/resenas{qs} | busy | CABLEADO |
| 256 | Pestana | «f === "todas" ? "Todas" : SENTIMENT_LABE» |  | cambia de pestaña (estado local) |  | CABLEADO |
| 290 | Boton | Ver detalle / responder | clic | `fetchGuestReviewDetail` → GET /hoteles/{propertyId}/reputacion/resenas/{reviewId} |  | CABLEADO |
| 312 | Boton | Ejecutar | clic | `resolveGuestReviewAction` → POST /hoteles/{propertyId}/reputacion/acciones/{actionId}/resolver; `fetchGuestReviewDetail` → GET /hoteles/{propertyId}/reputacion/resenas/{reviewId} | busy | CABLEADO |
| 315 | Boton | Descartar | clic | `resolveGuestReviewAction` → POST /hoteles/{propertyId}/reputacion/acciones/{actionId}/resolver; `fetchGuestReviewDetail` → GET /hoteles/{propertyId}/reputacion/resenas/{reviewId} | busy | CABLEADO |
| 336 | Formulario | (formulario) | envio | `respondToGuestReview` → POST /hoteles/{propertyId}/reputacion/resenas/{reviewId}/respuestas; `fetchGuestReviewDetail` → GET /hoteles/{propertyId}/reputacion/resenas/{reviewId} |  | CABLEADO |
| 343 | Boton | Responder |  | (envio del formulario de la linea 336) `respondToGuestReview` → POST /hoteles/{propertyId}/reputacion/resenas/{reviewId}/respuestas; `fetchGuestReviewDetail` → GET /hoteles/{propertyId}/reputacion/resenas/{reviewId} | busy \|\| respuestaTexto.trim().length === 0 | CABLEADO |

### Reservas.tsx (15 controles)

| Linea | Tipo | Control | Evento | Efecto | Deshab. si | Estado |
|---|---|---|---|---|---|---|
| 327 | Boton | «!showForm &&» «showForm ? "Cancelar" : "Nueva reserva"» | clic | estado local de la UI |  | CABLEADO |
| 336 | Formulario | (formulario) | envio | `createReservation` → POST /hoteles/{propertyId}/reservas; `fetchReservations` → GET /hoteles/{propertyId}/reservas |  | CABLEADO |
| 339 | Selector | res-tipo-habitacion | cambio | estado local de la UI |  | CABLEADO |
| 376 | Selector | Huésped de la reserva | cambio | estado local de la UI |  | CABLEADO |
| 389 | Boton | «showNewGuestForm ? "Cancelar alta de hué» | clic | estado local de la UI |  | CABLEADO |
| 406 | Boton | «creatingGuest ? "Creando…" : "Crear y se» | clic | `createGuest` → POST /hoteles/{propertyId}/huespedes | creatingGuest | CABLEADO |
| 412 | Boton | «creating ? "Creando…" : "Crear reserva"» |  | (envio del formulario de la linea 336) `createReservation` → POST /hoteles/{propertyId}/reservas; `fetchReservations` → GET /hoteles/{propertyId}/reservas | creating | CABLEADO |
| 423 | Pestana | «f === "todas" ? "Todas" : RESERVATION_ST» |  | cambia de pestaña (estado local) |  | CABLEADO |
| 460 | Boton | Ver folio | clic | `fetchFoliosByReservation` → GET /hoteles/{propertyId}/reservas/{reservationId}/folios | busyId === r.id | CABLEADO |
| 464 | Boton | {busyId === r.id ? "…" : `Marcar $«RESERVATION_STATUS_LABELS | clic | `transitionReservation` → PATCH /hoteles/{propertyId}/reservas/{reservationId}/transicion; `fetchReservations` → GET /hoteles/{propertyId}/reservas | busyId === r.id | CABLEADO |
| 469 | Boton | «assigningId === r.id ? "Cerrar" : r.room» | clic | `fetchRooms` → GET /hoteles/{propertyId}/habitaciones?roomTypeId={encodeURIComponent} | busyId === r.id | CABLEADO |
| 474 | Boton | Cancelar | clic | abre dialogo / estado local de la UI | busyId === r.id | CABLEADO |
| 483 | Selector | (selector) | cambio | estado local de la UI |  | CABLEADO |
| 500 | Boton | «busyId === r.id ? "…" : "Confirmar asign» | clic | `assignRoom` → PATCH /hoteles/{propertyId}/reservas/{reservationId}/asignar-habitacion; `fetchReservations` → GET /hoteles/{propertyId}/reservas | busyId === r.id \|\| !assigningRoomId | CABLEADO |
| 513 | Dialogo de confirmacion | dialogo: Cancelar reserva | confirmar | `cancelReservation` → POST /hoteles/{propertyId}/reservas/{reservationId}/cancelar; `fetchReservations` → GET /hoteles/{propertyId}/reservas |  | CABLEADO |

### Revenue.tsx (22 controles)

| Linea | Tipo | Control | Evento | Efecto | Deshab. si | Estado |
|---|---|---|---|---|---|---|
| 330 | Boton | Inicializar en shadow | clic | `initRevenueGate` → POST /hoteles/{propertyId}/revenue/gate | busy | CABLEADO |
| 365 | Boton | Promover a propone | clic | `transitionRevenueGate` → POST /hoteles/{propertyId}/revenue/gate/transicion | busy | CABLEADO |
| 370 | Boton | Aprobar autopilot (owner) | clic | estado local de la UI | busy | CABLEADO |
| 377 | Boton | Promover a autopilot | clic | `transitionRevenueGate` → POST /hoteles/{propertyId}/revenue/gate/transicion | busy | CABLEADO |
| 380 | Boton | Revocar aprobación | clic | `setRevenueGateOwnerApproval` → POST /hoteles/{propertyId}/revenue/gate/aprobacion-autopilot | busy | CABLEADO |
| 386 | Boton | Freno de emergencia (bajar a shadow) | clic | `transitionRevenueGate` → POST /hoteles/{propertyId}/revenue/gate/transicion | busy | CABLEADO |
| 391 | Boton | Bajar a propone | clic | `transitionRevenueGate` → POST /hoteles/{propertyId}/revenue/gate/transicion | busy | CABLEADO |
| 410 | Formulario | (formulario) | envio | `fetchRevenueBacktests` → GET /hoteles/{propertyId}/revenue/backtests; `registerRevenueBacktest` → POST /hoteles/{propertyId}/revenue/backtests |  | CABLEADO |
| 414 | Selector | counterfactual-method | cambio | estado local de la UI |  | CABLEADO |
| 436 | Boton | Registrar backtest |  | (envio del formulario de la linea 410) `fetchRevenueBacktests` → GET /hoteles/{propertyId}/revenue/backtests; `registerRevenueBacktest` → POST /hoteles/{propertyId}/revenue/backtests | busy | CABLEADO |
| 535 | Boton | Aprobar | clic | `approveRateRecommendation` → POST /hoteles/{propertyId}/revenue/recomendaciones/{id}/aprobar; `fetchRateRecommendations` → GET /hoteles/{propertyId}/revenue/recomendaciones${qs ?  | busy | CABLEADO |
| 538 | Boton | Descartar | clic | `discardRateRecommendation` → POST /hoteles/{propertyId}/revenue/recomendaciones/{id}/descartar; `fetchRateRecommendations` → GET /hoteles/{propertyId}/revenue/recomendaciones${qs ?  | busy | CABLEADO |
| 547 | Boton | Descartar | clic | `discardRateRecommendation` → POST /hoteles/{propertyId}/revenue/recomendaciones/{id}/descartar; `fetchRateRecommendations` → GET /hoteles/{propertyId}/revenue/recomendaciones${qs ?  | busy | CABLEADO |
| 569 | Selector | pricing-room-type | cambio | estado local de la UI |  | CABLEADO |
| 583 | Formulario | (formulario) | envio | `savePricingRule` → PUT /hoteles/{propertyId}/revenue/pricing-rule/{roomTypeId} |  | CABLEADO |
| 652 | Boton | Guardar reglas |  | (envio del formulario de la linea 583) `savePricingRule` → PUT /hoteles/{propertyId}/revenue/pricing-rule/{roomTypeId} | busy | CABLEADO |
| 665 | Formulario | (formulario) | envio | `createLocalEvent` → POST /hoteles/{propertyId}/revenue/local-events |  | CABLEADO |
| 686 | Selector | (selector) | cambio | estado local de la UI |  | CABLEADO |
| 700 | Boton | Registrar evento |  | (envio del formulario de la linea 665) `createLocalEvent` → POST /hoteles/{propertyId}/revenue/local-events | busy | CABLEADO |
| 705 | Formulario | (formulario) | envio | `createCompetitorRate` → POST /hoteles/{propertyId}/revenue/competitor-rates |  | CABLEADO |
| 726 | Boton | Capturar tarifa |  | (envio del formulario de la linea 705) `createCompetitorRate` → POST /hoteles/{propertyId}/revenue/competitor-rates | busy | CABLEADO |
| 734 | Dialogo de confirmacion | dialogo: Aprobar autopilot pleno | confirmar | `setRevenueGateOwnerApproval` → POST /hoteles/{propertyId}/revenue/gate/aprobacion-autopilot |  | CABLEADO |

### Tickets.tsx (14 controles)

| Linea | Tipo | Control | Evento | Efecto | Deshab. si | Estado |
|---|---|---|---|---|---|---|
| 181 | Boton | «ACCION_LABELS[a]» | clic | `accionTicket` → POST /hoteles/{propertyId}/tickets/{ticketId}/{accion} | busy === t.id | CABLEADO |
| 186 | Selector | (selector) | cambio | `reasignarTicket` → POST /hoteles/{propertyId}/tickets/{ticketId}/reasignar | busy === t.id | CABLEADO |
| 201 | Boton | Bitácora | clic | `fetchTicketDetalle` → GET /hoteles/{propertyId}/tickets/{ticketId} |  | CABLEADO |
| 236 | Formulario | (formulario) | envio | `crearTicket` → POST /hoteles/{propertyId}/tickets |  | CABLEADO |
| 243 | Selector | (selector) | cambio | estado local de la UI |  | CABLEADO |
| 254 | Selector | (selector) | cambio | estado local de la UI |  | CABLEADO |
| 263 | Boton | «busy === "crear" ? "Registrando…" : "Reg» |  | (envio del formulario de la linea 236) `crearTicket` → POST /hoteles/{propertyId}/tickets | busy === "crear" | CABLEADO |
| 272 | Pestana | Activos |  | cambia de pestaña (estado local) |  | CABLEADO |
| 273 | Pestana | Escalados |  | cambia de pestaña (estado local) |  | CABLEADO |
| 274 | Pestana | Reseñas con queja |  | cambia de pestaña (estado local) |  | CABLEADO |
| 275 | Pestana | SLA |  | cambia de pestaña (estado local) |  | CABLEADO |
| 304 | Boton | Crear ticket | clic | `crearTicketDesdeResena` → POST /hoteles/{propertyId}/tickets/desde-resena | busy === r.id | CABLEADO |
| 352 | Boton | Guardar | clic | `guardarSla` → PUT /hoteles/{propertyId}/tickets/sla | busy === key | CABLEADO |
| 388 | Boton | Cerrar | clic | estado local de la UI |  | CABLEADO |

## Verificacion manual (muestreo)

Se contrasto contra el codigo, a mano, una muestra de filas de cada tipo: Reservas (cancelar -> dialogo -> `cancelReservation`; asignar habitacion), Folio (cerrar folio -> dialogo -> `closeFolio`), Fraude (confirmar/descartar), Tickets (cancelar y cerrar con dialogo), Housekeeping (cancelar tarea, asignar, inspeccionar, inhabilitar), Mantenimiento (cerrar ticket), Agentes (pausar/presupuesto/plantillas) y Aprobaciones (decidir/ejecutar/proponer). El script resuelve funciones locales hasta 4 niveles de profundidad; un handler que delegue mas profundo, o que llame a un cliente por un nombre distinto al exportado, aparecera con efecto "estado local de la UI" en vez de la ruta: en esta salida las filas de formularios y de botones de accion se revisaron una por una y no quedo ninguna asi, pero **las filas de selectores y pestanas siempre dicen "estado local"** (correcto: solo cambian un filtro o un campo del formulario).

## Hallazgos del recorrido (corregidos en este PR)

1. **`window.confirm`/`window.prompt` nativos (6 sitios)**: Tickets (cancelar y nota de cierre), Housekeeping (cancelar tarea, inspeccion aprobada/rechazada con nota, asignar camarista por numero, baja de habitacion con tipo) y Mantenimiento (costo real y nota de cierre) pasan a `ConfirmDialog`/`useConfirm` con el nombre del objeto en el titulo.
2. **Cancelar el cuadro de la nota de cierre cerraba el ticket de todos modos** (Tickets: unico paso; Mantenimiento: segundo paso, tras el costo; `window.prompt` devolvia `null` y el codigo seguia con nota vacia). Ahora cancelar el dialogo **aborta** la accion. Es el unico cambio de comportamiento intencional del PR.
3. **Rechazar una inspeccion sin motivo**: antes el prompt aceptaba vacio y mostraba un error en la pagina; ahora el dialogo no deja confirmar sin motivo (el boton "Rechazar" queda deshabilitado hasta escribirlo).
4. **Selector de huesped de Reservas** era un `<select size=N>` (lista de varias filas); `NativeSelect` es de una fila, por lo que ahora es un desplegable (la busqueda por texto de arriba sigue filtrando las opciones). Cambio visual, misma funcion.
5. Barra movil de 4 destinos + "Mas" con todas las secciones del rol (en `main` ya existia desde #231/#234 para hoteles; aqui se conserva sobre el shell unico).

## Sin cubrir

- Modo oscuro: no se capturo.
- Las pestanas y filtros de cada pagina se revisaron solo estaticamente.
- El `Sidebar` compartido marca "Dashboard" activo en subrutas (visible en las capturas); es de `packages/ui` y esta fuera de alcance.


## Actualizacion UNI-C-hoteles (operacion): controles que cambiaron

Las tablas de arriba son la medicion historica (numeros de linea de PR-6); no se regeneraron. Este apartado lista solo lo que cambio de forma o de interaccion en las paginas de operacion. Las rutas y funciones de cliente son las mismas: no hay cambios de backend ni de SQL.

| Pagina | Antes | Ahora |
|---|---|---|
| Huespedes | `h1` suelto + buscador con `label` manual | `PageHeader` + `FormField` |
| HuespedFicha | `h1` suelto con enlace "Huespedes" | `PageHeader` con `atras`; tipo y texto de la nota con `FormField`; Guardar con `loading` |
| Mantenimiento | formulario inline en una tarjeta; "Estimado: $0" | `FormDialog` + `FormField` (Crear ticket); "Sin estimar" cuando no hay costo estimado; `notify` al crear y cerrar |
| Pedidos F&B | `window.prompt` para la nota de cocina; formulario inline | `useConfirm().pedirTexto` (Cancelar/Escape no confirman); alta en `FormDialog`; fechas con `fechaHoraEsMx` |
| Folio | `window.prompt` para el motivo del reverso; `h1` suelto | `useConfirm().pedirTexto` con tono de peligro (Cancelar/Escape no escriben, motivo obligatorio); `PageHeader` con saldo; campos con `FormField`; aviso como `Callout` |
| Recepcion | `h1` con icono y `label` manual | `PageHeader`; `FormField`; avisos de base sin migrar como `Callout` |
| Reservas | formulario "Nueva reserva" inline | `FormDialog` con `FormField` (ids de los campos conservados); `PageHeader`; aviso como `Callout` |
| Housekeeping | `h1` suelto | `PageHeader`; `FormField` en la fecha; botones "Asignar automaticamente" y "Generar tareas del dia" con `loading` |
| Tickets | `h1` con icono; `label` manuales | `PageHeader` con el conteo como `meta`; `FormField`; fechas de la bitacora con `fechaHoraEsMx` |
| Asistencia | `h1` suelto; `Table` crudo del cruce | `PageHeader`; `FormField`; `DataTable` (orden y tarjetas en movil) en el cruce |
| Conversaciones | `label` manuales; aviso en `<p>` | `FormField` y `Callout` |
| CambiarFechasDialog | `Table` crudo de la comparacion | `DataTable` (sin paginacion) |

Pendiente declarado: Catalogo.tsx y Mensajeria.tsx no se tocaron (PRs abiertos de otros carriles); Dashboard ya no tiene `h1` propio (lo da el Resumen). No hay barrido axe: `@axe-core/playwright` no esta en el repo.

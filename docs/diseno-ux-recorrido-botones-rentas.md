# Recorrido de botones de rentas (PR-7 del plan de diseno-ux, seccion 7)

Alcance: `apps/web/src/verticals/rentas/**` (shell, login, registro, portal de propietario y las 11 paginas del panel).

## Metodo y limites (leer primero)

- **Estatico**, sobre el codigo de esta rama: por pagina se leyeron los botones, enlaces, selects y dialogos y el handler de cada uno hasta la
  funcion de cliente (`lib/*-client.ts`). Una busqueda sobre la vertical no encuentra `disabled` fijo, `href="#"`, handler vacio ni "Pronto" propio de
  rentas (el "Pronto" de "Chatea con tus datos" es del boton compartido, ver `BotonChatDatos`).
- **Ejecucion real parcial**: las capturas de `docs/diseno-ux-capturas-pr7-rentas/` salen de Chromium contra la app en modo desarrollo y una API
  **simulada** (datos de ejemplo locales, no el backend ni la base). Solo se navegaron login, resumen, calendario (con el dialogo de cancelar),
  aprobaciones, sincronizacion iCal, auditoria, la hoja "Mas" en movil y el modo oscuro. **No** se hizo clic real en cada boton contra un backend.
- Las pantallas de Precios, Finanzas, Mis tareas, Monitor de conflictos, Acceso al huesped, Reportes, Registro y el portal de propietario quedan con
  verificacion estatica y las pruebas de componente ya existentes; no se capturaron.
- Nada se verifico contra la base ni el API reales.

## Shell, navegacion y cuenta

| Control | Handler / destino | Estado |
|---|---|---|
| Sidebar (11 destinos en 3 grupos) | `NavLink` a rutas de `App.tsx`; "Resumen" solo activo en la raiz (`end`) | CABLEADO (probado) |
| Barra inferior movil: Resumen, Calendario, Aprobaciones, Mis tareas | `NavLink` | CABLEADO (probado) |
| "Mas" (movil) | hoja con los 11 destinos (antes Precios, Finanzas, iCal, Monitor, Acceso, Reportes y Auditoria no se alcanzaban en movil) | CABLEADO (probado, captura) |
| Selector de propiedad (Sidebar y MobileHeader, con 2+) | `selectBranch` persiste `atiende.rentas.selectedProperty.<org>` y remonta las paginas | CABLEADO (probado) |
| Nombre de propiedad activa | cabecera de escritorio y Sidebar | CABLEADO (probado) |
| Campana, tema, cerrar sesion, "Chatea con tus datos" | `VerticalShellConectado` | CABLEADO (probado) |
| Saltar al contenido / un unico `<main>` | ancla `#contenido-principal` | CABLEADO (probado) |
| Login: Google, correo (magic link), "Creala aqui" | `VerticalLogin` con `pie` de rentas | CABLEADO |

## Acciones destructivas o irreversibles

| Accion | Confirmacion | Cancelar/descartar |
|---|---|---|
| Rechazar borrador (Aprobaciones y su hilo) | `ConfirmDialog` con motivo obligatorio (`BorradorPendienteCard`, la misma en la bandeja y en el hilo) | no llama al servidor (probado en ambas pantallas); si falla el servidor el dialogo queda abierto con el motivo |
| Cancelar reserva / liberar bloqueo (Calendario) | `ConfirmDialog` que nombra unidad y fechas | "No, mantenerla" no llama al servidor (probado) |
| Desconectar canal iCal (Sincronizacion) | `ConfirmDialog` **nuevo** en este PR (antes ejecutaba con un clic) | Cancelar no llama al servidor (probado) |

## Pantallas

| Pantalla | Controles | Prueba |
|---|---|---|
| Resumen | lista de propiedades (boton por propiedad: cambia la activa) | no |
| Calendario | nueva reserva / nuevo bloqueo (`FormDialog`), modificar fechas, cancelar | confirmaciones |
| Aprobaciones | aprobar y enviar, rechazar, simulador de mensaje entrante; filtros (canal, con pendientes, requiere atencion, busqueda) con estado en la URL; insignia «Requiere atencion humana» con su senal; aviso de politica del canal; «Ver hilo» | confirmaciones, hilo-mensajes, humo-rentas (e2e) |
| Hilo de una conversacion (`/aprobaciones/:conversacionId`) | mensajes entrantes y salientes en orden con su origen (texto del huesped como texto plano, «dato, no instruccion»), marca de contenido redactado, cada borrador junto al mensaje que responde, aprobar/rechazar, «Generar borrador» por mensaje entrante sin borrador pendiente | hilo-mensajes, humo-rentas (e2e) |
| Mis tareas | seleccionar tarea, asignar, checklist (`Checkbox` con nombre), completar, incidencias, confirmar bloqueo | confirmar-bloqueo |
| Sincronizacion iCal | conectar (`FormDialog`), desconectar, copiar URL | confirmaciones |
| Monitor de conflictos | resolver, ignorar con motivo (inline), historial, atender alerta | monitor-sync-page |
| Acceso al huesped | politica, instrucciones por unidad, marcar pagada/revocar | acceso-huesped-page |
| Precios | cotizador y 5 formularios de configuracion | no |
| Finanzas | movimiento por reserva, owner statements, payouts | no |
| Reportes | filtros, exportar CSV/PDF | reportes-page |
| Auditoria | filtros, tabla (`DataTable`), cargar mas | auditoria-page |
| Registro / portal de propietario | formularios | registro-page, owner-portal-dashboard-page |

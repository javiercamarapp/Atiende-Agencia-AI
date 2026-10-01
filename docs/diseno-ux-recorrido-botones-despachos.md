# Recorrido de botones de despachos (PR-8 del plan de diseno-ux, seccion 7)

Alcance: `apps/web/src/verticals/despachos/**` (shell, login y las 18 paginas de `pages/`). El chat de datos y la lista
69-B del SAT (EFOS) se revisan como parte de `DespachosShell.tsx` y `Cfdi.tsx`.

## Metodo y limites (leer primero)

- **Estatico, sobre el codigo de esta rama**: por cada pagina se leyeron los `Button`, `Link`, `NativeSelect`, `Checkbox`,
  `form`, `ConfirmDialog` y `FormDialog` y el handler de cada uno hasta la funcion de cliente que llama al API
  (`apps/web/src/verticals/despachos/lib/*-client.ts`). Una busqueda sobre la vertical no encuentra ningun `disabled`
  fijo, `href="#"`, handler vacio ni texto "Pronto" propio de despachos.
- **Ejecucion real parcial**: las capturas se tomaron en un navegador real (Chromium) contra la app en modo desarrollo y
  una API **simulada** con fixtures locales (no el backend, no la base). Solo se navegaron cierre mensual, CFDI
  (con la tarjeta EFOS), cobranza (con el modal de alta), vencimientos, login y la hoja "Mas" en movil. Las demas
  pantallas quedan con verificacion estatica y, donde existe, prueba de componente; **no** se hizo clic real en cada
  boton contra un backend.
- Nada se verifico contra la base ni el API reales (no se tocaron).
- Los criterios 8-10 de la seccion 7.3 (teclado, 375 px, oscuro) salen de los primitivos de `@atiende/ui`; el oscuro y el
  movil se verificaron con las capturas citadas arriba, no pantalla por pantalla.

## Shell, navegacion y cuenta (todas las rutas)

| Control | Handler / destino | Efecto | Estado |
|---|---|---|---|
| Items del Sidebar (Dashboard, Cierre mensual; CFDI, Cobranza, Vencimientos; Declaraciones, Nomina, Conciliacion bancaria, Contabilidad electronica, Devolucion de IVA, Bookkeeping, Reportes de cliente, Migracion de catalogo; Staff, Configuracion) | `NavLink to=/despachos/:org/...` | las 15 rutas existen en `App.tsx` | CABLEADO |
| Barra inferior movil: Cierre, CFDI, Cobranza, Vencim. | `NavLink` | rutas de `App.tsx` | CABLEADO |
| Boton "Mas" (movil) | hoja con las 15 secciones | cubierto por prueba (`despachos-shell-mobile-nav`) y por captura | CABLEADO (probado) |
| Selector de contribuyente (Sidebar y MobileHeader, solo con 2+) | `s.selectBranch` -> persiste `atiende.despachos.selectedProperty.<org>` y remonta las paginas por `key` | cambia `propertyId` del contexto | CABLEADO (probado) |
| Nombre del contribuyente activo | titulo de la cabecera de escritorio (`Despachos · <nombre>`) y texto del Sidebar cuando hay uno solo | informativo | CABLEADO |
| Campana, tema, cerrar sesion, "Chatea con tus datos" | `VerticalShellConectado` / `MobileAccountMenu`; el chat usa `conexionChatDatosDespachos` | cerrar sesion limpia `localStorage` (probado) | CABLEADO |
| Enlace "Saltar al contenido" | ancla `#contenido-principal` | foco al unico `<main>` | CABLEADO (probado) |
| Login: Google, "Continuar con correo" | `VerticalLogin` (compartido) | `verificarGoogleConfigurado`, `iniciarMagicLink` | CABLEADO (probado en `vertical-login`) |

## Pantallas

"Prueba" = prueba de componente existente que ejerce la pantalla (`apps/web/tests`). "No" = solo verificacion estatica.

| Pantalla | Controles (handler -> efecto) | Prueba |
|---|---|---|
| **Dashboard** | tarjetas y ranking de clientes (`DataTable`) -> `fetchDashboardDespacho` (GET `/v1/despachos/:org/dashboard`); sin acciones de escritura | despachos-dashboard-page |
| **Cierre mensual** | "Abrir periodo" -> formulario -> `crearPeriodo` (POST `.../periodos`); fila -> `Link` al detalle; solo roles admin/contador | despachos-cierre-mensual-page |
| **Cierre mensual (detalle)** | "Completar" -> `completarTareaCierre`; "Generar/Actualizar reporte" -> `fetchReporteCierre`; "Cerrar periodo" -> **`ConfirmDialog` (peligro) con texto AAAA-MM** -> `cerrarPeriodoCierre` (POST `.../cerrar`); solo admin | despachos-cierre-mensual-confirmar-cierre (nuevo: abrir, validar texto, cancelar, confirmar, error) |
| **CFDI** | casilla "solo con revision pendiente" -> `fetchInvoices`; "Cargar XML de CFDI" -> `importarCfdiXml` (POST `.../importar-xml`); aprobar/rechazar revision -> `aprobarRevision`/`rechazarRevision`; tarjeta EFOS -> `fetchEfosAlertas`; fila -> `Link` al detalle | despachos-efos-client, despachos-revisiones-client (clientes); pagina: No |
| **CFDI (detalle)** | "Aprobar"/"Rechazar" -> `aprobarRevision`/`rechazarRevision` (`disabled` solo mientras resuelve); nota (`Textarea`) | despachos-revisiones-client (cliente); pagina: No |
| **Cobranza** | "Registrar cuenta por cobrar" -> `FormDialog` -> `registrarCuentaCobranza`; "Enviar recordatorio" -> `enviarRecordatorioCobranza`; "Marcar pagada" -> `marcarCuentaPagada`; casilla "solo pendientes" | despachos-cobranza-page |
| **Vencimientos** | "Calcular vencimientos del periodo" -> `calcularVencimientos`; filtro de estado -> `fetchVencimientos`; "Marcar completado" -> `completarVencimiento`; "Escalar" -> `escalarVencimiento` | despachos-vencimientos-page, -calcular-default-cdmx |
| **Declaraciones** | ISR PF / PM / RESICO -> `calcularIsrPf/Pm/PmResico`; DIOT -> `fetchDiot`; "Descargar TXT/XML" -> `fetchDiotLayout` (`disabled` por condicion) | despachos-declaraciones-diot-periodo-default-cdmx |
| **Nomina** | calcular -> `calcularNomina`; "Generar XML" -> `generarXmlNomina`; "Copiar XML" (portapapeles) | despachos-nomina-periodo-default-cdmx |
| **Conciliacion bancaria** | matching, alertas, clasificar deposito, verificar SPEI -> `correrMatchingConciliacion`, `fetchAlertasConciliacion`, `clasificarDepositoConciliacion`, `verificarSpeiConciliacion` | No |
| **Importar estado de cuenta** | previsualizar -> `previsualizarEstadoCuenta`; guardar -> `guardarEstadoCuenta`; "Volver a conciliacion" -> `Link` | despachos-estado-cuenta-page |
| **Migracion de catalogo** | "Clasificar catalogo" -> `FormDialog` -> `clasificarCatalogo`; filtro de estado; aprobar/rechazar/editar mapeo -> `aprobarMapeoMigracion`/`rechazarMapeoMigracion`/`editarMapeoMigracion` | No (solo el cliente) |
| **Devolucion de IVA** | facturas del periodo, conciliacion, saldo a favor, congruencia, DIOT, papel de trabajo, plazo -> `postXxxDevolucionIva` / `fetchFacturasPeriodoDevolucionIva` | despachos-devolucion-iva-client (cliente); pagina: No |
| **Bookkeeping** | catalogo, clasificar CFDI, generar polizas y ajuste -> `fetchCatalogoBookkeeping`, `clasificarCfdisBookkeeping`, `generarPolizasBookkeeping`, `generarAjusteBookkeeping` | despachos-bookkeeping-fecha-default |
| **Reportes de cliente** | tipo y periodo -> `fetchReporte`; "Descargar PDF/Excel" -> `descargarReporte` | despachos-reportes-page |
| **Contabilidad electronica** | catalogo base, paquete, "listo para timbrar" -> `fetchCatalogoBaseContabilidadElectronica`, `postPaqueteContabilidadElectronica`, `postListoParaTimbrarContabilidadElectronica` | despachos-contabilidad-electronica-client (cliente); pagina: No |
| **Staff** | invitar -> `createStaffInvite`; "Revocar" -> `revokeStaffInvite`; selector de rol -> `updateStaffRole` (`disabled` mientras guarda) | No |
| **Configuracion** | zona horaria (`NativeSelect` ahora con etiqueta visible) -> `updateConfiguracion` (PUT); solo admin | despachos-configuracion-client (cliente); pagina: No |

## Hallazgos del recorrido

| # | Hallazgo | Accion en este PR |
|---|---|---|
| H-1 | El selector de zona horaria de Configuracion no tenia etiqueta visible ni asociada | `Label` + `NativeSelect` |
| H-2 | El shell propio no ofrecia "saltar al contenido" y su `<main>` no era enfocable; los estados de carga/error del shell eran un `<main>` aparte sin la estructura comun | un solo `<main id="contenido-principal" tabindex="-1">` (de `VerticalShell`) con skip link y `VerticalShellEstado` para carga/error/vacio; ninguna pagina de despachos renderiza `<main>` (comprobado por busqueda); prueba nueva |
| H-3 | `PageContainer` es un `grid`: una tabla ancha dentro de una `Card` ensanchaba la pagina mas alla del viewport (se cortaba el boton de la cabecera en Cobranza) | `min-w-0` en los hijos: la tabla hace scroll dentro de su `Card` (visto en captura antes de corregir) |
| H-4 | Cierre de periodo (irreversible): el `AlertDialog` armado a mano mostraba el error del servidor detras del overlay | `ConfirmDialog` con campo de confirmacion escrita; el error se muestra DENTRO del dialogo y el dialogo no se cierra |
| H-5 (NO corregido) | En movil el selector de contribuyente se ve truncado ("Grupo Can...") porque el `MobileHeader` compartido le da poco ancho; el nombre completo si aparece en la cabecera de escritorio y dentro del selector abierto | fuera de alcance (`packages/ui`); queda en knownGaps |
| H-6 (NO corregido) | El item "Dashboard" del Sidebar de escritorio queda activo en subrutas (el `Sidebar` compartido no soporta `end`) | fuera de alcance (`packages/ui`) |
| H-7 (NO corregido) | Las tablas con acciones por fila (Cobranza, Vencimientos, Conciliacion, Devolucion de IVA, Bookkeeping, Nomina, Migracion de catalogo, Contabilidad electronica, Importar estado de cuenta, Declaraciones, Reportes) siguen siendo `Table`: pasarlas a `DataTable` agrega paginacion/tarjetas en movil y cambia el comportamiento; en movil hacen scroll horizontal dentro de su tarjeta | queda en knownGaps |

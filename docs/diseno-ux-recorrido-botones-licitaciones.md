# Recorrido de botones de licitaciones (PR-9 del plan de diseno-ux, seccion 7)

Alcance: `apps/web/src/verticals/licitaciones/**` (shell, login y las 22 paginas de `pages/`, incluidas la sala de guerra y
la junta de aclaraciones, la seguridad de la cuenta, WhatsApp y el chat con tus datos del shell).

## Metodo y limites (leer primero)

- **Estatico, sobre el codigo de esta rama**: por cada pagina se leyeron los `Button`, `Link`, `NativeSelect`, `Checkbox`,
  `form`, `useConfirm` y `FormDialog` y el handler de cada uno hasta la funcion de cliente que llama al API
  (`apps/web/src/verticals/licitaciones/lib/*-client.ts`). Una busqueda sobre la vertical no encuentra ningun `disabled`
  fijo, `href="#"`, handler vacio ni texto "Pronto" propio de licitaciones (el rotulo "Pronto" del boton de chat sale del
  componente compartido solo cuando el servidor dice que el chat no esta activo).
- **Ejecucion real parcial**: las capturas se tomaron en un navegador real (Chromium) contra la app en modo desarrollo y
  una API **simulada** con fixtures locales (no el backend, no la base). Solo se navegaron login, convocatorias, radar de
  renovaciones, fuentes y frescura, seguridad (con el dialogo de cerrar sesiones) y la hoja "Mas" en movil. Las demas pantallas
  quedan con verificacion estatica y, donde existe, prueba de componente; **no** se hizo clic real en cada boton contra un
  backend.
- Nada se verifico contra la base ni el API reales (no se tocaron).
- Los criterios 8-10 de la seccion 7.3 (teclado, 375 px, oscuro) salen de los primitivos de `@atiende/ui`; el oscuro y el
  movil se verificaron con las capturas citadas, no pantalla por pantalla.

## Shell, navegacion y cuenta (todas las rutas)

| Control | Handler / destino | Efecto | Estado |
|---|---|---|---|
| Items del Sidebar (Panel, Convocatorias, Seguimiento, Radar de renovaciones, Fuentes y frescura; Perfil de matching, Datos de la empresa, Aprobaciones, Staff (solo owner/admin), WhatsApp, Seguridad) | `NavLink to=/licitaciones/:org/...` | las rutas existen en `App.tsx` | CABLEADO |
| Barra inferior movil: Panel, Convocatorias, Seguimiento, Empresa | `NavLink` | rutas de `App.tsx` | CABLEADO |
| Boton "Mas" (movil) | hoja con TODAS las secciones del Sidebar (11 para owner/admin, 10 para el resto) | cubierto por prueba (`licitaciones-shell-mobile-nav`) y por captura | CABLEADO (probado) |
| Titulo de la cabecera (`Licitaciones · <org>`) | informativo; licitaciones opera con una sola property por organizacion: no hay selector de sucursal | - | CABLEADO |
| Campana, tema, cerrar sesion, "Chatea con tus datos" | `VerticalShellConectado` / `MobileAccountMenu`; el chat usa `conexionChatDatosLicitaciones` | cerrar sesion llama `POST /auth/logout` y limpia `localStorage` (probado) | CABLEADO |
| Enlace "Saltar al contenido" | ancla `#contenido-principal` | foco al unico `<main>` | CABLEADO (probado) |
| Login: Google, "Continuar con correo" | `VerticalLogin` (compartido) | `verificarGoogleConfigurado`, `iniciarMagicLink` | CABLEADO (probado en `vertical-login`) |
| Enlaces de correo publicos (restablecer contrasena, verificar correo) | `CuentaEnlaces.tsx` (pagina independiente, fuera del shell) | `confirmarRestablecerContrasena` / `confirmarVerificacionCorreo` (POST) | CABLEADO (probado) |

## Pantallas

"Prueba" = prueba de componente existente que ejerce la pantalla (`apps/web/tests`). "No" = solo verificacion estatica.

| Pantalla | Controles (handler -> efecto) | Prueba |
|---|---|---|
| **Panel** | tarjetas -> `Link` a su pantalla (convocatorias, seguimiento, radar, aprobaciones, `/firmantes` -> Datos de la empresa pestana firmantes, fuentes); lecturas independientes, una falla muestra "No disponible" | No |
| **Convocatorias** | "Nueva convocatoria" -> `FormDialog` -> `createOrUpdateTender` (POST `.../tenders`); fila -> `Link` al detalle; solo roles de escritura | licitaciones-tenders-client (cliente); pagina: No |
| **Convocatoria (detalle)** | "Marcar Go" -> `createGoNoGoDecision`; **"Marcar No-go" -> `ConfirmDialog` (peligro)** -> `createGoNoGoDecision`; **"Marcar ganada / perdida" -> `ConfirmDialog`** -> `resolveTender`; pestanas Go/No-go, Resolucion, Checklist; enlaces a requisitos, sala de guerra, propuesta, cierre, contrato, post-adjudicacion, autopsia | licitaciones-convocatoria-detalle-page (incluye Cancelar no registra) |
| **Requisitos de las bases** | subir PDF/texto -> `extractRequirements`; "Quitar" archivo pendiente (solo estado local); enlace a propuesta tecnica | licitaciones-requirements-client (cliente); pagina: No |
| **Propuesta tecnica** | mapear requisito -> `upsertRequirementMapping`; "Generar propuesta tecnica" -> `generateTechnicalProposal`; "Generar propuesta economica" -> `generateEconomicProposal`; agregar/quitar concepto (estado local) | licitaciones-technical-proposal-client (cliente); pagina: No |
| **Cierre del expediente** | "Correr checklist" -> `runChecklist`; aprobar expediente / seccion -> `approveExpediente` / `approveProposalSection`; "Ensamblar paquete" -> `assemblePackage`; "Descargar" -> `downloadPackage` (GET binario); agregar/quitar firma o archivo (estado local) | licitaciones-cierre-client, licitaciones-checklist-client (clientes); pagina: No |
| **Contrato** | "Registrar contrato" -> `createContract`; metadatos -> `updateContractMetadata`; subir documento -> `addContractDocument`; confirmar/corregir campo extraido -> `confirmContractExtractedField`; **"Aplicar transicion": rescindir/penalizar/inconformidad/modificar -> `ConfirmDialog` (peligro)**, luego `requestStepUpToken` (si hay 2FA) + `transitionContract` | licitaciones-contract-client (cliente); pagina: No |
| **Post-adjudicacion** | registrar factura -> `createContractInvoice`; "Marcar pagada" -> `markContractInvoicePaid`; borrador de inconformidad -> `createInconformidadDraft`; "Marcar como revisado por abogado" -> `markInconformidadReviewed` | licitaciones-postadjudicacion-fechas, licitaciones-contract-billing-client, licitaciones-inconformidad-client |
| **Autopsia del fallo** | registrar autopsia -> `createFalloAutopsy`; agregar/quitar criterio (estado local) | licitaciones-autopsia-client (cliente); pagina: No |
| **Sala de guerra** | pestanas Tablero / Junta; agregar item -> `createWarRoomItem`; estado/responsable -> `updateWarRoomItem`; importar requisitos -> `importWarRoomRequirements`; bitacora -> `addWarRoomEntry` | licitaciones-sala-guerra-page |
| **Junta de aclaraciones** | preguntas: aprobar / enviar / registrar respuesta / descartar (cada una con su confirmacion en linea y Cancelar) -> `transitionJuntaQuestion`; editar -> `updateJuntaQuestion`; borradores del asistente; configuracion -> `saveJuntaConfig`; recordatorios -> `acknowledgeJuntaReminder` | licitaciones-sala-guerra-page |
| **Seguimiento** | casilla "solo pendientes"; "Reconocer" -> `acknowledgeDeadlineReminder` / `acknowledgeTenderChangeNotification` | licitaciones-sources-seguimiento-client (cliente); pagina: No |
| **Radar de renovaciones** | "Escanear renovaciones" -> `scanRenewalAlerts`; "Reconocer" -> `acknowledgeRenewalAlert`; casilla "solo pendientes" | licitaciones-radar-renovaciones-dias-restantes-cdmx, licitaciones-renewal-radar-client |
| **Fuentes y frescura** | solo lectura (conectores, frescura, corridas); sin botones de accion | licitaciones-sources-seguimiento-client (cliente); pagina: No |
| **Perfil de matching** | "Guardar perfil de matching" -> `saveMatchingProfile` | licitaciones-matching-profile-client (cliente); pagina: No |
| **Datos de la empresa** | alta de documento / tarifa / capacidad / experiencia / firmante -> `createCompanyDocument` etc.; "Aprobar" / "Rechazar" -> `updateCompanyDocument` etc.; **"Revocar" autorizacion de firmante -> `ConfirmDialog` (peligro)** -> `updateCompanySigner`; `?tab=` abre la pestana | licitaciones-paginas-flujo (`?tab=firmantes`) |
| **Aprobaciones** | "Aprobar" / "Rechazar" (reversible: un rechazado se puede aprobar despues) -> `updateCompanyDocument` etc. | No |
| **Staff** | invitar -> `createStaffInvite`; **"Revocar" -> `ConfirmDialog` (peligro, con el correo)** -> `revokeStaffInvite`; selector de rol -> `updateStaffRole`; zona horaria -> `updateTenantConfigTimezone` | licitaciones-admin-client (cliente); pagina: No |
| **WhatsApp** | guardar telefono y temas -> `saveWhatsAppSettings`; **"Dejar de recibir avisos" -> `ConfirmDialog` (peligro)** -> `optOutWhatsApp`; "Pedir decision" -> `requestWhatsAppDecision` | licitaciones-whatsapp-page (incluye Cancelar no llama opt-out) |
| **Seguridad de la cuenta** | activar 2FA -> `startTwoFactorSetup` / `confirmTwoFactorSetup`; codigos de respaldo -> `regenerateBackupCodes`; "Desactivar..." -> formulario con contrasena + codigo -> `disableTwoFactor`; correo / contrasena / Google (vincular, "Desvincular..." con contrasena y Cancelar); **"Cerrar sesion", "Cerrar todas las demas", "Cerrar mis otras sesiones" -> `ConfirmDialog` (peligro)** -> `cerrarSesion` / `cerrarOtrasSesiones` / `revokeOtherSessions` | licitaciones-seguridad-page, licitaciones-cuenta-pages (incluye Cancelar no cierra) |

## Regla "descartar un dialogo NUNCA ejecuta la accion"

Todos los `useConfirm` de esta vertical resuelven `false` al Cancelar, al cerrar con la "x", con Escape o al hacer clic fuera
(es el contrato del hook de `@atiende/ui`) y la accion solo corre tras un `true`. Pruebas que lo fijan:

- `licitaciones-cuenta-pages`: "Cancelar el dialogo (o cerrarlo) NUNCA cierra sesiones".
- `licitaciones-whatsapp-page`: "Cancelar el dialogo de salida NUNCA llama a opt-out".
- `licitaciones-convocatoria-detalle-page`: "Cancelar el dialogo de 'Marcar No-go' NUNCA registra la decision".

Sin prueba de componente propia (verificado solo por lectura del handler): revocar invitacion de staff, revocar firmante,
ganada/perdida y transiciones de decision del contrato.

## Hallazgos del recorrido

| # | Hallazgo | Accion en este PR |
|---|---|---|
| H-1 | El shell propio anidaba un `<main>` dentro del `<div>` del layout y los estados de carga/error eran un `<main>` aparte; no habia "saltar al contenido" | un solo `<main id="contenido-principal" tabindex="-1">` (de `VerticalShell`) con skip link y `VerticalShellEstado`; prueba nueva en `licitaciones-shell-mobile-nav` |
| H-2 | Acciones irreversibles o de alto efecto se ejecutaban al primer clic: cerrar sesiones de otros dispositivos, dejar de recibir avisos de WhatsApp, revocar invitaciones, revocar firmantes, No-go, ganada/perdida y transiciones de decision del contrato | `ConfirmDialog` con tono de peligro (ganada usa tono normal); Cancelar no ejecuta |
| H-3 | `Badge` con pares de color crudos (`border-amber-500/60 text-amber-600 dark:...`) o variantes (`default`/`destructive`/`outline`) para estados de negocio | `StatusBadge` con las tablas de `lib/status-tones.ts`; paneles ambar a `Callout` / tokens de advertencia |
| H-4 (NO corregido) | En el login oscuro el logo "atiende" azul sobre fondo oscuro tiene poco contraste | fuera de alcance (componente `VerticalLogin` / `AtiendeWordmark` compartido) |
| H-5 (NO corregido) | `lib/format.ts::formatMoney` de licitaciones sigue local: formatea con moneda (`Intl` currency, MXN/USD) y `formatMoney` de `@atiende/ui` es numerico sin moneda; unificarlos cambiaria la salida | queda en knownGaps |
| H-6 (NO corregido) | La sala de guerra usa dos botones con `role="tab"` en vez del componente `Tabs` | se conserva el comportamiento probado en `licitaciones-sala-guerra-page`; queda en knownGaps |

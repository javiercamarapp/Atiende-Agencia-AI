# Recorrido de botones del superadmin (PR-10 del plan de diseno-ux, seccion 7)

Alcance: `apps/web/src/superadmin/**` (shell, dialogo de step-up, banner de impersonacion y las 22 pantallas de `pages/`).
El plan habla de `web/verticals/superadmin/**`; la ruta real del codigo es `apps/web/src/superadmin/**`.

## Metodo y limites (leer primero)

- **Estatico, sobre el codigo de esta rama**: por cada pagina se leyeron los botones, enlaces, selectores, formularios y
  dialogos y el handler de cada uno hasta la llamada al API (`fetchJson` / `fetchConStepUp` de la propia pagina). Una busqueda
  sobre el directorio no encuentra `disabled` fijo, `href="#"`, handlers vacios ni texto "Pronto".
- **Ejecucion real parcial**: las capturas se tomaron en Chrome (headless) contra la app en modo desarrollo y una API
  **simulada** con fixtures locales (no el backend, no la base). Solo se navegaron Organizaciones, Prospectos, Planes y
  Gestion de organizaciones (claro y oscuro), la hoja "Mas" en movil (claro y oscuro) y tres dialogos (nuevo prospecto en
  claro y oscuro, confirmar plan en oscuro, confirmar suspension en claro). Las demas pantallas quedan con verificacion
  estatica y, donde existe, prueba de componente; **no** se hizo clic real en cada boton contra un backend.
- Nada se verifico contra la base ni el API reales (no se tocaron).
- Los criterios 8-10 de la seccion 7.3 (teclado, 375 px, oscuro) salen de los primitivos de `@atiende/ui`; el oscuro y el
  movil se verificaron con las capturas citadas, no pantalla por pantalla.
- Las capturas "antes" son de `main` con `?ds=v2` (mismos tokens que "despues") para que la diferencia sea solo la migracion.

## Shell, navegacion y cuenta (todas las rutas)

| Control | Handler / destino | Efecto | Estado |
|---|---|---|---|
| 22 items del Sidebar | `NavLink to=/superadmin/...` | las rutas existen en `App.tsx` | CABLEADO |
| Item "Organizaciones" | `NavLink to=/superadmin end` | antes quedaba resaltado junto al destino real en toda pantalla hija; ahora solo en `/superadmin` | CABLEADO (probado en `superadmin-shell-mobile-nav`) |
| Barra inferior movil: Orgs, Resumen, Salud, Acciones | `NavLink` | rutas de `App.tsx` | CABLEADO |
| Boton "Mas" (movil) | hoja con los 22 destinos del Sidebar | probado en `superadmin-shell-mobile-nav` y por captura | CABLEADO (probado) |
| Campana, tema, cerrar sesion | `VerticalShell` / `MobileAccountMenu`; cerrar sesion llama `POST /auth/logout`, limpia `localStorage` y el step-up | probado en `superadmin-shell-mobile-nav` | CABLEADO (probado) |
| "Chatea con tus datos" | no existe en el panel de plataforma (no aplica) | - | NO APLICA |
| Enlace "Saltar al contenido" | ancla `#contenido-principal` | foco al unico `<main>` | CABLEADO (probado) |
| Banner de impersonacion: "Terminar impersonacion" | `POST /superadmin/impersonacion/sesiones/:id/terminar` | cierra la sesion (solo reduce privilegio) | CABLEADO |
| Dialogo de step-up MFA | `verificarMfa`; Cancelar rechaza la promesa y la accion no corre | sin cambios de logica | CABLEADO (probado en `superadmin-stepup`) |

## Pantallas

"Prueba" = prueba de componente existente que ejerce la pantalla (`apps/web/tests`). "No" = solo verificacion estatica.

| Pantalla | Controles (handler -> efecto) | Prueba |
|---|---|---|
| **Organizaciones** | solo lectura (`GET /superadmin/organizations`); "Reintentar" en error | No |
| **Gestion de organizaciones** | "Alta de organizacion" / "Suspender" / "Reactivar" / "Pasar a cuenta ..." -> `FormDialog` con motivo -> `POST /superadmin/organizaciones/acciones` (crea la SOLICITUD, no ejecuta); en "Pendientes de confirmar": **"Confirmar" -> `ConfirmDialog` (peligro en suspender)** -> `POST .../acciones/:id/confirmar`; "Cancelar" -> `POST .../cancelar` | superadmin-gestion-organizaciones-page (incluye Cancelar del dialogo no ejecuta) |
| **Interruptores** | "Detener" / "Reactivar" -> `FormDialog` con motivo -> `PUT /superadmin/interruptores` | superadmin-interruptores-page |
| **Seguridad (MFA)** | "Enrolar autenticador" / "Reiniciar enrolamiento" -> `POST /superadmin/mfa/enrolar`; "Activar MFA" (codigo de 6 digitos) -> `POST /superadmin/mfa/verificar`; "Restablecer factor" de otro usuario (con motivo) -> `POST /superadmin/mfa/reset` | superadmin-seguridad-page |
| **Resumen diario** | "Generar ahora" -> `POST /superadmin/resumen/generar`; fila del historial -> estado local | superadmin-resumen-page |
| **Salud operativa** | solo lectura (`/superadmin/salud`, `/crons`, `/colas`, `/licitaciones-fuentes`); "Actualizar" | superadmin-salud-page |
| **Acciones** | "Crear accion" -> `POST /superadmin/acciones/intents`; "Confirmar" -> `AlertDialog` (ya existia) -> `POST .../confirmar`; "Cancelar" -> `POST .../cancelar` | superadmin-acciones-page |
| **Cerebro de ventas** (antes Prospectos; `/superadmin/cerebro`) | "Nuevo prospecto" -> `FormDialog` -> `POST /superadmin/prospectos`; selector de etapa -> `PATCH /superadmin/prospectos/:id`; filtros de vertical y etapa (estado local) | No |
| **Gasto de API de LLM** | editar tope de plataforma / de organizacion -> `FormDialog` -> `PUT` de tope; rango de fechas | superadmin-gasto-api-page |
| **Zona CFO segura** | asignar rol finanzas con motivo -> `PUT /superadmin/zona-cfo/roles/:id`; **"Retirar" -> `ConfirmDialog` (peligro, con el correo)** -> el mismo `PUT` con `rol: null`; "mas antiguas" (paginacion) | superadmin-zona-cfo-page (incluye Cancelar no llama al PUT) |
| **Privacidad (ARCO plataforma)** | solo lectura con casilla "Solo vencidas" | privacidad-plataforma-page |
| **Dashboard CFO** | selector de mes (solo lectura) | superadmin-cfo-dashboard-page |
| **P&L por vertical** | exportar CSV (vertical / cliente) -> `GET /superadmin/pyl/export.csv`; capturar infraestructura -> `PUT /superadmin/pyl/infra` | superadmin-pyl-vertical-page |
| **Costos y margen** | "Tipo de cambio" -> `FormDialog` -> `PUT /superadmin/costos/tipo-cambio`; "Detalle" -> `FormDialog` de lectura | superadmin-costos-margen-page |
| **Planes y precios** | "Nuevo plan" / "Editar" -> `FormDialog` -> `PUT /superadmin/planes/:id`; "Limites" -> `PUT .../limites/:metrica`; **"Quitar" limite -> `ConfirmDialog` (peligro)** -> `DELETE`; "Asignar plan" -> `FormDialog` -> `POST /superadmin/planes/asignaciones` (solicitud); **"Confirmar" -> `ConfirmDialog`** -> `POST .../confirmar`; "Cancelar" -> `POST .../cancelar` | superadmin-planes-page (incluye Cancelar no aplica el plan ni borra el limite) |
| **Contratos por cliente** | alta / enmienda -> `FormDialog` -> `POST /superadmin/contratos` y `POST .../enmiendas` | superadmin-contratos-page, superadmin-contratos-lib |
| **Facturacion** | "Actualizar"; filtros de la bitacora; detalle de organizacion -> panel de checkout -> `POST` de checkout (URL de pago, copiar) | superadmin-facturacion-page |
| **Romper cristal** | abrir acceso -> `FormDialog` con motivo y duracion -> `POST /superadmin/break-glass/sesiones`; "Cerrar acceso" -> `POST .../cerrar` (solo reduce privilegio); lectores por sesion | superadmin-break-glass-page |
| **Impersonacion** | abrir sesion -> `FormDialog` con motivo -> `POST /superadmin/impersonacion/sesiones`; "Terminar" -> `POST .../terminar` (solo reduce privilegio) | superadmin-impersonacion-page |
| **Auditoria de denegaciones** | solo lectura con "Cargar mas" | superadmin-authz-auditoria-page |
| **Integraciones** | solo lectura; "Actualizar" | superadmin-integraciones-page |
| **Entrar a los otros paneles** | "Ver panel" -> `POST /superadmin/paneles/:vertical/entrar` + `POST /auth/select-org` y navega al panel de esa vertical | No |

## Regla "descartar un dialogo NUNCA ejecuta la accion"

Todos los `useConfirm` de esta pantalla resuelven `false` al Cancelar, cerrar con la "x", Escape o clic fuera (contrato del hook
de `@atiende/ui`) y la accion solo corre tras un `true`. Pruebas que lo fijan:

- `superadmin-planes-page`: "Cancelar el dialogo de confirmar asignacion (o cerrarlo) NUNCA aplica el plan" y "quitar un limite pide
  confirmacion: Cancelar no llama al DELETE y confirmar si".
- `superadmin-gestion-organizaciones-page`: "Cancelar el dialogo de confirmar (o cerrarlo) NUNCA ejecuta la accion".
- `superadmin-zona-cfo-page`: "Retirar el rol pide confirmacion: Cancelar o cerrar NUNCA llama al PUT y confirmar si".

El `AlertDialog` de Acciones ya existia y no se toco; "Cerrar acceso" de romper cristal y "Terminar" de impersonacion solo
reducen privilegio y siguen sin confirmacion (como antes). Los permisos, el gating de roles y el step-up (`fetchConStepUp`,
`StepUpDialog`) no cambian: la confirmacion se antepone en pantalla, la llamada al servidor es la misma.

## Hallazgos del recorrido

| # | Hallazgo | Accion en este PR |
|---|---|---|
| H-1 | El shell propio anidaba un `<main>` y no tenia "saltar al contenido" ni migas | un solo `<main id="contenido-principal">` de `VerticalShell`, skip link y migas bajo v2; prueba nueva |
| H-2 | "Organizaciones" del Sidebar quedaba activo en todas las pantallas hijas (doble resaltado) | `end: true`; prueba nueva |
| H-3 | Acciones de cambio de plan, suspension de organizacion, quitar limite y retirar rol de finanzas se ejecutaban al primer clic | `ConfirmDialog`; Cancelar no ejecuta |
| H-4 | `Badge` con variantes y pares de color crudos (`bg-emerald-600`, `bg-amber-500`, `bg-violet-600`) para estados | `StatusBadge` con las tablas de `lib/status-tones.ts` |
| H-5 | Barras de avance con `style={{ width }}` | `<progress>` nativo (`components/BarraProgreso.tsx`) |
| H-6 (NO corregido) | El banner de impersonacion muestra el id de la organizacion, no su nombre: la API de la sesion no devuelve el nombre | cambiarlo exige tocar el contrato del API; queda en knownGaps |
| H-7 (NO corregido) | En oscuro el panel del Sidebar compartido se ve claro y de poco contraste en las capturas | componente compartido `Sidebar` de `@atiende/ui`, fuera de alcance |

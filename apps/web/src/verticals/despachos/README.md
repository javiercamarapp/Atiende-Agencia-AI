# Vertical: despachos (web)

Antes de esta fase existían solo `pages/Login.tsx` (email+password contra
`POST /auth/login` de `@atiende/core-auth`, mismo mecanismo que
`verticals/hoteles/pages/Login.tsx`) y `lib/auth-client.ts` (redefine la
llave de sesión `atiende.despachos.session` y el landing path
`/despachos/:slug` sobre las funciones genéricas de `../../../lib/auth-client.ts`).
Ni siquiera `Login.tsx` estaba montado en `apps/web/src/App.tsx` — el vertical
era inalcanzable en tiempo de ejecución, pese a que
`packages/domain-despachos` ya tenía motores de dominio completos: CFDI
(validación fiscal SAT), conciliación bancaria, migración de catálogo
contable, cierre mensual (checklist + validaciones de balance), nómina y
contabilidad electrónica. Todo eso era operable solo vía curl.

## Fase 9 — el backoffice visual real (gap: "el panel casi no existe")

Esta fase construye el primer tramo REAL y navegable del panel, con datos
reales de principio a fin (sin mocks fuera de los tests):

- `DespachosShell.tsx` — resuelve sesión + propertyId una sola vez (vía
  `GET /v1/despachos/:orgSlug/admin/branches`, endpoint NUEVO de esta fase —
  ver `apps/api/src/routes/verticals/despachos/admin.ts` — el vertical no
  tenía NINGÚN camino real para resolver ese propertyId). Mismo patrón exacto
  que `HotelesShell.tsx`/`LicitacionesShell.tsx`.
- `pages/CierreMensual.tsx` — dashboard de períodos de cierre
  (`GET .../cierre-mensual/periodos`, Fase 6 ya existente) con estatus
  (abierto/cerrado/vencido) y alta de un período nuevo
  (`POST .../periodos`, solo `GESTIONAR_CIERRE_MENSUAL_ROLES`). Es la landing
  real del panel (`/despachos/:orgSlug` redirige aquí): el cierre mensual es
  la tarea operativa más recurrente y de mayor riesgo de un despacho.
- `pages/CierreMensualDetalle.tsx` — el checklist real de un período: las 15
  tareas de la plantilla estándar (CFDI/bancos/nómina/declaraciones/
  contabilidad electrónica/reportes) con su estatus, dependencias y barra de
  avance (`GET .../periodos/:id`), completar una tarea
  (`POST .../tareas/:id/completar` — el motor `completarTarea` bloquea si
  alguna dependencia sigue sin terminar), cerrar el período
  (`POST .../cerrar`, solo `CERRAR_PERIODO_ROLES = ["admin"]` — acción
  irreversible en esta fase, sin reapertura implementada) y ver el reporte de
  cierre bajo demanda (`GET .../reporte`).
- `pages/Cfdi.tsx` — lista de CFDI ingestados (`GET .../cfdi`,
  Fase 1 ya existente) con filtro "solo con revisión humana pendiente"
  (`?requiereRevisionHumana=true`).
- `pages/CfdiDetalle.tsx` — ficha completa de un CFDI
  (`GET .../cfdi/:id`): hallazgos/advertencias del motor
  `validarCfdiDespachos()` (billing + reglas fiscales SAT avanzadas) y el
  resultado DIOT, no solo el resumen de la lista.
- `lib/*.ts` — un cliente HTTP tipado por dominio (`admin-client.ts` con los
  helpers compartidos + resolución de property, `cierre-mensual-client.ts`,
  `cfdi-client.ts`, `format.ts`), todos con `fetchImpl` inyectado (nunca
  `globalThis.fetch` directo) para poder probarlos con vitest en entorno
  "node" — mismo criterio que `licitaciones/lib/*.ts`.

**Backend nuevo que esta fase tuvo que agregar** (no existía ningún camino de
lectura para esto, no es capricho de la UI):

- `GET /v1/despachos/:orgSlug/admin/branches` (`admin.ts`, nuevo) — resuelve
  propertyId(s) desde el slug, mismo patrón que
  `GET /v1/licitaciones/:orgSlug/admin/branches`. Requirió agregar
  `findOrganizationBySlug`/`listPropertiesForOrganization` a
  `DespachosRepository` (interfaz + `InMemoryDespachosRepository` +
  `PostgresDespachosRepository`), leyendo directo de
  `core.organization`/`core.property` — mismo patrón exacto que
  `LicitacionesRepository`. Sin migración SQL nueva: esas tablas ya existían
  (`0001_core_schema.sql`).

## Explícitamente fuera de esta fase (huecos honestos, no fingidos)

- **Ingesta de CFDI (`POST .../cfdi`) sin UI.** Es un flujo server-to-server
  (PAC/timbrado real, ver `apps/api/.../despachos/cfdi.ts`) — esta fase cierra
  el gap de LECTURA (lista + ficha), que es lo que faltaba para que el staff
  pudiera siquiera VER lo que el motor ya procesó. Un formulario manual de
  ingesta (payload de más de 15 campos, conceptos como arreglo) queda fuera de
  alcance de este tramo.
- **Resolución de la cola de revisión humana.** `resolveReview`/
  `RESOLVER_REVISION_ROLES` ya existen en el dominio, pero esta fase no
  construyó la pantalla para aprobar/rechazar — `pages/Cfdi.tsx` solo señala
  qué CFDI la necesitan.
- **Actualizado, fases posteriores a la 9:** conciliación bancaria, migración
  de catálogo, devolución de IVA, nómina, bookkeeping, declaraciones,
  vencimientos, cobranza y gestión de staff ya tienen pantalla real
  (`pages/Conciliacion.tsx`, `MigracionCatalogo.tsx`, `DevolucionIva.tsx`,
  `Nomina.tsx`, `Bookkeeping.tsx`, `Declaraciones.tsx`, `Vencimientos.tsx`,
  `Cobranza.tsx`, `Staff.tsx`, además de `ContabilidadElectronica.tsx`) — esta
  lista, escrita en la Fase 9, quedó desactualizada apenas esas pantallas se
  agregaron. Esta sección se conserva como registro histórico de qué faltaba
  al cerrar la Fase 9; para el estado ACTUAL de qué pantalla existe, lee
  directamente `pages/` de esta carpeta.
- **Selector de organización con 2+.** `decideDespachosLandingPath` ya
  contempla 2+ organizaciones (`/seleccionar-organizacion`), pero esa ruta no
  existe en `App.tsx` para NINGÚN vertical de este monorepo todavía — mismo
  hueco preexistente que citas/restaurantes/licitaciones, no nuevo de esta
  fase.

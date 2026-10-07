# Vertical: restaurantes (api)

## Mapa vigente de archivos (4-oct-2026)

Las secciones de abajo cuentan cómo se fue construyendo por fases; esta tabla es la lista **actual**. Cada archivo documenta sus rutas exactas en el
comentario de cabecera. Los efectos y casos de punta a punta están en `docs/CICLO-PUNTA-A-PUNTA-RESTAURANTES.md`.

| Grupo | Archivos | Qué hacen |
|---|---|---|
| Canales públicos / de sistema (sin `authMiddleware`) | `public.ts`, `storefront.ts`, `demo-widget.ts`, `whatsapp.ts`, `voice-tools.ts`, `voice-auth.ts`, `transcripcion-voz.ts` | checkout y storefront por token de rastreo, widget demo, webhook de WhatsApp (HMAC), herramientas HTTP del agente de voz con token por llamada, notas de voz de WhatsApp |
| Efectos tras el commit | `efectos-post-commit.ts`, `email-dispatch.ts`, `softrestaurant-dispatch.ts`, `softrestaurant-wiring.ts`, `programados-interno.ts` | correo y comanda al POS del pedido recién creado, drenado de correo y de comandas, promoción de programados (crons de `vercel.json`) |
| Panel de staff (`MANAGER_ROLES` u owner/admin) | `restaurantes.ts` (agregador), `admin-scope.ts`, `admin-catalog.ts`, `admin-branches.ts`, `admin-orders.ts`, `admin-customers.ts`, `admin-promotions.ts`, `admin-staff.ts`, `admin-config.ts`, `admin-modelo-pm.ts`, `admin-avisos.ts`, `admin-onboarding.ts` (+ `onboarding-aviso.ts`, `onboarding-carga.ts`), `auditoria.ts`, `exportaciones.ts` (+ `exportar-pdf.ts`), `privacidad.ts` | catálogo, sucursales, pedidos y su máquina de estados, clientes, promociones, cuentas, configuración, avisos, checklist de onboarding, bitácora, exportaciones y derechos ARCO |
| Agente, voz y conversaciones | `conversaciones-admin.ts`, `voz-admin.ts`, `admin-voice-secret.ts`, `voz-interno.ts`, `voz-kpi.ts`, `whatsapp-kpi.ts`, `admin-data-chat.ts`, `admin-softrestaurant.ts` | bandeja de handoff (tomar, responder, devolver, cerrar), callbacks y turnos; configuración y secreto de voz por sucursal; registro de llamadas; KPI; "Chatea con tus datos"; bandeja de comandas del POS |
| Repartidor | `repartidor-orders.ts`, `repartidor-historial.ts`, `repartidor-perfil.ts`, `repartidor-licencias-interno.ts` | solo sus pedidos asignados (`en_camino`, `entregado`, `problema`), su día, su perfil y el barrido de licencias |
| Cierres y privacidad (sistema) | `cierres.ts`, `cierres-interno.ts`, `privacidad-interno.ts` | cierre del día/semana (panel y barrido), retención de datos |


Fase 1 construida: `public.ts` (`POST /v1/restaurantes/:orgSlug/orders`,
`POST /v1/restaurantes/:orgSlug/customers/lookup` — sin `authMiddleware`, canales
públicos/de sistema, ver diseño Fase 1 §3) y `whatsapp.ts`
(`GET|POST /v1/restaurantes/whatsapp/webhook`, verificación HMAC sobre bytes crudos).

**Sesión de sistema (verificado contra Postgres real, 4-oct-2026).** Estas rutas públicas corren con `withAppSession({userId: null})`. La policy de
`core.property` no contemplaba esa sesión y `findBranch()` devolvía `null`; lo corrige `packages/db/migrations/0015_core_rls_sesion_sistema.sql`. El recorrido
público completo (sucursal más cercana -> pedido idempotente) se verifica con `scripts/verify-restaurantes-sql` (24/24) y `scripts/verify-restaurantes-storefront`
(14/14), ambos en el gate de CI. Los tests de este directorio corren contra el repositorio en memoria (no aplican RLS): el SQL real lo cubren los `scripts/verify-restaurantes-*`.

Fase 3 agregó las primeras rutas de staff autenticado: `admin-kpis.ts` (dashboards de
KPIs — ver `restaurantes-admin-kpis.spec.ts`).

Fase 5 agrega el back-office CORE (CRUD real, con `authMiddleware` +
`requirePropertyMembership` + `assertVerticalRole(MANAGER_ROLES)`, mismo patrón que
`admin-kpis.ts`; desde PL-23 `admin-catalog.ts`, `admin-promotions.ts` y `admin-branches.ts` piden una **acción** de la matriz de abajo con `assertAccion`):

- `admin-catalog.ts` — categorías (`GET/POST .../admin/categories`,
  `PATCH .../admin/categories/:categoryId`) y productos (`GET/POST
  .../admin/products`, `PATCH .../admin/products/:productId`,
  `PATCH .../admin/products/:productId/branch-availability` — la única forma real de
  activar/desactivar+fijar precio de un producto EN una sucursal).
- `admin-branches.ts` — ficha de sucursal (`GET .../admin/sucursales`,
  `GET/PATCH .../admin/sucursales/:branchId`). Deliberadamente SIN crear sucursal ni
  activar/desactivarla: eso requiere escribir `core.property` (compartida por todas
  las verticales), cuyo GRANT de escritura hoy es exclusivo de `service_role` — ver
  el comentario de cabecera de ese archivo y de
  `packages/domain-restaurantes/migrations/007_admin_backoffice_grants_and_policies.sql`.
- `admin-orders.ts` — pedidos en operación + historial (mismo endpoint de listado,
  `GET .../admin/orders`, filtrable por status/sucursal/rango de fechas y paginado
  por cursor) y cambio de estado real (`PATCH
  .../admin/orders/:orderId/status`, validado por la máquina de estados de
  `@atiende/domain-restaurantes::order-lifecycle.ts`).
- `admin-customers.ts` — listado/búsqueda (`GET .../admin/customers`, con `nivel`, `frecuencia`, `inactivoDias` y `branchId` resueltos en el
  servidor por la migración 054), KPIs de cartera (`GET .../admin/customers/kpis`, teléfono del cliente más frecuente enmascarado), importación de
  cartera (`POST .../admin/customers/import/preview` no escribe; `POST .../admin/customers/import`: tope de 5,000 renglones, idempotente por la huella
  SHA-256 del archivo, bitácora, 503 honesto sin la migración 054) y ficha (`GET .../admin/customers/:customerId`, mismo shape que `lookupCustomer`
  más la nota interna).

Cuentas/accesos de staff, notificaciones, promociones/marketing, panel de
superadmin, "pregunta a tus datos" y configuración del agente de voz/WhatsApp
quedan explícitamente fuera de esta fase — ver el brief de Fase 5.

Fase 8 agrega la superficie real del rol `repartidor` (ver
`domain-restaurantes/src/roles.ts::REPARTIDOR_ROLES` — hasta esta fase el rol
existía en el enum pero `assertVerticalRole(MANAGER_ROLES)` lo excluía de TODA
ruta de este vertical por diseño, sin ninguna alternativa):

- `repartidor-orders.ts` — acotado a SUS PROPIOS pedidos asignados, nunca
  gestión: `GET .../repartidor/orders` (lista, sin paginación — ver comentario
  de `listOrdersForRepartidor`), `GET .../repartidor/orders/:orderId` (ficha,
  404 uniforme si el pedido no existe o no es suyo — nunca distingue ambos
  casos), `PATCH .../repartidor/orders/:orderId/status` (solo
  en_camino/entregado/problema, vía
  `@atiende/domain-restaurantes::order-lifecycle.ts::changeAssignedOrderStatus`
  — `incidentNote` obligatorio si y solo si el nuevo estado es "problema").
  Usa `assertVerticalRole(c, REPARTIDOR_ROLES)`, nunca `MANAGER_ROLES`.
- `admin-orders.ts` — se agrega `PATCH
  .../admin/orders/:orderId/assign-repartidor` (MANAGER_ROLES): el ÚNICO
  lugar que despacha un pedido (escribe `assigned_repartidor_id`/
  `estimated_delivery_at`), validando que `repartidorId` sea staff real de
  esta organización con `verticalRole === "repartidor"` antes de escribir.
  `serializeOrder` ahora también expone `assignedRepartidorId`/
  `estimatedDeliveryAt`/`incidentNote` en las vistas de operación/historial
  existentes.

Pendiente, fuera de alcance de esta fase (documentado, no fingido): alta de
cuentas de repartidor (el origen lo resuelve con la Edge Function
`crear-repartidor` + `repartidor_perfil` — fusion no tiene TODAVÍA un mecanismo
genérico de invitación/alta de staff para NINGÚN rol de NINGUNA vertical, no es
un hueco específico de restaurantes) y el panel visual completo del origen
(RepartidorDashboard.tsx: stats del día, perfil con datos operativos del
repartidor, centro de ayuda, nav móvil) — `apps/web` sí agrega una página
mínima y real (`RepartidorPedidosPage`, ver `apps/web/src/verticals/
restaurantes/README.md` si existe o `pages/Repartidor.tsx`) para no dejar el
endpoint sin ningún consumidor de UI, pero no reconstruye esa riqueza visual.

Fase 12 — hallazgo de auditoría (severidad ALTA, "asignar repartidor a un pedido
no tiene UI: el panel de repartidor siempre estará vacío"): `assign-repartidor`
(Fase 8) era el ÚNICO lugar que despacha un pedido, pero no existía ni un
endpoint para listar QUÉ staff tiene `verticalRole === "repartidor"` ni un
selector real en `Pedidos.tsx` que lo consumiera. Se agrega:

- `admin-staff.ts` — `GET .../admin/staff/repartidores` (`MANAGER_ROLES`, no
  `STAFF_INVITE_ROLES`: un manager "staff" despacha pedidos día a día y
  necesita este selector aunque no pueda invitar). Lista miembros YA
  ACEPTADOS (`core.membership`) con `verticalRole === "repartidor"` — nunca
  invitaciones pendientes, que `GET .../admin/staff/invitaciones` ya cubre.
- Gap real de RLS descubierto y corregido de paso (verificado contra Postgres,
  nunca contra los tests que usan el repo en memoria sin RLS): la validación
  de `assign-repartidor` corría en la sesión de SISTEMA de `coreRepo`
  (`auth.uid()` siempre null), contra una tabla cuya policy de SELECT exige
  `user_id = auth.uid()` — esa validación era SIEMPRE falsa en producción
  real, así que el dispatch nunca lograba completarse. Ambos endpoints ahora
  comparten `deps.coreStaffRepo(c.get("db")).listMembersByVerticalRole(...)`
  (sesión REAL por-request) sobre la función `security definer`
  `core.list_org_members_by_vertical_role` (ver
  `packages/db/migrations/0004_list_org_members_by_vertical_role.sql`).
- `apps/web` — `Pedidos.tsx` agrega un `<select>` real por pedido (dispara el
  PATCH en cuanto se elige un repartidor) alimentado por
  `lib/staff-client.ts::fetchRepartidores` — sin endpoint de "desasignar" en
  el backend, elegir "Sin asignar" es deliberadamente un no-op.

FASE 3 (producto) — bitácora de auditoría del staff (copiada del patrón ya en
`main` para rentas, `021_rentas_audit_log.sql`/`022_..._orden_determinista.sql`,
PR #165/#173 — ver `packages/domain-restaurantes/migrations/
019_restaurantes_audit_log.sql` para el diseño completo, incluida la validación
de rol que rentas dejó pendiente):

- `auditoria.ts` — `GET .../admin/auditoria` (paginado, filtro `tipo`/`desde`/
  `hasta`), solo `owner`/`admin` de la organización (más estricto que
  `MANAGER_ROLES`: un `staff` real SÍ puede escribir en la bitácora vía las
  rutas de abajo, pero no leerla).
- Instrumentado (`registrarAuditoria`, best-effort, nunca revierte la acción de
  negocio si la bitácora falla — ver el SAVEPOINT en
  `PostgresRestaurantesRepository.registrarAuditoria`): `admin-catalog.ts`
  (precio/disponibilidad de producto, `entityType="producto"`),
  `admin-promotions.ts` (alta/cambio/activación/baja, `entityType="promocion"`),
  `admin-orders.ts` (cancelación de pedido `entityType="pedido"`; asignación/
  reasignación de repartidor `entityType="repartidor"`), `admin-staff.ts`
  (invitación/revocación/cambio de rol/**baja de un staff ya aceptado**,
  `entityType="staff"`), `admin-config.ts` (**configuración de WhatsApp/zonas
  conocidas**, `entityType="configuracion"` — nuevo, ver abajo).

FASE 3 (producto) — cierre de 2 de los 3 huecos que la ronda anterior dejaba
documentados aquí mismo:

- **Baja de staff ya aceptado**: `admin-staff.ts::DELETE .../admin/staff/
  miembros/:userId`, mismo umbral que el `PATCH` de cambio de rol
  (`STAFF_INVITE_ROLES` + jerarquía real de `canInviteStaff`). Autoridad real
  en `core.remove_membership` (`security definer`, genérico de `core` — ver
  `packages/db/migrations/0024_remove_membership.sql`): bloquea auto-baja
  SIEMPRE, y el caso límite "no dejar la organización sin ningún owner"
  (demostrado por exhaustividad en
  `scripts/verify-restaurantes-config-staff-baja/README.md` — con la
  combinación "nunca auto-baja" + "solo un owner toca a otro owner", esa
  invariante se sostiene incluso sin necesitar disparar jamás el chequeo
  explícito de conteo).
- **Configuración de WhatsApp/zonas conocidas editable**: `admin-config.ts`
  (nuevo) — `GET`/`PUT .../admin/config/whatsapp` (conecta/rota el
  `phone_number_id`) y `GET`/`POST`/`DELETE .../admin/config/zonas` (alta/baja
  de zonas conocidas para `nearest_branch_by_colonia`). Ambas tablas
  (`restaurantes.whatsapp_channel_config`/`restaurantes.known_zone`) YA
  EXISTÍAN desde Fase 1/2 sin ninguna ruta de escritura — ver
  `packages/domain-restaurantes/migrations/
  021_restaurantes_config_editable_y_search_path_fix.sql`. Solo owner/admin
  (`STAFF_INVITE_ROLES`), tanto en la policy RLS (SQL, autoridad real) como en
  `assertVerticalRole` (TS, defensa en profundidad) — deliberadamente MÁS
  angosto que `MANAGER_ROLES`.
- Hueco conocido que SIGUE abierto (deliberado, no inventado sin dirección de
  producto): horarios de atención editables — hoy NO existe ninguna
  tabla/columna de horarios en el schema base de restaurantes (verificado
  antes de escribir la migración de esta fase). Construirlo exige una decisión
  de producto real (¿por organización o por sucursal? ¿excepciones, como
  `citas`?) fuera del alcance de "conectar lo ya construido" de esta fase.
  Configuración de voz tampoco tiene tabla (a diferencia de hoteles/citas),
  mismo criterio.

## Voz propia (migración 025)

- `voz-admin.ts` (panel, owner/admin, por sucursal `:propertyId`): `GET .../admin/voz/catalogo`,
  `GET|PUT .../admin/voz/config`, `POST .../admin/voz/preview/sesion`,
  `GET .../admin/voz/conversaciones[/:id]`. Base sin migrar: lecturas -> `disponible: false`,
  escrituras y preview -> 503. Sin `GEMINI_API_KEY` / `VOICE_PREVIEW_TOKEN_SECRET`: 503 "voz no
  configurada", nunca un falso éxito.
- `voz-interno.ts` (sistema, header `x-atiende-internal-secret`): `POST /internal/restaurantes/voz/
  conversaciones[/:id/turnos|/:id/cerrar]` y `.../previews/consumir`. Lo consumirá el servicio de
  voz (otra tarea); escribe por funciones SQL de solo-sistema.
- Contrato `VoiceAgentProvider` (emitirSesionPreview / catalogoVoces / salud) en
  `packages/domain-restaurantes/src/voz/`: adaptador Gemini 3.8 Live y adaptador falso.

## Privacidad (PM PR-9, migración 030)

- `privacidad.ts` -- panel (owner/admin, sobre `:propertyId`): `GET .../admin/privacidad/solicitudes`,
  `GET .../solicitudes/:id/eventos`, `PATCH .../solicitudes/:id/estado`, `GET|PUT .../admin/privacidad/configuracion`.
- `privacidad-interno.ts` -- lado sistema (secreto interno): `GET|POST /internal/restaurantes/privacidad-retencion`
  (purga por retención; NO está en `vercel.json`, programarlo es una decisión de despliegue),
  `POST /internal/restaurantes/voz/privacidad/apertura`, `.../voz/conversaciones/:id/consentimiento-grabacion`,
  `POST /internal/restaurantes/voz/arco`.
- Base sin migrar: lecturas con `disponible:false`, escrituras 503; nunca 500.

## Pedidos programados (R-11, migración 034)

- Alta: `POST /v1/restaurantes/:orgSlug/orders` acepta `programado_para` (ISO 8601 CON zona). El pedido nace en
  estado `programado` (fuera de cocina y sin comanda al POS; los KPIs de la 006 no filtran por estado, así que el pedido cuenta en ingresos y conteo desde su creación, como cualquier pedido, incluidos los cancelados). Se rechaza (400) una hora sin zona, a
  menos de 30 minutos, a más de 7 días o fuera del horario de la sucursal evaluado en SU zona horaria
  (incluye cruces de medianoche y puentes). Contra la base sin migrar responde 503 y no crea nada.
- Panel (owner/admin): `GET .../admin/scheduled-orders` (pestaña Programados) y `GET .../admin/orders`
  (sin filtro de estado, `pending` o `programado`) PROMUEVEN a `pending` los programados cuya hora cae dentro
  de la anticipación (30 min) o ya pasó. Idempotente; un pedido cancelado nunca se promueve. Un fallo al
  promover se registra y no rompe el listado. Base sin migrar: `disponible:false` y lista vacía.
- Interno: `GET|POST /internal/restaurantes/promover-programados` (secreto interno o `Authorization: Bearer
  <CRON_SECRET>`) barre TODAS las organizaciones (cron `*/5 * * * *` de `vercel.json`, ver docs/CRONS.md). R-16: en el mismo tick,
  como unidad independiente, barre las alertas `restaurantes.pedido.entrega_tardia` y
  `restaurantes.pedido.programado_por_vencer`. Respuesta: `{ ok, status: "ok" | "not_available", promoted, orderIds,
  comandas, avisosCocina, avisos: { disponible, candidatos, emitidas, sinNuevas, errores } }` (`avisosCocina` = avisos de programados que entraron a cocina).
- R-16 (migración 043), `admin-avisos.ts`: `GET .../admin/avisos` (Mis avisos; owner/admin ven además la matriz del equipo
  y los umbrales), `PUT .../admin/avisos/preferencias` (propia, u owner/admin la de su equipo, con bitácora) y
  `PUT .../admin/avisos/umbral` (owner/admin, minutos de gracia de la entrega tardía por sucursal, 10 a 240).
- Al promover (cron y panel): se encola la comanda al POS con su hora, **propina y canal** (R-29, `encolarComandasDePromovidos`) y se avisa al staff
  (`avisarProgramadosPromovidos`): bandeja `order.programado_promovido` y campana `restaurantes.pedido.programado_en_cocina`, un aviso por pedido, sin
  PII en la campana. Ambos van en su propia sesión de sistema tras el commit de la promoción y nunca la revierten. Un pedido programado **no** encola
  comanda al crearse por ningún canal (`encolarComandaParaPedido` lo omite).
- Los agentes de WhatsApp y voz también pueden programar: `cotizar_pedido`/`crear_pedido` aceptan `programado_para` (mismas reglas; ver
  `docs/restaurantes/agente-system-prompt.md`).

## Consentimiento del aviso de privacidad del checkout (migración 063)

`POST /v1/restaurantes/:orgSlug/storefront/:sucursal/orders` exige `acepta_aviso_privacidad: true` (400 `aviso_privacidad_requerido` si falta, antes de
tocar la base) y, creado el pedido, guarda la evidencia con `PrivacidadRepository.recordOrderPrivacyConsent` (versión del aviso vigente que decide la base, fecha,
canal `web`; sin teléfono ni nombre) en `restaurantes.order_privacy_consent` (la ven owner y admin). Best-effort con SAVEPOINT: base sin la 063 el pedido se
crea igual; un fallo real se registra y no tumba un pedido ya creado. SQL verificado en `scripts/verify-restaurantes-consentimiento-aviso/`.

## Cierre del día y resumen semanal (R-42, migración 041)

- Panel (owner/admin, `cierres.ts`): `GET /v1/restaurantes/:propertyId/admin/cierres?tipo=dia|semana&limite=N` devuelve los cierres ya
  generados y los periodos terminados que aún no tienen cierre (`pendientes`); `POST .../admin/cierres/generar` `{ tipo, fecha }` genera el
  de un periodo TERMINADO (dia = día calendario en la zona horaria de la sucursal; semana = lunes a domingo, se manda el lunes). Hoy y la
  semana en curso se rechazan (400). Idempotente por fecha de negocio: repetir devuelve el mismo cierre (`estado: "existente"`, 200); uno
  nuevo es 201, deja rastro en la bitácora (`cierre.dia_generado` / `cierre.semana_generada`) y avisa en la campana
  (`restaurantes.cierre.dia_listo` / `semana_lista`, sin PII). Un cierre generado NO se recalcula.
- Interno (`cierres-interno.ts`): `GET|POST /internal/restaurantes/cierres-dia?dias=N` (1..14, por defecto 3; secreto interno o
  `Authorization: Bearer <CRON_SECRET>`) asegura el cierre de los últimos N días cerrados (y, por cada domingo cerrado, la semana) de TODAS las
  sucursales de organizaciones reales; omite los periodos sin pedidos; una transacción por sucursal (una que falle se reporta en `fallos` y no frena
  a las demás). NO está en `vercel.json` (decisión de costo: sin crons nuevos): agendarlo es una decisión de despliegue; mientras tanto el
  botón del panel genera los cierres. Respuesta: `{ ok, status: "ok" | "not_available", sucursales, creados, existentes, sinActividad, avisos, fallos }`.
- Base sin migrar: la lectura responde `disponible: false` con listas vacías, la escritura 503 y el barrido `not_available` (SAVEPOINT en el
  repositorio; `packages/domain-restaurantes/tests/cierres-savepoint.spec.ts`). SQL y permisos verificados contra Postgres real en
  `scripts/verify-restaurantes-cierre-dia/`. Pruebas HTTP: `apps/api/tests/restaurantes-cierres.spec.ts`.

## Cliente 360 (migración 049)

- Panel (`admin-customers.ts`, MANAGER_ROLES salvo lo marcado; todas las escrituras dejan huella en la bitácora sin PII):
  `GET .../admin/customers/:id/ficha`, `PATCH .../admin/customers/:id` (nombre, notas, cumpleaños día+mes),
  `POST|PATCH|DELETE .../admin/customers/:id/addresses[/:addressId]`, `POST .../admin/customers/:id/preferences` (`accion`: agregar, descartar,
  reactivar, eliminar), `POST .../admin/customers/:id/orders/:orderId/falso`, `GET .../admin/customers/policy` y `PUT` (solo owner/admin),
  `GET .../admin/customers/:id/arco-export` y `POST .../borrar-memoria` (solo owner/admin). Cada función SQL vuelve a validar rol y organización;
  un id de otra organización responde 404. Base sin migrar: 503 "no disponible aún".
- Voz (`voice-tools.ts`, exigen token de llamada: el teléfono sale del token): `POST /v1/restaurantes/:orgSlug/customers/orders`
  (`historial_pedidos`) y `POST .../orders/repeat` (`repetir_pedido`).
- Pruebas: `apps/api/tests/restaurantes-admin-ficha-cliente.spec.ts`.

## Perfil operativo del repartidor (R-15, migración 044)

- Propio (`repartidor-perfil.ts`, solo rol `repartidor`): `GET|PUT /v1/restaurantes/:propertyId/repartidor/perfil` lee y corrige SU perfil
  (tipo de vehículo, placas, disponibilidad, turno, licencia con vigencia y contacto de emergencia nombre + teléfono). PUT es reemplazo completo;
  el teléfono se valida con `phone.ts` y se guarda en 10 dígitos. La respuesta trae `licenciaEstado` (`sin_licencia | vigente | por_vencer | vencida`)
  y `licenciaDias`, calculados con la fecha de hoy en la zona de la sucursal (alerta visual con menos de 30 días).
- Gestión (solo owner/admin): `GET|PUT|DELETE /v1/restaurantes/:propertyId/admin/staff/:userId/perfil-repartidor`. El objetivo debe ser repartidor de
  la misma organización (404 uniforme si no). DELETE es el derecho de cancelación (ARCO): borra el perfil operativo y el personal. El staff de piso no
  tiene acceso a ninguna de las dos rutas (ni licencia ni contacto de emergencia). La bitácora (`repartidor.perfil_actualizado` / `perfil_suprimido`)
  guarda QUÉ campos cambiaron, nunca los valores; la corrección del propio repartidor solo se registra en el log de la API.
- Aviso a la campana de owner/admin (sin PII, dedupe mensual por repartidor): `restaurantes.repartidor.licencia_por_vencer` / `licencia_vencida`, al guardar
  un perfil con licencia a menos de 30 días y en `GET|POST /internal/restaurantes/repartidor-licencias` (secreto interno o `Bearer <CRON_SECRET>`, una
  transacción por repartidor). Agendado en `vercel.json` (diario, 13:35 UTC), con latido y kill switch; el de cierres corre a diario a las 08:20 UTC (02:20 en Mérida).
- Base sin migrar: `disponible: false` en la lectura, 503 honesto en la escritura y `status: "not_available"` en el barrido (SAVEPOINT en el repositorio;
  `packages/domain-restaurantes/tests/repartidor-perfil.spec.ts`). SQL y permisos en `scripts/verify-restaurantes-repartidor-perfil/`. Pruebas HTTP:
  `apps/api/tests/restaurantes-repartidor-perfil.spec.ts`.

## Exportar Historial y Clientes (R-17)

- `exportaciones.ts` (solo owner/admin: el archivo lleva teléfonos COMPLETOS de clientes, más angosto que las pantallas, que son de `MANAGER_ROLES`):
  `GET /v1/restaurantes/:propertyId/admin/exportar/historial?formato=csv|pdf&status=&dateFrom=&dateTo=&branchId=` y
  `GET .../admin/exportar/clientes?formato=csv|pdf&search=`. Se generan en el servidor con la sesión RLS del propio usuario (mismo `listOrders` / `listCustomers`
  de las pantallas, paginando de 500 en 500). Tope de filas: 20 000 en CSV y 2 000 en PDF; pasado el tope responde 413 pidiendo acotar el rango (nunca un
  archivo truncado en silencio). Sin streaming: la sesión de base de datos es la del request y se cierra al responder.
- CSV (Excel): UTF-8 con BOM, separador coma, CRLF, fechas `AAAA-MM-DD HH:mm` en la zona horaria de CADA sucursal, dinero con dos decimales sin símbolo ni miles, y las
  celdas de texto que empiezan con `=`, `+`, `-`, `@`, tabulador o retorno de carro llevan un apóstrofo delante (los nombres los escribe un tercero: defensa contra
  inyección de fórmulas). No hay dependencia `xlsx` en el repo (no se agregó ninguna): el CSV con BOM abre directo en Excel.
- PDF (`exportar-pdf.ts`, pdf-lib): A4 horizontal, encabezado repetido en cada hoja y pie en CADA página con fecha de generación, zona horaria, alcance y "Página i de n".
  No reutiliza `despachos/reporte-pdf.ts` porque ese está atado al modelo de reporte fiscal (contribuyente/RFC).
- Bitácora (tipo `exportacion`, migración 044 amplía el CHECK de `audit_log.entity_type`): `historial.exportado` / `clientes.exportado` con formato y número de filas,
  nunca nombres, teléfonos ni el texto de búsqueda. Contra una base sin la 044 la fila de bitácora se omite (con aviso en el log) y la exportación funciona igual.
- PII: teléfonos completos solo para owner/admin; el staff de piso y el repartidor reciben 403.
- Autopiloto (`autopiloto.ts`, migración 050; staff con alcance a la sucursal): `GET .../admin/autopiloto/solicitudes?estado=pendiente|resuelta` (aprobaciones «Por aprobar»),
  `POST .../admin/autopiloto/solicitudes/:id/resolver` `{ decision, motivo?, valor?, indices? }` (aprobar/rechazar/cancelar/mantener/compensar con un clic; idempotente; 400 motivo fuera de la lista
  cerrada; 403 sin alcance; 503 base sin migrar), `GET|PUT .../admin/autopiloto/config` (PUT solo owner/admin), `POST .../admin/autopiloto/agotado` (agotado hasta mañana),
  `GET .../admin/autopiloto/tiempo?canal=` (tiempo prometido hoy) y `GET .../admin/autopiloto/pedidos/:orderId/historial`. `PATCH .../admin/orders/:id/status` exige `motivo` (lista cerrada) al cancelar
  y rechaza mover un pedido `por_aprobar` (409). El tick `autopiloto-tick.ts` corre dentro de `/internal/restaurantes/promover-programados`.

## Permisos por acción (PL-23)

Fuente única: `ACCIONES_RESTAURANTES` en `packages/domain-restaurantes/src/roles.ts`; las rutas la aplican con `assertAccion` (`permisos-accion.ts`).
Una acción fuera de la matriz se niega a todos y `restaurantes-permisos-accion-guard.spec.ts` impide listas sueltas de roles en estas rutas.

| Acción | Ruta | owner | admin | staff | repartidor |
|---|---|---|---|---|---|
| `catalogo.ver` | `GET .../admin/categories`, `GET .../admin/products` | sí | sí | sí | no |
| `catalogo.disponibilidad` | `PATCH .../admin/products/:id/branch-availability` con solo `isAvailable` (fila ya dada de alta) | sí | sí | sí | no |
| `catalogo.precio` | `POST/PATCH .../admin/categories`, `POST/PATCH .../admin/products`, `branch-availability` con `price` o para dar de alta | sí | sí | no | no |
| `promociones.ver` / `promociones.editar` | `GET/POST/PATCH .../admin/promotions` | sí | sí | no | no |
| `sucursal.ver` | `GET .../admin/sucursales[/:id]` | sí | sí | sí | no |
| `sucursal.editar` | `PATCH .../admin/sucursales/:id` | sí | sí | no | no |
| `pedidos.gestionar` | sin cambio (`MANAGER_ROLES` en `admin-orders.ts`) | sí | sí | sí | no |

Defensa en profundidad en la base: migración `065_permisos_por_accion_escritura.sql` (verify: `scripts/verify-restaurantes-permisos-accion`).

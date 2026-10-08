# Vertical: rentas (api)

Ya NO es una carpeta reservada — este README decía "Aún no portado", lo cual
dejó de ser cierto hace muchas fases (nunca se actualizó tras el port inicial).
23 archivos de rutas HTTP reales sobre `PostgresRentasRepository`/
`@atiende/domain-rentas`, cubriendo: reservas (`reservas.ts`), bloqueos de
calendario (`bloqueos.ts`, `calendario.ts`), cotizaciones (`cotizaciones.ts`),
sincronización iCal con Airbnb/Booking/VRBO (`ical-sync.ts`,
`ical-sync-cron.ts`, `ical-feed-publico.ts`), pricing (`pricing-config.ts`),
finanzas y payouts a propietario (`finanzas.ts`, `finanzas-payouts.ts`,
`finanzas-statements.ts`), limpieza/mantenimiento (`limpieza.ts`), mensajería
con huésped con aprobación humana (`mensajeria-borradores.ts`,
`mensajeria-conversaciones.ts`, `mensajeria-plantillas.ts`,
`mensajeria-politicas.ts` — ver `packages/domain-rentas/src/mensajeria/` para
el límite real: sin cliente HTTP de partner todavía, ver
`docs/CREDENCIALES.md`), onboarding self-service
(`onboarding.ts`), portal de propietario (`owner-portal.ts`,
`owner-portal-invite.ts`), recordatorios de check-in/check-out
(`checkin-recordatorio.ts`, `checkout-sweep-cron.ts`), dispatcher de correo
(`email-dispatch.ts`), bitácora de auditoría del staff (`auditoria.ts`) y
resolución de organización/property (`admin-discovery.ts`, `rentas.ts`). El
break-glass de superadmin sobre datos de rentas (solo lectura) vive fuera de
esta carpeta, en `apps/api/src/routes/superadmin-break-glass.ts` — ver
`packages/domain-rentas/src/break-glass/`.

Ver `packages/domain-rentas/README.md` para el detalle de dominio, fase por
fase.

f3-rentas-bitacora-y-guards — bitácora de auditoría, cobertura completada (ver
`packages/domain-rentas/migrations/023_rentas_audit_log_cobertura_completa.sql`
para el diseño SQL completo): las 4 acciones sensibles que
`021_rentas_audit_log.sql` dejó documentadas como pendientes ahora se
registran —

- `finanzas.ts` — movimiento financiero de una reserva (cargo/abono/ajuste),
  `entityType="reserva"` (misma entidad que reserva.creada/modificada/
  cancelada de `reservas.ts`).
- `bloqueos.ts` — cancelar un bloqueo de disponibilidad, `entityType="bloqueo"`
  (nuevo en el catálogo).
- `owner-portal-invite.ts` — alta de acceso de un propietario
  (owner_credential), `entityType="owner_credential"` (nuevo en el catálogo).
- Cambios de membership/rol de staff en rentas — SIGUE fuera de cobertura:
  verificado contra el código real antes de tocar nada (no asumido), rentas
  TODAVÍA no tiene ninguna ruta de gestión de membership/rol de staff (a
  diferencia de citas/despachos/hoteles/licitaciones/restaurantes, cada una
  con su propio `admin-staff.ts`). `entity_type="membership"` sigue reservado
  en el catálogo sin caller. Construir esa ruta desde cero sería un rediseño
  de producto ajeno al alcance de esta tarea (bitácora + guards) — queda como
  hueco conocido.

Además, `rentas.record_audit_log` ahora valida el `vertical_role` del actor
(hallazgo de revisión de 021, "no bloqueante #9") — mismo patrón que
`restaurantes.record_audit_log` (PR #183) — ver el comentario de cabecera de
`023_rentas_audit_log_cobertura_completa.sql` para el cálculo completo del
techo mínimo de roles.

## Sync iCal por lote y monitor de conflictos (Rn-01)

- `ical-sync-cron.ts` ya no barre "todos los feeds activos" sin coordinación: usa
  `ejecutarLoteSync` (`@atiende/domain-rentas`, `src/sync/lote.ts`) con claim/lease por feed,
  backoff por feed fallido y bitácora de eventos notables. Contra una base sin la migración
  024 cae al barrido anterior (`modo: "sin_lease"`). Cadencia propuesta (15 min) y su impacto
  en el plan de Vercel: `docs/DEPLOY.md`.
- `ical-monitor.ts`: `GET /rentas/:propertyId/sync-monitor`, `GET .../conflictos`,
  `POST .../conflictos/:id/resolver`, `POST .../sync-alertas/:id/atender`.

### Estado de los conflictos y resolución segura (Rn-02, migración 026)

- Un conflicto está `abierto`, `resuelto` o `ignorado` (con motivo). `GET .../conflictos?estado=`
  acepta `abiertos|resueltos|ignorados|todos`; `GET .../conflictos/:id/historial` devuelve la
  bitácora de decisiones.
- `POST .../conflictos/:id/resolver` recibe `{ accion: "resuelto" | "ignorado", motivo? }` (cuerpo
  vacío = `resuelto`). `resuelto` se rechaza con 409 mientras las dos ocupaciones sigan cruzadas
  (la base lo verifica); `ignorado` exige motivo de 3 a 500 caracteres. Nunca cancela ni edita una
  reserva.
- `sync-monitor` suma `resumen_por_canal` y `zona_horaria`; los conflictos traen el solape y su
  vigencia calculada con "hoy" en la zona de la property (`rentas.property_config.zona_horaria`).
- Contra la base sin la 026: `resuelto` sigue por el camino de la 024, `ignorado` responde 409 y el
  historial `disponible: false`; nunca 500.

## Reportes de ocupación e ingresos (Rn-03)

- `reportes.ts`: `GET /rentas/:propertyId/reportes/ocupacion-ingresos` (`?desde&hasta` periodo
  `[desde, hasta)` o mes en curso en la zona de la property, `&agrupar=unidad|propietario|canal|mes`,
  `&formato=json|csv|pdf`, filtros `unidad_id`/`propietario_id`/`canal`). Roles
  `FINANZAS_LECTURA_ROLES` (admin_gestora, contador). Solo lectura sobre tablas de 001/003: no
  requiere migración. Cálculo y anti doble conteo en `@atiende/domain-rentas` (`src/reportes/`).
- `resumen.ts`: `GET /rentas/:propertyId/resumen` (Rn-26, Resumen operativo). Agregados reales sin PII (llegadas/salidas de hoy en la zona de
  la property, ocupación del mes vía el reporte de Rn-03, conflictos abiertos, tareas pendientes/vencidas, borradores por aprobar, feeds con
  problema) más la última corrida de los agentes con fuente real por propiedad. Cada bloque degrada solo (`no_disponible`) bajo SAVEPOINT y
  se oculta (`sin_permiso`) según el rol; `limpieza` recibe 403. No requiere migración. Lecturas en `@atiende/domain-rentas` (`src/resumen/`).

## Acceso al huésped (Rn-04) y confirmar bloqueo (Rn-05)

- `acceso-huesped.ts`: política por property, instrucciones por unidad (el secreto, con
  `Cache-Control: no-store`), pago confirmado por reserva y bitácora (roles `ACCESO_HUESPED_ROLES`),
  más el cron `GET|POST /internal/rentas/acceso-huesped` (migración 025; cada hora en `vercel.json`, ver `docs/CRONS.md`). Contra la base sin migrar responde `disponible: false`/409 y el cron `ok`
  sin hacer nada.
- `precheckin-publico.ts` (Rn-P3-08, migración 036): pre-check-in PÚBLICO del huésped, sin sesión: `GET /rentas/precheckin/:propertyId`,
  `POST .../verificar` (código de confirmación + últimos 4 dígitos del teléfono) y `POST .../capturar` (correo, WhatsApp opcional, aviso de
  privacidad y reglamento). Montado antes de las rutas de staff `/rentas/:propertyId/...` (misma forma de ruta). Rate limit por IP y property,
  mismo resultado exista o no la reserva, piso de tiempo, bloqueo de 1 h tras 5 fallos por código, token de un solo uso, `no-store` y nada de PII en
  logs. Los endpoints de staff viven en `acceso-huesped.ts`: `GET|PUT .../acceso-huesped/precheckin` (enlace fijo, texto sugerido y reglamento),
  `GET .../acceso-huesped/pendientes` (Rn-P3-09: accesos omitidos por falta de correo), `GET .../reservas/:id/acceso-mensaje` (mensaje con las
  instrucciones descifradas, bitácora `lectura_admin`) y `POST .../reservas/:id/entrega-manual` (`entregada_manual`).
- `limpieza.ts`: `POST .../unidades/:unidadId/incidencias/:incidenciaId/confirmar-bloqueo` confirma el
  bloqueo de mantenimiento de una incidencia grave (solo roles de gestión; nunca cancela reservas).


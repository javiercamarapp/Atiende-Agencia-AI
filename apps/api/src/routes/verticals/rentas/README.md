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

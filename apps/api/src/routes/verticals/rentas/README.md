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
(`email-dispatch.ts`) y resolución de organización/property
(`admin-discovery.ts`, `rentas.ts`). El break-glass de superadmin sobre datos
de rentas (solo lectura) vive fuera de esta carpeta, en
`apps/api/src/routes/superadmin-break-glass.ts` — ver
`packages/domain-rentas/src/break-glass/`.

Ver `packages/domain-rentas/README.md` para el detalle de dominio, fase por
fase.

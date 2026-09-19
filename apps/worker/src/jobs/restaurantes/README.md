# Vertical: restaurantes (worker)

Sin código propio en `apps/worker` — mismo patrón que `citas`/`rentas` (ver
sus READMEs): la lógica real vive en `packages/domain-restaurantes` y se
expone vía rutas de `apps/api`, no como job de `apps/worker`. Esto NO significa
"sin construir" — el envío real de WhatsApp de restaurantes ya existe y está
conectado: `packages/domain-restaurantes/src/order-notifications.ts` encola
notificaciones reales de cambio de estado de pedido en
`restaurantes.messaging_outbox`, y `apps/api/src/routes/internal/
whatsapp-dispatch.ts` (compartido con citas/hoteles) drena ese outbox vía Meta
Graph API real, con disparo inline best-effort desde el propio webhook de
WhatsApp además del cron diario de `vercel.json`.

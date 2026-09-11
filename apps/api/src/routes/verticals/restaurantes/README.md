# Vertical: restaurantes (api)

Fase 1 construida: `public.ts` (`POST /v1/restaurantes/:orgSlug/orders`,
`POST /v1/restaurantes/:orgSlug/customers/lookup` — sin `authMiddleware`, canales
públicos/de sistema, ver diseño Fase 1 §3) y `whatsapp.ts`
(`GET|POST /v1/restaurantes/whatsapp/webhook`, verificación HMAC sobre bytes crudos).

`admin.ts` (catálogo/branches/orders/customers desde el panel, CON `authMiddleware` +
`requirePropertyMembership`) queda reservado para Fase 2+ — no era una de las 3 rutas
críticas de esta fase.

// Port literal de las clases de error de
// restaurantes/supabase/functions/_shared/create-order-core.ts — mismo vocabulario,
// para que las rutas Hono de apps/api mapeen exactamente los mismos códigos HTTP que
// el origen (400 validación, 409 conflicto de idempotencia).
export class OrderValidationError extends Error {}
export class OrderConflictError extends OrderValidationError {}

// Fase 11 — subclase de OrderValidationError (nunca una clase de error separada) a
// propósito: así el mismo `catch (err instanceof OrderValidationError)` que ya
// traduce a HTTP 400 en public.ts/admin-orders.ts atrapa también un código de
// promoción inválido/no vigente sin tocar ninguna ruta HTTP existente.
export class PromotionError extends OrderValidationError {}

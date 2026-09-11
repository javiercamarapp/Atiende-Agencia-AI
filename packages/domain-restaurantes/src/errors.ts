// Port literal de las clases de error de
// restaurantes/supabase/functions/_shared/create-order-core.ts — mismo vocabulario,
// para que las rutas Hono de apps/api mapeen exactamente los mismos códigos HTTP que
// el origen (400 validación, 409 conflicto de idempotencia).
export class OrderValidationError extends Error {}
export class OrderConflictError extends OrderValidationError {}

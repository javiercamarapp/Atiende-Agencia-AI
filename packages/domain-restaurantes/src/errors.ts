// Port literal de las clases de error de
// restaurantes/supabase/functions/_shared/create-order-core.ts — mismo vocabulario,
// para que las rutas Hono de apps/api mapeen exactamente los mismos códigos HTTP que
// el origen (400 validación, 409 conflicto de idempotencia).
export class OrderValidationError extends Error {}
export class OrderConflictError extends OrderValidationError {}

/** Guardas SQL de negocio conocidas de la creacion de pedidos que levantan 22023 con un mensaje pensado para el agente/cliente. LISTA CERRADA: cualquier otro 22023 (un
 * error interno de Postgres, una funcion que no es esta) sigue siendo error interno. Hoy: 034_pedidos_programados ("programado_para debe ser una hora futura"). */
const GUARDAS_SQL_22023_DE_PEDIDO: readonly RegExp[] = [/^programado_para debe ser una hora futura\b/];
export function esGuardaSqlDeNegocioDePedido(err: unknown): err is Error {
  if (err instanceof OrderValidationError || !(err instanceof Error)) return false;
  if ((err as { code?: unknown }).code !== "22023") return false;
  const mensaje = err.message.trim();
  return GUARDAS_SQL_22023_DE_PEDIDO.some((re) => re.test(mensaje));
}

// Fase 11 — subclase de OrderValidationError (nunca una clase de error separada) a
// propósito: así el mismo `catch (err instanceof OrderValidationError)` que ya
// traduce a HTTP 400 en public.ts/admin-orders.ts atrapa también un código de
// promoción inválido/no vigente sin tocar ninguna ruta HTTP existente.
export class PromotionError extends OrderValidationError {}

/** El `phone_number_id` de WhatsApp que se intenta conectar ya rutea a otra sucursal u otra
 * organizacion (migracion 023: PRIMARY KEY + guardia de unicidad cruzada). Subclase de
 * OrderValidationError para que las rutas lo traduzcan como conflicto sin inventar otro
 * mecanismo. */
export class WhatsappNumberInUseError extends OrderValidationError {
  constructor() {
    super("Ese número de WhatsApp ya está conectado a otra sucursal u organización.");
    this.name = "WhatsappNumberInUseError";
  }
}

/** El guardado del agente de WhatsApp perdio contra otro guardado (la version esperada ya no es la vigente). Las
 * rutas lo traducen a 409 para que la pantalla recargue y el usuario revise antes de reintentar. */
export class WhatsAppAgentConfigConflictError extends Error {
  constructor() {
    super("La configuración del agente cambió mientras la editaba. Recargue y revise los cambios antes de guardar.");
    this.name = "WhatsAppAgentConfigConflictError";
  }
}

/** La memoria del cliente (migracion 049) todavia no esta aplicada en esta base. Las rutas del staff lo traducen a 503
 * "no disponible aun: requiere la migracion 049" en vez de fingir un resultado; el agente cae al camino anterior. */
export class ClienteMemoriaNoDisponibleError extends Error {
  constructor() {
    super("La memoria del cliente todavía no está disponible: requiere aplicar la migración 049 de restaurantes.");
    this.name = "ClienteMemoriaNoDisponibleError";
  }
}

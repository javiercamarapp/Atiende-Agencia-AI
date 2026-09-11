// Port de "anotar el contacto" — cierra un hueco real: ambos agentes (voz y
// WhatsApp) siempre prometieron registrar el contacto cuando la llamada/mensaje no es
// para hacer un pedido (quejas, facturación, empleo), pero en el origen no existía
// tabla ni herramienta que de verdad lo guardara antes de
// 20260903010000_callback_requests.sql — se preserva tal cual.
import type { RestaurantesRepository } from "./repository.ts";
import type { CallbackRequest, CallbackRequestInput } from "./types.ts";

export async function registerCallbackRequest(repo: RestaurantesRepository, input: CallbackRequestInput): Promise<CallbackRequest> {
  if (!input.customerName.trim() || !input.customerPhone.trim()) {
    throw new Error("customerName y customerPhone son requeridos para registrar un contacto");
  }
  return repo.createCallbackRequest(input);
}

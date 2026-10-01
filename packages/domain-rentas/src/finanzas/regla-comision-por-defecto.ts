// Rn-18 -- que pasa cuando una reserva no tiene regla de comision de canal.
//
// Decision documentada: SOLO existe un default seguro para las reservas SIN canal externo
// (canal nulo o "manual": reserva directa o bloqueo manual interno). Ahi no hay quien cobre
// comision de canal, asi que 0 puntos base es la unica respuesta correcta, no una suposicion.
// Para un canal externo (Airbnb, Booking.com, Vrbo) NO se inventa ninguna comision: asumir
// 0% sobreestimaria el neto que se le liquida al propietario. Se devuelve `null` y el llamador
// lanza `ReglaComisionCanalNoConfiguradaError` (error de negocio 409 con la accion a seguir).
// Los tenants nuevos nacen con reglas sugeridas (migracion 027) para que esto casi no ocurra.
import type { ConfiguracionComisionCanal } from "./tipos.ts";

export const CODIGO_CANAL_DIRECTO = "manual";

export const FUENTE_COMISION_DIRECTA_POR_DEFECTO = "default: reserva directa o manual, sin comisión de canal (no hay regla configurada)";

export function reglaComisionPorDefecto(canalCodigo: string | null): ConfiguracionComisionCanal | null {
  if (canalCodigo === null || canalCodigo === CODIGO_CANAL_DIRECTO) {
    return { yaNetoDeComision: false, comisionBasisPoints: 0, fuente: FUENTE_COMISION_DIRECTA_POR_DEFECTO };
  }
  return null;
}

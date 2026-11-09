// Pruebas de la ESPERA por pedido grande: desde el 9-nov-2026 (decisión de Omar) no hay espera por omisión. Estas pruebas cubren la regla cuando se
// configura, con los umbrales de antes (total $4,000, 5 kg, $2,500 sin historial y en efectivo). Llamar una vez a nivel de archivo.
import { afterEach, beforeEach, vi } from "vitest";

export function activarEsperaPedidoGrande(): void {
  beforeEach(() => {
    vi.stubEnv("PM_PEDIDO_GRANDE_TOTAL_MXN", "4000");
    vi.stubEnv("PM_PEDIDO_GRANDE_KG", "5");
    vi.stubEnv("PM_PEDIDO_GRANDE_SIN_HISTORIAL_EFECTIVO_MXN", "2500");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
}

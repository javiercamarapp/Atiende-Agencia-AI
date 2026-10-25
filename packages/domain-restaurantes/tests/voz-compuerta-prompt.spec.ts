// El prompt de voz debe coincidir con la compuerta de la cascada v2 (VOZ-MEDICION-1): confirmar_resumen SOLO tras el «si» (el servidor lo rechaza en el turno de la cotizacion),
// crear_pedido enseguida, UN solo «si», saludo solo en la apertura; WhatsApp conserva su redaccion (confirmar y crear en la MISMA respuesta).
import { describe, expect, it } from "vitest";
import { bloqueReglasVozPm, comportamientoVozPm, COMPORTAMIENTO_VOZ_MAX } from "../src/voz/perfil-voz-pm.ts";

const base = { businessName: "Taquería de prueba", agentName: "Ana", deliveryTimeText: "30 minutos" };

describe("prompt de voz alineado con la compuerta confirmar -> crear", () => {
  const bloque = bloqueReglasVozPm(base);
  const comportamiento = comportamientoVozPm({ ...base, branches: [] });

  it("pide confirmar_resumen solo DESPUES del «si», un solo «si», sin releer el resumen", () => {
    expect(bloque).toMatch(/NO llame confirmar_resumen al leer el resumen/);
    expect(bloque).toMatch(/TRAS EL «SÍ» \(un solo sí basta\): llame confirmar_resumen y enseguida crear_pedido/);
    expect(bloque).toMatch(/espera_confirmacion_del_cliente/);
    expect(bloque).toMatch(/Léalo UNA sola vez y pida UN solo sí/);
    expect(bloque).not.toMatch(/siempre llame confirmar_resumen y crear_pedido/);
  });

  it("espera_confirmacion_del_cliente no es falla ni motivo para escalar, y la regla prevalece sobre el flujo compartido", () => {
    expect(bloque).toMatch(/espera_confirmacion_del_cliente NO es una falla del sistema ni motivo para escalar/);
    expect(bloque).toMatch(/prevalece sobre «confirmar_resumen y crear_pedido» del flujo/);
  });

  it("el saludo se dice solo en la apertura", () => {
    expect(bloque).toMatch(/SALUDO: .*SOLO en el turno de apertura/);
  });

  it("el comportamiento compacto (editable) no cambia: sigue bajo el tope de 8000", () => {
    expect(comportamiento.length).toBeLessThanOrEqual(COMPORTAMIENTO_VOZ_MAX);
  });
});

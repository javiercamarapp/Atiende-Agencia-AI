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

// Comportamiento (no solo texto): el prompt le dice al modelo EXACTAMENTE lo que hace la compuerta del codigo. Si el cliente no afirma, no se llama crear_pedido; si
// la herramienta responde espera_confirmacion_del_cliente / resumen_distinto_al_leido, la salida es releer UNA vez y pedir UN «si» (nunca crear, escalar ni inventar).
describe("prompt de voz: el contrato de la compuerta es operable", () => {
  const bloque = bloqueReglasVozPm(base);

  it("cubre los tres caminos que la compuerta distingue: sin «si», «si» valido y rechazo de la herramienta", () => {
    // 1) sin «si» (negacion, pregunta, ruido): no se confirma ni se crea; se atiende lo que dijo el cliente.
    expect(bloque).toMatch(/NO llame confirmar_resumen al leer el resumen/);
    expect(bloque).toMatch(/solo después del sí/);
    expect(bloque).toMatch(/Si el cliente NO dijo sí \(dijo no o «espere», preguntó algo o no se entendió\), NO llame confirmar_resumen ni crear_pedido/);
    // 2) con «si»: confirmar y enseguida crear, sin pedir otro «si».
    expect(bloque).toMatch(/llame confirmar_resumen y enseguida crear_pedido/);
    // 3) rechazo de la herramienta: no es falla, se relee una vez y se pide un solo «si».
    expect(bloque).toMatch(/léalo UNA vez, pida UN solo sí y calle/);
  });

  it("el orden de cierre obliga a un «si» NUEVO cuando cambia algo despues de aceptar el total (coherente con la huella de la compuerta)", () => {
    expect(bloque).toMatch(/espere un «sí» NUEVO antes de crear_pedido/);
  });

  it("ninguna regla de voz manda a crear sin que el cliente haya contestado", () => {
    const lineas = bloque.split("\n").filter((l) => /crear_pedido/.test(l));
    expect(lineas.length).toBeGreaterThan(0);
    for (const l of lineas) expect(l).not.toMatch(/sin esperar (al|el) (cliente|sí|si)/i);
  });
});

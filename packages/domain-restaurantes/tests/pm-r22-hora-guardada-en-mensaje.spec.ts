// PM R22 (causa 4 / R3): el mensaje final decia una hora distinta de la guardada en el pedido (SIM 118: «25 a 35 minutos», resumen 2:02 pm, cierre «en 20 minutos»; 163 y 115: «25 a 35» con la BD a 40).
import { describe, expect, it } from "vitest";
import { corregirHoraDeRecogidaEnRespuesta } from "../src/agent-tools/cierre-maquina.ts";

// 13:00 Merida (-06:00) = 19:00Z; pedido guardado a las 13:40 locales.
const AHORA = Date.parse("2026-10-06T19:00:00Z");
const hora = { instanteMs: Date.parse("2026-10-06T19:40:00Z"), zonaHoraria: "America/Merida", ahoraMs: AHORA };
const corrige = (t: string) => corregirHoraDeRecogidaEnRespuesta(t, hora);

describe("R22: el mensaje final usa la hora guardada", () => {
  it("sustituye un plazo que no alcanza la espera real", () => {
    expect(corrige("Listo, lo esperamos en 20 minutos.")).toBe("Listo, lo esperamos en 40 minutos.");
    // Una frase de «tiempo estimado» que no habla de esperar / recoger / estar listo no se reescribe (revision R22): ante la duda se deja.
    expect(corrige("El tiempo estimado es de 25 a 35 minutos.")).toBe("El tiempo estimado es de 25 a 35 minutos.");
  });
  it("sustituye una hora de reloj distinta de la guardada", () => {
    expect(corrige("Su pedido estará listo a las 2:02 pm.")).toBe("Su pedido estará listo a la 1:40 pm.");
    expect(corrige("Lo esperamos para las 3 pm.")).toBe("Lo esperamos para la 1:40 pm.");
  });
  it("deja intacto lo que coincide (con tolerancia) y lo que no habla de la espera", () => {
    expect(corrige("Lo esperamos en 40 minutos.")).toBe("Lo esperamos en 40 minutos.");
    expect(corrige("Lo esperamos en 38 minutos.")).toBe("Lo esperamos en 38 minutos.");
    expect(corrige("Lo esperamos a la 1:40 pm.")).toBe("Lo esperamos a la 1:40 pm.");
    expect(corrige("La sucursal cierra a las 11 pm. Lo esperamos en 40 minutos.")).toBe("La sucursal cierra a las 11 pm. Lo esperamos en 40 minutos.");
    expect(corrige("Su total es $90.")).toBe("Su total es $90.");
  });
});

// De punta a punta: pedido para recoger en 40 min; el modelo redacta «en 20 minutos» y el cliente lee la hora guardada.
import { afterEach, beforeEach, vi } from "vitest";
import { MARTES_14H, nuevoViaje, pedidosDe } from "./qa-viaje/arnes-viaje.ts";

describe("R22: en el turno de WhatsApp el cierre usa la hora guardada", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(MARTES_14H));
  });
  afterEach(() => vi.useRealTimers());

  it("el modelo dice «en 20 minutos» y el pedido quedó a 40: el mensaje dice 40", async () => {
    const v = await nuevoViaje();
    const items = [{ product_id: v.producto("Coca-Cola"), product_name: "Coca-Cola", requested_quantity: 2 }];
    v.guion([
      { tools: [{ name: "cotizar_pedido", args: { branch_slug: "garcia-lavin", canal: "recoger", payment_method: "efectivo", customer_name: "Ana Prueba", minutos_para_recoger: 40, items } }] },
      { texto: "Permítame repetirle su pedido: 2 Coca-Cola. Total $106.00. ¿Es correcto?" },
    ]);
    await v.escribe("dos cocas para recoger en 40 minutos");
    v.guion([{ texto: "Su pedido ya quedó registrado. Lo esperamos en 20 minutos." }]);
    const r = await v.escribe("Sí, es correcto");
    expect(await pedidosDe(v)).toHaveLength(1);
    expect(r.reply).toContain("Lo esperamos en 40 minutos.");
    expect(r.reply).not.toContain("20 minutos");
  });
});

describe("R22 (revisión): la corrección no rompe frases ni cifras ajenas", () => {
  it.each([
    "Pasa por él a las 3 pm, cerramos a las 12.",
    "Listo para las 9 personas.",
    "Lo esperamos a las 12 en punto.",
    "El tiempo estimado es de 25 a 35 minutos aprox.",
    "Está listo de 25 a 35 minutos aprox.",
    "Abrimos a las 12:00 pm y lo esperamos.",
    "Su total es $90 y son 3 pedidos.",
  ])("queda intacta: %s", (t) => {
    expect(corrige(t)).toBe(t);
  });
  it("conserva los espacios y la puntuación al sustituir", () => {
    expect(corrige("Lo esperamos a las 3 pm, gracias.")).toBe("Lo esperamos a la 1:40 pm, gracias.");
    expect(corrige("Lo esperamos a las 3 p. m. por favor")).toBe("Lo esperamos a la 1:40 pm por favor");
    expect(corrige("Estará listo en 25 a 35 minutos.")).toBe("Estará listo en 40 minutos.");
  });
});

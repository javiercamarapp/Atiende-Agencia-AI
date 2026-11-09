// Cerebro v2, plan de conexión paso 3 (SUELTO-VS-718-V2.md «Alergia antes del modelo»): la alergia dicha JUNTO con algo más que atender
// («soy alérgico al cacahuate, quiero 3 tacos de pastor») no se queda en la respuesta fija: el aviso queda, su texto va primero y el modelo toma el
// pedido (suelto R87-N: decidirSalud con residualConContenido = hayResidualConContenido del núcleo, whatsapp-agent-core.ts:15553).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decidirAntesDelModelo } from "../src/whatsapp/cerebro-v2/antes-del-modelo.ts";
import { hayResidualConContenido } from "../src/whatsapp/cerebro-v2/residual.ts";
import { ALERGIA_REPLY, decidirSalud } from "../src/whatsapp/cerebro-v2/salud.ts";
import { nuevoViaje } from "./qa-viaje/arnes-viaje.ts";

describe("residual con contenido (puerto literal del suelto)", () => {
  const sinAtender = () => false;
  it("una petición después del riesgo cuenta; la cortesía y la enumeración del riesgo no", () => {
    const t = "soy alérgico al cacahuate, quiero 3 tacos de pastor";
    expect(hayResidualConContenido([t], new Set([t]), sinAtender, (c) => /alergic/.test(c))).toBe(true);
    const solo = "soy alérgico al cacahuate, gracias";
    expect(hayResidualConContenido([solo], new Set([solo]), sinAtender, (c) => /alergic/.test(c))).toBe(false);
  });
  it("otra burbuja con una pregunta cuenta", () => {
    expect(hayResidualConContenido(["soy alérgica al cacahuate", "¿hasta qué hora abren?"], new Set(["soy alérgica al cacahuate"]), sinAtender, (c) => /alergic/.test(c))).toBe(true);
  });
});

describe("cerebro v2: alergia con algo más en la ráfaga", () => {
  it("decidirAntesDelModelo sigue al modelo con el aviso, el prefijo y el bloque (como decidirSalud con residual)", () => {
    const textos = ["soy alérgico al cacahuate, quiero 3 tacos de pastor"];
    const d = decidirAntesDelModelo(textos, { pedidoEnCurso: false });
    const suelto = decidirSalud(textos, { pedidoEnCurso: false, residualConContenido: true });
    expect(suelto.seguirAlModelo).toBe(true);
    expect(d.respuestaFija).toBeNull();
    expect(d.prefijoRespuesta).toBe(suelto.respuesta);
    expect(d.bloquePrompt).toContain(suelto.bloquePrompt!);
    expect(d.avisos.some((a) => a.motivo === "alergia_salud")).toBe(true);
  });
  it("la alergia sola sigue en la respuesta fija", () => {
    const d = decidirAntesDelModelo(["soy alérgico al cacahuate"], { pedidoEnCurso: false });
    expect(d.respuestaFija).not.toBeNull();
  });

  describe("en el turno", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-13T19:00:00-06:00"));
    });
    afterEach(() => vi.useRealTimers());
    it("el modelo atiende el pedido y el cliente lee primero lo de la alergia", async () => {
      const v = await nuevoViaje({ cerebroV2: true });
      v.guion([{ texto: "Con gusto: 3 tacos de pastor. ¿Para entregar a domicilio o recoger?" }]);
      const r = await v.escribe("soy alérgico al cacahuate, quiero 3 tacos de pastor");
      expect(r.reply).toContain(ALERGIA_REPLY.slice(0, 40));
      expect(r.reply).toContain("3 tacos de pastor. ¿Para entregar");
      expect(v.callbacks.some((c) => c.reason === "escalada:alergia_salud")).toBe(true);
    });
  });
});

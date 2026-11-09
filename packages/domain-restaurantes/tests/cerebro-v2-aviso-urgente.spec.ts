// Cerebro v2, plan de conexión paso 2 (SUELTO-VS-718-V2.md, B7 urgencia): la urgencia que decide v2 antes del modelo (`AvisoAntesDelModelo.urgente`) no se pierde.
// En el suelto el aviso urgente lleva la marca URGENTE al inicio del mensaje (mensajeAvisoDeRiesgo) y sale la alerta inmediata; aquí: marca al inicio del aviso
// (callback_requests) + notificación con severidad crítica. Decisión del dueño (7-nov): toda alergia declarada escala como URGENTE.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decidirAntesDelModelo } from "../src/whatsapp/cerebro-v2/antes-del-modelo.ts";
import { MARCA_AVISO_URGENTE } from "../src/whatsapp/cerebro-v2/salud.ts";
import { nuevoViaje } from "./qa-viaje/arnes-viaje.ts";

describe("cerebro v2: urgencia de los avisos antes del modelo", () => {
  it("una alergia declarada siempre va URGENTE, con la marca al inicio del resumen", () => {
    const d = decidirAntesDelModelo(["soy alérgica al cacahuate"], { pedidoEnCurso: false });
    const a = d.avisos.find((x) => x.motivo === "alergia_salud");
    expect(a?.urgente).toBe(true);
    expect(a?.resumen.startsWith(MARCA_AVISO_URGENTE)).toBe(true);
  });

  describe("en el turno", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-13T19:00:00-06:00"));
    });
    afterEach(() => vi.useRealTimers());

    it("el aviso urgente llega a callback_requests marcado urgente (notificación crítica)", async () => {
      const v = await nuevoViaje({ cerebroV2: true });
      await v.escribe("Hola, soy alérgica al cacahuate, ¿sus salsas llevan?");
      const aviso = v.callbacks.find((c) => c.reason === "escalada:alergia_salud");
      expect(aviso?.urgente).toBe(true);
      expect(aviso?.message?.startsWith(MARCA_AVISO_URGENTE)).toBe(true);
    });

    it("sin cerebro v2 nada cambia (sin marca de urgencia)", async () => {
      const v = await nuevoViaje();
      v.guion([{ tools: [{ name: "escalar_a_humano", args: { customer_name: "Cliente", motivo: "alergia_salud", resumen: "alergia al cacahuate" } }] }, { texto: "Ya avisé a la sucursal." }]);
      await v.escribe("Hola, soy alérgica al cacahuate, ¿sus salsas llevan?");
      for (const c of v.callbacks) expect(c.urgente).not.toBe(true);
    });
  });
});

// Cerebro v2: decision determinista antes del modelo (salud/alergia URGENTE, transferencia realizada) que el turno ejecuta con la bandera encendida.
import { describe, expect, it } from "vitest";
import { decidirAntesDelModelo } from "../src/whatsapp/cerebro-v2/antes-del-modelo.ts";
import { ALERGIA_REPLY, SALUD_REACCION_REPLY } from "../src/whatsapp/cerebro-v2/salud.ts";
import { TRANSFERENCIA_REALIZADA_REPLY } from "../src/whatsapp/cerebro-v2/pago.ts";

const ctx = { pedidoEnCurso: false };

describe("decidirAntesDelModelo", () => {
  it("emergencia (garganta que se cierra): respuesta fija de salud, aviso URGENTE y toma de handoff", () => {
    const d = decidirAntesDelModelo(["auxilio se me esta cerrando la garganta, tenia cacahuate"], ctx);
    expect(d.respuestaFija).toBe(SALUD_REACCION_REPLY);
    expect(d.avisos.some((a) => a.urgente && a.motivo === "alergia_salud" && /URGENTE/.test(a.resumen))).toBe(true);
    expect(d.motivoToma).toBe("alergia_salud");
  });

  it("alergia declarada antes de pedir: respuesta fija de alergia y aviso", () => {
    const d = decidirAntesDelModelo(["soy alérgica al cacahuate, ¿qué me recomiendan?"], ctx);
    expect(d.respuestaFija).toBe(ALERGIA_REPLY);
    expect(d.avisos).toHaveLength(1);
  });

  it("negar alergias no escala y v2 sustituye el intent de guards.ts", () => {
    const d = decidirAntesDelModelo(["no tengo alergias, 2 tacos de pastor"], ctx);
    expect(d.avisos).toHaveLength(0);
    expect(d.respuestaFija).toBeNull();
    expect(d.sustituye.has("alergia_salud")).toBe(true);
  });

  it("figura sin salud («me ahogo de calor») no escala", () => {
    expect(decidirAntesDelModelo(["me ahogo de calor, mandame 3 cocas"], ctx).avisos).toHaveLength(0);
  });

  it("transferencia YA realizada: aviso y respuesta fija; preguntar si aceptan transferencia va al modelo", () => {
    const d = decidirAntesDelModelo(["ya te transferí, aquí está el comprobante"], ctx);
    expect(d.respuestaFija).toBe(TRANSFERENCIA_REALIZADA_REPLY);
    expect(d.avisos.map((a) => a.motivo)).toEqual(["transferencia"]);
    const q = decidirAntesDelModelo(["¿aceptan transferencia?"], ctx);
    expect(q.avisos).toHaveLength(0);
    expect(q.respuestaFija).toBeNull();
  });

  it("un pedido normal no cambia nada", () => {
    const d = decidirAntesDelModelo(["quiero 3 tacos de bistec con tortilla de maíz"], ctx);
    expect(d).toMatchObject({ respuestaFija: null, prefijoRespuesta: null, bloquePrompt: null, avisos: [] });
  });
});

describe("decidirAntesDelModelo: cancelacion del suelto (con el hilo)", () => {
  const base = { pedidoEnCurso: true, mensajes: [{ role: "user", content: "quiero 2 tacos de pastor" }, { role: "assistant", content: "Listo, su pedido quedó registrado." }], ahoraMs: Date.parse("2026-11-04T20:00:00Z") };

  it("«cancela mi pedido» con pedido vivo: aviso de cancelacion y v2 sustituye el intent de guards.ts", () => {
    const d = decidirAntesDelModelo(["cancela mi pedido por favor"], base);
    expect(d.sustituye.has("cancelacion_modificacion")).toBe(true);
    expect(d.avisos.some((a) => a.motivo === "cancelacion_modificacion")).toBe(true);
    expect(d.respuestaFija ?? d.prefijoRespuesta).toBeTruthy();
  });

  it("la duda («¿puedo cancelar mi pedido?») no cede la conversacion: pregunta y el agente sigue", () => {
    const d = decidirAntesDelModelo(["¿puedo cancelar mi pedido?"], base);
    expect(d.motivoToma).toBeNull();
    expect(d.cancelacion?.accion ?? "nada").not.toBe("avisar_cancelacion");
  });

  it("sin pedido vivo y sin hilo no hay aviso de cancelacion", () => {
    expect(decidirAntesDelModelo(["cancela mi pedido"], { pedidoEnCurso: false }).avisos).toHaveLength(0);
  });
});

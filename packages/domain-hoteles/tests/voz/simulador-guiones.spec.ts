// Prueba ciega es-MX del agente de VOZ de hoteles con el proveedor FALSO guionado (sin red, sin credenciales): cada guion corre contra el nucleo real de
// @atiende/voice-core (maquina de la llamada + controlador + ejecutor) y el motor real de reservas en memoria, y lo juzgan graders deterministas.
import { describe, expect, it } from "vitest";
import { GUIONES_ES_MX, correrGuion, evaluarLlamada } from "../../src/voz/simulador/index.ts";

describe("guiones es-MX de la voz de hoteles", () => {
  it("hay al menos los 8 escenarios que exige el brief, con ids unicos", () => {
    expect(GUIONES_ES_MX.length).toBeGreaterThanOrEqual(8);
    expect(new Set(GUIONES_ES_MX.map((g) => g.id)).size).toBe(GUIONES_ES_MX.length);
    const ids = GUIONES_ES_MX.map((g) => g.id).join(" ");
    for (const clave of ["feliz", "cambio", "cancelacion", "sin-disponibilidad", "humano", "fuera-de-horario", "ambiguo", "abuso"]) expect(ids).toContain(clave);
  });

  it("incluye los 8 escenarios de hotel de la paridad3 (toallas, alergia, factura, estacionamiento/wifi, tuteo, emergencia, reserva no pagada, ingles)", () => {
    const ids = GUIONES_ES_MX.map((g) => g.id).join(" ");
    for (const clave of ["toallas", "alergia-room-service", "factura", "estacionamiento-wifi", "tutea", "emergencia", "reserva-no-pagada", "ingles"]) expect(ids).toContain(clave);
  });

  it("el grader de texto esperado muerde: prometer lo prohibido o callar lo exigido hace fallar el guion", async () => {
    const base = GUIONES_ES_MX.find((g) => g.id.startsWith("H19"))!;
    const exigeOtraCosa = { ...base, esperado: { ...base.esperado, decir: [/llame a la policia municipal/i] } };
    expect((await evaluarLlamada(await correrGuion(exigeOtraCosa))).filter((r) => !r.ok).map((r) => r.grader)).toEqual(["G_TEXTO_ESPERADO"]);
    const prohibeLoDicho = { ...base, esperado: { ...base.esperado, noDecir: [/\b911\b/] } };
    expect((await evaluarLlamada(await correrGuion(prohibeLoDicho))).filter((r) => !r.ok).map((r) => r.grader)).toEqual(["G_TEXTO_ESPERADO"]);
  });

  it("un agente que promete entrega o dice que un platillo es seguro NO pasa", async () => {
    const toallas = GUIONES_ES_MX.find((g) => g.id.startsWith("H14"))!;
    const promete = {
      ...toallas,
      turnos: [{ kind: "voz" as const, cliente: "Cuarto 312, dos toallas", agente: [{ tool: "registrar_contacto_no_operativo", args: { motivo: "toallas" } }, { dice: "Ya van en camino, llegan en cinco minutos." }] }],
    };
    expect((await evaluarLlamada(await correrGuion(promete))).filter((r) => !r.ok).map((r) => r.grader)).toContain("G_TEXTO_ESPERADO");
  });

  for (const guion of GUIONES_ES_MX) {
    it(`${guion.id}: pasan TODOS los graders`, async () => {
      const llamada = await correrGuion(guion);
      const fallos = (await evaluarLlamada(llamada)).filter((r) => !r.ok);
      expect(fallos).toEqual([]);
    });
  }
});

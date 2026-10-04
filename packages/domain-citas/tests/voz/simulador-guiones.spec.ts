// Prueba ciega es-MX del agente de VOZ de citas con el proveedor FALSO guionado (sin red, sin credenciales): cada guion corre contra el nucleo real de
// @atiende/voice-core (maquina de la llamada + controlador + ejecutor + guardia de crisis) y el motor real de agenda en memoria, y lo juzgan graders
// deterministas. Los graders tambien se prueban en NEGATIVO: un agente que hace lo que no debe tiene que fallar.
import { describe, expect, it } from "vitest";
import { CRISIS_VOICE_MESSAGE } from "../../src/vertical-config.ts";
import { GUIONES_ES_MX, correrGuion, evaluarLlamada } from "../../src/voz/simulador/index.ts";
import type { GuionLlamada } from "../../src/voz/simulador/index.ts";

describe("guiones es-MX de la voz de citas", () => {
  it("hay los 8 escenarios del brief mas 2 de crisis, con ids unicos", () => {
    expect(GUIONES_ES_MX.length).toBeGreaterThanOrEqual(10);
    expect(new Set(GUIONES_ES_MX.map((g) => g.id)).size).toBe(GUIONES_ES_MX.length);
    const ids = GUIONES_ES_MX.map((g) => g.id).join(" ");
    for (const clave of ["feliz", "cambio", "cancelacion", "sin-disponibilidad", "persona", "fuera-de-horario", "ambiguo", "abuso"]) expect(ids).toContain(clave);
    expect(GUIONES_ES_MX.filter((g) => g.id.startsWith("X")).length).toBe(2);
  });

  for (const guion of GUIONES_ES_MX) {
    it(`${guion.id}: pasan TODOS los graders`, async () => {
      const llamada = await correrGuion(guion);
      const fallos = (await evaluarLlamada(llamada)).filter((r) => !r.ok);
      expect(fallos).toEqual([]);
    });
  }
});

const guion = (id: string): GuionLlamada => GUIONES_ES_MX.find((g) => g.id.startsWith(id))!;

describe("efectos reales de los guiones (no solo que pasen los graders)", () => {
  it("C01 crea UNA cita de voz del llamante y la marca con origen voice", async () => {
    const l = await correrGuion(guion("C01"));
    const citas = await l.mundo.citasVoz();
    expect(citas).toHaveLength(1);
    expect(citas[0]!.source).toBe("voice");
    expect(l.resultado).toBe("cita_gestionada");
  });

  it("C02 reagenda la MISMA cita (mismo id) y no crea otra", async () => {
    const l = await correrGuion(guion("C02"));
    expect(await l.mundo.citasVoz()).toHaveLength(0);
    const c = await l.mundo.cita(l.mundo.citaSembradaId);
    expect(c?.status).toBe("confirmed");
    expect(c?.startsAt).not.toBe("");
  });

  it("C05 avisa al equipo con un mensaje que lleva el telefono del cliente y el motivo, pero no una transcripcion", async () => {
    const l = await correrGuion(guion("C05"));
    const avisos = l.mundo.repo.getOutbox().filter((o) => o.eventType === "voz.callback");
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.dedupeKey).toBe(`voz-callback:sim-${guion("C05").id}`);
    const cuerpo = (avisos[0]!.payload as { body: string; to: string }).body;
    expect(cuerpo).toContain("9991230000");
    expect((avisos[0]!.payload as { to: string }).to).toBe("+5219990001111");
  });

  it("C08: buscar_mis_citas con un telefono ajeno devuelve SOLO las citas del llamante (el telefono sale del SIP From)", async () => {
    const l = await correrGuion(guion("C08"));
    const busqueda = l.tools.find((t) => t.nombre === "buscar_mis_citas")!;
    expect(JSON.stringify(busqueda.resultado)).toContain(l.mundo.citaSembradaId);
    expect(JSON.stringify(busqueda.resultado)).not.toContain(l.mundo.citaOtroClienteId);
    // Aunque el modelo mande un telefono ajeno, la herramienta usa solo el de la llamada: el resultado no trae nada del otro cliente.
  });

  it("X01: la guardia habla el mensaje de crisis TAL CUAL, el modelo no recibe la frase (la escalacion la hace la guardia, no el modelo), no se agenda nada y solo el MOTIVO llega al log", async () => {
    const l = await correrGuion(guion("X01"));
    expect(l.textosGuardia).toEqual([CRISIS_VOICE_MESSAGE]);
    expect(l.tools.map((t) => t.nombre)).toEqual(["listar_servicios", "listar_proveedores"]);
    expect(l.resultado).toBe("escalado");
    const escalaciones = l.mundo.repo.getEmergencyEscalations();
    expect(escalaciones).toHaveLength(1);
    expect(escalaciones[0]).toMatchObject({ channel: "voice", customerPhone: "9991230000", keywordMatched: "ideación suicida", messageExcerpt: "" });
    expect(JSON.stringify(l.logs)).not.toContain("morirme");
    expect(JSON.stringify(l.logs)).not.toContain("aguanto");
  });

  it("X02: la cita agendada antes de la crisis se conserva y el resultado es escalado (la guardia pesa mas que el cierre exitoso)", async () => {
    const l = await correrGuion(guion("X02"));
    expect(await l.mundo.citasVoz()).toHaveLength(1);
    expect(l.resultado).toBe("escalado");
    expect(l.mundo.repo.getEmergencyEscalations()).toHaveLength(1);
  });
});

describe("los graders detectan a un agente que hace lo que NO debe", () => {
  it("G_CITAS: una cita que el guion no esperaba hace fallar al grader", async () => {
    const l = await correrGuion({ ...guion("C01"), esperado: { ...guion("C01").esperado, citaNueva: null } });
    const fallos = (await evaluarLlamada(l)).filter((r) => !r.ok).map((r) => r.grader);
    expect(fallos).toContain("G_CITAS");
  });

  it("G_CONFIRMACION: agendar cuando el cliente NO dijo que si hace fallar al grader (aunque el modelo ponga confirmado_por_cliente en true)", async () => {
    const base = guion("C01");
    const sinSi = { ...base, turnos: base.turnos.map((t, i) => (i === 3 && t.kind === "voz" ? { ...t, cliente: "Mmm, no sé todavía" } : t)) };
    const l = await correrGuion(sinSi);
    const fallos = (await evaluarLlamada(l)).filter((r) => !r.ok).map((r) => r.grader);
    expect(fallos).toContain("G_CONFIRMACION");
  });

  it("G_NO_AFIRMA_SIN_HERRAMIENTA: decir 'quedo agendada' sin que crear_cita haya salido bien hace fallar al grader", async () => {
    const mentira: GuionLlamada = {
      id: "N01",
      titulo: "miente",
      rasgos: [],
      turnos: [{ kind: "voz", cliente: "Quiero una cita", agente: [{ dice: "Listo, su cita quedó agendada para mañana." }] }],
      esperado: { resultado: "abandonado", citaNueva: null },
    };
    const fallos = (await evaluarLlamada(await correrGuion(mentira))).filter((r) => !r.ok).map((r) => r.grader);
    expect(fallos).toContain("G_NO_AFIRMA_SIN_HERRAMIENTA");
  });

  it("G_ESCALACIONES: una crisis esperada que no se registro (o una no esperada que si) hace fallar al grader", async () => {
    const l = await correrGuion({ ...guion("X01"), esperado: { resultado: "escalado", citaNueva: null, escalacionesCrisis: 0 } });
    const fallos = (await evaluarLlamada(l)).filter((r) => !r.ok).map((r) => r.grader);
    expect(fallos).toContain("G_ESCALACIONES");
  });
});

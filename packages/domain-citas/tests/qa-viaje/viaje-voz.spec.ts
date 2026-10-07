// QA citas R1 -- lente VIAJE COMPLETO por VOZ (agente de citas sobre @atiende/voice-core, PR #391). Llamadas completas con el proveedor
// FALSO guionado (sin red ni credenciales) contra el nucleo real de la llamada y el motor real de agenda en memoria.
import { describe, expect, it } from "vitest";
import { correrGuionConAdaptador } from "@atiende/voice-core/simulador";
import { CRISIS_VOICE_MESSAGE } from "../../src/vertical-config.ts";
import { crearAdaptadorSimuladorCitas } from "../../src/voz/simulador/correr-guion.ts";
import { crearMundoVozCitas, DIA_LUNES } from "../../src/voz/simulador/mundo-voz.ts";
import { GUIONES_ES_MX, correrGuion } from "../../src/voz/simulador/index.ts";
import type { GuionLlamada, MemoriaCitas } from "../../src/voz/simulador/index.ts";

const SENSIBLES = ["Ana Pech"] as const;

function adaptadorConListaDeEspera() {
  const base = crearAdaptadorSimuladorCitas();
  return {
    ...base,
    crearMundo: () => {
      const mundo = crearMundoVozCitas();
      // Alguien espera un hueco con la Dra. Lucia (cualquier dia/hora) para la consulta de valoracion.
      mundo.repo.seedWaitlistEntry({ organizationId: mundo.organizationId, customerPhone: "+529995550302", customerName: "Mario Chan", providerId: mundo.proveedores.lucia, serviceId: mundo.servicios.valoracion, preferredDateFrom: null, preferredDateTo: null, preferredTimeWindow: "any" });
      return mundo;
    },
  };
}

const CANCELA: GuionLlamada = {
  id: "QA-V01-cancela-por-voz",
  titulo: "El paciente llama, el agente busca su cita, repite cual es y la cancela tras el si",
  rasgos: ["cancelacion por voz"],
  sensibles: SENSIBLES,
  turnos: [
    { kind: "voz", cliente: "Buenas tardes, quiero cancelar mi cita del lunes", agente: [{ tool: "buscar_mis_citas", args: {} }, { dice: "Veo su consulta del lunes dieciséis a las diez de la mañana. ¿La cancelo?" }] },
    { kind: "voz", cliente: "Sí, cancélela por favor", agente: [{ tool: "cancelar_cita", args: (m: MemoriaCitas) => ({ appointment_id: m.citaId(), confirmado_por_cliente: true }) }, { dice: "Listo, su cita quedó cancelada." }] },
  ],
  esperado: { resultado: "cita_gestionada", citaNueva: null, citaSembrada: { estado: "cancelled" } },
};

describe("viaje voz: cancelar por telefono", () => {
  it("la cita del llamante queda cancelada por voz (solo la suya)", async () => {
    const l = await correrGuionConAdaptador(adaptadorConListaDeEspera(), CANCELA, {});
    expect(l.iniciada).toBe(true);
    expect((await l.mundo.cita(l.mundo.citaSembradaId))?.status).toBe("cancelled");
    expect((await l.mundo.cita(l.mundo.citaOtroClienteId))?.status).toBe("confirmed");
  });

  it("QA-citas-R1-viaje-11: cancelar por VOZ avisa a la lista de espera del hueco liberado (regresion de la migracion a voice-core: las rutas de voz ya no pasan por appointments-lifecycle)", async () => {
    const l = await correrGuionConAdaptador(adaptadorConListaDeEspera(), CANCELA, {});
    expect((await l.mundo.cita(l.mundo.citaSembradaId))?.status).toBe("cancelled");
    expect(l.mundo.repo.getOutbox().filter((o) => o.eventType === "waitlist.slot_offered")).toHaveLength(1);
  });
});

describe("viaje voz: horarios hablados", () => {
  it.fails("QA-citas-R1-viaje-01 (voz): consultar_disponibilidad entrega al modelo de voz la hora LOCAL (hoy solo ISO UTC, y el prompt pide decir la hora 'en palabras')", async () => {
    const l = await correrGuion(GUIONES_ES_MX.find((g) => g.id.startsWith("C01"))!);
    const consulta = l.tools.find((t) => t.nombre === "consultar_disponibilidad")!;
    const primero = (consulta.resultado as { slots: Record<string, unknown>[] }).slots[0]!;
    expect(JSON.stringify(primero)).toMatch(/"09:00"|9:00 a/);
    void DIA_LUNES;
  });
});

describe("viaje voz: guardia de crisis", () => {
  it("una crisis dicha en la llamada se atiende con el mensaje de ayuda y la llamada se escala (X01)", async () => {
    const l = await correrGuion(GUIONES_ES_MX.find((g) => g.id.startsWith("X01"))!);
    expect(l.resultado).toBe("escalado");
    expect(l.textosGuardia).toContain(CRISIS_VOICE_MESSAGE);
  });

  it("QA-citas-R1-viaje-12: el mensaje de crisis que se LEE en voz trata de usted y no contiene 'solo/a' (el TTS lo pronuncia literal)", async () => {
    const l = await correrGuion(GUIONES_ES_MX.find((g) => g.id.startsWith("X01"))!);
    const dicho = l.textosGuardia?.[0] ?? "";
    expect(dicho).not.toMatch(/\/a\b/);
    expect(dicho).not.toMatch(/\bestás\b|\bcontacta\b/);
  });

  it("QA-citas-R1-viaje-08 (voz): 'me quiero morir' dicho al psicologo escala la llamada", async () => {
    const guion: GuionLlamada = {
      id: "QA-V02-me-quiero-morir",
      titulo: "Frase de crisis comun que no esta en la lista fija",
      rasgos: ["crisis"],
      sensibles: SENSIBLES,
      turnos: [
        { kind: "voz", cliente: "Hola, quiero una cita con la doctora Lucía", agente: [{ tool: "listar_servicios", args: {} }, { dice: "Con gusto. ¿Para qué día?" }] },
        { kind: "voz", cliente: "Es que me quiero morir, ya no sé qué hacer", agente: [{ dice: "Entiendo. ¿Para qué día le busco?" }] },
      ],
      esperado: { resultado: "escalado", citaNueva: null, escalacionesCrisis: 1 },
    };
    const l = await correrGuion(guion);
    expect(l.resultado).toBe("escalado");
  });
});

// QA R1 -- lente AGENTES de la vertical citas: el agente de VOZ (sobre @atiende/voice-core, PR #391). Se ataca lo que el servidor y la maquina de
// la cita deben imponer aunque el modelo hablado se equivoque o lo manipulen: confirmacion en voz alta, ids y horarios solo de herramientas, una cita
// por llamada, llamante anonimo, derivacion a una persona y guardia de crisis. Todo en memoria, sin red ni credenciales.
//
// Convencion: `it` = comportamiento correcto confirmado; `it.fails` = DEFECTO confirmado (describe lo ESPERADO y hoy falla).
import { describe, expect, it } from "vitest";
import { CRISIS_ESCALATION_MESSAGE, CRISIS_VOICE_MESSAGE } from "../../src/vertical-config.ts";
import { evaluarCrisisVoz } from "../../src/voz/guardia-crisis.ts";
import { MaquinaCitaVoz } from "../../src/voz/maquina-cita.ts";
import { obtenerContextoLlamadaVoz } from "../../src/voz/contexto-llamada.ts";
import { derivarAHumanoVoz, ejecutarToolVozCitas } from "../../src/voz/tools-servidor.ts";
import type { CitasVozContexto } from "../../src/voz/tools-servidor.ts";
import { merida, montarConsultorio } from "./r1-agentes-support.ts";

function llamada(rubro = "psicologo", telefono = "9991230000") {
  const t = montarConsultorio({ rubro });
  const ctx: CitasVozContexto = { repo: t.repo, organizationId: t.organizationId, telefono, llamadaId: "call-qa-1" };
  const maquina = new MaquinaCitaVoz();
  // Corre una herramienta como lo hace el core: primero la guardia de la maquina, luego el servidor, y avanza el estado.
  const tool = async (nombre: string, args: Record<string, unknown>) => {
    const rechazo = maquina.guardia(nombre, args);
    if (rechazo) return { resultado: rechazo as unknown, rechazada: true };
    const { resultado } = await ejecutarToolVozCitas(ctx, nombre, args);
    const ok = !(typeof resultado === "object" && resultado !== null && "error" in resultado);
    maquina.alResultado(nombre, args, resultado, ok);
    return { resultado, rechazada: false };
  };
  return { t, ctx, maquina, tool };
}

const errorDe = (r: unknown) => (r as { error?: string }).error;

describe("QA R1 citas · voz · lo que SI funciona", () => {
  it("la maquina de la cita frena al modelo: sin confirmacion, con ids inventados, con un horario no ofrecido y una segunda cita en la misma llamada", async () => {
    const { t, tool } = llamada();
    const crearArgs = (inicio: string, extra: Record<string, unknown> = {}) => ({ provider_id: t.providerId, service_id: t.serviceId, customer_name: "Ana Pech", starts_at: inicio, ...extra });
    // Ids inventados (antes de listar).
    expect(errorDe((await tool("crear_cita", crearArgs(merida(t.lunes, "10:00"), { confirmado_por_cliente: true }))).resultado)).toBe("ids_no_resueltos");
    await tool("listar_servicios", {});
    await tool("listar_proveedores", {});
    await tool("consultar_disponibilidad", { provider_id: t.providerId, service_id: t.serviceId, date: t.lunes });
    // Sin el "si" del cliente.
    expect(errorDe((await tool("crear_cita", crearArgs(merida(t.lunes, "10:00")))).resultado)).toBe("falta_confirmacion");
    // Horario que no salio de consultar_disponibilidad (10:15).
    expect(errorDe((await tool("crear_cita", crearArgs(merida(t.lunes, "10:15"), { confirmado_por_cliente: true }))).resultado)).toBe("horario_no_ofrecido");
    // Bien.
    const ok = await tool("crear_cita", crearArgs(merida(t.lunes, "10:00"), { confirmado_por_cliente: true }));
    expect(errorDe(ok.resultado)).toBeUndefined();
    // Otra cita en la misma llamada -> a una persona.
    expect(errorDe((await tool("crear_cita", crearArgs(merida(t.lunes, "11:00"), { confirmado_por_cliente: true }))).resultado)).toBe("una_cita_por_llamada");
    const citas = await t.citas();
    expect(citas).toHaveLength(1);
    expect(citas[0]!.source).toBe("voice");
  });

  it("cancelar o reagendar una cita que no se vio con buscar_mis_citas (id dictado o inventado) se rechaza antes del servidor", async () => {
    const { tool } = llamada();
    const r = await tool("cancelar_cita", { appointment_id: "00000000-0000-4000-8000-000000000000", confirmado_por_cliente: true });
    expect(errorDe(r.resultado)).toBe("falta_buscar_citas");
    expect(r.rechazada).toBe(true);
  });

  it("llamante anonimo (SIP sin numero): no puede buscar, crear ni cancelar; el servidor pide una persona", async () => {
    const { tool } = llamada("psicologo", "");
    const r = await tool("buscar_mis_citas", {});
    expect(r.resultado).toMatchObject({ error: "llamante_anonimo", requiere_humano: true });
  });

  it("guardia de crisis por voz: 'ya no aguanto, quiero morirme' -> mensaje fijo y escalacion de crisis con solo la palabra clave (sin transcripcion)", async () => {
    const decision = evaluarCrisisVoz("ya no aguanto, quiero morirme");
    expect(decision).toMatchObject({ texto: CRISIS_VOICE_MESSAGE, motivo: "crisis" });
    const { t, ctx } = llamada();
    await derivarAHumanoVoz(ctx, { motivo: decision!.motivo, resumen: decision!.resumen });
    const escalaciones = t.repo.getEmergencyEscalations();
    expect(escalaciones).toHaveLength(1);
    expect(escalaciones[0]).toMatchObject({ channel: "voice", messageExcerpt: "" });
    expect(CRISIS_ESCALATION_MESSAGE).toContain("800 911 2000");
  });

  it("inyeccion: el modelo manda motivo 'crisis' con texto libre del cliente en el resumen -> solo se guarda texto fijo, nunca lo que dijo", async () => {
    const { t, ctx } = llamada();
    await derivarAHumanoVoz(ctx, { motivo: "crisis", resumen: "palabra_clave:mi diagnostico es depresion mayor y tomo sertralina" });
    expect(t.repo.getEmergencyEscalations()[0]!.keywordMatched).toBe("señal de crisis en la llamada");
    const aviso = t.repo.getOutbox().find((o) => o.eventType === "crisis.escalated");
    expect(JSON.stringify(aviso?.payload ?? {})).not.toContain("sertralina");
  });

  it("derivar_a_humano fuera de crisis: un solo aviso al equipo por llamada (dedupe por id de llamada) y nunca una escalacion de crisis en una barberia", async () => {
    const { t, ctx } = llamada("barberia");
    await derivarAHumanoVoz(ctx, { motivo: "crisis", resumen: "palabra_clave:quiero morirme" });
    await derivarAHumanoVoz(ctx, { motivo: "queja", resumen: "quiere hablar con el dueño" });
    expect(t.repo.getEmergencyEscalations()).toHaveLength(0);
    const avisos = t.repo.getOutbox().filter((o) => o.eventType === "voz.callback");
    expect(avisos).toHaveLength(1);
  });

  it("contexto de la llamada: 'hoy' y la hora local salen de la zona del negocio (Merida), no de UTC", async () => {
    const { t } = llamada();
    // 2026-01-15T05:30Z = 2026-01-14 23:30 en Merida.
    const ctx = await obtenerContextoLlamadaVoz(t.repo, { id: t.organizationId, name: "Clínica" }, new Date("2026-01-15T05:30:00.000Z"));
    expect(ctx).toMatchObject({ timezone: "America/Merida", hoy: "2026-01-14", horaLocal: "23:30", guardiaCrisis: true });
  });
});

describe("QA R1 citas · voz · DEFECTOS confirmados", () => {
  // QA-citas-R1-agentes-01 (P1, voz): el prompt de voz pide decir las horas "en palabras", pero consultar_disponibilidad le entrega ISO UTC; el
  // modelo hablado dice "tres de la tarde" para un horario de las nueve de la mañana (mismo origen que el defecto de WhatsApp).
  it.fails("01c por voz, consultar_disponibilidad trae la hora local del negocio para decirla en palabras", async () => {
    const { t, tool } = llamada();
    await tool("listar_servicios", {});
    await tool("listar_proveedores", {});
    const { resultado } = await tool("consultar_disponibilidad", { provider_id: t.providerId, service_id: t.serviceId, date: t.lunes });
    const primero = (resultado as { slots: Record<string, unknown>[] }).slots[0]!;
    expect(Object.values(primero).some((v) => typeof v === "string" && !v.endsWith("Z") && /\b0?9:00\b/.test(v))).toBe(true);
  });

  // QA-citas-R1-agentes-02 (P1, voz): la guardia de voz usa la misma lista; "me quiero morir" dicho por telefono no la dispara.
  it("02b por voz, 'me quiero morir' y 'me voy a suicidar' disparan la guardia", () => {
    expect(evaluarCrisisVoz("me quiero morir")).not.toBeNull();
    expect(evaluarCrisisVoz("me voy a suicidar")).not.toBeNull();
  });

  // QA-citas-R1-agentes-15 (P2, privacidad): derivar_a_humano copia el `resumen` libre del modelo al WhatsApp del dueño SIN redactar datos de pago
  // (WhatsApp si redacta con redactSensitiveInfo); si el paciente dicto su tarjeta y el modelo la resume, viaja en claro al telefono de avisos.
  it("15 el aviso de callback al dueño no lleva el numero de tarjeta que dicto el paciente", async () => {
    const { t, ctx } = llamada("dental");
    await derivarAHumanoVoz(ctx, { motivo: "quiere pagar el anticipo", resumen: "dicto su tarjeta 4111 1111 1111 1111 vence 12/29 para el anticipo" });
    const aviso = t.repo.getOutbox().find((o) => o.eventType === "voz.callback")!;
    expect((aviso.payload as { body: string }).body).not.toMatch(/4111[ -]?1111/);
  });
});

describe("QA R1 citas · voz · aviso al dueño sin datos de pago (agentes-15, refuerzo)", () => {
  it("el motivo tambien se redacta, y la tarjeta cortada por el recorte no queda a medias", async () => {
    const { t, ctx } = llamada("dental");
    await derivarAHumanoVoz(ctx, { motivo: "pago con tarjeta 4111 1111 1111 1111", resumen: `${"x".repeat(270)} 4111 1111 1111 1111` });
    const body = (t.repo.getOutbox().find((o) => o.eventType === "voz.callback")!.payload as { body: string }).body;
    expect(body).not.toMatch(/4111/);
    expect(body).not.toMatch(/\d{12,}/);
  });
});

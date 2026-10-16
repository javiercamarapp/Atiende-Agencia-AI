// Paquete 06 (WhatsApp multinumero): E2E del ruteo ACTUAL con varios numeros de WhatsApp. Cinco sucursales con numero propio
// (T1, T2, T3, T7, T8) y dos sin numero (T4, T5): cada mensaje cae en SU sucursal y la respuesta sale por EL MISMO numero por el que entro.
// Un lote firmado con dos numeros rutea cada `change`; un numero desconocido se acusa con 200 sin procesar nada.
//
// Todo es simulado (MetaCloudSimulator + repos en memoria + LLM guionado): jamas se llama a Meta ni se usa una credencial real.
// Debe pasar sin los paquetes 02 y 03. El describe «hoy: ecos ignorados» documenta el comportamiento ACTUAL ante ecos de la app,
// `history` y `smb_app_state_sync`; el paquete 02 (coexistencia) lo reemplazara.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LlmCompletionRequest } from "@atiende/agent-core";
import { PHONE_NUMBER_ID, startCicloStack } from "../support/e2e-ciclo-restaurantes.ts";
import type { CicloStack, ScriptStep } from "../support/e2e-ciclo-restaurantes.ts";

/** Miercoles 2026-10-07 12:00 hora de Merida (UTC-6): reloj fijo, el CI corre a cualquier hora. */
const MIERCOLES_MEDIODIA = "2026-10-07T18:00:00.000Z";

/** Sucursales con numero propio (cada una con su `phone_number_id`) y sin numero (atienden por el numero por defecto de la organizacion). */
const CON_NUMERO = ["T1", "T2", "T3", "T7", "T8"] as const;
const SIN_NUMERO = ["T4", "T5"] as const;
const numeroDe = (t: string): string => `70000000${t.slice(1)}`;
const clienteDe = (n: number): string => `52999123${String(5000 + n)}`;

interface Sucursales {
  readonly propertyIds: Readonly<Record<string, string>>;
  readonly prompts: LlmCompletionRequest[];
  /** Cuantas veces se llamo al LLM guionado (un mensaje procesado = un turno). */
  turnos(): number;
  /** Guion: un turno por paso, cada uno responde `Hola desde <etiqueta>` y registra el prompt del sistema. */
  guion(etiquetas: readonly string[]): void;
}

describe("e2e WhatsApp multinumero: ruteo actual por sucursal", () => {
  let stack: CicloStack;
  let s: Sucursales;

  beforeEach(async () => {
    stack = await startCicloStack({ now: MIERCOLES_MEDIODIA });
    const repo = stack.ctx.restaurantesRepo;
    const organizationId = stack.ctx.organizationId;
    const propertyIds: Record<string, string> = {};
    for (const t of [...CON_NUMERO, ...SIN_NUMERO]) {
      const propertyId = randomUUID();
      propertyIds[t] = propertyId;
      repo.seedBranch({ propertyId, organizationId, name: `Taqueria PM ${t}`, slug: `pm-${t.toLowerCase()}`, status: "active", phone: null, address: null, lat: null, lng: null });
    }
    for (const t of CON_NUMERO) {
      repo.seedWhatsAppBranchChannel(organizationId, propertyIds[t]!, numeroDe(t));
      stack.sim.addPhoneNumberId(numeroDe(t));
    }
    const prompts: LlmCompletionRequest[] = [];
    let turnos = 0;
    s = {
      propertyIds,
      prompts,
      turnos: () => turnos,
      guion(etiquetas) {
        const pasos: ScriptStep[] = etiquetas.map((etiqueta) => (req) => {
          turnos += 1;
          prompts.push(req);
          return { text: `Hola desde ${etiqueta}`, model: "fake/scripted", tokensIn: 1, tokensOut: 1, costUsd: 0 };
        });
        stack.setScript(pasos);
      },
    };
  });
  afterEach(async () => {
    await stack?.stop();
  });

  it("5 sucursales con numero propio: cada mensaje llega a SU sucursal y la respuesta sale por el MISMO numero", async () => {
    s.guion(CON_NUMERO);
    for (const [i, t] of CON_NUMERO.entries()) {
      const d = await stack.sim.inbound({ from: clienteDe(i), body: "Hola, quiero pedir", phoneNumberId: numeroDe(t) });
      expect(d.status, t).toBe(200);
    }
    await stack.dispatchWhatsApp();
    for (const [i, t] of CON_NUMERO.entries()) {
      const enviados = stack.sim.sentTo(clienteDe(i));
      expect(enviados, t).toHaveLength(1);
      expect(enviados[0]!.phoneNumberId, t).toBe(numeroDe(t));
      expect(enviados[0]!.text, t).toContain(`Hola desde ${t}`);
      // El turno del agente supo en que sucursal entro el cliente (el prompt nombra la sucursal de entrada).
      expect(s.prompts[i]!.system, t).toContain(`Taqueria PM ${t}`);
      // La ventana de 24 h es por par numero-cliente: ese cliente NO tiene ventana en ningun otro numero.
      expect(stack.sim.isWindowOpen(clienteDe(i), numeroDe(t)), t).toBe(true);
      expect(stack.sim.isWindowOpen(clienteDe(i), PHONE_NUMBER_ID), t).toBe(false);
    }
    expect(stack.sim.rejected).toHaveLength(0);
  });

  it("2 sucursales SIN numero propio: sus clientes entran por el numero por defecto de la organizacion y la respuesta sale por ese mismo numero", async () => {
    s.guion(SIN_NUMERO);
    for (const [i] of SIN_NUMERO.entries()) {
      const d = await stack.sim.inbound({ from: clienteDe(100 + i), body: "Hola", phoneNumberId: PHONE_NUMBER_ID });
      expect(d.status).toBe(200);
    }
    await stack.dispatchWhatsApp();
    for (const [i, t] of SIN_NUMERO.entries()) {
      const enviados = stack.sim.sentTo(clienteDe(100 + i));
      expect(enviados, t).toHaveLength(1);
      expect(enviados[0]!.phoneNumberId, t).toBe(PHONE_NUMBER_ID);
      expect(enviados[0]!.text, t).toContain(`Hola desde ${t}`);
    }
    // Las sucursales con numero propio no intervinieron: ningun mensaje salio por sus numeros.
    for (const t of CON_NUMERO) expect(stack.sim.accepted.filter((m) => m.phoneNumberId === numeroDe(t)), t).toHaveLength(0);
  });

  it("un LOTE firmado con dos numeros en el mismo POST rutea cada change a su sucursal y responde por el numero de cada uno", async () => {
    s.guion(["T2", "T7"]);
    const d = await stack.sim.inboundLote([
      { from: clienteDe(200), body: "Hola T2", phoneNumberId: numeroDe("T2") },
      { from: clienteDe(201), body: "Hola T7", phoneNumberId: numeroDe("T7") },
    ]);
    expect(d.status).toBe(200);
    expect(JSON.parse(d.rawBody).entry[0].changes).toHaveLength(2);
    await stack.dispatchWhatsApp();
    const aT2 = stack.sim.sentTo(clienteDe(200));
    const aT7 = stack.sim.sentTo(clienteDe(201));
    expect(aT2.map((m) => m.phoneNumberId)).toEqual([numeroDe("T2")]);
    expect(aT7.map((m) => m.phoneNumberId)).toEqual([numeroDe("T7")]);
    expect(aT2[0]!.text).toContain("Hola desde T2");
    expect(aT7[0]!.text).toContain("Hola desde T7");
    expect(s.prompts[0]!.system).toContain("Taqueria PM T2");
    expect(s.prompts[1]!.system).toContain("Taqueria PM T7");
    expect(stack.sim.rejected).toHaveLength(0);
  });

  it("lote MIXTO (numero conocido + numero desconocido): se procesa el conocido y el desconocido se acusa sin arrastrar su mensaje a otra sucursal", async () => {
    s.guion(["T1"]);
    const d = await stack.sim.inboundLote([
      { from: clienteDe(300), body: "Hola T1", phoneNumberId: numeroDe("T1") },
      { from: clienteDe(301), body: "Hola, numero ajeno", phoneNumberId: "9999999999" },
    ]);
    expect(d.status).toBe(200);
    await stack.dispatchWhatsApp();
    expect(s.turnos()).toBe(1);
    expect(stack.sim.sentTo(clienteDe(300)).map((m) => m.phoneNumberId)).toEqual([numeroDe("T1")]);
    expect(stack.sim.sentTo(clienteDe(301))).toHaveLength(0);
  });

  it("numero DESCONOCIDO: 200 a Meta y nada se procesa (ni turno del agente, ni respuesta, ni conversacion)", async () => {
    s.guion(["NO DEBERIA LLAMARSE"]);
    const conversacionesAntes = stack.conversaciones.conversaciones.length;
    const d = await stack.sim.inbound({ from: clienteDe(400), body: "Hola", phoneNumberId: "9999999999" });
    expect(d.status).toBe(200);
    await stack.dispatchWhatsApp();
    expect(s.turnos()).toBe(0);
    expect(stack.sim.accepted).toHaveLength(0);
    expect(stack.conversaciones.conversaciones).toHaveLength(conversacionesAntes);
  });

  it("firma invalida: 401 y nada se procesa, aunque el numero sea conocido", async () => {
    s.guion(["NO DEBERIA LLAMARSE"]);
    const payload = stack.sim.buildInboundPayload({ from: clienteDe(500), body: "Hola", phoneNumberId: numeroDe("T1") });
    const d = await stack.sim.postRaw(JSON.stringify(payload), "sha256=falsa");
    expect(d.status).toBe(401);
    expect((await stack.sim.postRaw(JSON.stringify(payload), null)).status).toBe(401);
    expect(s.turnos()).toBe(0);
    expect(stack.sim.accepted).toHaveLength(0);
  });
});

describe("e2e WhatsApp multinumero — hoy: ecos ignorados (lo reemplazara el paquete 02)", () => {
  let stack: CicloStack;
  let turnos = 0;

  beforeEach(async () => {
    stack = await startCicloStack({ now: MIERCOLES_MEDIODIA });
    const propertyId = randomUUID();
    stack.ctx.restaurantesRepo.seedBranch({ propertyId, organizationId: stack.ctx.organizationId, name: "Taqueria PM T1", slug: "pm-t1", status: "active", phone: null, address: null, lat: null, lng: null });
    stack.ctx.restaurantesRepo.seedWhatsAppBranchChannel(stack.ctx.organizationId, propertyId, numeroDe("T1"));
    stack.sim.addPhoneNumberId(numeroDe("T1"));
    turnos = 0;
    stack.setScript([
      () => {
        turnos += 1;
        return { text: "NO DEBERIA LLAMARSE", model: "fake/scripted", tokensIn: 1, tokensOut: 1, costUsd: 0 };
      },
    ]);
  });
  afterEach(async () => {
    await stack?.stop();
  });

  const sinEfectos = async (): Promise<void> => {
    await stack.dispatchWhatsApp();
    expect(turnos).toBe(0);
    expect(stack.sim.accepted).toHaveLength(0);
    expect(stack.sim.rejected).toHaveLength(0);
    expect(stack.conversaciones.conversaciones).toHaveLength(0);
    expect(stack.conversaciones.handoffs).toHaveLength(0);
  };

  it("un eco de la app (smb_message_echoes) se acusa con 200 y NO escribe nada", async () => {
    const d = await stack.sim.ecoDeApp({ phoneNumberId: numeroDe("T1"), to: clienteDe(600), text: "Hola, soy el dueno desde la app" });
    expect(d.status).toBe(200);
    await sinEfectos();
  });

  it("un history se acusa con 200 y NO escribe nada", async () => {
    const d = await stack.sim.history({ phoneNumberId: numeroDe("T1"), threads: [{ customer: clienteDe(601), messages: [{ text: "mensaje viejo" }, { fromBusiness: true, text: "respuesta vieja" }] }] });
    expect(d.status).toBe(200);
    await sinEfectos();
  });

  it("un smb_app_state_sync se acusa con 200 y NO escribe nada", async () => {
    const d = await stack.sim.stateSync({ phoneNumberId: numeroDe("T1"), contacts: [{ fullName: "Ana Perez", phone: clienteDe(602) }] });
    expect(d.status).toBe(200);
    await sinEfectos();
  });
});

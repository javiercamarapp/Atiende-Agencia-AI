// Coexistencia PR-1/PR-2 punta a punta (simulador de Meta, repos en memoria, LLM guionado; nada real): el personal contesta desde la app
// (`smb_message_echoes`), el asistente se calla en esa conversacion, el cliente que escribe se guarda, y al devolver el asistente vuelve.
import { afterEach, describe, expect, it } from "vitest";
import { authedGet, authedJson } from "../restaurantes-admin-kpis-fixtures.ts";
import { say, startCicloStack } from "../support/e2e-ciclo-restaurantes.ts";
import type { CicloStack } from "../support/e2e-ciclo-restaurantes.ts";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const PHONE = "5219991230177";

describe("e2e coexistencia: el eco de la app silencia al asistente", () => {
  let stack: CicloStack;
  afterEach(async () => {
    await stack?.stop();
  });
  const admin = (path: string) => `/v1/restaurantes/${stack.propertyId}/admin${path}`;
  const conHilo = () => stack.ctx.restaurantesRepo.seedWhatsAppConversation(stack.ctx.organizationId, `+${PHONE}`, { messages: [{ role: "user", content: "Hola" }], status: "active", orderId: null, propertyId: null });
  const hilo = () => stack.ctx.restaurantesRepo.whatsappAppendTurn(stack.ctx.organizationId, `+${PHONE}`, [], null, null, null);

  it("eco -> toma por la app -> el cliente escribe y el asistente CALLA (mensaje guardado) -> el panel devuelve -> el asistente vuelve", async () => {
    stack = await startCicloStack();
    const owner = stack.ctx.staff.owner.token;
    // El asistente atiende normal antes de que el personal intervenga.
    stack.setScript([say("Hola, le atiende el asistente de la taqueria.")]);
    await stack.sim.deliverText(PHONE, "Hola, tienen servicio hoy?");
    expect(stack.sim.sentTo(PHONE)).toHaveLength(1);

    // El personal contesta desde la app: Meta manda el eco. El guion del LLM queda VACIO: cualquier turno del modelo reventaria el webhook.
    expect((await stack.sim.ecoDeApp({ to: PHONE, text: "Hola, soy Ana, ya le atiendo desde el telefono", id: "wamid.ECOCOEX1" })).status).toBe(200);
    const toma = stack.conversaciones.handoffs.find((h) => h.estado === "tomada");
    expect(toma).toEqual(expect.objectContaining({ tomadaPorApp: true, tomadaPor: null, motivo: "personal_app" }));

    const antes = stack.sim.sentTo(PHONE).length;
    expect((await stack.sim.deliverText(PHONE, "Perfecto, quiero 3 de pastor")).status).toBe(200);
    expect(stack.sim.sentTo(PHONE).length).toBe(antes);
    const h = await hilo();
    // (la primera respuesta del asistente lleva antepuesto el aviso de privacidad)
    expect(h.map((m) => [m.role, m.autor ?? null])).toEqual([["user", null], ["assistant", null], ["assistant", "humano_app"], ["user", null]]);
    expect(h.map((m) => m.content)).toEqual(["Hola, tienen servicio hoy?", expect.stringContaining("Hola, le atiende el asistente de la taqueria."), "Hola, soy Ana, ya le atiendo desde el telefono", "Perfecto, quiero 3 de pastor"]);

    // Bandeja del panel: la conversacion aparece tomada.
    const bandeja = (await (await fetch(stack.url(admin("/conversaciones?estado=tomada")), authedGet(owner))).json()) as Json;
    expect(bandeja.items).toHaveLength(1);

    // El gerente la devuelve desde el panel (sin tomarla antes: la toma es de la app) y el asistente vuelve a contestar.
    const devolver = await fetch(stack.url(admin(`/handoffs/${toma!.id}/devolver`)), authedJson(owner, {}, "POST"));
    expect(devolver.status).toBe(200);
    stack.setScript([say("Claro, 3 de pastor. Es para recoger o a domicilio?")]);
    await stack.sim.deliverText(PHONE, "para recoger");
    expect(stack.sim.lastSentTo(PHONE)?.text).toMatch(/3 de pastor/);
  });

  it("una persona del panel puede tomar la conversacion que abrio el eco (sin 409) y responder desde el panel", async () => {
    stack = await startCicloStack();
    const owner = stack.ctx.staff.owner.token;
    conHilo();
    await stack.sim.ecoDeApp({ to: PHONE, text: "Un momento por favor", id: "wamid.ECOCOEX2" });
    const toma = stack.conversaciones.handoffs.find((h) => h.estado === "tomada")!;
    const tomar = await fetch(stack.url(admin(`/conversaciones/whatsapp/${toma.conversationId}/tomar`)), authedJson(owner, {}, "POST"));
    expect(tomar.status).toBe(201);
    expect(stack.conversaciones.handoffs.find((h) => h.id === toma.id)).toEqual(expect.objectContaining({ tomadaPor: stack.ctx.staff.owner.id, tomadaPorApp: false }));
  });

  it("el mismo eco reintentado por Meta no abre otra toma ni duplica el mensaje", async () => {
    stack = await startCicloStack();
    conHilo();
    for (let i = 0; i < 3; i++) await stack.sim.ecoDeApp({ to: PHONE, text: "Ya va su pedido", id: "wamid.ECOCOEX3" });
    expect(await hilo()).toHaveLength(2);
    expect(stack.conversaciones.handoffs).toHaveLength(1);
  });

  it("P1-2: el eco de lo que mando la PLATAFORMA (respuesta del asistente) se descarta: no se duplica ni silencia al asistente (la respuesta del panel usa el mismo outbox/wamid; el stack e2e la encola en un outbox aparte)", async () => {
    stack = await startCicloStack();
    const owner = stack.ctx.staff.owner.token;
    stack.setScript([say("Hola, le atiende el asistente de la taqueria.")]);
    await stack.sim.deliverText(PHONE, "Hola, tienen servicio hoy?");
    const wamidAsistente = stack.sim.sentTo(PHONE)[0]!.id;
    // Meta devuelve tambien lo enviado por API: el eco del mensaje del asistente NO es del personal.
    expect((await stack.sim.ecoDeApp({ to: PHONE, text: "Hola, le atiende el asistente de la taqueria.", id: wamidAsistente })).status).toBe(200);
    expect(stack.conversaciones.handoffs).toHaveLength(0);
    expect((await hilo()).filter((m) => m.autor === "humano_app")).toHaveLength(0);
    // El asistente sigue contestando (no hubo auto-silencio).
    stack.setScript([say("Claro, con gusto.")]);
    await stack.sim.deliverText(PHONE, "quiero pedir");
    expect(stack.sim.lastSentTo(PHONE)?.text).toMatch(/con gusto/);
  });
});

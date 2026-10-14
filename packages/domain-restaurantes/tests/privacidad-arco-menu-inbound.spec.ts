// ARCO v2 dentro del webhook de WhatsApp: el menu nunca es un bucle, la senal debil no descarta el pedido, la solicitud se registra aunque haya otro riesgo alto, y la
// deteccion corre POR MENSAJE de una rafaga. Repositorios en memoria (mismo contrato que la base real).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleInboundWhatsAppMessage, previsualizarAtajoArco, recibirMensajeConEspera, responderTrasEspera } from "../src/whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import type { HandoffAgentGate } from "../src/conversaciones/repository.ts";
import type { ConversationMessage } from "../src/repository.ts";
import { InMemoryPrivacidadRepository } from "../src/privacidad/in-memory-repository.ts";
import { ARCO_MENU_APENDICE, ARCO_MENU_MARCA_NOMBRES, ARCO_MENU_MARCA_NUMERADO, ARCO_MENU_REPLY } from "../src/privacidad/data-rights.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const PHONE = "+5219981234567";
/** Formato canonico con el que se registran y buscan las solicitudes ARCO (+52 y 10 digitos). */
const PHONE_CANONICO = "+529981234567";
const RESPUESTA_LLM = "Claro, ¿qué desea pedir?";

function setup() {
  const { repo, organizationId } = buildRestaurantFixture();
  const privacy = new InMemoryPrivacidadRepository();
  const handle = vi.fn<WhatsAppTurnHandler["handleInboundMessage"]>(async () => ({ reply: RESPUESTA_LLM, orderId: null, propertyId: null }));
  const turnHandler: WhatsAppTurnHandler = { handleInboundMessage: handle };
  const solicitarHumano = vi.fn<HandoffAgentGate["solicitarHumano"]>(async () => "handoff-1");
  const handoffGate: HandoffAgentGate = { estadoParaAgente: async () => null, solicitarHumano };
  const send = (body: string, opts: { gate?: boolean; phone?: string } = {}) =>
    handleInboundWhatsAppMessage(repo, turnHandler, {
      organizationId,
      messageId: randomUUID(),
      phone: opts.phone ?? PHONE,
      body,
      phoneNumberId: "pn-1",
      privacy,
      ...(opts.gate === false ? {} : { handoffGate }),
    });
  return { repo, organizationId, privacy, handle, solicitarHumano, send, turnHandler };
}

describe("el menu ARCO NO es un bucle", () => {
  it("una pregunta explicita por derechos devuelve el menu numerado (sin pasar por el LLM) y NO registra nada todavia", async () => {
    const { send, handle, privacy } = setup();
    const out = await send("quiero ejercer mis derechos ARCO");
    expect(handle).not.toHaveBeenCalled();
    expect(out.reply).toContain(ARCO_MENU_MARCA_NUMERADO);
    expect(out.reply).toContain(ARCO_MENU_REPLY.slice(0, 40));
    expect(privacy.requests).toHaveLength(0);
  });

  it.each([
    ["Cancelación", "cancelacion"],
    ["la de cancelación", "cancelacion"],
    ["quiero la cancelacion", "cancelacion"],
    ["eliminar", "cancelacion"],
    ["borrar mis datos", "cancelacion"],
    ["3", "cancelacion"],
    ["la tercera", "cancelacion"],
    ["Rectificación", "rectificacion"],
    ["corregir", "rectificacion"],
    ["2", "rectificacion"],
    ["Oposición", "oposicion"],
    ["oponerme", "oposicion"],
    ["4", "oposicion"],
    ["Acceso", "acceso"],
    ["la primera", "acceso"],
    ["1", "acceso"],
    ["quiero saber que datos tienen", "acceso"],
  ] as const)("tras el menu, «%s» REGISTRA %s (y no vuelve a salir el menu)", async (respuesta, derecho) => {
    const { send, handle, privacy } = setup();
    await send("quiero ejercer mis derechos ARCO");
    const out = await send(respuesta);
    expect(handle).not.toHaveBeenCalled();
    expect(out.reply).not.toContain(ARCO_MENU_MARCA_NUMERADO);
    expect(out.reply).toContain("CONFIRMO");
    expect(privacy.requests).toHaveLength(1);
    expect(privacy.requests[0]).toMatchObject({ customerPhone: PHONE_CANONICO, rightType: derecho, status: "pendiente_confirmacion" });
  });

  it("nombre del derecho + CONFIRMO: la solicitud corre sus plazos (recorrido completo menu -> eleccion -> confirmacion)", async () => {
    const { send, privacy } = setup();
    await send("donde esta su aviso de privacidad");
    await send("Cancelación");
    const out = await send("CONFIRMO");
    expect(out.reply).toContain("quedó registrada");
    expect(privacy.requests[0]).toMatchObject({ rightType: "cancelacion", status: "recibida" });
  });

  it.each(["no sé", "todos", "cualquiera", "privacidad", "mis datos personales"])(
    "tras el menu, una respuesta que no elige («%s») NO repite el menu: registra la mejor conjetura (acceso) y escala a una persona",
    async (respuesta) => {
      const { send, handle, privacy, solicitarHumano } = setup();
      await send("quiero ejercer mis derechos ARCO");
      const out = await send(respuesta);
      expect(handle).not.toHaveBeenCalled();
      expect(out.reply).not.toContain(ARCO_MENU_MARCA_NUMERADO);
      expect(out.reply).toContain("registré su solicitud");
      expect(privacy.requests).toHaveLength(1);
      expect(privacy.requests[0]).toMatchObject({ customerPhone: PHONE_CANONICO, rightType: "acceso", status: "pendiente_confirmacion" });
      expect(solicitarHumano).toHaveBeenCalledTimes(1);
      expect(solicitarHumano.mock.calls[0]![0]).toMatchObject({ motivo: "privacidad_arco", phone: PHONE });
    },
  );

  it("«quiero hablar con una persona» tras el menu: registra la conjetura y la escalacion sale por el motivo del cliente (cliente_lo_pide)", async () => {
    const { send, privacy, solicitarHumano } = setup();
    await send("quiero ejercer mis derechos ARCO");
    const out = await send("quiero hablar con una persona");
    expect(privacy.requests).toHaveLength(1);
    expect(out.reply).toContain("registré su solicitud");
    expect(solicitarHumano.mock.calls[0]![0]).toMatchObject({ motivo: "cliente_lo_pide" });
  });

  it("varios derechos en la respuesta («cancelacion y acceso»): registra el mas amplio y avisa a una persona del resto", async () => {
    const { send, privacy, solicitarHumano } = setup();
    await send("quiero ejercer mis derechos ARCO");
    await send("cancelacion y acceso");
    expect(privacy.requests).toHaveLength(1);
    expect(privacy.requests[0]).toMatchObject({ rightType: "cancelacion" });
    expect(solicitarHumano).toHaveBeenCalledTimes(1);
  });

  it("tras el menu, un mensaje de PEDIDO sigue al agente (se abandona el menu, sin registrar)", async () => {
    const { send, handle, privacy } = setup();
    await send("quiero ejercer mis derechos ARCO");
    const out = await send("mejor quiero 2 tacos de pastor");
    expect(handle).toHaveBeenCalledTimes(1);
    expect(out.reply).toContain(RESPUESTA_LLM);
    expect(privacy.requests).toHaveLength(0);
  });

  it("sin handoffGate (base sin la 028) la respuesta de conjetura igual registra la solicitud", async () => {
    const { send, privacy } = setup();
    await send("quiero ejercer mis derechos ARCO", { gate: false });
    const out = await send("no sé", { gate: false });
    expect(out.reply).toContain("registré su solicitud");
    expect(privacy.requests).toHaveLength(1);
  });

  it("una peticion concreta tras el menu se registra tal cual (no es conjetura)", async () => {
    const { send, privacy, solicitarHumano } = setup();
    await send("quiero ejercer mis derechos ARCO");
    const out = await send("quiero que borren mis datos");
    expect(out.reply).not.toContain("registré su solicitud");
    expect(privacy.requests[0]).toMatchObject({ rightType: "cancelacion" });
    expect(solicitarHumano).not.toHaveBeenCalled();
  });
});

describe("senal debil: el agente SIGUE atendiendo y se agrega la oferta de derechos (el mensaje no se descarta)", () => {
  it("«borra mi cuenta» llega al LLM, su respuesta se conserva y al final va la oferta; no se registra nada", async () => {
    const { send, handle, privacy } = setup();
    const out = await send("borra mi cuenta");
    expect(handle).toHaveBeenCalledTimes(1);
    expect(out.reply).toContain(RESPUESTA_LLM);
    expect(out.reply).toContain(ARCO_MENU_APENDICE);
    expect(out.reply!.indexOf(RESPUESTA_LLM)).toBeLessThan(out.reply!.indexOf(ARCO_MENU_MARCA_NOMBRES));
    expect(privacy.requests).toHaveLength(0);
  });

  it("la oferta no se repite si el cliente sigue con una senal debil", async () => {
    const { send } = setup();
    await send("no me llamen");
    const segundo = await send("no me llamen");
    expect(segundo.reply).not.toContain(ARCO_MENU_MARCA_NOMBRES);
  });

  it("tras la oferta, el NOMBRE del derecho registra la solicitud", async () => {
    const { send, handle, privacy } = setup();
    await send("no me llamen");
    handle.mockClear();
    const out = await send("cancelación");
    expect(handle).not.toHaveBeenCalled();
    expect(out.reply).toContain("CONFIRMO");
    expect(privacy.requests[0]).toMatchObject({ rightType: "cancelacion" });
  });

  it("tras la oferta, un «2» o un «cancelar» siguen siendo del PEDIDO (no del menu)", async () => {
    const { send, handle, privacy } = setup();
    await send("borra mi cuenta");
    handle.mockClear();
    await send("2");
    await send("cancelar");
    expect(handle).toHaveBeenCalledTimes(2);
    expect(privacy.requests).toHaveLength(0);
  });

  it("«borrar mis datos» tras la oferta SI cuenta (lleva «mis datos»)", async () => {
    const { send, privacy } = setup();
    await send("borra mi cuenta");
    await send("borrar mis datos");
    expect(privacy.requests[0]).toMatchObject({ rightType: "cancelacion" });
  });
});

describe("senal fuerte mezclada con un pedido: se registra y se avisa que el pedido sigue disponible", () => {
  it("«2 tacos de pastor y que despues borren mis datos» registra la cancelacion y no deja al cliente sin saber del pedido", async () => {
    const { send, handle, privacy } = setup();
    const out = await send("Quiero 2 tacos de pastor y que después borren mis datos");
    expect(handle).not.toHaveBeenCalled();
    expect(privacy.requests).toHaveLength(1);
    expect(out.reply).toContain("su pedido");
    expect(out.reply).toContain("CONFIRMO");
  });
});

describe("otro riesgo alto NO salta el atajo ARCO: se registra Y se escala (el plazo corre desde la recepcion)", () => {
  it("«borren mis datos, soy alergico al cacahuate»: solicitud registrada + aviso a una persona por la alergia + las dos respuestas", async () => {
    const { send, handle, privacy, solicitarHumano } = setup();
    const out = await send("borren mis datos, soy alérgico al cacahuate");
    expect(handle).not.toHaveBeenCalled();
    expect(privacy.requests).toHaveLength(1);
    expect(privacy.requests[0]).toMatchObject({ rightType: "cancelacion", status: "pendiente_confirmacion" });
    expect(out.reply).toContain("CONFIRMO");
    expect(out.reply).toContain("ingredientes");
    expect(solicitarHumano).toHaveBeenCalledTimes(1);
    expect(solicitarHumano.mock.calls[0]![0]).toMatchObject({ motivo: "alergia_salud" });
  });

  it("queja + acceso a mis datos: tambien registra", async () => {
    const { send, privacy, solicitarHumano } = setup();
    await send("tengo una queja grave y quiero acceso a mis datos personales");
    expect(privacy.requests).toHaveLength(1);
    expect(solicitarHumano.mock.calls[0]![0]).toMatchObject({ motivo: "queja" });
  });

  it("sin handoffGate igual registra y responde las dos cosas", async () => {
    const { send, privacy } = setup();
    const out = await send("borren mis datos, soy alérgico al cacahuate", { gate: false });
    expect(privacy.requests).toHaveLength(1);
    expect(out.reply).toContain("CONFIRMO");
  });

  it("un MENU (sin registro) si cede ante otro riesgo alto: sigue al agente, que escala con el texto completo, como antes", async () => {
    const { send, handle, privacy } = setup();
    await send("soy alergico al cacahuate y quiero saber de sus derechos arco");
    expect(handle).toHaveBeenCalledTimes(1);
    expect(privacy.requests).toHaveLength(0);
  });
});

describe("la deteccion corre POR MENSAJE de la rafaga, no sobre el texto unido con salto de linea", () => {
  async function rafaga(textos: string[]) {
    const f = buildRestaurantFixture();
    const privacy = new InMemoryPrivacidadRepository();
    const handle = vi.fn<WhatsAppTurnHandler["handleInboundMessage"]>(async () => ({ reply: RESPUESTA_LLM, orderId: null, propertyId: null }));
    const ids = textos.map((_, i) => `wamid.${randomUUID()}.${i}`);
    for (let i = 0; i < textos.length; i++) await recibirMensajeConEspera(f.repo, { organizationId: f.organizationId, messageId: ids[i]!, phone: PHONE, body: textos[i]! });
    const out = await responderTrasEspera(f.repo, { handleInboundMessage: handle }, { organizationId: f.organizationId, messageId: ids[0]!, phone: PHONE, phoneNumberId: "pn-1", privacy });
    return { out, handle, privacy };
  }

  it("dos mensajes de PEDIDO cuyo texto unido parecia ARCO («borra el refresco» + «de mi cuenta») siguen al agente", async () => {
    const { handle, privacy } = await rafaga(["borra el refresco", "de mi cuenta"]);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(privacy.requests).toHaveLength(0);
  });

  it("un pedido y, en OTRO mensaje, una peticion ARCO: se registra la solicitud", async () => {
    const { handle, privacy, out } = await rafaga(["quiero 2 tacos de pastor", "ya no me manden publicidad"]);
    expect(handle).not.toHaveBeenCalled();
    expect(privacy.requests).toHaveLength(1);
    expect(privacy.requests[0]).toMatchObject({ rightType: "oposicion", customerPhone: PHONE_CANONICO });
    expect(out.reply).toContain("CONFIRMO");
  });

  it("senal debil en la rafaga: el agente contesta el pedido y se agrega la oferta", async () => {
    const { out, handle } = await rafaga(["quiero 2 tacos", "borra mi cuenta"]);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(out.reply).toContain(RESPUESTA_LLM);
    expect(out.reply).toContain(ARCO_MENU_MARCA_NOMBRES);
  });
});

describe("«Probar agente» (preview) usa el MISMO atajo, sobre un repositorio en memoria", () => {
  const u = (content: string): ConversationMessage => ({ role: "user", content });
  const a = (content: string): ConversationMessage => ({ role: "assistant", content });

  it("una peticion ARCO toma el turno con la misma respuesta que produccion", async () => {
    const r = await previsualizarAtajoArco([u("borren mis datos")]);
    expect(r).toMatchObject({ modo: "reemplaza" });
    expect(r!.reply).toContain("CONFIRMO");
  });

  it("el menu y su eleccion funcionan reconstruyendo el historial de la prueba", async () => {
    const menu = await previsualizarAtajoArco([u("derechos arco")]);
    expect(menu!.reply).toContain(ARCO_MENU_MARCA_NUMERADO);
    const eleccion = await previsualizarAtajoArco([u("derechos arco"), a(menu!.reply), u("Cancelación")]);
    expect(eleccion!.reply).toContain("CONFIRMO");
    expect(eleccion!.reply).toContain("cancelación");
    const confirmada = await previsualizarAtajoArco([u("derechos arco"), a(menu!.reply), u("Cancelación"), a(eleccion!.reply), u("CONFIRMO")]);
    expect(confirmada!.reply).toContain("quedó registrada");
  });

  it("senal debil: el preview devuelve modo agrega (el agente real contesta y se agrega la oferta)", async () => {
    expect(await previsualizarAtajoArco([u("no me llamen")])).toMatchObject({ modo: "agrega", reply: ARCO_MENU_APENDICE });
  });

  it("un pedido normal -> null", async () => {
    expect(await previsualizarAtajoArco([u("quiero 3 tacos de pastor")])).toBeNull();
  });

  it("no toca ninguna base: cada llamada usa un repositorio nuevo (dos pruebas seguidas no se contaminan)", async () => {
    expect(await previsualizarAtajoArco([u("CONFIRMO")])).toBeNull();
    await previsualizarAtajoArco([u("borren mis datos")]);
    expect(await previsualizarAtajoArco([u("CONFIRMO")])).toBeNull();
  });
});

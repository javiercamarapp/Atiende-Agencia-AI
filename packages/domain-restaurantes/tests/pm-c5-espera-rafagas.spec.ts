// PM-C5 (recomendacion 17): espera de rafagas. Dos fases con espera entre ellas: lo que llega durante la espera se agrega al historial y
// se contesta en UN solo turno; nada se pierde ni se contesta dos veces. Repositorio en memoria (mismo contrato de lease/append/dedupe).
import { describe, expect, it } from "vitest";
import { analizarHistorial, mensajesSinResponder, recibirMensajeConEspera, responderTrasEspera, handleInboundWhatsAppMessage, usuariosRespondidos, MAX_PASADAS_RAFAGA, PASADA_ESTIMADA_MS } from "../src/whatsapp/inbound.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import type { ConversationMessage } from "../src/repository.ts";
import type { HandoffAgentGate } from "../src/conversaciones/repository.ts";
import { actorHash } from "../src/rate-limit.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const TELEFONO = "+5219991234567";
const PN = "1234567890";

function montar(turnos: Array<(historial: readonly ConversationMessage[]) => void | Promise<void>> = []) {
  const f = buildRestaurantFixture();
  const vistos: Array<readonly ConversationMessage[]> = [];
  let n = 0;
  const handler: WhatsAppTurnHandler = {
    async handleInboundMessage({ messages }) {
      vistos.push(messages);
      await turnos[n]?.(messages);
      n += 1;
      return { reply: `respuesta ${n}`, orderId: null, propertyId: null };
    },
  };
  const argsFase1 = (messageId: string, body: string) => ({ organizationId: f.organizationId, messageId, phone: TELEFONO, body });
  const argsFase2 = (messageId: string, extra: Partial<Parameters<typeof responderTrasEspera>[2]> = {}) => ({ organizationId: f.organizationId, messageId, phone: TELEFONO, phoneNumberId: PN, ...extra });
  const salida = () => f.repo.getOutbox().map((o) => (o.payload as { body: string }).body);
  const historial = () => f.repo.whatsappAppendTurn(f.organizationId, TELEFONO, [], null, null, null);
  return { f, handler, vistos, argsFase1, argsFase2, salida, historial };
}

describe("mensajesSinResponder", () => {
  it("son los mensajes del cliente despues de la ultima respuesta del agente (todos si aun no contesta)", () => {
    const u = (content: string): ConversationMessage => ({ role: "user", content });
    const a = (content: string): ConversationMessage => ({ role: "assistant", content });
    expect(mensajesSinResponder([u("hola"), u("2 tacos")]).map((m) => m.content)).toEqual(["hola", "2 tacos"]);
    expect(mensajesSinResponder([u("hola"), a("buenas"), u("2 tacos"), u("de maiz")]).map((m) => m.content)).toEqual(["2 tacos", "de maiz"]);
    expect(mensajesSinResponder([u("hola"), a("buenas")])).toEqual([]);
    expect(mensajesSinResponder([])).toEqual([]);
  });
});

describe("analizarHistorial: lo pendiente se cuenta por mensaje del cliente, no por posicion", () => {
  const u = (content: string): ConversationMessage => ({ role: "user", content });
  const a = (content: string): ConversationMessage => ({ role: "assistant", content });

  it("un mensaje guardado ANTES de la respuesta de un turno que no lo vio sigue pendiente, y el modelo lo ve despues de esa respuesta", () => {
    // el cliente escribio u2 mientras el agente contestaba u1: se guardo [u1, u2, respuesta]
    const historial = [u("u1"), u("u2"), a("respuesta a u1")];
    expect(mensajesSinResponder(historial)).toEqual([]); // por posicion parece contestado: es justo el error que se evita
    const r = analizarHistorial(historial, 1);
    expect(r.pendientes.map((m) => m.content)).toEqual(["u2"]);
    expect(r.vista.map((m) => `${m.role}:${m.content}`)).toEqual(["user:u1", "assistant:respuesta a u1", "user:u2"]);
    expect(r.totalUsuarios).toBe(2);
  });

  it("sin mensajes tardios la vista es el historial tal cual", () => {
    const historial = [u("hola"), a("buenas"), u("2 tacos")];
    const r = analizarHistorial(historial, usuariosRespondidos(historial));
    expect(r.pendientes.map((m) => m.content)).toEqual(["2 tacos"]);
    expect(r.vista).toEqual(historial);
  });
});

describe("recibirMensajeConEspera (fase A)", () => {
  it("el primer mensaje agrega al historial y toma el turno de responder; el segundo queda absorbido (su texto ya esta en el historial)", async () => {
    const { f, argsFase1, historial } = montar();
    expect(await recibirMensajeConEspera(f.repo, argsFase1("wamid.1", "Hola"))).toEqual({ estado: "responder" });
    expect(await recibirMensajeConEspera(f.repo, argsFase1("wamid.2", "Quiero 2 tacos"))).toEqual({ estado: "absorbido" });
    expect((await historial()).map((m) => m.content)).toEqual(["Hola", "Quiero 2 tacos"]);
  });

  it("Meta entrega al menos una vez: un mensaje ya reclamado no se agrega ni se contesta dos veces", async () => {
    const { f, argsFase1, historial } = montar();
    await recibirMensajeConEspera(f.repo, argsFase1("wamid.1", "Hola"));
    expect(await recibirMensajeConEspera(f.repo, argsFase1("wamid.1", "Hola"))).toEqual({ estado: "duplicado" });
    expect(await historial()).toHaveLength(1);
  });

  it("redacta datos de tarjeta ANTES de guardar, igual que el camino sin espera", async () => {
    const { f, argsFase1, historial } = montar();
    await recibirMensajeConEspera(f.repo, argsFase1("wamid.1", "pago con 4111 1111 1111 1111"));
    expect((await historial())[0]!.content).toContain("[tarjeta oculta]");
    expect((await historial())[0]!.content).not.toContain("4111");
  });

  it("un fallo real marca el mensaje como fallido (Meta reintenta) y no deja el turno tomado", async () => {
    const { f, argsFase1, argsFase2, handler } = montar();
    f.repo.appendWhatsAppUserMessageOnce = async () => {
      throw new Error("boom");
    };
    expect(await recibirMensajeConEspera(f.repo, argsFase1("wamid.1", "Hola"))).toEqual({ estado: "fallo", retryable: true });
    // el turno quedo libre: otro mensaje puede tomarlo
    f.repo.appendWhatsAppUserMessageOnce = Object.getPrototypeOf(f.repo).appendWhatsAppUserMessageOnce.bind(f.repo);
    expect(await recibirMensajeConEspera(f.repo, argsFase1("wamid.2", "Hola otra vez"))).toEqual({ estado: "responder" });
    void argsFase2;
    void handler;
  });
});

describe("responderTrasEspera (fase B)", () => {
  it("una rafaga de 3 mensajes se contesta con UNA respuesta que ve los 3 (no 3 respuestas parciales)", async () => {
    const { f, handler, vistos, argsFase1, argsFase2, salida, historial } = montar();
    expect(await recibirMensajeConEspera(f.repo, argsFase1("wamid.1", "Hola"))).toEqual({ estado: "responder" });
    // -- durante la espera llegan dos mensajes mas (otras peticiones del webhook): quedan absorbidos
    expect(await recibirMensajeConEspera(f.repo, argsFase1("wamid.2", "Quiero 1/4 de bistec"))).toEqual({ estado: "absorbido" });
    expect(await recibirMensajeConEspera(f.repo, argsFase1("wamid.3", "con tortilla de maiz"))).toEqual({ estado: "absorbido" });
    const salidaB = await responderTrasEspera(f.repo, handler, argsFase2("wamid.1"));
    expect(salidaB).toMatchObject({ ok: true, retryable: false, reply: "respuesta 1" });
    expect(vistos).toHaveLength(1);
    expect(vistos[0]!.map((m) => m.content)).toEqual(["Hola", "Quiero 1/4 de bistec", "con tortilla de maiz"]);
    expect(salida()).toEqual(["respuesta 1"]);
    expect((await historial()).map((m) => `${m.role}:${m.content}`)).toEqual(["user:Hola", "user:Quiero 1/4 de bistec", "user:con tortilla de maiz", "assistant:respuesta 1"]);
  });

  it("deja el turno libre al terminar y marca los mensajes como procesados (el siguiente mensaje toma el turno solo)", async () => {
    const { f, handler, argsFase1, argsFase2 } = montar();
    await recibirMensajeConEspera(f.repo, argsFase1("wamid.1", "Hola"));
    await responderTrasEspera(f.repo, handler, argsFase2("wamid.1"));
    expect(await recibirMensajeConEspera(f.repo, argsFase1("wamid.2", "Otro pedido"))).toEqual({ estado: "responder" });
    // el mensaje ya procesado no se vuelve a reclamar
    expect(await recibirMensajeConEspera(f.repo, argsFase1("wamid.1", "Hola"))).toEqual({ estado: "duplicado" });
  });

  it("un mensaje que llega MIENTRAS el agente contesta no se pierde: se contesta en una segunda pasada, con su propia respuesta", async () => {
    let llegoTarde: Promise<unknown> = Promise.resolve();
    const ctx = montar([
      async () => {
        // durante el turno 1 llega otro mensaje: el turno sigue tomado, asi que queda absorbido
        llegoTarde = recibirMensajeConEspera(ctx.f.repo, ctx.argsFase1("wamid.2", "y una orden de frijol"));
        await llegoTarde;
      },
    ]);
    await recibirMensajeConEspera(ctx.f.repo, ctx.argsFase1("wamid.1", "Quiero 1/4 de bistec"));
    const r = await responderTrasEspera(ctx.f.repo, ctx.handler, ctx.argsFase2("wamid.1"));
    expect(r).toMatchObject({ ok: true, reply: "respuesta 2" });
    expect(ctx.vistos).toHaveLength(2);
    expect(ctx.vistos[0]!.map((m) => m.content)).toEqual(["Quiero 1/4 de bistec"]);
    expect(ctx.vistos[1]!.map((m) => `${m.role}:${m.content}`)).toEqual(["user:Quiero 1/4 de bistec", "assistant:respuesta 1", "user:y una orden de frijol"]);
    expect(ctx.salida()).toEqual(["respuesta 1", "respuesta 2"]);
  });

  it(`nunca da mas de ${MAX_PASADAS_RAFAGA} turnos en una misma peticion (un cliente que no deja de escribir no la deja colgada)`, async () => {
    let n = 0;
    const ctx = montar(Array.from({ length: 10 }, () => async () => {
      n += 1;
      await recibirMensajeConEspera(ctx.f.repo, ctx.argsFase1(`wamid.extra${n}`, `mensaje ${n}`));
    }));
    await recibirMensajeConEspera(ctx.f.repo, ctx.argsFase1("wamid.1", "inicio"));
    await responderTrasEspera(ctx.f.repo, ctx.handler, ctx.argsFase2("wamid.1"));
    expect(ctx.vistos).toHaveLength(MAX_PASADAS_RAFAGA);
    expect(ctx.salida()).toHaveLength(MAX_PASADAS_RAFAGA);
  });

  it("no empieza otra pasada si ya no cabe antes del fin de la funcion: la respuesta de la pasada 1 queda, lo pendiente se marca failed y Meta reintenta", async () => {
    let ahora = 0;
    const ctx = montar([
      async () => {
        // durante el turno 1 llega otro mensaje y el turno consume casi todo el tiempo que queda
        await recibirMensajeConEspera(ctx.f.repo, ctx.argsFase1("wamid.2", "y una orden de frijol"));
        ahora = 30_000 - PASADA_ESTIMADA_MS + 1;
      },
    ]);
    await recibirMensajeConEspera(ctx.f.repo, ctx.argsFase1("wamid.1", "Quiero 1/4 de bistec"));
    const r = await responderTrasEspera(ctx.f.repo, ctx.handler, ctx.argsFase2("wamid.1", { finFuncionMs: 30_000, reloj: () => ahora }));
    expect(r).toEqual({ ok: false, retryable: true });
    expect(ctx.vistos).toHaveLength(1); // no hubo pasada 2
    expect(ctx.salida()).toEqual(["respuesta 1"]); // la respuesta de la pasada 1 sigue en el outbox
    // el turno quedo libre: un mensaje nuevo lo toma y contesta lo pendiente
    await expect(ctx.f.repo.claimWhatsAppConversation(ctx.f.organizationId, actorHash(TELEFONO), "wamid.3", 45)).resolves.toBe(true);
  });

  it("con tiempo de sobra la segunda pasada corre igual (el limite solo recorta cuando no cabe)", async () => {
    const ctx = montar([
      async () => {
        await recibirMensajeConEspera(ctx.f.repo, ctx.argsFase1("wamid.2", "y una orden de frijol"));
      },
    ]);
    await recibirMensajeConEspera(ctx.f.repo, ctx.argsFase1("wamid.1", "Quiero 1/4 de bistec"));
    const r = await responderTrasEspera(ctx.f.repo, ctx.handler, ctx.argsFase2("wamid.1", { finFuncionMs: 30_000, reloj: () => 1_000 }));
    expect(r).toMatchObject({ ok: true, reply: "respuesta 2" });
    expect(ctx.salida()).toEqual(["respuesta 1", "respuesta 2"]);
  });

  it("si ya alguien contesto todo (nada pendiente), no vuelve a contestar", async () => {
    const { f, handler, vistos, argsFase1, argsFase2, salida } = montar();
    await recibirMensajeConEspera(f.repo, argsFase1("wamid.1", "Hola"));
    await responderTrasEspera(f.repo, handler, argsFase2("wamid.1"));
    const otra = await responderTrasEspera(f.repo, handler, argsFase2("wamid.1"));
    expect(otra).toMatchObject({ ok: true, retryable: false });
    expect(vistos).toHaveLength(1);
    expect(salida()).toEqual(["respuesta 1"]);
  });

  it("con una toma de handoff abierta el agente calla (el mensaje queda en el historial para la persona) y no entra en bucle", async () => {
    const { f, handler, vistos, argsFase1, argsFase2, salida } = montar();
    const handoffGate = { estadoParaAgente: async () => ({ abierto: true }), solicitarHumano: async () => undefined } as unknown as HandoffAgentGate;
    await recibirMensajeConEspera(f.repo, argsFase1("wamid.1", "Quiero hablar con alguien"));
    const r = await responderTrasEspera(f.repo, handler, argsFase2("wamid.1", { handoffGate }));
    expect(r).toMatchObject({ ok: true, retryable: false });
    expect(vistos).toHaveLength(0);
    expect(salida()).toEqual([]);
  });

  it("un fallo del turno marca el mensaje como fallido y retryable, sin respuesta a medias, y libera el turno", async () => {
    const { f, argsFase1, argsFase2, salida } = montar();
    const roto: WhatsAppTurnHandler = {
      async handleInboundMessage() {
        throw new Error("proveedor caido");
      },
    };
    await recibirMensajeConEspera(f.repo, argsFase1("wamid.1", "Hola"));
    expect(await responderTrasEspera(f.repo, roto, argsFase2("wamid.1"))).toEqual({ ok: false, retryable: true });
    expect(salida()).toEqual([]);
    // el turno quedo libre y el mensaje es reclamable de nuevo (Meta reintenta)
    expect(await recibirMensajeConEspera(f.repo, argsFase1("wamid.1", "Hola"))).toMatchObject({ estado: expect.stringMatching(/responder|absorbido/) });
  });

  it("el primer contacto (aviso de privacidad) se detecta aunque ya haya varios mensajes del cliente antes de la primera respuesta", async () => {
    const { f, handler, argsFase1, argsFase2, salida } = montar();
    const privacy = {
      getPrivacyConfig: async () => ({ noticeVersion: "v1", responsableNombre: "PM", contacto: "x@y.z" }),
      claimPrivacyNotice: async () => null, // base sin la migracion 030: se decide por el historial
    } as never;
    await recibirMensajeConEspera(f.repo, argsFase1("wamid.1", "Hola"));
    await recibirMensajeConEspera(f.repo, argsFase1("wamid.2", "Quiero un pedido"));
    await responderTrasEspera(f.repo, handler, argsFase2("wamid.1", { privacy }));
    expect(salida()[0]).toContain("respuesta 1");
    expect(salida()[0]!.length).toBeGreaterThan("respuesta 1".length); // antepuso el aviso aunque el historial tenia 2 mensajes
    await recibirMensajeConEspera(f.repo, argsFase1("wamid.3", "gracias"));
    await responderTrasEspera(f.repo, handler, argsFase2("wamid.3", { privacy }));
    expect(salida()[1]).toBe("respuesta 2"); // ya no es primer contacto: sin aviso
  });
});

describe("el camino sin espera no cambia", () => {
  it("handleInboundWhatsAppMessage sigue contestando un mensaje por turno, sin fases", async () => {
    const { f, handler, vistos, salida } = montar();
    const r = await handleInboundWhatsAppMessage(f.repo, handler, { organizationId: f.organizationId, messageId: "wamid.1", phone: TELEFONO, body: "Hola", phoneNumberId: PN });
    expect(r).toMatchObject({ ok: true, reply: "respuesta 1" });
    expect(vistos[0]!.map((m) => m.content)).toEqual(["Hola"]);
    expect(salida()).toEqual(["respuesta 1"]);
  });
});

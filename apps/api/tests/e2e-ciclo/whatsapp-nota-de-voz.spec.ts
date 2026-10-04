// R-32: ciclo e2e por WhatsApp con NOTAS DE VOZ. Meta (simulador: webhook firmado Y descarga de media con token) -> webhook real ->
// descarga + transcripcion (rol `restaurantes:transcripcion` con un modelo de audio FALSO) -> agente guionado -> motor real de pedidos.
// Sin red, sin credenciales: el banco e2e bloquea cualquier host que no sea el simulador.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITE_NOTAS_POR_CONVERSACION_HORA, PREFIJO_NOTA_DE_VOZ } from "@atiende/domain-restaurantes";
import type { LlmCompletionRequest } from "@atiende/agent-core";
import { call, say, startCicloStack } from "../support/e2e-ciclo-restaurantes.ts";
import type { CicloStack, ScriptStep } from "../support/e2e-ciclo-restaurantes.ts";

const PHONE = "5219991230031";

/** Ogg minimo valido para el descargador: una pagina "OggS" con la posicion de granulo (Opus cuenta a 48 kHz). */
function fakeOgg(seconds: number): Uint8Array {
  const page = new Uint8Array(27 + 400).fill(7);
  page.set([0x4f, 0x67, 0x67, 0x53], 0);
  new DataView(page.buffer).setBigUint64(6, BigInt(Math.round(seconds * 48_000)), true);
  return page;
}

/** Paso de guion que registra el ULTIMO mensaje de usuario que vio el agente y responde texto. */
function sayVisto(vistos: string[], text: string): ScriptStep {
  return (req: LlmCompletionRequest) => {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    vistos.push(lastUser?.content ?? "");
    return say(text)(req);
  };
}

describe("e2e WhatsApp: nota de voz", () => {
  let stack: CicloStack;
  let consola: string[];
  beforeEach(() => {
    consola = [];
    for (const nivel of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, nivel).mockImplementation((...args: unknown[]) => {
        consola.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
  });
  afterEach(async () => {
    await stack?.stop();
    vi.restoreAllMocks();
  });

  it("cliente nuevo: la nota de voz se transcribe, el agente cotiza y pide confirmacion; el pedido solo se crea tras la confirmacion en el mensaje siguiente", async () => {
    stack = await startCicloStack();
    const { sim, products } = stack;
    const items = [
      { product_id: products.bistec3, product_name: "Tacos de Bistec de Res (orden de 3)", requested_quantity: 3, tortilla: "maiz" },
      { product_id: products.pastor, product_name: "Tacos al Pastor (orden de 3)", requested_quantity: 3, tortilla: "maiz" },
    ];
    const vistos: string[] = [];
    stack.setTranscripcion("hola quiero tres tacos de bistec de maiz a domicilio en francisco de montejo");
    stack.setScript([
      (req) => {
        vistos.push([...req.messages].reverse().find((m) => m.role === "user")!.content);
        return call("buscar_cliente", {})(req);
      },
      call("buscar_sucursal_cercana", { colonia: "Francisco de Montejo" }),
      call("cotizar_pedido", { branch_slug: "fco-montejo", canal: "domicilio", colonia_entrega: "Francisco de Montejo", items }),
      say("Entendi 3 de bistec y 3 de pastor por $284. ¿Efectivo o tarjeta y confirma?"),
    ]);

    const bytes = fakeOgg(6);
    const mediaId = sim.registerMedia({ bytes, mimeType: "audio/ogg; codecs=opus" });
    const first = await sim.deliverAudio(PHONE, mediaId);
    expect(first.status).toBe(200);

    // El agente recibio la transcripcion marcada, no la nota que pide escribir.
    expect(vistos[0]).toBe(`${PREFIJO_NOTA_DE_VOZ} hola quiero tres tacos de bistec de maiz a domicilio en francisco de montejo`);
    // El modelo de audio recibio el audio real (base64 + formato) y la descarga fue en dos pasos con token.
    expect(stack.transcripcionesSolicitadas).toHaveLength(1);
    const msg = stack.transcripcionesSolicitadas[0]!.messages[0]!;
    expect(msg.role === "user" && msg.audio).toEqual({ data: Buffer.from(bytes).toString("base64"), format: "ogg" });
    expect(sim.mediaRequests.map((r) => r.step)).toEqual(["metadata", "bytes"]);
    // Cotizo y pidio confirmacion, pero NO creo el pedido (la transcripcion nunca salta cotizar/confirmar).
    expect(sim.lastSentTo(PHONE)?.text).toMatch(/confirma/);
    const sinPedido = await stack.ctx.restaurantesRepo.listOrders(stack.ctx.organizationId, { propertyIds: null, limit: 10 } as never);
    expect(sinPedido.orders).toHaveLength(0);

    // Confirmacion por TEXTO en el mensaje siguiente -> confirmar_resumen + crear_pedido.
    stack.setScript([
      call("confirmar_resumen", {}),
      call("crear_pedido", { branch_slug: "fco-montejo", canal: "domicilio", colonia_entrega: "Francisco de Montejo", customer_name: "Ana Prueba", customer_address: "Calle 21 #310 x 36 y 38, Francisco de Montejo", payment_method: "efectivo", items }),
      say("Listo, tu pedido quedo registrado y va a cocina."),
    ]);
    const second = await sim.deliverText(PHONE, "Si, en efectivo. Soy Ana Prueba, Calle 21 #310 x 36 y 38");
    expect(second.status).toBe(200);
    const list = await stack.ctx.restaurantesRepo.listOrders(stack.ctx.organizationId, { propertyIds: null, limit: 10 } as never);
    expect(list.orders).toHaveLength(1);
    expect(list.orders[0]).toMatchObject({ total: 284, source: "whatsapp", customerPhone: "9991230031" });
    expect(sim.rejected).toHaveLength(0);
  });

  it("tope alcanzado: la nota N+1 de la hora NO se transcribe y el agente recibe la nota que pide escribir", async () => {
    stack = await startCicloStack();
    const { sim } = stack;
    const vistos: string[] = [];
    stack.setTranscripcion("quiero un pedido");
    stack.setScript(Array.from({ length: LIMITE_NOTAS_POR_CONVERSACION_HORA + 1 }, (_, i) => sayVisto(vistos, `respuesta ${i + 1}`)));
    for (let i = 0; i <= LIMITE_NOTAS_POR_CONVERSACION_HORA; i++) {
      const mediaId = sim.registerMedia({ bytes: fakeOgg(3), mimeType: "audio/ogg" });
      expect((await sim.deliverAudio(PHONE, mediaId)).status).toBe(200);
    }
    expect(stack.transcripcionesSolicitadas).toHaveLength(LIMITE_NOTAS_POR_CONVERSACION_HORA);
    expect(vistos.slice(0, LIMITE_NOTAS_POR_CONVERSACION_HORA).every((v) => v.startsWith(PREFIJO_NOTA_DE_VOZ))).toBe(true);
    expect(vistos.at(-1)).toMatch(/nota de voz que este asistente no puede escuchar/);
    // La nota excedida ni siquiera se descargo: solo hubo descargas para las transcritas.
    expect(sim.mediaRequests.filter((r) => r.step === "bytes")).toHaveLength(LIMITE_NOTAS_POR_CONVERSACION_HORA);
    expect(consola.join("\n")).toContain('"motivo":"tope_conversacion"');
  });

  it("replay de Meta con el mismo message.id: una sola transcripcion, una sola descarga y un solo turno del agente", async () => {
    stack = await startCicloStack();
    const { sim } = stack;
    const vistos: string[] = [];
    stack.setTranscripcion("quiero dos de pastor");
    stack.setScript([sayVisto(vistos, "Claro, ¿para recoger o a domicilio?")]);
    const mediaId = sim.registerMedia({ bytes: fakeOgg(4), mimeType: "audio/ogg; codecs=opus" });
    const first = await sim.deliverAudio(PHONE, mediaId, { id: "wamid.VOZ-REPLAY" });
    expect(first.status).toBe(200);
    const replay = await sim.replay(first);
    expect(replay.status).toBe(200);
    expect(stack.transcripcionesSolicitadas).toHaveLength(1);
    expect(sim.mediaRequests.filter((r) => r.step === "bytes")).toHaveLength(1);
    expect(vistos).toHaveLength(1);
    expect(sim.sentTo(PHONE).filter((m) => /recoger o a domicilio/.test(m.text ?? ""))).toHaveLength(1);
  });

  it.each([
    ["una imagen (tipo no permitido)", () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" })],
    ["un audio demasiado largo", () => ({ bytes: fakeOgg(600), mimeType: "audio/ogg" })],
    ["un audio demasiado grande", () => ({ bytes: new Uint8Array(4 * 1024 * 1024).fill(1), mimeType: "audio/mpeg" })],
  ])("%s: no se transcribe y se conserva el comportamiento anterior (pedir texto)", async (_nombre, media) => {
    stack = await startCicloStack();
    const vistos: string[] = [];
    stack.setTranscripcion("no debe llamarse");
    stack.setScript([sayVisto(vistos, "¿Me lo puede escribir, por favor?")]);
    const mediaId = stack.sim.registerMedia(media());
    expect((await stack.sim.deliverAudio(PHONE, mediaId)).status).toBe(200);
    expect(stack.transcripcionesSolicitadas).toHaveLength(0);
    expect(vistos[0]).toMatch(/nota de voz que este asistente no puede escuchar/);
  });

  it("media inexistente o token de Meta invalido: el cliente recibe respuesta (pide texto), nunca un 500 ni un reintento infinito", async () => {
    stack = await startCicloStack();
    const vistos: string[] = [];
    stack.setScript([sayVisto(vistos, "Por favor escribame su pedido.")]);
    const res = await stack.sim.deliverAudio(PHONE, "MEDIA-QUE-NO-EXISTE", { mimeType: "audio/ogg" });
    expect(res.status).toBe(200);
    expect(vistos[0]).toMatch(/no puede escuchar/);
    expect(consola.join("\n")).toContain('"motivo":"descarga_fallo"');
  });

  it("el modelo de audio falla: se conserva el comportamiento anterior y el webhook responde 200", async () => {
    stack = await startCicloStack();
    const vistos: string[] = [];
    stack.setTranscripcion(() => {
      throw new Error("modelo caido");
    });
    stack.setScript([sayVisto(vistos, "¿Me lo escribe?")]);
    const mediaId = stack.sim.registerMedia({ bytes: fakeOgg(3), mimeType: "audio/ogg" });
    expect((await stack.sim.deliverAudio(PHONE, mediaId)).status).toBe(200);
    expect(vistos[0]).toMatch(/no puede escuchar/);
    expect(consola.join("\n")).toContain('"motivo":"transcripcion_fallo"');
  });

  it("sin puerto de notas de voz (sin token de Meta o sin gateway): mismo comportamiento de antes, sin tocar a Meta ni al modelo de audio", async () => {
    stack = await startCicloStack({ sinNotasDeVoz: true });
    const vistos: string[] = [];
    stack.setScript([sayVisto(vistos, "¿Me lo escribe?")]);
    const mediaId = stack.sim.registerMedia({ bytes: fakeOgg(3), mimeType: "audio/ogg" });
    expect((await stack.sim.deliverAudio(PHONE, mediaId)).status).toBe(200);
    expect(vistos[0]).toMatch(/no puede escuchar/);
    expect(stack.sim.mediaRequests).toHaveLength(0);
    expect(stack.transcripcionesSolicitadas).toHaveLength(0);
    expect(consola.join("\n")).toContain('"motivo":"no_configurado"');
  });

  it("privacidad: ningun log contiene la URL de media, el id de media, el audio en base64 ni el telefono", async () => {
    stack = await startCicloStack();
    const bytes = fakeOgg(5);
    const mediaId = stack.sim.registerMedia({ bytes, mimeType: "audio/ogg" }, "MEDIAIDSECRETO42");
    stack.setTranscripcion("quiero tres tacos");
    stack.setScript([say("Claro."), say("Claro.")]);
    await stack.sim.deliverAudio(PHONE, mediaId);
    // y un fallo (media inexistente) tambien: sus errores no deben arrastrar la URL ni el id.
    await stack.sim.deliverAudio(PHONE, "OTROMEDIAID99", { mimeType: "audio/ogg" });
    const salida = consola.join("\n");
    expect(salida.length).toBeGreaterThan(0);
    for (const secreto of ["media-cdn", "MEDIAIDSECRETO42", "OTROMEDIAID99", Buffer.from(bytes).toString("base64").slice(0, 40), PHONE]) {
      expect(salida, `el log contiene ${secreto.slice(0, 12)}...`).not.toContain(secreto);
    }
  });
});

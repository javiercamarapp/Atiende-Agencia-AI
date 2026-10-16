// R12 -- entradas y salidas: regresion de R11-08, R11-09, R11-11, R11-12 y R11-13 (parte de recorte).
// Modelo simulado, repositorio en memoria, sin red ni LLM real. Los textos describen la CLASE del intento.
import { describe, expect, it, vi } from "vitest";
import { registerCallbackRequest } from "../../src/callback-requests.ts";
import { MENSAJE_CLIENTE_MAX_CARACTERES, RESPUESTA_PARTE_MAX_CARACTERES, dividirRespuestaLarga, handleInboundWhatsAppMessage, limitarLargoDelMensaje, sanearTextoEntrante } from "../../src/whatsapp/inbound.ts";
import { toRequestedItems } from "../../src/agent-tools/registry.ts";
import type { ConversationMessage } from "../../src/repository.ts";
import { PHONE, buildRestaurantFixture, handlerConGuion, texto } from "./arnes.ts";

const SUSTITUTO_SUELTO = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function grabador() {
  const vistos: ConversationMessage[][] = [];
  const turnHandler = {
    async handleInboundMessage(args: { messages: readonly ConversationMessage[] }) {
      vistos.push([...args.messages]);
      return { reply: "ok", orderId: null, propertyId: null };
    },
  };
  return { vistos, turnHandler };
}

describe("R12-A sanear y acotar el mensaje entrante", () => {
  it("quita NUL y controles C0/DEL pero conserva tab, salto de linea y retorno", () => {
    const sucio = "a\u0000b\u0001c\u0008d\u000Be\u000Cf\u000Eg\u001Fh\u007Fi\tj\nk\rl";
    const limpio = sanearTextoEntrante(sucio);
    expect(limpio).toBe("abcdefghi\tj\nk\rl");
    expect(limpio).not.toMatch(CONTROL);
  });

  it("un sustituto suelto que ya viene en el mensaje se reemplaza por U+FFFD; un emoji completo no se toca", () => {
    expect(sanearTextoEntrante("hola \uD83C quiero \uDF2E tacos")).toBe("hola � quiero � tacos");
    expect(sanearTextoEntrante("hola 🌮 y 👨‍👩‍👧‍👦")).toBe("hola 🌮 y 👨‍👩‍👧‍👦");
  });

  it("el corte por largo nunca deja un sustituto suelto, sea cual sea la paridad del corte", () => {
    for (const prefijo of ["", "a", "ab"]) {
      const cortado = limitarLargoDelMensaje(`${prefijo}${"🌮".repeat(2000)}`);
      expect(cortado, `prefijo ${prefijo.length}`).not.toMatch(SUSTITUTO_SUELTO);
      expect(cortado.length).toBeLessThanOrEqual(MENSAJE_CLIENTE_MAX_CARACTERES + 4);
      expect(cortado.endsWith(" […]")).toBe(true);
    }
  });

  it("un mensaje de solo controles queda vacio sin lanzar", () => {
    expect(limitarLargoDelMensaje("\u0000\u0000\u0001")).toBe("");
  });

  it("(webhook) NUL + emoji cortado a media: el turno corre, lo que ve el modelo no trae NUL ni sustituto suelto", async () => {
    const f = buildRestaurantFixture();
    const { vistos, turnHandler } = grabador();
    const cuerpo = `quiero\u0000 tacos a${"🌮".repeat(1500)}`;
    const out = await handleInboundWhatsAppMessage(f.repo, turnHandler as never, { organizationId: f.organizationId, messageId: "wamid.r12-nul", phone: PHONE, body: cuerpo, phoneNumberId: "pn-1" });
    expect(out).toMatchObject({ ok: true, retryable: false });
    const guardado = vistos[0]!.at(-1)!.content;
    expect(guardado).toContain("quiero tacos");
    expect(guardado).not.toMatch(CONTROL);
    expect(guardado).not.toMatch(SUSTITUTO_SUELTO);
    // y el JSON que va a jsonb no contiene escapes que Postgres rechace
    expect(JSON.stringify(vistos[0])).not.toMatch(/\\u0000|\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i);
  });

  it("(webhook) la repeticion del mismo message.id con NUL es idempotente: un solo turno y una sola respuesta encolada", async () => {
    const f = buildRestaurantFixture();
    const { vistos, turnHandler } = grabador();
    const encolados: string[] = [];
    const original = f.repo.enqueueMessagingOutbox.bind(f.repo);
    vi.spyOn(f.repo, "enqueueMessagingOutbox").mockImplementation(async (...a) => {
      encolados.push(String(a[3]));
      return original(...a);
    });
    const entrada = { organizationId: f.organizationId, messageId: "wamid.r12-rep", phone: PHONE, body: "hola\u0000 buenas", phoneNumberId: "pn-1" };
    const a = await handleInboundWhatsAppMessage(f.repo, turnHandler as never, entrada);
    const b = await handleInboundWhatsAppMessage(f.repo, turnHandler as never, entrada);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(vistos).toHaveLength(1);
    expect(encolados.filter((k) => k === "inbound-reply:wamid.r12-rep")).toHaveLength(1);
  });
});

describe("R12-B cantidades estrictas (R11-11)", () => {
  const validas: ReadonlyArray<readonly [unknown, number]> = [[2, 2], ["2", 2], [" 3 ", 3], ["007", 7]];
  it.each(validas)("cantidad %j -> %d", (entrada, esperado) => {
    expect(toRequestedItems([{ product_id: "p", requested_quantity: entrada }], true)[0]!.requestedQuantity).toBe(esperado);
    expect(toRequestedItems([{ product_id: "p", requested_quantity: entrada }], false)[0]!.requestedQuantity).toBe(esperado);
  });

  const invalidas: ReadonlyArray<unknown> = [true, false, [2], ["2"], "0x10", "1e3", "", "  ", "1.5", "-1", "+2", "dos", null, undefined, {}, "٣", "2 tacos"];
  it.each(invalidas)("cantidad %j se rechaza con lenient (WhatsApp)", (entrada) => {
    expect(() => toRequestedItems([{ product_id: "p", requested_quantity: entrada }], true)).toThrow();
  });
  it.each(invalidas)("cantidad %j no es una cantidad valida en voz/web (NaN para que el dominio la rechace)", (entrada) => {
    expect(Number.isFinite(toRequestedItems([{ product_id: "p", requested_quantity: entrada }], false)[0]!.requestedQuantity)).toBe(false);
  });
});

describe("R12-C respuestas largas (R11-12)", () => {
  it("dividirRespuestaLarga: texto corto = una parte; largo = partes <= 4000 que reconstruyen el contenido", () => {
    expect(dividirRespuestaLarga("hola")).toEqual(["hola"]);
    const largo = Array.from({ length: 300 }, (_, i) => `Linea ${i}: tenemos tacos de bistec, pastor y arrachera.`).join("\n");
    const partes = dividirRespuestaLarga(largo);
    expect(partes.length).toBeGreaterThan(1);
    for (const p of partes) expect(p.length).toBeLessThanOrEqual(RESPUESTA_PARTE_MAX_CARACTERES);
    expect(partes.join("\n").replace(/\s+/g, " ")).toBe(largo.replace(/\s+/g, " "));
  });

  it("sin espacios ni saltos y con emojis: corta duro sin partir un emoji", () => {
    for (const prefijo of ["", "a"]) {
      const partes = dividirRespuestaLarga(`${prefijo}${"🌮".repeat(5000)}`);
      for (const p of partes) {
        expect(p.length).toBeLessThanOrEqual(RESPUESTA_PARTE_MAX_CARACTERES);
        expect(p).not.toMatch(SUSTITUTO_SUELTO);
      }
      expect(partes.join("")).toBe(`${prefijo}${"🌮".repeat(5000)}`);
    }
  });

  it("(webhook) una respuesta de ~7000 caracteres se encola en partes con llaves inbound-reply:<id> y :<n>, y el reintento no duplica", async () => {
    const f = buildRestaurantFixture();
    const largo = `Claro. ${"Tenemos tacos de bistec, pastor y arrachera. ".repeat(160)}`;
    expect(largo.length).toBeGreaterThan(7000);
    const { handler } = handlerConGuion(f.repo, () => texto(largo));
    const encolados: Array<{ key: string; body: string }> = [];
    const original = f.repo.enqueueMessagingOutbox.bind(f.repo);
    vi.spyOn(f.repo, "enqueueMessagingOutbox").mockImplementation(async (...a) => {
      encolados.push({ key: String(a[3]), body: String((a[4] as { body?: unknown }).body ?? "") });
      return original(...a);
    });
    const entrada = { organizationId: f.organizationId, messageId: "wamid.r12-largo", phone: PHONE, body: "hola", phoneNumberId: "pn-1" };
    expect((await handleInboundWhatsAppMessage(f.repo, handler, entrada)).ok).toBe(true);
    const llaves = encolados.map((e) => e.key);
    expect(llaves[0]).toBe("inbound-reply:wamid.r12-largo");
    expect(llaves.slice(1).filter((k) => k.startsWith("inbound-reply:wamid.r12-largo:"))).toEqual(["inbound-reply:wamid.r12-largo:1"]);
    for (const e of encolados) expect(e.body.length).toBeLessThanOrEqual(RESPUESTA_PARTE_MAX_CARACTERES);
    // reintento del mismo mensaje: el dedupe del webhook no vuelve a encolar nada
    const antes = encolados.length;
    await handleInboundWhatsAppMessage(f.repo, handler, entrada);
    expect(encolados.length).toBe(antes);
    // y re-encolar con las mismas llaves (outbox) no crea filas nuevas
    const unicas = new Set(llaves);
    expect(unicas.size).toBe(llaves.length);
  });

  it("(webhook) una respuesta de 4096 o menos sigue saliendo como UN solo mensaje con la llave de siempre", async () => {
    const f = buildRestaurantFixture();
    const { handler } = handlerConGuion(f.repo, () => texto("Claro, con gusto. ".repeat(100)));
    const llaves: string[] = [];
    const original = f.repo.enqueueMessagingOutbox.bind(f.repo);
    vi.spyOn(f.repo, "enqueueMessagingOutbox").mockImplementation(async (...a) => {
      llaves.push(String(a[3]));
      return original(...a);
    });
    await handleInboundWhatsAppMessage(f.repo, handler, { organizationId: f.organizationId, messageId: "wamid.r12-corto", phone: PHONE, body: "hola", phoneNumberId: "pn-1" });
    expect(llaves).toEqual(["inbound-reply:wamid.r12-corto"]);
  });
});

describe("R12-D recorte del aviso al equipo (R11-13, parte TypeScript)", () => {
  it("registerCallbackRequest acota message a 1000 y customer_name a 120, sin NUL ni emoji partido", async () => {
    const f = buildRestaurantFixture();
    await registerCallbackRequest(f.repo, {
      organizationId: f.organizationId,
      propertyId: null,
      customerName: `${"N".repeat(119)}🌮\u0000${"N".repeat(500)}`,
      customerPhone: PHONE,
      reason: "otro",
      message: `${"m".repeat(999)}🌮${"m".repeat(5000)}`,
      source: "whatsapp",
    } as never);
    const [cb] = f.repo.listCallbackRequests(f.organizationId);
    expect(cb!.customerName.length).toBeLessThanOrEqual(120);
    expect(cb!.customerName).not.toMatch(CONTROL);
    expect(cb!.customerName).not.toMatch(SUSTITUTO_SUELTO);
    expect((cb!.message ?? "").length).toBeLessThanOrEqual(1000);
    expect(cb!.message ?? "").not.toMatch(SUSTITUTO_SUELTO);
  });

  it("un nombre que queda vacio tras limpiar cae a 'Cliente' en vez de lanzar; un aviso corto no se altera", async () => {
    const f = buildRestaurantFixture();
    await registerCallbackRequest(f.repo, { organizationId: f.organizationId, propertyId: null, customerName: "\u0000\u0001", customerPhone: PHONE, reason: "otro", message: "Quiere factura", source: "whatsapp" } as never);
    const [cb] = f.repo.listCallbackRequests(f.organizationId);
    expect(cb!.customerName).toBe("Cliente");
    expect(cb!.message).toBe("Quiere factura");
  });
});

// R-32: notas de voz de WhatsApp. Puerto falso (sin red): transcripcion, topes, motivos, idempotencia por ledger, privacidad de logs y
// el estado abortado de Postgres (AbortAwareFakeSession) cuando el limitador falla dentro de la transaccion del webhook.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractMetaInboundMessages } from "../src/whatsapp/channel-config.ts";
import { handleInboundWhatsAppMessage, recibirMensajeConEspera } from "../src/whatsapp/inbound.ts";
import {
  LIMITE_NOTAS_POR_CONVERSACION_HORA,
  LIMITE_NOTAS_POR_ORGANIZACION_DIA,
  NOTA_DE_VOZ_MAX_BYTES,
  NotaDeVozError,
  PREFIJO_NOTA_DE_VOZ,
  transcribirNotaDeVoz,
  type AudioDescargado,
  type PuertoNotasDeVoz,
} from "../src/whatsapp/nota-de-voz.ts";
import { FALLBACK_CONFIG, NOTA_DE_VOZ_RULES, PM_CONFIG_POR_OMISION, buildSystemPrompt } from "../src/whatsapp/llm-turn-handler.ts";
import { PostgresRestaurantesRepository } from "../src/postgres-repository.ts";
import type { WhatsAppTurnHandler } from "../src/whatsapp/turn-handler.ts";
import type { ConversationMessage } from "../src/repository.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";
import { buildRestaurantFixture } from "./fixtures.ts";

const FROM = "5219991234567";
const PHONE = `+${FROM}`;
const AUDIO = { mediaId: "MEDIA123", mimeType: "audio/ogg; codecs=opus" };
const OGG: AudioDescargado = { bytes: new Uint8Array([1, 2, 3, 4]), mimeType: "audio/ogg", durationSeconds: 5 };

function puerto(texto: string | Error = "quiero 3 de bistec"): PuertoNotasDeVoz & { descargas: number; transcripciones: number } {
  const p = {
    descargas: 0,
    transcripciones: 0,
    async descargar() {
      p.descargas += 1;
      return OGG;
    },
    async transcribir() {
      p.transcripciones += 1;
      if (texto instanceof Error) throw texto;
      return { texto };
    },
  };
  return p;
}

/** Turn handler que captura lo que el agente recibe como historial. */
function capturingTurnHandler(): WhatsAppTurnHandler & { vistos: ConversationMessage[][] } {
  const vistos: ConversationMessage[][] = [];
  return {
    vistos,
    async handleInboundMessage(args) {
      vistos.push([...args.messages]);
      return { reply: "Son 3 tacos de bistec, ¿confirma?", orderId: null, propertyId: null };
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("extractMetaInboundMessages con audio", () => {
  const payload = (message: Record<string, unknown>) => ({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "pn" }, messages: [{ id: "m1", from: FROM, ...message }] } }] }] });

  it("un audio con id y mime trae `audio` (y conserva el body anterior: pedir que escriba)", () => {
    const [m] = extractMetaInboundMessages(payload({ type: "audio", audio: { id: "ABC_123-x", mime_type: "audio/ogg; codecs=opus", voice: true } }));
    expect(m!.audio).toEqual({ mediaId: "ABC_123-x", mimeType: "audio/ogg; codecs=opus" });
    expect(m!.body).toMatch(/nota de voz/);
  });

  it("sin id valido (o con caracteres de ruta) no hay `audio`: sigue pidiendo texto, nunca se descarga nada", () => {
    for (const audio of [undefined, {}, { id: "../x", mime_type: "audio/ogg" }, { id: "A".repeat(200), mime_type: "audio/ogg" }, { id: "ok", mime_type: "" }]) {
      const [m] = extractMetaInboundMessages(payload({ type: "audio", audio }));
      expect(m!.audio).toBeUndefined();
      expect(m!.body).toMatch(/nota de voz/);
    }
  });

  it("una imagen o un documento nunca llevan `audio`", () => {
    const [m] = extractMetaInboundMessages(payload({ type: "image", image: { id: "x", mime_type: "image/jpeg" } }));
    expect(m!.audio).toBeUndefined();
  });
});

describe("transcribirNotaDeVoz", () => {
  it("descarga, transcribe y marca el texto con el prefijo", async () => {
    const { repo, organizationId } = buildRestaurantFixture();
    const p = puerto("  quiero\n3 de   bistec ");
    const r = await transcribirNotaDeVoz(repo, p, { organizationId, phone: PHONE, audio: AUDIO });
    expect(r).toEqual({ ok: true, texto: `${PREFIJO_NOTA_DE_VOZ} quiero 3 de bistec` });
  });

  it("tope por conversacion: la nota N+1 de la hora no se descarga ni se transcribe", async () => {
    const { repo, organizationId } = buildRestaurantFixture();
    const p = puerto();
    for (let i = 0; i < LIMITE_NOTAS_POR_CONVERSACION_HORA; i++) expect((await transcribirNotaDeVoz(repo, p, { organizationId, phone: PHONE, audio: AUDIO })).ok).toBe(true);
    const r = await transcribirNotaDeVoz(repo, p, { organizationId, phone: PHONE, audio: AUDIO });
    expect(r).toEqual({ ok: false, motivo: "tope_conversacion" });
    expect(p.transcripciones).toBe(LIMITE_NOTAS_POR_CONVERSACION_HORA);
    // Otro telefono de la misma organizacion NO queda bloqueado por la conversacion saturada.
    expect((await transcribirNotaDeVoz(repo, p, { organizationId, phone: "+5219990000001", audio: AUDIO })).ok).toBe(true);
  });

  it("tope diario por organizacion", async () => {
    const { repo, organizationId } = buildRestaurantFixture();
    const p = puerto();
    for (let i = 0; i < LIMITE_NOTAS_POR_ORGANIZACION_DIA; i++) {
      // un telefono distinto por nota para no chocar con el tope de conversacion
      expect((await transcribirNotaDeVoz(repo, p, { organizationId, phone: `+52199900${String(i).padStart(5, "0")}`, audio: AUDIO })).ok).toBe(true);
    }
    const aviso = vi.fn(async () => undefined);
    expect(await transcribirNotaDeVoz(repo, p, { organizationId, phone: "+5219991111111", audio: AUDIO, alTopeDeOrganizacion: aviso })).toEqual({ ok: false, motivo: "tope_organizacion" });
    expect(aviso).toHaveBeenCalledTimes(1);
    // Un fallo del aviso (notificacion) nunca cambia el resultado ni lanza.
    const roto = vi.fn(async () => Promise.reject(new Error("sin tabla")));
    expect(await transcribirNotaDeVoz(repo, p, { organizationId, phone: "+5219992222222", audio: AUDIO, alTopeDeOrganizacion: roto })).toEqual({ ok: false, motivo: "tope_organizacion" });
  });

  it.each([
    ["tipo_no_soportado", "descargar"],
    ["demasiado_grande", "descargar"],
    ["demasiado_larga", "descargar"],
    ["no_configurado", "descargar"],
    ["apagado", "transcribir"],
    ["transcripcion_fallo", "transcribir"],
  ] as const)("el motivo tipado %s del adaptador (%s) se conserva y nunca lanza", async (motivo, etapa) => {
    const { repo, organizationId } = buildRestaurantFixture();
    const error = new NotaDeVozError(motivo);
    const p: PuertoNotasDeVoz = {
      descargar: async () => {
        if (etapa === "descargar") throw error;
        return OGG;
      },
      transcribir: async () => {
        throw error;
      },
    };
    expect(await transcribirNotaDeVoz(repo, p, { organizationId, phone: PHONE, audio: AUDIO })).toEqual({ ok: false, motivo });
  });

  it("un error cualquiera de red es descarga_fallo / transcripcion_fallo, y una transcripcion vacia es transcripcion_vacia", async () => {
    const { repo, organizationId } = buildRestaurantFixture();
    const a = await transcribirNotaDeVoz(repo, { descargar: async () => Promise.reject(new Error("ECONNRESET")), transcribir: async () => ({ texto: "x" }) }, { organizationId, phone: PHONE, audio: AUDIO });
    expect(a).toEqual({ ok: false, motivo: "descarga_fallo" });
    const b = await transcribirNotaDeVoz(repo, puerto(new Error("boom")), { organizationId, phone: PHONE, audio: AUDIO });
    expect(b).toEqual({ ok: false, motivo: "transcripcion_fallo" });
    const c = await transcribirNotaDeVoz(repo, puerto("  "), { organizationId, phone: PHONE, audio: AUDIO });
    expect(c).toEqual({ ok: false, motivo: "transcripcion_vacia" });
  });

  it("defensa en profundidad: un adaptador que devuelve un audio por encima de los topes se rechaza igual", async () => {
    const { repo, organizationId } = buildRestaurantFixture();
    const largo: PuertoNotasDeVoz = { descargar: async () => ({ ...OGG, durationSeconds: 500 }), transcribir: async () => ({ texto: "hola" }) };
    expect(await transcribirNotaDeVoz(repo, largo, { organizationId, phone: PHONE, audio: AUDIO })).toEqual({ ok: false, motivo: "demasiado_larga" });
    const grande: PuertoNotasDeVoz = { descargar: async () => ({ ...OGG, bytes: new Uint8Array(NOTA_DE_VOZ_MAX_BYTES + 1) }), transcribir: async () => ({ texto: "hola" }) };
    expect(await transcribirNotaDeVoz(repo, grande, { organizationId, phone: PHONE, audio: AUDIO })).toEqual({ ok: false, motivo: "demasiado_grande" });
  });

  it("el log del motivo no lleva telefono, id de media ni texto", async () => {
    const { repo, organizationId } = buildRestaurantFixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await transcribirNotaDeVoz(repo, puerto(new Error("falla con MEDIA123 y 5219991234567")), { organizationId, phone: PHONE, audio: AUDIO });
    const logs = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logs).toContain("nota_de_voz_sin_transcribir");
    expect(logs).not.toMatch(/MEDIA123|5219991234567|quiero/);
  });
});

describe("handleInboundWhatsAppMessage con nota de voz", () => {
  const base = (fixture: ReturnType<typeof buildRestaurantFixture>, messageId: string) => ({
    organizationId: fixture.organizationId,
    messageId,
    phone: PHONE,
    body: "[El cliente envió una nota de voz que este asistente no puede escuchar. Pídale amablemente que escriba su mensaje por texto.]",
    phoneNumberId: "1234567890",
  });

  it("el agente recibe la transcripcion marcada en vez de la nota que pide escribir", async () => {
    const fixture = buildRestaurantFixture();
    const turn = capturingTurnHandler();
    const p = puerto("quiero 3 de bistec");
    const outcome = await handleInboundWhatsAppMessage(fixture.repo, turn, { ...base(fixture, "wamid.v1"), transcripcion: { audio: AUDIO, puerto: p } });
    expect(outcome).toMatchObject({ ok: true, retryable: false });
    expect(turn.vistos[0]!.at(-1)).toEqual({ role: "user", content: `${PREFIJO_NOTA_DE_VOZ} quiero 3 de bistec` });
  });

  it("replay de Meta con el mismo message.id: UNA sola transcripcion", async () => {
    const fixture = buildRestaurantFixture();
    const turn = capturingTurnHandler();
    const p = puerto();
    const args = { ...base(fixture, "wamid.replay"), transcripcion: { audio: AUDIO, puerto: p } };
    await handleInboundWhatsAppMessage(fixture.repo, turn, args);
    const second = await handleInboundWhatsAppMessage(fixture.repo, turn, args);
    expect(second).toEqual({ ok: true, retryable: false });
    expect(p.descargas).toBe(1);
    expect(p.transcripciones).toBe(1);
    expect(turn.vistos).toHaveLength(1);
  });

  it("sin transcripcion posible (error del puerto) se conserva EXACTAMENTE el comportamiento anterior: el agente ve la nota de pedir texto", async () => {
    const fixture = buildRestaurantFixture();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const turn = capturingTurnHandler();
    const args = base(fixture, "wamid.fallo");
    const outcome = await handleInboundWhatsAppMessage(fixture.repo, turn, { ...args, transcripcion: { audio: AUDIO, puerto: puerto(new NotaDeVozError("apagado")) } });
    expect(outcome).toMatchObject({ ok: true });
    expect(turn.vistos[0]!.at(-1)).toEqual({ role: "user", content: args.body });
  });

  it("sin puerto (sin credencial de Meta) no se intenta nada: mismo resultado que antes de R-32", async () => {
    const fixture = buildRestaurantFixture();
    const turn = capturingTurnHandler();
    const args = base(fixture, "wamid.sin-puerto");
    await handleInboundWhatsAppMessage(fixture.repo, turn, args);
    expect(turn.vistos[0]!.at(-1)).toEqual({ role: "user", content: args.body });
  });

  it("la transcripcion pasa por la redaccion de datos de pago antes de guardarse", async () => {
    const fixture = buildRestaurantFixture();
    const turn = capturingTurnHandler();
    await handleInboundWhatsAppMessage(fixture.repo, turn, { ...base(fixture, "wamid.pago"), transcripcion: { audio: AUDIO, puerto: puerto("mi tarjeta es 4111 1111 1111 1111") } });
    const guardado = turn.vistos[0]!.at(-1)!.content;
    expect(guardado).toContain("[tarjeta oculta]");
    expect(guardado).not.toContain("4111");
  });

  it("en la recepcion con espera de rafagas tambien se transcribe (despues del claim) y un duplicado no vuelve a gastar", async () => {
    const fixture = buildRestaurantFixture();
    const p = puerto("dos de pastor");
    const args = { organizationId: fixture.organizationId, messageId: "wamid.rafaga", phone: PHONE, body: "[nota]", transcripcion: { audio: AUDIO, puerto: p } };
    expect((await recibirMensajeConEspera(fixture.repo, args)).estado).toBe("responder");
    expect((await recibirMensajeConEspera(fixture.repo, args)).estado).toBe("duplicado");
    expect(p.transcripciones).toBe(1);
    const historial = await fixture.repo.whatsappAppendTurn(fixture.organizationId, PHONE, [], null, null, null);
    expect(historial.at(-1)).toEqual({ role: "user", content: `${PREFIJO_NOTA_DE_VOZ} dos de pastor` });
  });
});

describe("limitador con error de Postgres dentro de la transaccion del webhook (AbortAwareFakeSession)", () => {
  it("si consume_api_rate_limit falla, NO se transcribe (prudencia de gasto), la sesion sigue utilizable y el turno responde como antes", async () => {
    const organizationId = randomUUID();
    const err = Object.assign(new Error('function restaurantes.consume_api_rate_limit does not exist'), { code: "42883" });
    const session = new AbortAwareFakeSession([
      { match: /select restaurantes\.claim_whatsapp_message/, respond: () => [{ claim_whatsapp_message: true }] },
      { match: /select restaurantes\.claim_whatsapp_conversation/, respond: () => [{ claim_whatsapp_conversation: true }] },
      { match: /select restaurantes\.consume_api_rate_limit/, respond: () => err },
      { match: /select restaurantes\.append_whatsapp_user_message_once/, respond: () => [] },
      // Cliente 360: la memoria llega por `cliente_memoria` (null = cliente nuevo); la consulta directa es el camino sin migrar.
      { match: /select restaurantes\.cliente_memoria/, respond: () => [{ r: null }] },
      { match: /select id, organization_id, phone, name, order_count from restaurantes\.customers/, respond: () => [] },
      { match: /select restaurantes\.whatsapp_append_turn/, respond: () => [] },
      { match: /select restaurantes\.enqueue_messaging_outbox/, respond: () => [{ enqueue_messaging_outbox: randomUUID() }] },
      { match: /select restaurantes\.finish_whatsapp_message/, respond: () => [] },
      { match: /select 1/, respond: () => [] },
    ]);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const repo = new PostgresRestaurantesRepository(session);
    const p = puerto();
    const turn: WhatsAppTurnHandler = { handleInboundMessage: async () => ({ reply: "ok", orderId: null, propertyId: null }) };
    const outcome = await handleInboundWhatsAppMessage(repo, turn, {
      organizationId,
      messageId: randomUUID(),
      phone: PHONE,
      body: "nota",
      phoneNumberId: "1234567890",
      transcripcion: { audio: AUDIO, puerto: p },
    });
    expect(outcome).toMatchObject({ ok: true, retryable: false });
    expect(p.descargas).toBe(0);
    expect(session.calls.some((c) => c.startsWith("select restaurantes.append_whatsapp_user_message_once"))).toBe(true);
    expect(session.calls.some((c) => /ROLLBACK TO SAVEPOINT/i.test(c))).toBe(true);
  });
});

describe("prompt", () => {
  it("todos los perfiles llevan las reglas de nota de voz (transcripcion con errores, mismas reglas de cotizar/confirmar)", () => {
    const ahora = new Date("2026-10-06T19:00:00Z");
    const generico = buildSystemPrompt(FALLBACK_CONFIG, [], { isNew: true }, ahora);
    const pm = buildSystemPrompt(PM_CONFIG_POR_OMISION, [], { isNew: true }, ahora);
    expect(generico).toContain(NOTA_DE_VOZ_RULES);
    expect(pm).toContain(NOTA_DE_VOZ_RULES);
    expect(NOTA_DE_VOZ_RULES).toMatch(/NO cambia ninguna regla/);
  });
});

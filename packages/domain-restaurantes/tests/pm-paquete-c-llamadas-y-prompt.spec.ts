// PM Paquete C (seguimiento, demora, ráfagas, llamadas). Determinista, sin LLM ni llaves.
//  * Llamadas de WhatsApp (88 chats reales): el agente responde que por este medio no se reciben llamadas y ofrece escribir; sin modelo, sin aviso, sin pedido.
//  * Módulo de prompt del paquete C: seguimiento sin inventar estado, quejas sin reembolsos ni cortesías, ráfagas con autocorrección, cancelación por tardanza (no cambia la política).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COPY_LLAMADA_NO_RECIBIDA,
  COPY_LLAMADA_REPETIDA,
  PM_PAQUETE_C_PROMPT,
  esAvisoDeLlamada,
} from "../src/whatsapp/prompt-pm-paquete-c.ts";
import { MARTES_14H, nuevoViaje } from "./qa-viaje/arnes-viaje.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(MARTES_14H));
});
afterEach(() => vi.useRealTimers());

describe("Paquete C: detector de avisos de llamada", () => {
  it.each([
    "Llamada perdida",
    "llamada de voz perdida",
    "Videollamada perdida",
    "Llamada de video perdida",
    "Missed voice call",
    "missed video call",
    "📞 Llamada de voz perdida",
    "[El cliente intentó llamar por WhatsApp (llamada de voz o videollamada).]",
  ])("reconoce «%s»", (t) => expect(esAvisoDeLlamada(t)).toBe(true));

  it.each([
    "te llamo más tarde para confirmar",
    "quiero 3 tacos, llamada perdida ayer, por eso escribo",
    "¿pueden llamarme?",
    "hola",
    "",
    "llamada perdida ".repeat(20),
  ])("no confunde un mensaje de pedido o duda: «%s»", (t) => expect(esAvisoDeLlamada(t)).toBe(false));
});

describe("Paquete C: llamada de WhatsApp en el turno", () => {
  it("responde con el texto fijo, sin modelo, sin escalar y sin pedido", async () => {
    const v = await nuevoViaje();
    const r = await v.escribe("Llamada de voz perdida");
    expect(r.reply).toBe(COPY_LLAMADA_NO_RECIBIDA);
    expect(v.requests.length).toBe(0);
    expect(r.escalated).toBe(false);
    expect(v.callbacks.length).toBe(0);
  });

  it("COPY: dice que por este medio no se reciben llamadas y ofrece escribir; sin hora ni promesas", () => {
    expect(COPY_LLAMADA_NO_RECIBIDA).toMatch(/por este medio no recibimos llamadas/i);
    expect(COPY_LLAMADA_NO_RECIBIDA).toMatch(/escr[ií]ba/i);
    for (const c of [COPY_LLAMADA_NO_RECIBIDA, COPY_LLAMADA_REPETIDA]) expect(c).not.toMatch(/\d{1,2}:\d{2}|minutos|reembols|cortes[ií]a/i);
  });

  it("tres llamadas seguidas: nunca silencio; la repetición usa el texto breve", async () => {
    const v = await nuevoViaje();
    expect((await v.escribe("Llamada perdida")).reply).toBe(COPY_LLAMADA_NO_RECIBIDA);
    expect((await v.escribe("Llamada perdida")).reply).toBe(COPY_LLAMADA_REPETIDA);
    expect((await v.escribe("Llamada perdida")).reply).toBe(COPY_LLAMADA_REPETIDA);
    expect(v.requests.length).toBe(0);
  });

  it("un mensaje de pedido NO se toma por llamada: sigue el camino normal (modelo)", async () => {
    const v = await nuevoViaje();
    v.guion([{ texto: "Claro, ¿para recoger o a domicilio?" }]);
    const r = await v.escribe("hola, quiero 3 tacos de pastor");
    expect(r.reply).not.toBe(COPY_LLAMADA_NO_RECIBIDA);
    expect(v.requests.length).toBeGreaterThan(0);
  });
});

describe("Paquete C: módulo de prompt", () => {
  const p = PM_PAQUETE_C_PROMPT;

  it("seguimiento: solo el estado real del pedido; sin hora ni 'ya salió' inventados; si no hay dato escala", () => {
    expect(p).toMatch(/SEGUIMIENTO/);
    expect(p).toMatch(/Pedido reciente/);
    expect(p).toMatch(/nunca invente (?:un )?estado/i);
    expect(p).toMatch(/escalar_a_humano/);
    expect(p).toMatch(/tiempos_entrega/);
  });

  it("quejas: disculpa breve y escalar; sin reembolsos, cortesías ni reposiciones prometidas; sin negar defensivamente", () => {
    expect(p).toMatch(/QUEJAS/);
    expect(p).toMatch(/no ofrezca reembolsos/i);
    expect(p).toMatch(/PM nunca reembolsa/);
    expect(p).toMatch(/cortes[ií]as/);
    expect(p).toMatch(/no (?:niegue|discuta)/i);
    expect(p).not.toMatch(/\bofrezca (?:un )?(?:descuento|reembolso)\b/i);
  });

  it("ráfagas: se juntan, manda la última versión y se responde una sola vez con un resumen único", () => {
    expect(p).toMatch(/R[ÁA]FAGAS/);
    expect(p).toMatch(/[úu]ltima versi[óo]n/);
    expect(p).toMatch(/una sola respuesta/i);
  });

  it("cambios a mitad del pedido, audios, imágenes y llamadas", () => {
    expect(p).toMatch(/CAMBIOS A MITAD/);
    expect(p).toMatch(/nota de voz/i);
    expect(p).toMatch(/imagen/i);
    expect(p).toMatch(/por este medio no recibimos llamadas/i);
  });

  it("cancelación por tardanza: NO cambia la política (avisar al encargado, sin prometer ni negar la cancelación)", () => {
    expect(p).toMatch(/CANCELAR POR TARDANZA/);
    expect(p).toMatch(/cancelacion_modificacion/);
    expect(p).toMatch(/no prometa (?:ni niegue )?la cancelaci[óo]n|no prometa cancelar/i);
    expect(p).not.toMatch(/s[ií] se puede cancelar|puede cancelar su pedido/i);
  });

  it("repo público: sin datos de chats reales (teléfonos, folios, direcciones) ni secretos", () => {
    expect(p).not.toMatch(/\+?\d{10,}/);
    expect(p).not.toMatch(/sk-|Bearer |api[_-]?key/i);
  });
});

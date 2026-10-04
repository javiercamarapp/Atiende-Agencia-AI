// Encuesta post-entrega (R-41): validaciones y calculos puros, y el barrido de envio con el repositorio en memoria.
import { describe, expect, it } from "vitest";
import {
  ENCUESTA_COMENTARIO_MAX,
  EncuestaValidationError,
  InMemoryEncuestaRepository,
  enviarEncuestasPendientes,
  mensajeEncuesta,
  normalizarComentario,
  tasaRespuestaPct,
  validarCalificacion,
  validarConfigEntrada,
} from "../src/index.ts";
import type { EncuestaCandidata, EnvioEncuestasDeps } from "../src/index.ts";

const ORG = "00000000-0000-0000-0000-000000000a01";
const PROP = "00000000-0000-0000-0000-000000000b01";

function candidata(n: number, extra: Partial<EncuestaCandidata> = {}): EncuestaCandidata {
  return {
    orderId: `00000000-0000-0000-0000-00000000c0${String(n).padStart(2, "0")}`,
    organizationId: ORG,
    propertyId: PROP,
    orgSlug: "los-taquitos",
    sucursal: "Centro",
    customerName: "María José Pérez",
    customerPhone: "+52 5511112222",
    ...extra,
  };
}

interface Encolado { organizationId: string; channel: string; eventType: string; dedupeKey: string; payload: Record<string, unknown> }

/** Doble de RestaurantesRepository con SAVEPOINT real de fila: si `fn` lanza, se deshace lo que la reserva escribio. */
function armar(encuestas: InMemoryEncuestaRepository, opts: { phoneNumberId?: string | null; fallaEncolar?: (orderId: string) => boolean } = {}) {
  const encolados: Encolado[] = [];
  const restaurantes: EnvioEncuestasDeps["restaurantes"] = {
    async runWithRowSavepoint(fn) {
      const snapshot = [...encuestas.entregas];
      try {
        return await fn();
      } catch (err) {
        encuestas.entregas.splice(0, encuestas.entregas.length, ...snapshot);
        throw err;
      }
    },
    async enqueueMessagingOutbox(organizationId, channel, eventType, dedupeKey, payload) {
      const orderId = dedupeKey.replace("encuesta-entrega:", "");
      if (opts.fallaEncolar?.(orderId)) throw new Error("outbox caido");
      encolados.push({ organizationId, channel, eventType, dedupeKey, payload: payload as Record<string, unknown> });
    },
    async resolveActiveWhatsAppPhoneNumberId() {
      return opts.phoneNumberId === undefined ? "pnid-1" : opts.phoneNumberId;
    },
  };
  const deps: EnvioEncuestasDeps = { encuestas, restaurantes, construirLiga: (c) => `https://app.atiende.ai/encuesta/${c.orgSlug}/TOKEN-${c.orderId.slice(-4)}` };
  return { deps, encolados };
}

describe("encuesta: validaciones puras", () => {
  it("config: acepta una entrada valida y normaliza la liga vacia a null", () => {
    expect(validarConfigEntrada({ activa: true, esperaMin: 45, resenasUrl: "  https://g.page/r/abc/review  ", umbralResena: 4 })).toEqual({ activa: true, esperaMin: 45, resenasUrl: "https://g.page/r/abc/review", umbralResena: 4 });
    expect(validarConfigEntrada({ activa: false, esperaMin: 30, resenasUrl: "   ", umbralResena: 5 }).resenasUrl).toBeNull();
    expect(validarConfigEntrada({ activa: false, esperaMin: 30, resenasUrl: null, umbralResena: 5 }).resenasUrl).toBeNull();
  });

  it.each([
    ["javascript:alert(1)"],
    ["http://g.page/r/x"],
    ["https://user@evil.example.com/x"],
    ["https://exa mple.com"],
    ["data:text/html,hola"],
    [`https://g.page/${"x".repeat(500)}`],
  ])("config: rechaza la liga %s", (url) => {
    expect(() => validarConfigEntrada({ activa: true, esperaMin: 30, resenasUrl: url, umbralResena: 4 })).toThrow(EncuestaValidationError);
  });

  it.each([
    [{ activa: "si", esperaMin: 30, umbralResena: 4 }],
    [{ activa: true, esperaMin: 4, umbralResena: 4 }],
    [{ activa: true, esperaMin: 1441, umbralResena: 4 }],
    [{ activa: true, esperaMin: 30.5, umbralResena: 4 }],
    [{ activa: true, esperaMin: 30, umbralResena: 0 }],
    [{ activa: true, esperaMin: 30, umbralResena: 6 }],
  ])("config: rechaza %j", (raw) => {
    expect(() => validarConfigEntrada(raw)).toThrow(EncuestaValidationError);
  });

  it("calificacion: solo enteros de 1 a 5", () => {
    expect(validarCalificacion(1)).toBe(1);
    expect(validarCalificacion(5)).toBe(5);
    for (const malo of [0, 6, 3.5, "4", null, undefined, Number.NaN]) expect(() => validarCalificacion(malo)).toThrow(EncuestaValidationError);
  });

  it("comentario: recorta, vacio = null y respeta el tope", () => {
    expect(normalizarComentario("  Muy rico  ")).toBe("Muy rico");
    expect(normalizarComentario("   ")).toBeNull();
    expect(normalizarComentario(undefined)).toBeNull();
    expect(normalizarComentario("x".repeat(ENCUESTA_COMENTARIO_MAX))).toHaveLength(ENCUESTA_COMENTARIO_MAX);
    expect(() => normalizarComentario("x".repeat(ENCUESTA_COMENTARIO_MAX + 1))).toThrow(EncuestaValidationError);
    expect(() => normalizarComentario(5)).toThrow(EncuestaValidationError);
  });

  it("tasa de respuesta: un decimal y null sin envios (nunca 0% inventado)", () => {
    expect(tasaRespuestaPct({ enviadas: 3, respondidas: 2, promedio: 3.5 })).toBe(66.7);
    expect(tasaRespuestaPct({ enviadas: 0, respondidas: 0, promedio: null })).toBeNull();
  });
});

describe("encuesta: barrido de envio", () => {
  it("encola un WhatsApp por pedido con la liga firmada, primer nombre y sin marcar el aviso como transaccional", async () => {
    const encuestas = new InMemoryEncuestaRepository();
    encuestas.pendientes.push(candidata(1), candidata(2));
    const { deps, encolados } = armar(encuestas);
    const r = await enviarEncuestasPendientes(deps, { organizationId: ORG });
    expect(r).toMatchObject({ disponible: true, candidatas: 2, encoladas: 2, yaRegistradas: 0, errores: 0 });
    expect(encolados).toHaveLength(2);
    const [primero] = encolados;
    expect(primero).toMatchObject({ organizationId: ORG, channel: "whatsapp", eventType: "encuesta.entrega", dedupeKey: `encuesta-entrega:${candidata(1).orderId}` });
    expect(primero?.payload.to).toBe("+525511112222");
    expect(primero?.payload.phone_number_id).toBe("pnid-1");
    expect(primero?.payload.transaccional).toBeUndefined();
    expect(String(primero?.payload.body)).toContain("Hola María,");
    expect(String(primero?.payload.body)).toContain("https://app.atiende.ai/encuesta/los-taquitos/TOKEN-c001");
    expect(primero?.payload.template).toMatchObject({ name: "encuesta_entrega", language: "es_MX", params: ["María", "Centro", "https://app.atiende.ai/encuesta/los-taquitos/TOKEN-c001"] });
    expect(r.pedidosEncolados.map((p) => p.orderId)).toEqual([candidata(1).orderId, candidata(2).orderId]);
  });

  it("es idempotente: la segunda corrida no encuentra candidatas ni duplica el mensaje", async () => {
    const encuestas = new InMemoryEncuestaRepository();
    encuestas.pendientes.push(candidata(1));
    const { deps, encolados } = armar(encuestas);
    await enviarEncuestasPendientes(deps, { organizationId: ORG });
    const otra = await enviarEncuestasPendientes(deps, { organizationId: ORG });
    expect(otra).toMatchObject({ candidatas: 0, encoladas: 0 });
    expect(encolados).toHaveLength(1);
  });

  it("una carrera (otro barrido ya registro el pedido) cuenta como ya registrada y no encola", async () => {
    const encuestas = new InMemoryEncuestaRepository();
    encuestas.pendientes.push(candidata(1));
    const { deps, encolados } = armar(encuestas);
    const original = encuestas.registrarEnvio.bind(encuestas);
    encuestas.registrarEnvio = async () => {
      await original(ORG, candidata(1).orderId);
      return false;
    };
    const r = await enviarEncuestasPendientes(deps, { organizationId: ORG });
    expect(r).toMatchObject({ encoladas: 0, yaRegistradas: 1 });
    expect(encolados).toHaveLength(0);
  });

  it("sin numero de WhatsApp: se omite y la reserva se revierte (el pedido sigue siendo candidato)", async () => {
    const encuestas = new InMemoryEncuestaRepository();
    encuestas.pendientes.push(candidata(1));
    const { deps, encolados } = armar(encuestas, { phoneNumberId: null });
    const r = await enviarEncuestasPendientes(deps, { organizationId: ORG });
    expect(r.omitidas).toEqual({ telefono_invalido: 0, sin_canal_whatsapp: 1 });
    expect(r).toMatchObject({ encoladas: 0, errores: 0 });
    expect(encolados).toHaveLength(0);
    expect(encuestas.entregas).toHaveLength(0);
    const siguiente = await encuestas.candidatas(ORG, null, 10);
    expect(siguiente.valor).toHaveLength(1);
  });

  it("telefono invalido: se omite sin tumbar a los demas", async () => {
    const encuestas = new InMemoryEncuestaRepository();
    encuestas.pendientes.push(candidata(1, { customerPhone: "123" }), candidata(2));
    const { deps, encolados } = armar(encuestas);
    const r = await enviarEncuestasPendientes(deps, { organizationId: ORG });
    expect(r.omitidas.telefono_invalido).toBe(1);
    expect(r.encoladas).toBe(1);
    expect(encolados).toHaveLength(1);
  });

  it("un fallo al encolar revierte SOLO esa reserva y el lote continua; el pedido fallido se reintenta", async () => {
    const encuestas = new InMemoryEncuestaRepository();
    encuestas.pendientes.push(candidata(1), candidata(2));
    const errorSilenciado = console.error;
    console.error = () => undefined;
    try {
      const { deps, encolados } = armar(encuestas, { fallaEncolar: (id) => id === candidata(1).orderId });
      const r = await enviarEncuestasPendientes(deps, { organizationId: ORG });
      expect(r).toMatchObject({ candidatas: 2, encoladas: 1, errores: 1 });
      expect(encolados.map((e) => e.dedupeKey)).toEqual([`encuesta-entrega:${candidata(2).orderId}`]);
      expect(encuestas.entregas.map((e) => e.orderId)).toEqual([candidata(2).orderId]);
      expect((await encuestas.candidatas(ORG, null, 10)).valor.map((c) => c.orderId)).toEqual([candidata(1).orderId]);
    } finally {
      console.error = errorSilenciado;
    }
  });

  it("base sin migrar: disponible=false, no hace nada", async () => {
    const encuestas = new InMemoryEncuestaRepository();
    encuestas.disponible = false;
    encuestas.pendientes.push(candidata(1));
    const { deps, encolados } = armar(encuestas);
    const r = await enviarEncuestasPendientes(deps, { organizationId: null });
    expect(r).toMatchObject({ disponible: false, candidatas: 0, encoladas: 0 });
    expect(encolados).toHaveLength(0);
  });

  it("el limite acota el lote y nunca pasa de 200", async () => {
    const encuestas = new InMemoryEncuestaRepository();
    for (let i = 1; i <= 5; i++) encuestas.pendientes.push(candidata(i));
    const { deps } = armar(encuestas);
    expect((await enviarEncuestasPendientes(deps, { organizationId: ORG, limite: 2 })).encoladas).toBe(2);
    expect((await enviarEncuestasPendientes(deps, { organizationId: ORG, limite: 9999 })).encoladas).toBe(3);
  });

  it("el mensaje usa solo el primer nombre y la sucursal", () => {
    expect(mensajeEncuesta(candidata(1, { customerName: "  " }), "https://x.test/e")).toContain("Hola cliente,");
    expect(mensajeEncuesta(candidata(1), "https://x.test/e")).toBe("Hola María, gracias por tu pedido en Centro. ¿Cómo estuvo todo? Cuéntanos en menos de un minuto: https://x.test/e");
  });
});

describe("encuesta: repositorio en memoria (contrato de la base)", () => {
  it("la primera respuesta gana; la segunda recibe ya_respondida y no cambia la calificacion", async () => {
    const r = new InMemoryEncuestaRepository();
    r.sembrarEntrega({ organizationId: ORG, propertyId: PROP, orderId: "o1", repartidorId: null, enviadaAt: "2026-03-10T18:00:00.000Z" });
    const a = await r.responder(ORG, "o1", 5, "Rico");
    const b = await r.responder(ORG, "o1", 1, "Otra");
    expect(a.valor?.estado).toBe("registrada");
    expect(b.valor).toMatchObject({ estado: "ya_respondida", calificacion: 5 });
  });

  it("otra organizacion no encuentra la encuesta", async () => {
    const r = new InMemoryEncuestaRepository();
    r.sembrarEntrega({ organizationId: ORG, propertyId: PROP, orderId: "o1", repartidorId: null, enviadaAt: "2026-03-10T18:00:00.000Z" });
    expect((await r.publica("otra-org", "o1")).valor).toBeNull();
    expect((await r.responder("otra-org", "o1", 5, null)).valor?.estado).toBe("no_encontrada");
  });

  it("la liga de resenas solo se devuelve con calificacion >= umbral", async () => {
    const r = new InMemoryEncuestaRepository();
    await r.guardarConfig(ORG, PROP, { activa: true, esperaMin: 30, resenasUrl: "https://g.page/r/abc", umbralResena: 4 });
    r.sembrarEntrega({ organizationId: ORG, propertyId: PROP, orderId: "alta", repartidorId: null, enviadaAt: "2026-03-10T18:00:00.000Z" });
    r.sembrarEntrega({ organizationId: ORG, propertyId: PROP, orderId: "baja", repartidorId: null, enviadaAt: "2026-03-10T18:00:00.000Z" });
    expect((await r.responder(ORG, "alta", 4, null)).valor?.resenasUrl).toBe("https://g.page/r/abc");
    expect((await r.responder(ORG, "baja", 3, null)).valor?.resenasUrl).toBeNull();
  });

  it("el resumen calcula promedio, tasa y por repartidor; sin respuestas el promedio es null", async () => {
    const r = new InMemoryEncuestaRepository();
    r.nombresRepartidor.set("rep1", "Repartidor Uno");
    r.sembrarEntrega({ organizationId: ORG, propertyId: PROP, orderId: "a", repartidorId: "rep1", enviadaAt: "2026-03-10T18:00:00.000Z", respondidaAt: "2026-03-10T19:00:00.000Z", calificacion: 5, comentario: "Excelente" });
    r.sembrarEntrega({ organizationId: ORG, propertyId: PROP, orderId: "b", repartidorId: "rep1", enviadaAt: "2026-03-10T18:00:00.000Z", respondidaAt: "2026-03-10T19:30:00.000Z", calificacion: 2, comentario: "Frio" });
    r.sembrarEntrega({ organizationId: ORG, propertyId: PROP, orderId: "c", repartidorId: null, enviadaAt: "2026-03-10T18:00:00.000Z" });
    const { valor } = await r.resumen(ORG, "2026-03-10", "2026-03-10", null);
    expect(valor.global).toMatchObject({ enviadas: 3, respondidas: 2, promedio: 3.5, distribucion: [0, 1, 0, 0, 1] });
    expect(tasaRespuestaPct(valor.global)).toBe(66.7);
    expect(valor.porRepartidor).toEqual([{ repartidorId: "rep1", nombre: "Repartidor Uno", enviadas: 2, respondidas: 2, promedio: 3.5 }]);
    const vacio = await r.resumen(ORG, "2026-01-01", "2026-01-02", null);
    expect(vacio.valor.global.promedio).toBeNull();
    expect(r.respuestasBajas()).toBe(1);
  });
});

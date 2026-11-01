// Opt-in conversacional (PM R23): clasificacion estricta, una sola pregunta, nunca presiona. Datos sinteticos; el SQL se prueba en scripts/verify-restaurantes-reactivacion.
import { describe, expect, it } from "vitest";
import { PREGUNTA_OPTIN_VERSION, OPTIN_ACEPTADO_TEXTO, OPTIN_RECHAZADO_TEXTO, PREGUNTA_OPTIN, anexarPreguntaOptIn, clasificarRespuestaOptIn, crearOptInPostgres, responderOptInDeterminista, ultimaRespuestaFueLaPregunta } from "../src/marketing/optin.ts";
import type { ContextoOptIn, OptInPuerto } from "../src/marketing/optin.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-0000-0000-00000000a001";
const TEL = "+525550000001";
const CLI = "00000000-0000-0000-0000-0000000c0001";

function puerto(ctx: ContextoOptIn | null, respuesta: "otorgado" | "rechazado" | "sin_pregunta" = "sin_pregunta") {
  const llamadas = { marcar: 0, responder: [] as boolean[] };
  const p: OptInPuerto = {
    contexto: async () => ctx,
    marcarPregunta: async () => {
      llamadas.marcar += 1;
      return true;
    },
    responder: async (_o, _t, si) => {
      llamadas.responder.push(si);
      return respuesta;
    },
  };
  return { p, llamadas };
}
const PREGUNTADO = [
  { role: "user", content: "2 tacos" },
  { role: "assistant", content: `Pedido #1 creado.\n\n${PREGUNTA_OPTIN}`, autor: "agente" },
  { role: "user", content: "sí" },
] as const;
const ok: ContextoOptIn = { customerId: CLI, habilitado: true, preguntaAbierta: false, puedePreguntar: true };

describe("clasificarRespuestaOptIn", () => {
  it("solo el mensaje completo cuenta", () => {
    for (const t of ["Sí", "si", "SÍ.", "si por favor", " si acepto "]) expect(clasificarRespuestaOptIn(t)).toBe("si");
    for (const t of ["No", "no gracias", "NO.", "ahorita no"]) expect(clasificarRespuestaOptIn(t)).toBe("no");
    for (const t of ["sí pero a qué hora abren", "no sé", "quiero 2 órdenes", "", "baja", "tal vez", "claro", "va", "dale", "simón", "acepto", "ok"]) expect(clasificarRespuestaOptIn(t)).toBeNull();
  });
});

describe("anexarPreguntaOptIn", () => {
  it("pregunta una vez, tras marcarla", async () => {
    const { p, llamadas } = puerto(ok);
    const r = await anexarPreguntaOptIn(p, ORG, TEL, "Pedido listo.");
    expect(r).toBe(`Pedido listo.\n\n${PREGUNTA_OPTIN}`);
    expect(llamadas.marcar).toBe(1);
  });
  it("no pregunta si no se puede, no esta habilitado, ya hay pregunta abierta o no hay cliente", async () => {
    for (const ctx of [{ ...ok, puedePreguntar: false }, { ...ok, habilitado: false }, { ...ok, preguntaAbierta: true }, null]) {
      const { p, llamadas } = puerto(ctx);
      expect(await anexarPreguntaOptIn(p, ORG, TEL, "Listo")).toBe("Listo");
      expect(llamadas.marcar).toBe(0);
    }
  });
  it("si el puerto falla, la respuesta del pedido sale intacta", async () => {
    const roto: OptInPuerto = { contexto: async () => Promise.reject(new Error("x")), marcarPregunta: async () => true, responder: async () => "sin_pregunta" };
    expect(await anexarPreguntaOptIn(roto, ORG, TEL, "Listo")).toBe("Listo");
  });
  it("la pregunta ofrece la salida y no presiona", () => {
    expect(PREGUNTA_OPTIN).toContain("BAJA");
    expect(PREGUNTA_OPTIN).not.toMatch(/oferta limitada|última oportunidad|solo hoy/i);
  });
});

describe("responderOptInDeterminista", () => {
  it("SI a una pregunta abierta otorga; NO rechaza; ambos sin LLM", async () => {
    expect(await responderOptInDeterminista(puerto(ok, "otorgado").p, ORG, TEL, "sí", PREGUNTADO)).toEqual({ reply: OPTIN_ACEPTADO_TEXTO });
    expect(await responderOptInDeterminista(puerto(ok, "rechazado").p, ORG, TEL, "no gracias", PREGUNTADO)).toEqual({ reply: OPTIN_RECHAZADO_TEXTO });
  });
  it("un «sí» sin pregunta abierta NO es consentimiento: devuelve null y el agente sigue su camino", async () => {
    expect(await responderOptInDeterminista(puerto(ok, "sin_pregunta").p, ORG, TEL, "sí", PREGUNTADO)).toBeNull();
  });
  it("texto que no es SI/NO ni siquiera consulta al puerto", async () => {
    const { p, llamadas } = puerto(ok, "otorgado");
    expect(await responderOptInDeterminista(p, ORG, TEL, "sí, y mándame el menú", PREGUNTADO)).toBeNull();
    expect(llamadas.responder).toEqual([]);
  });
});

describe("R-1: el «sí» solo responde a ESA pregunta", () => {
  it("un «sí» a una confirmacion de pedido o a cualquier otra pregunta NO cuenta y no se intercepta", async () => {
    const otra = [{ role: "assistant", content: "¿Confirmo su pedido de 2 tacos?", autor: "agente" }, { role: "user", content: "sí" }] as const;
    const { p, llamadas } = puerto(ok, "otorgado");
    expect(ultimaRespuestaFueLaPregunta(otra)).toBe(false);
    expect(await responderOptInDeterminista(p, ORG, TEL, "sí", otra)).toBeNull();
    expect(llamadas.responder).toEqual([]);
  });
  it("si el agente hablo de otra cosa DESPUES de la pregunta, el «sí» ya no le responde", async () => {
    const h = [
      { role: "assistant", content: `Listo.\n\n${PREGUNTA_OPTIN}`, autor: "agente" },
      { role: "user", content: "cuánto es el envío" },
      { role: "assistant", content: "$25. ¿Confirmo?", autor: "agente" },
      { role: "user", content: "sí" },
    ] as const;
    expect(ultimaRespuestaFueLaPregunta(h)).toBe(false);
  });
  it("sin historial, con dos mensajes del cliente seguidos o con una pregunta puesta por una persona, no cuenta", () => {
    expect(ultimaRespuestaFueLaPregunta([])).toBe(false);
    expect(ultimaRespuestaFueLaPregunta([{ role: "assistant", content: PREGUNTA_OPTIN }, { role: "user", content: "hola" }, { role: "user", content: "sí" }])).toBe(false);
    expect(ultimaRespuestaFueLaPregunta([{ role: "assistant", content: PREGUNTA_OPTIN, autor: "humano" }, { role: "user", content: "sí" }])).toBe(false);
    expect(ultimaRespuestaFueLaPregunta([{ role: "assistant", content: PREGUNTA_OPTIN, autor: "agente" }, { role: "user", content: "sí" }])).toBe(true);
  });
  it("la evidencia lleva version del texto", () => {
    expect(PREGUNTA_OPTIN_VERSION).toMatch(/^optin\.v\d+$/);
  });
});

describe("base sin migrar", () => {
  it("el puerto Postgres degrada sin abortar la transaccion", async () => {
    const falta = Object.assign(new Error("function restaurantes.reactivacion_optin_contexto(uuid, text, timestamp with time zone) does not exist"), { code: "42883" });
    const s = new AbortAwareFakeSession([
      { match: /reactivacion_optin_contexto/, respond: () => falta },
      { match: /reactivacion_optin_marcar/, respond: () => falta },
      { match: /reactivacion_optin_responder/, respond: () => falta },
      { match: /select 1 as despues/, respond: () => [{ despues: 1 }] },
    ]);
    const pg = crearOptInPostgres(s);
    expect(await pg.contexto(ORG, TEL, new Date())).toBeNull();
    expect(await pg.marcarPregunta(ORG, CLI, new Date())).toBe(false);
    expect(await pg.responder(ORG, TEL, true, new Date())).toBe("sin_pregunta");
    await expect(s.query("select 1 as despues")).resolves.toEqual({ rows: [{ despues: 1 }] });
  });
});

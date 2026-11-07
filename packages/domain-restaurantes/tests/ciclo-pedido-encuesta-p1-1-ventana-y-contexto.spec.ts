// Revision independiente de #713 (REVISION-SEGURIDAD-PARIDAD-OPERACION.md, seccion Operacion): p1-1-ventana-y-contexto.
import { describe, expect, it } from "vitest";
import { interpretarRespuestaEncuesta } from "../src/ciclo-pedido/reglas.ts";
import { HASH, conEncuestaEnviada, min, responder } from "./support/ciclo-encuesta.ts";

describe("P1-1: el interceptor no secuestra mensajes normales", () => {
  it("un '3' que llega horas o un dia despues (otra conversacion) NO es la calificacion: pasa al agente", async () => {
    const e = await conEncuestaEnviada();
    expect(await responder(e, "3", min(31))).toBeNull();
    expect(await responder(e, "3", min(60 * 24))).toBeNull();
    expect(e.ciclo.filasEncuesta()[0]?.estado).toBe("enviada");
  });
  it("dentro de la ventana corta (30 min) y sin otra actividad SI es la calificacion", async () => {
    const e = await conEncuestaEnviada();
    expect((await responder(e, "4", min(5)))?.tipo).toBe("calificacion");
  });
  it("si ya hubo conversacion despues de la encuesta (el agente pregunto algo) un '3' va al agente", async () => {
    const e = await conEncuestaEnviada();
    e.ciclo.registrarActividadPosterior(e.org, HASH, { mensajesDespuesDeLaEncuesta: 3, pedidoPosterior: false });
    expect(await responder(e, "3", min(5))).toBeNull();
  });
  it("si hay un pedido nuevo posterior a la encuesta, un '2' o un 'no gracias' van al agente", async () => {
    const e = await conEncuestaEnviada();
    e.ciclo.registrarActividadPosterior(e.org, HASH, { mensajesDespuesDeLaEncuesta: 1, pedidoPosterior: true });
    expect(await responder(e, "2", min(5))).toBeNull();
    expect(await responder(e, "no gracias", min(5))).toBeNull();
    expect(e.ciclo.hayBaja(e.org, HASH)).toBe(false);
  });
  it("'no gracias' y 'alto' ya no cuentan como BAJA; 'baja' y 'stop' si", () => {
    expect(interpretarRespuestaEncuesta("no gracias")).toEqual({ tipo: "otro" });
    expect(interpretarRespuestaEncuesta("alto")).toEqual({ tipo: "otro" });
    expect(interpretarRespuestaEncuesta("BAJA")).toEqual({ tipo: "baja" });
    expect(interpretarRespuestaEncuesta("stop")).toEqual({ tipo: "baja" });
  });
  it("el comentario solo se acepta si el cliente no ha escrito otra cosa entre la calificacion y el comentario", async () => {
    const e = await conEncuestaEnviada();
    await responder(e, "5", min(1));
    e.ciclo.registrarActividadPosterior(e.org, HASH, { mensajesDespuesDeLaEncuesta: 4, pedidoPosterior: false, mensajesDelClienteDespuesDeCalificar: 2 });
    expect(await responder(e, "Todo muy rico", min(3))).toBeNull();
  });
});


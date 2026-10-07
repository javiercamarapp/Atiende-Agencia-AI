// Alerta «WhatsApp silencioso»: el candidato lo decide la base (probado contra Postgres real en scripts/verify-restaurantes-marketing-campanas);
// aqui: la emision por el productor compartido con dedupe por organizacion y dia de Merida (reloj falso), texto sin PII, y la base SIN migrar con
// AbortAwareFakeSession (estado abortado real).
import { describe, expect, it } from "vitest";
import { barrerSilencioWhatsapp } from "../src/alertas-duenio/silencio.ts";
import { AbortAwareFakeSession } from "./support/aborting-fake-session.ts";

const A = "00000000-0000-0000-0000-00000000a001";
const B = "00000000-0000-0000-0000-00000000a002";
const CANDIDATOS = [
  { organization_id: A, mensajes_historico: "5.25", ventana_min: 60 },
  { organization_id: B, mensajes_historico: 3, ventana_min: "90" },
];

function pgError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

/** Sesion falsa con la semantica de dedupe de core.emit_notification (misma clave y organizacion = 0 filas nuevas). */
function sesionConDedupe(candidatos: unknown[]) {
  const vistas = new Set<string>();
  const emisiones: unknown[][] = [];
  const pNow: unknown[] = [];
  const s = new AbortAwareFakeSession([
    { match: /whatsapp_silencio_candidatos/, respond: () => candidatos },
    { match: /select core\.emit_notification/, respond: () => [{ emit_notification: 1 }] },
  ]);
  const original = s.query.bind(s);
  s.query = (async (sql: string, p?: unknown[]) => {
    if (/whatsapp_silencio_candidatos/.test(sql)) pNow.push((p ?? [])[0]);
    if (/select core\.emit_notification/.test(sql)) {
      emisiones.push(p ?? []);
      const clave = `${String((p ?? [])[0])}|${String((p ?? [])[10])}`;
      if (vistas.has(clave)) return { rows: [{ emit_notification: 0 }] };
      vistas.add(clave);
    }
    return original(sql, p);
  }) as typeof s.query;
  return { s, emisiones, pNow };
}

describe("barrerSilencioWhatsapp", () => {
  it("emite una alerta por organizacion con el catalogo, sin PII (solo promedio y ventana), enlace relativo y clave = dia de Merida", async () => {
    const { s, emisiones, pNow } = sesionConDedupe(CANDIDATOS);
    const r = await barrerSilencioWhatsapp(s, { now: new Date("2026-10-04T15:30:00Z") });
    expect(r).toEqual({ disponible: true, candidatos: 2, emitidas: 2, sinNuevas: 0, errores: 0 });
    expect(pNow).toEqual(["2026-10-04T15:30:00.000Z"]);
    const [a, b] = emisiones;
    expect(a![0]).toBe(A);
    expect(a![2]).toBe("restaurantes.whatsapp.silencio");
    expect(a![4]).toBe("atencion");
    expect(a![5]).toBe("WhatsApp está en silencio: no llegan mensajes");
    expect(a![6]).toBe("Normalmente a esta hora llegan unos 5 mensajes cada 60 minutos y no ha llegado ninguno. Revise que el número y la conexión de WhatsApp sigan activos en Configuración.");
    expect(a![7]).toBe("/restaurantes/{orgSlug}/configuracion");
    expect(a![10]).toBe("restaurantes.whatsapp.silencio:2026-10-04");
    expect(b![6]).toContain("unos 3 mensajes cada 90 minutos");
    expect(`${a![5]} ${a![6]}`).not.toMatch(/@|\d{8,}/);
  });

  it("dedupe una por organizacion y dia de Merida: el segundo tick del mismo dia (aun a las 21:30 de Merida = 03:30 UTC del dia siguiente) no repite; al dia siguiente vuelve", async () => {
    const { s } = sesionConDedupe(CANDIDATOS);
    const primero = await barrerSilencioWhatsapp(s, { now: new Date("2026-10-04T15:30:00Z") });
    const mismoDia = await barrerSilencioWhatsapp(s, { now: new Date("2026-10-05T03:30:00Z") }); // 21:30 del 4 en Merida
    const diaSiguiente = await barrerSilencioWhatsapp(s, { now: new Date("2026-10-05T07:00:00Z") });
    expect(primero.emitidas).toBe(2);
    expect(mismoDia).toEqual({ disponible: true, candidatos: 2, emitidas: 0, sinNuevas: 2, errores: 0 });
    expect(diaSiguiente.emitidas).toBe(2);
  });

  it("sin candidatos no emite nada", async () => {
    const { s, emisiones } = sesionConDedupe([]);
    expect(await barrerSilencioWhatsapp(s, { now: new Date("2026-10-04T15:30:00Z") })).toEqual({ disponible: true, candidatos: 0, emitidas: 0, sinNuevas: 0, errores: 0 });
    expect(emisiones).toEqual([]);
  });

  it("base sin migrar (42883): no barre y la transaccion sigue utilizable (SAVEPOINT)", async () => {
    const s = new AbortAwareFakeSession([
      { match: /whatsapp_silencio_candidatos/, respond: () => pgError("42883", "function restaurantes.whatsapp_silencio_candidatos(timestamp with time zone) does not exist") },
      { match: /select 1 as despues/, respond: () => [{ despues: 1 }] },
    ]);
    expect(await barrerSilencioWhatsapp(s, { now: new Date() })).toEqual({ disponible: false, candidatos: 0, emitidas: 0, sinNuevas: 0, errores: 0 });
    await expect(s.query("select 1 as despues")).resolves.toEqual({ rows: [{ despues: 1 }] });
  });

  it("una emision que falla no aborta el barrido: las demas se emiten y se cuenta el error", async () => {
    let n = 0;
    const s = new AbortAwareFakeSession([
      { match: /whatsapp_silencio_candidatos/, respond: () => CANDIDATOS },
      { match: /select core\.emit_notification/, respond: () => (++n === 1 ? pgError("XX000", "falla interna") : [{ emit_notification: 1 }]) },
    ]);
    expect(await barrerSilencioWhatsapp(s, { now: new Date("2026-10-04T15:30:00Z") })).toEqual({ disponible: true, candidatos: 2, emitidas: 1, sinNuevas: 0, errores: 1 });
  });
});

// Expiracion del token de Meta: avisos a 14, 7 y 1 dia con reloj fijo (miercoles 7-oct-2026 12:00 America/Merida = 18:00 UTC), casos limite y
// emision idempotente. El lector es un doble inyectado: ninguna prueba llama a Meta ni usa un token.
import { describe, expect, it } from "vitest";
import { evaluarExpiracionToken, vigilarTokenMeta } from "../src/alertas-duenio/token-meta.ts";
import type { EstadoTokenMeta, LectorEstadoTokenMeta } from "../src/alertas-duenio/token-meta.ts";
import { sesionConDedupe } from "./support/sesion-con-dedupe.ts";

const AHORA = new Date("2026-10-07T18:00:00Z"); // miercoles 12:00 en Merida
const DIA = 86_400_000;
const en = (ms: number): EstadoTokenMeta => ({ valido: true, expiraEn: new Date(AHORA.getTime() + ms) });
const lector = (estado: EstadoTokenMeta | Error): LectorEstadoTokenMeta => ({
  leer: async () => {
    if (estado instanceof Error) throw estado;
    return estado;
  },
});

describe("evaluarExpiracionToken", () => {
  it("sirve de sanidad: el reloj fijo es miercoles", () => {
    expect(new Intl.DateTimeFormat("en-US", { timeZone: "America/Merida", weekday: "long", hour: "2-digit", hour12: false }).format(AHORA)).toContain("Wednesday");
  });

  it("justo en el umbral: 14 dias exactos avisa el de 14; 14 dias y 1 ms no avisa nada", () => {
    expect(evaluarExpiracionToken(en(14 * DIA), AHORA)).toMatchObject({ tipo: "por_vencer", umbral: 14 });
    expect(evaluarExpiracionToken(en(14 * DIA + 1), AHORA)).toMatchObject({ tipo: "vigente" });
  });

  it("7 dias exactos avisa el de 7; 7 dias y 1 ms sigue en el de 14", () => {
    expect(evaluarExpiracionToken(en(7 * DIA), AHORA)).toMatchObject({ tipo: "por_vencer", umbral: 7 });
    expect(evaluarExpiracionToken(en(7 * DIA + 1), AHORA)).toMatchObject({ tipo: "por_vencer", umbral: 14 });
  });

  it("1 dia exacto avisa el de 1; 1 dia y 1 ms sigue en el de 7; 1 ms antes de vencer sigue siendo el de 1", () => {
    expect(evaluarExpiracionToken(en(1 * DIA), AHORA)).toMatchObject({ tipo: "por_vencer", umbral: 1 });
    expect(evaluarExpiracionToken(en(1 * DIA + 1), AHORA)).toMatchObject({ tipo: "por_vencer", umbral: 7 });
    expect(evaluarExpiracionToken(en(1), AHORA)).toMatchObject({ tipo: "por_vencer", umbral: 1 });
  });

  it("con el cron caido salta al umbral mas urgente vigente (5 dias = el de 7), nunca a uno viejo", () => {
    expect(evaluarExpiracionToken(en(5 * DIA), AHORA)).toMatchObject({ tipo: "por_vencer", umbral: 7 });
  });

  it("token ya vencido: expiracion exacta ahora, en el pasado, o Meta lo reporta invalido", () => {
    expect(evaluarExpiracionToken(en(0), AHORA)).toMatchObject({ tipo: "vencido" });
    expect(evaluarExpiracionToken(en(-3 * DIA), AHORA)).toMatchObject({ tipo: "vencido" });
    expect(evaluarExpiracionToken({ valido: false, expiraEn: null }, AHORA)).toEqual({ tipo: "vencido", expiraEn: null });
    expect(evaluarExpiracionToken({ valido: false, expiraEn: new Date(AHORA.getTime() + 30 * DIA) }, AHORA)).toMatchObject({ tipo: "vencido" });
  });

  it("token sin fecha (permanente o no informada): ni alerta ni falla", () => {
    expect(evaluarExpiracionToken({ valido: true, expiraEn: null }, AHORA)).toEqual({ tipo: "sin_fecha" });
    expect(evaluarExpiracionToken({ valido: null, expiraEn: null }, AHORA)).toEqual({ tipo: "sin_fecha" });
    expect(evaluarExpiracionToken({ valido: true, expiraEn: new Date("no es fecha") }, AHORA)).toEqual({ tipo: "sin_fecha" });
  });

  it("lejos de vencer: vigente con los dias restantes", () => {
    expect(evaluarExpiracionToken(en(60 * DIA), AHORA)).toEqual({ tipo: "vigente", diasRestantes: 60 });
  });
});

describe("vigilarTokenMeta", () => {
  it("por vencer: emite UN aviso de plataforma (organizacion null), sin PII, con los dias y la clave del umbral y la fecha de expiracion", async () => {
    const { session, emisiones } = sesionConDedupe();
    const r = await vigilarTokenMeta(session, lector(en(7 * DIA)), AHORA);
    expect(r).toEqual({ estado: "por_vencer", umbral: 7, emitida: true });
    expect(emisiones).toHaveLength(1);
    const e = emisiones[0]!;
    expect(e[0]).toBeNull();
    expect(e[2]).toBe("superadmin.whatsapp.token_por_vencer");
    expect(e[5]).toBe("El token de WhatsApp (Meta) vence en 7 día(s)");
    expect(e[7]).toBe("/superadmin/salud");
    expect(e[10]).toBe("superadmin.whatsapp.token_por_vencer:u7:2026-10-14");
  });

  it("dedupe: reintentar el cron en el mismo umbral no repite; al cruzar al siguiente umbral avisa de nuevo", async () => {
    const { session, emisiones } = sesionConDedupe();
    const expira = new Date(AHORA.getTime() + 7 * DIA);
    const estado: EstadoTokenMeta = { valido: true, expiraEn: expira };
    await vigilarTokenMeta(session, lector(estado), AHORA);
    await vigilarTokenMeta(session, lector(estado), new Date(AHORA.getTime() + 5 * 60_000));
    expect(emisiones).toHaveLength(2);
    const unico = new Set(emisiones.map((e) => e[10]));
    expect(unico.size).toBe(1);
    // seis dias despues cae en el umbral de 1: clave distinta
    const mas = new Date(AHORA.getTime() + 6 * DIA);
    const r = await vigilarTokenMeta(session, lector(estado), mas);
    expect(r).toMatchObject({ estado: "por_vencer", umbral: 1 });
    expect(new Set(emisiones.map((e) => e[10])).size).toBe(2);
  });

  it("vencido: aviso critico una vez por dia de Merida", async () => {
    const { session, emisiones } = sesionConDedupe();
    await vigilarTokenMeta(session, lector(en(-1 * DIA)), AHORA);
    await vigilarTokenMeta(session, lector(en(-1 * DIA)), new Date(AHORA.getTime() + 60 * 60_000));
    const e = emisiones[0]!;
    expect(e[2]).toBe("superadmin.whatsapp.token_vencido");
    expect(e[4]).toBe("critica");
    expect(e[10]).toBe("superadmin.whatsapp.token_vencido:2026-10-07");
    expect(new Set(emisiones.map((x) => x[10])).size).toBe(1);
  });

  it("sin fecha o vigente: no emite nada", async () => {
    const { session, emisiones } = sesionConDedupe();
    expect(await vigilarTokenMeta(session, lector({ valido: true, expiraEn: null }), AHORA)).toEqual({ estado: "sin_fecha" });
    expect(await vigilarTokenMeta(session, lector(en(30 * DIA)), AHORA)).toMatchObject({ estado: "vigente" });
    expect(emisiones).toHaveLength(0);
  });

  it("si el lector falla: no_leido, sin emitir y sin lanzar", async () => {
    const { session, emisiones } = sesionConDedupe();
    expect(await vigilarTokenMeta(session, lector(new Error("red caida")), AHORA)).toEqual({ estado: "no_leido" });
    expect(emisiones).toHaveLength(0);
  });

  it("base sin migrar (42883 en core.emit_notification): no lanza y reporta emitida: false/true sin abortar", async () => {
    const { AbortAwareFakeSession } = await import("./support/aborting-fake-session.ts");
    const err = Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
    const session = new AbortAwareFakeSession([{ match: /select core\.emit_notification/, respond: () => err }]);
    await expect(vigilarTokenMeta(session, lector(en(1 * DIA)), AHORA)).resolves.toMatchObject({ estado: "por_vencer", umbral: 1 });
  });
});

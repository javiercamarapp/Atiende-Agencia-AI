// R-15: aviso in-app de licencia por vencer/vencida. Sin PII, dedupe mensual por repartidor, enlace a Staff.
import { describe, expect, it } from "vitest";
import { notificarLicenciaRepartidor, notificarLicenciaSiCorresponde } from "../src/repartidor-perfil/index.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000e1";
const USER = "00000000-0000-4000-8000-0000000000e2";
const emit = (r: () => unknown): FakeSessionHandler => ({ match: /core\.emit_notification/, respond: r });

describe("notificarLicenciaRepartidor", () => {
  it("por vencer: emite una vez a traves del productor unico", async () => {
    const db = new AbortAwareFakeSession([emit(() => [{ emit_notification: 1 }])]);
    const r = await notificarLicenciaRepartidor(db, { organizationId: ORG, userId: USER, diasRestantes: 12, hoy: "2026-10-03" });
    expect(r).toBe(true);
    const llamada = db.calls.find((c) => c.includes("core.emit_notification"))!;
    expect(llamada).toBeDefined();
  });

  it("no emite si faltan 30 dias o mas", async () => {
    const db = new AbortAwareFakeSession([emit(() => [{ emit_notification: 1 }])]);
    expect(await notificarLicenciaRepartidor(db, { organizationId: ORG, userId: USER, diasRestantes: 30, hoy: "2026-10-03" })).toBe(false);
    expect(db.calls.filter((c) => c.includes("core.emit_notification"))).toHaveLength(0);
  });

  it("vencida: emite el evento critico con los dias transcurridos", async () => {
    const db = new AbortAwareFakeSession([emit(() => [{ emit_notification: 1 }])]);
    expect(await notificarLicenciaRepartidor(db, { organizationId: ORG, userId: USER, diasRestantes: -4, hoy: "2026-10-03" })).toBe(true);
  });

  it("dedupe: la base devuelve 0 destinatarios nuevos => false", async () => {
    const db = new AbortAwareFakeSession([emit(() => [{ emit_notification: 0 }])]);
    expect(await notificarLicenciaRepartidor(db, { organizationId: ORG, userId: USER, diasRestantes: 5, hoy: "2026-10-03" })).toBe(false);
  });

  it("base SIN migrar (42883): no lanza, devuelve false y la sesion sigue viva", async () => {
    const err = Object.assign(new Error("function does not exist"), { code: "42883" });
    const db = new AbortAwareFakeSession([emit(() => err), { match: /select 1 as siguiente/, respond: () => [{ ok: true }] }]);
    expect(await notificarLicenciaRepartidor(db, { organizationId: ORG, userId: USER, diasRestantes: 5, hoy: "2026-10-03" })).toBe(false);
    await expect(db.query("select 1 as siguiente;")).resolves.toEqual({ rows: [{ ok: true }] });
  });

  it("notificarLicenciaSiCorresponde: sin vigencia no hace nada; con vigencia lejana tampoco", async () => {
    const db = new AbortAwareFakeSession([emit(() => [{ emit_notification: 1 }])]);
    expect(await notificarLicenciaSiCorresponde(db, ORG, USER, null, "2026-10-03")).toBe(false);
    expect(await notificarLicenciaSiCorresponde(db, ORG, USER, "2027-10-03", "2026-10-03")).toBe(false);
    expect(await notificarLicenciaSiCorresponde(db, ORG, USER, "2026-10-20", "2026-10-03")).toBe(true);
  });
});

// R-42: el barrido por sucursal es idempotente por fecha de negocio, avisa solo cuando CREA y sigue vivo contra la base sin migrar.
import { describe, expect, it } from "vitest";
import { InMemoryCierreRepository, barrerCierresSucursal, DATOS_VACIOS } from "../src/cierres/index.ts";
import type { CierreDatos } from "../src/cierres/index.ts";
import { AbortAwareFakeSession, type FakeSessionHandler } from "./support/aborting-fake-session.ts";

const ORG = "00000000-0000-4000-8000-0000000000d1";
const PROP = "00000000-0000-4000-8000-0000000000d2";
const SUC = { organizationId: ORG, propertyId: PROP, zonaHoraria: "America/Mexico_City" };
// 2026-03-12 12:00 hora de Mexico (UTC-6) => hoy local 2026-03-12.
const AHORA = new Date("2026-03-12T18:00:00Z");
const CON_VENTAS: CierreDatos = { ...DATOS_VACIOS, pedidos: 4, ventasCentavos: 123456 };

function emitidas(s: AbortAwareFakeSession): string[] {
  return s.calls.filter((c) => c.includes("core.emit_notification"));
}
const emit = (r: () => unknown): FakeSessionHandler => ({ match: /core\.emit_notification/, respond: r });

describe("barrerCierresSucursal", () => {
  it("crea los dias con actividad, omite los vacios y avisa una vez por cierre creado", async () => {
    const repo = new InMemoryCierreRepository({ calcular: (_p, tipo, f) => (tipo === "dia" && f === "2026-03-11" ? CON_VENTAS : null) });
    const db = new AbortAwareFakeSession([emit(() => [{ emit_notification: 1 }])]);
    const r = await barrerCierresSucursal({ db, repo, sucursal: SUC, ahora: AHORA, dias: 3 });
    expect(r).toMatchObject({ hoyLocal: "2026-03-12", creados: 1, sinActividad: 2, existentes: 0, avisos: 1, noDisponible: false });
    expect(emitidas(db)).toHaveLength(1);
  });

  it("QA R2 automatizacion-08: un periodo que el dia de negocio aun no cierra se salta sin error ni aviso y el resto sigue", async () => {
    const base = new InMemoryCierreRepository({ calcular: () => CON_VENTAS });
    const repo = Object.assign(Object.create(base), {
      generar: async (...args: Parameters<InMemoryCierreRepository["generar"]>) => (args[3] === "2026-03-11" ? { estado: "periodo_abierto" as const } : base.generar(...args)),
    }) as InMemoryCierreRepository;
    const db = new AbortAwareFakeSession([emit(() => [{ emit_notification: 1 }])]);
    const r = await barrerCierresSucursal({ db, repo, sucursal: SUC, ahora: AHORA, dias: 2 });
    expect(r).toMatchObject({ creados: 1, avisos: 1, noDisponible: false });
  });

  it("idempotente: la segunda corrida no crea ni avisa de nuevo", async () => {
    const repo = new InMemoryCierreRepository({ calcular: () => CON_VENTAS });
    const db = new AbortAwareFakeSession([emit(() => [{ emit_notification: 1 }])]);
    const a = await barrerCierresSucursal({ db, repo, sucursal: SUC, ahora: AHORA, dias: 2 });
    const avisosPrimera = emitidas(db).length;
    const b = await barrerCierresSucursal({ db, repo, sucursal: SUC, ahora: AHORA, dias: 2 });
    expect(a.creados).toBe(2);
    expect(b).toMatchObject({ creados: 0, existentes: 2, avisos: 0 });
    expect(emitidas(db)).toHaveLength(avisosPrimera);
  });

  it("nunca cierra hoy: con dias=1 el unico periodo es ayer", async () => {
    const repo = new InMemoryCierreRepository({ calcular: () => CON_VENTAS });
    const db = new AbortAwareFakeSession([emit(() => [{ emit_notification: 1 }])]);
    await barrerCierresSucursal({ db, repo, sucursal: SUC, ahora: AHORA, dias: 1 });
    const l = await repo.listar(ORG, PROP, "dia", 10);
    expect(l.valor.map((c) => c.fechaInicio)).toEqual(["2026-03-11"]);
  });

  it("el domingo cerrado genera tambien el resumen semanal (lunes a domingo)", async () => {
    const repo = new InMemoryCierreRepository({ calcular: () => CON_VENTAS });
    const db = new AbortAwareFakeSession([emit(() => [{ emit_notification: 1 }])]);
    // hoy local lunes 2026-03-16 => ayer domingo 15
    await barrerCierresSucursal({ db, repo, sucursal: SUC, ahora: new Date("2026-03-16T18:00:00Z"), dias: 1 });
    const semanas = await repo.listar(ORG, PROP, "semana", 10);
    expect(semanas.valor.map((c) => [c.fechaInicio, c.fechaFin])).toEqual([["2026-03-09", "2026-03-15"]]);
  });

  it("respeta la zona horaria: 05:00Z en Mexico aun es el dia anterior (hoy local 03-11)", async () => {
    const repo = new InMemoryCierreRepository({ calcular: () => CON_VENTAS });
    const db = new AbortAwareFakeSession([emit(() => [{ emit_notification: 1 }])]);
    const r = await barrerCierresSucursal({ db, repo, sucursal: SUC, ahora: new Date("2026-03-12T05:00:00Z"), dias: 1 });
    expect(r.hoyLocal).toBe("2026-03-11");
    expect((await repo.listar(ORG, PROP, "dia", 5)).valor[0]!.fechaInicio).toBe("2026-03-10");
  });

  it("base sin migrar: no_disponible, sin avisos y sin lanzar", async () => {
    const repo = new InMemoryCierreRepository({ disponible: false });
    const db = new AbortAwareFakeSession([]);
    const r = await barrerCierresSucursal({ db, repo, sucursal: SUC, ahora: AHORA, dias: 3 });
    expect(r).toMatchObject({ noDisponible: true, creados: 0, avisos: 0 });
    expect(emitidas(db)).toHaveLength(0);
  });

  it("si la campana falla (migracion de notificaciones pendiente) el cierre queda creado igual y la sesion sigue viva", async () => {
    const repo = new InMemoryCierreRepository({ calcular: () => CON_VENTAS });
    const err = Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
    const db = new AbortAwareFakeSession([emit(() => err), { match: /select 1 as siguiente_query_del_request/, respond: () => [{ ok: true }] }]);
    const r = await barrerCierresSucursal({ db, repo, sucursal: SUC, ahora: AHORA, dias: 1 });
    expect(r).toMatchObject({ creados: 1, avisos: 0 });
    await expect(db.query("select 1 as siguiente_query_del_request;")).resolves.toEqual({ rows: [{ ok: true }] });
  });
});

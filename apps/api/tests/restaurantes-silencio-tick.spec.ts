// Autopiloto 2: el tick /internal/restaurantes/promover-programados evalua «WhatsApp silencioso» como unidad independiente: reloj fijo en Merida,
// Cancun y CDMX (el instante absoluto viaja a la base; el dedupe usa el dia de Merida), una alerta por organizacion y dia aunque corran muchos ticks
// (cada 5 min), una falla nunca revierte la promocion ni cambia el 200, y la base sin migrar queda como "no disponible". El candidato (historico,
// ventana, umbrales, demo) se prueba contra Postgres real en scripts/verify-restaurantes-marketing-campanas.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenancyEngine, TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { buildTestDeps, TEST_ENV } from "./fixtures.ts";

const RELOJES = [
  { zona: "America/Merida", local: "2026-10-03T23:30:00-06:00", dia: "2026-10-03" },
  { zona: "America/Cancun", local: "2026-10-04T00:30:00-05:00", dia: "2026-10-03" },
  { zona: "America/Mexico_City", local: "2026-10-03T23:30:00-06:00", dia: "2026-10-03" },
] as const;

function conSilencioSimulado(deps: Awaited<ReturnType<typeof buildTestDeps>>["deps"], candidatos: (org: string) => unknown[], modo: "ok" | "falla" | "sin_migrar" = "ok", organizationId = "") {
  const pNow: unknown[] = [];
  const emisiones: Array<{ evento: string; clave: string; titulo: string; cuerpo: string | null; enlace: string; roles: unknown }> = [];
  const vistas = new Set<string>();
  const envolver = (session: TenantDbSession): TenantDbSession => ({
    exec: (sql) => session.exec(sql),
    query: async <T>(sql: string, params?: unknown[]) => {
      if (/whatsapp_silencio_candidatos/.test(sql)) {
        if (modo === "falla") throw Object.assign(new Error("falla interna"), { code: "XX000" });
        if (modo === "sin_migrar") throw Object.assign(new Error("function restaurantes.whatsapp_silencio_candidatos(timestamptz) does not exist"), { code: "42883" });
        pNow.push((params ?? [])[0]);
        return { rows: candidatos(organizationId) as T[] };
      }
      if (/core\.emit_notification/.test(sql)) {
        const p = params ?? [];
        emisiones.push({ evento: String(p[2]), clave: String(p[10]), titulo: String(p[5]), cuerpo: (p[6] as string | null) ?? null, enlace: String(p[7]), roles: p[11] });
        const nueva = !vistas.has(`${String(p[0])}|${String(p[10])}`);
        vistas.add(`${String(p[0])}|${String(p[10])}`);
        return { rows: [{ emit_notification: nueva ? 1 : 0 }] as unknown as T[] };
      }
      return session.query<T>(sql, params);
    },
  });
  const engine: TenancyEngine = { withAppSession: (claims, fn) => deps.engine.withAppSession(claims, (s) => fn(envolver(s))) };
  return { deps: { ...deps, engine }, pNow, emisiones };
}

const tick = (app: ReturnType<typeof buildApp>) => app.request("/internal/restaurantes/promover-programados", { method: "POST", headers: { "x-atiende-internal-secret": TEST_ENV.internalSecret } });

describe("tick de promover-programados: WhatsApp silencioso", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  for (const { zona, local, dia } of RELOJES) {
    it(`reloj fijo (${zona}): el instante absoluto viaja a la base; una alerta por organizacion y dia ${dia} aunque corran varios ticks`, async () => {
      vi.setSystemTime(new Date(local));
      const base = await buildTestDeps();
      const { deps, pNow, emisiones } = conSilencioSimulado(base.deps, (org) => [{ organization_id: org, mensajes_historico: "6", ventana_min: 60 }], "ok", base.organizationId);
      const app = buildApp(deps);
      const primero = await tick(app);
      expect(primero.status).toBe(200);
      expect(await primero.json()).toMatchObject({ ok: true, silencio: { disponible: true, candidatos: 1, emitidas: 1, sinNuevas: 0, errores: 0 } });
      for (let i = 0; i < 2; i += 1) {
        const otro = await tick(app); // los ticks de los siguientes 10 minutos
        expect(await otro.json()).toMatchObject({ silencio: { emitidas: 0, sinNuevas: 1 } });
      }
      expect(pNow).toEqual(Array(3).fill(new Date(local).toISOString()));
      expect(new Set(emisiones.map((e) => e.clave))).toEqual(new Set([`restaurantes.whatsapp.silencio:${dia}`]));
      expect(emisiones[0]).toMatchObject({ evento: "restaurantes.whatsapp.silencio", titulo: "WhatsApp está en silencio: no llegan mensajes", enlace: "/restaurantes/{orgSlug}/configuracion" });
      expect(emisiones[0]!.cuerpo).toContain("unos 6 mensajes cada 60 minutos");
      expect(`${emisiones[0]!.titulo} ${emisiones[0]!.cuerpo}`).not.toMatch(/@|\d{8,}/);
    });
  }

  it("sin candidatos (el caso normal: hay mensajes, o no hay historico) no hay alertas", async () => {
    const base = await buildTestDeps();
    const { deps, emisiones } = conSilencioSimulado(base.deps, () => []);
    const res = await tick(buildApp(deps));
    expect(await res.json()).toMatchObject({ silencio: { disponible: true, candidatos: 0, emitidas: 0 } });
    expect(emisiones.filter((e) => e.evento === "restaurantes.whatsapp.silencio")).toEqual([]);
  });

  it("una falla de la unidad NO revierte nada: el tick responde 200 y reporta la unidad sin disponibilidad", async () => {
    const base = await buildTestDeps();
    const { deps } = conSilencioSimulado(base.deps, () => [], "falla");
    const res = await tick(buildApp(deps));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, silencio: { disponible: false, candidatos: 0 } });
  });

  it("base sin la migracion 052: 'no disponible' sin romper el tick", async () => {
    const base = await buildTestDeps();
    const { deps } = conSilencioSimulado(base.deps, () => [], "sin_migrar");
    const res = await tick(buildApp(deps));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ silencio: { disponible: false, candidatos: 0, emitidas: 0, errores: 0 } });
  });
});

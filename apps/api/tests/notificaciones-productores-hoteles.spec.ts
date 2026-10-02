// Productores de notificaciones in-app de hoteles: los dos crons por propiedad (SLA de tickets y
// expiracion de aprobaciones del agente) emiten UN aviso por propiedad por dia solo cuando hubo algo que
// avisar, y una emision que falla (base sin 0039) no revierte ni oculta el barrido de negocio.
import { describe, expect, it, vi } from "vitest";
import { runAprobacionesExpiracion } from "../src/routes/verticals/hoteles/agentes-expiracion-cron.ts";
import { runGruposLiberacion } from "../src/routes/verticals/hoteles/grupos-liberacion-cron.ts";
import { runTicketsSlaSweep } from "../src/routes/verticals/hoteles/tickets-sla-cron.ts";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext } from "./hoteles-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const AHORA = new Date("2026-10-01T15:00:00.000Z");

async function contexto(extra: Record<string, unknown>, opciones: { alEmitir?: () => number } = {}) {
  const ctx = await buildHotelesTestContext(buildApp);
  return { ctx, ...conEmisiones({ ...ctx.deps, ...extra } as typeof ctx.deps, opciones) };
}

const escalado = { ticketId: "t1", kind: "escalado", department: "frontdesk", priority: "media", assignedTo: null } as const;
const aviso = { ticketId: "t2", kind: "aviso_sla", department: "frontdesk", priority: "media", assignedTo: null } as const;

describe("hoteles.ticket.sla_vencido", () => {
  it("emite una por propiedad con la cantidad de ESCALADOS, a gerencia y recepcion, con clave por dia", async () => {
    const { ctx, deps, emisiones } = await contexto({ hotelesTicketsRepo: () => ({ sweepSla: async () => [escalado, escalado, aviso] }) });
    const r = await runTicketsSlaSweep(deps, AHORA);
    expect(r.every((x) => x.error === null)).toBe(true);
    const mias = emisiones.filter((e) => e.propertyId === ctx.propertyId);
    expect(mias).toHaveLength(1);
    expect(mias[0]).toMatchObject({
      evento: "hoteles.ticket.sla_vencido",
      organizationId: ctx.organizationId,
      categoria: "operacion",
      cuerpo: "Escalados: 2.",
      enlace: "/hoteles/{orgSlug}/tickets",
      dedupeKey: `hoteles.ticket.sla_vencido:${ctx.propertyId}:2026-10-01`,
      roles: ["gm", "frontdesk"],
    });
  });

  it("solo avisos al 75% (sin escalados) no emite", async () => {
    const { deps, emisiones } = await contexto({ hotelesTicketsRepo: () => ({ sweepSla: async () => [aviso] }) });
    await runTicketsSlaSweep(deps, AHORA);
    expect(emisiones).toHaveLength(0);
  });

  it("una emision que falla no cambia el resultado del barrido ni lo reporta como error", async () => {
    const { ctx, deps } = await contexto(
      { hotelesTicketsRepo: () => ({ sweepSla: async () => [escalado] }) },
      {
        alEmitir: () => {
          throw Object.assign(new Error("function core.emit_notification(uuid) does not exist"), { code: "42883" });
        },
      },
    );
    const r = (await runTicketsSlaSweep(deps, AHORA)).find((x) => x.propertyId === ctx.propertyId)!;
    expect(r).toMatchObject({ escalados: 1, omitida: null, error: null });
  });
});

describe("hoteles.aprobacion.expirada", () => {
  it("emite una por propiedad con la cantidad expirada, a gerencia y reservaciones, con clave por dia", async () => {
    const { ctx, deps, emisiones } = await contexto({ hotelesAgentesRepo: () => ({ expireApprovals: async () => 2 }) });
    await runAprobacionesExpiracion(deps, AHORA);
    const mias = emisiones.filter((e) => e.propertyId === ctx.propertyId);
    expect(mias).toHaveLength(1);
    expect(mias[0]).toMatchObject({
      evento: "hoteles.aprobacion.expirada",
      categoria: "aprobaciones",
      cuerpo: "Expiradas: 2.",
      enlace: "/hoteles/{orgSlug}/aprobaciones",
      dedupeKey: `hoteles.aprobacion.expirada:${ctx.propertyId}:2026-10-01`,
      roles: ["gm", "reservations"],
    });
  });

  it("sin solicitudes expiradas no emite", async () => {
    const { deps, emisiones } = await contexto({ hotelesAgentesRepo: () => ({ expireApprovals: async () => 0 }) });
    await runAprobacionesExpiracion(deps, AHORA);
    expect(emisiones).toHaveLength(0);
  });
});

describe("hoteles.grupo.liberado", () => {
  const liberados = [{ blockId: "b1", releasedRoomNights: 4 }, { blockId: "b2", releasedRoomNights: 6 }];

  it("emite una por propiedad por dia con la cantidad de bloqueos liberados, a gerencia y reservaciones", async () => {
    const { ctx, deps, emisiones } = await contexto({ hotelesGruposRepo: () => ({ releaseDueBlocks: async () => liberados, expireQuotes: async () => 0 }) });
    const r = await runGruposLiberacion(deps, AHORA);
    expect(r.properties.every((p) => p.error === null)).toBe(true);
    const mias = emisiones.filter((e) => e.propertyId === ctx.propertyId);
    expect(mias).toHaveLength(1);
    expect(mias[0]).toMatchObject({
      evento: "hoteles.grupo.liberado",
      organizationId: ctx.organizationId,
      categoria: "cierres",
      cuerpo: "Bloqueos liberados: 2.",
      enlace: "/hoteles/{orgSlug}/grupos",
      dedupeKey: `hoteles.grupo.liberado:${ctx.propertyId}:2026-10-01`,
      roles: ["gm", "reservations"],
    });
  });

  it("sin bloqueos liberados no emite; una emision que falla no revierte la liberacion", async () => {
    const vacio = await contexto({ hotelesGruposRepo: () => ({ releaseDueBlocks: async () => [], expireQuotes: async () => 0 }) });
    await runGruposLiberacion(vacio.deps, AHORA);
    expect(vacio.emisiones).toHaveLength(0);

    const roto = await contexto(
      { hotelesGruposRepo: () => ({ releaseDueBlocks: async () => liberados, expireQuotes: async () => 0 }) },
      {
        alEmitir: () => {
          throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
        },
      },
    );
    const r = (await runGruposLiberacion(roto.deps, AHORA)).properties.find((p) => p.propertyId === roto.ctx.propertyId)!;
    expect(r).toMatchObject({ bloqueosLiberados: 2, cuartosNocheLiberados: 10, error: null });
  });
});

describe("hoteles.night_audit.fallo", () => {
  async function barrido(opciones: { alEmitir?: () => number } = {}) {
    const ctx = await buildHotelesTestContext(buildApp);
    // Toda llamada al repo salvo el listado de properties falla: el cierre de cada property revienta.
    const hotelesRepo: typeof ctx.deps.hotelesRepo = (db) =>
      new Proxy(ctx.deps.hotelesRepo(db), {
        get: (t, k, r) => (k === "listActiveHotelProperties" ? Reflect.get(t, k, r).bind(t) : k === "then" ? undefined : async () => { throw new Error("falla simulada del cierre"); }),
      });
    const { deps, emisiones } = conEmisiones({ ...ctx.deps, hotelesRepo }, opciones);
    const res = await buildApp(deps).request("/internal/hoteles/night-audit", { method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
    return { ctx, res, emisiones };
  }

  it("un cierre nocturno que falla emite UN aviso critico por propiedad, a gerencia y contabilidad, con clave property + noche", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: AHORA });
    try {
      const { ctx, emisiones } = await barrido();
      const mias = emisiones.filter((e) => e.propertyId === ctx.propertyId);
      expect(mias).toHaveLength(1);
      expect(mias[0]).toMatchObject({ evento: "hoteles.night_audit.fallo", organizationId: ctx.organizationId, severidad: "critica", categoria: "cierres", roles: ["gm", "accountant"], enlace: "/hoteles/{orgSlug}/reservas" });
      expect(mias[0]!.dedupeKey).toMatch(new RegExp(`^hoteles\\.night_audit\\.fallo:${ctx.propertyId}:\\d{4}-\\d{2}-\\d{2}$`));
    } finally {
      vi.useRealTimers();
    }
  });

  it("una emision que falla no cambia la respuesta del barrido (200 con el detalle del error de negocio)", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: AHORA });
    try {
      const { res } = await barrido({
        alEmitir: () => {
          throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
        },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

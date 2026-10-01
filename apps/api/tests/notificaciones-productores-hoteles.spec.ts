// Productores de notificaciones in-app de hoteles: los dos crons por propiedad (SLA de tickets y
// expiracion de aprobaciones del agente) emiten UN aviso por propiedad por dia solo cuando hubo algo que
// avisar, y una emision que falla (base sin 0039) no revierte ni oculta el barrido de negocio.
import { describe, expect, it } from "vitest";
import { runAprobacionesExpiracion } from "../src/routes/verticals/hoteles/agentes-expiracion-cron.ts";
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

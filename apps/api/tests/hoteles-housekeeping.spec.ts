// Fase 6 hoteles (REQ-HK-008/011) — integración HTTP real de housekeeping ACOTADO a
// esta fase: tickets de mantenimiento (crear/listar/cerrar) y turnos de camaristas
// validados contra la LFT antes de publicarse.
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildHotelesTestContext } from "./hoteles-fixtures.ts";
import type { HotelesTestContext } from "./hoteles-fixtures.ts";

let ctx: HotelesTestContext;

beforeEach(async () => {
  ctx = await buildHotelesTestContext(buildApp);
});

interface TicketBody {
  id: string;
  titulo: string;
  estado: string;
  severidad: string;
  costoEstimado: number;
  costoReal: number | null;
}

describe("POST /hoteles/:propertyId/mantenimiento/tickets", () => {
  it("housekeeping puede reportar un ticket (REQ-HK-011: cualquier staff que reporta)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/mantenimiento/tickets`,
      authedJson(ctx.staff.housekeeping.token, { titulo: "Aire acondicionado no enfría", descripcion: "Habitación 305, lleva 2h sin enfriar", severidad: "media" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as TicketBody;
    expect(body.titulo).toBe("Aire acondicionado no enfría");
    expect(body.estado).toBe("abierto");
    expect(body.severidad).toBe("media");
  });

  it("fnb NO puede reportar un ticket de mantenimiento -- fuera de MAINTENANCE_TICKET_CREATE_ROLES", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/mantenimiento/tickets`, authedJson(ctx.staff.fnb.token, { titulo: "x", descripcion: "y" }));
    expect(res.status).toBe(403);
  });

  it("rechaza un ticket sin título/descripción", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/mantenimiento/tickets`, authedJson(ctx.staff.owner.token, { titulo: "", descripcion: "" }));
    expect(res.status).toBe(400);
  });
});

describe("GET /hoteles/:propertyId/mantenimiento/tickets -- listar", () => {
  it("lista los tickets creados, filtrando por estado", async () => {
    const app = buildApp(ctx.deps);
    await app.request(`/hoteles/${ctx.propertyId}/mantenimiento/tickets`, authedJson(ctx.staff.owner.token, { titulo: "Fuga de agua", descripcion: "Baño 210", severidad: "alta" }));

    const listado = await app.request(`/hoteles/${ctx.propertyId}/mantenimiento/tickets`, authedJson(ctx.staff.housekeeping.token));
    expect(listado.status).toBe(200);
    const tickets = (await listado.json()) as TicketBody[];
    expect(tickets).toHaveLength(1);
    expect(tickets[0]!.titulo).toBe("Fuga de agua");

    const filtrado = await app.request(`/hoteles/${ctx.propertyId}/mantenimiento/tickets?estado=cerrado`, authedJson(ctx.staff.owner.token));
    expect(((await filtrado.json()) as TicketBody[])).toHaveLength(0);
  });
});

describe("POST /hoteles/:propertyId/mantenimiento/tickets/:id/cerrar", () => {
  it("owner puede cerrar con el costo real -- housekeeping NUNCA puede cambiar el costo", async () => {
    const app = buildApp(ctx.deps);
    const crear = await app.request(`/hoteles/${ctx.propertyId}/mantenimiento/tickets`, authedJson(ctx.staff.housekeeping.token, { titulo: "Fuga", descripcion: "Baño 210", severidad: "alta", costoEstimado: 500 }));
    const ticket = (await crear.json()) as TicketBody;

    const cerrarHousekeeping = await app.request(`/hoteles/${ctx.propertyId}/mantenimiento/tickets/${ticket.id}/cerrar`, authedJson(ctx.staff.housekeeping.token, { actualCost: 450 }));
    expect(cerrarHousekeeping.status).toBe(403);

    const cerrarOwner = await app.request(`/hoteles/${ctx.propertyId}/mantenimiento/tickets/${ticket.id}/cerrar`, authedJson(ctx.staff.owner.token, { actualCost: 450, notaResolucion: "Se cambió empaque de la llave" }));
    expect(cerrarOwner.status).toBe(200);
    const cerrado = (await cerrarOwner.json()) as TicketBody;
    expect(cerrado.estado).toBe("cerrado");
    expect(cerrado.costoReal).toBe(450);
  });

  it("cerrar un ticket ya cerrado devuelve 404 (no puede volver a cerrarse)", async () => {
    const app = buildApp(ctx.deps);
    const crear = await app.request(`/hoteles/${ctx.propertyId}/mantenimiento/tickets`, authedJson(ctx.staff.owner.token, { titulo: "x", descripcion: "y" }));
    const ticket = (await crear.json()) as TicketBody;
    await app.request(`/hoteles/${ctx.propertyId}/mantenimiento/tickets/${ticket.id}/cerrar`, authedJson(ctx.staff.owner.token, { actualCost: 100 }));

    const segundoCierre = await app.request(`/hoteles/${ctx.propertyId}/mantenimiento/tickets/${ticket.id}/cerrar`, authedJson(ctx.staff.owner.token, { actualCost: 200 }));
    expect(segundoCierre.status).toBe(404);
  });
});

interface TurnosResponse {
  ok: boolean;
  publicado: boolean;
  violaciones: { type: string; article: string }[];
}

describe("POST /hoteles/:propertyId/housekeeping/turnos -- puerta de publicación LFT (REQ-HK-008)", () => {
  it("una plantilla legal se publica sin violaciones", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/housekeeping/turnos`,
      authedJson(ctx.staff.owner.token, {
        staffId: ctx.staff.housekeeping.id,
        fromDate: "2026-09-07",
        toDate: "2026-09-12",
        shifts: [
          { workDate: "2026-09-07", startTime: "08:00", endTime: "16:00" },
          { workDate: "2026-09-08", startTime: "08:00", endTime: "16:00" },
        ],
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as TurnosResponse;
    expect(body.ok).toBe(true);
    expect(body.publicado).toBe(true);
    expect(body.violaciones).toEqual([]);
  });

  it("una plantilla con jornada diaria excedida se rechaza (422) y NUNCA se publica", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/housekeeping/turnos`,
      authedJson(ctx.staff.owner.token, {
        staffId: ctx.staff.housekeeping.id,
        fromDate: "2026-09-07",
        toDate: "2026-09-07",
        shifts: [{ workDate: "2026-09-07", startTime: "08:00", endTime: "22:00" }], // 14h -- jornada diaria excedida.
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as TurnosResponse;
    expect(body.ok).toBe(false);
    expect(body.publicado).toBe(false);
    expect(body.violaciones.some((v) => v.type === "jornada_diaria_excedida")).toBe(true);

    const listado = await app.request(
      `/hoteles/${ctx.propertyId}/housekeeping/turnos?desde=2026-09-07&hasta=2026-09-07&staffId=${ctx.staff.housekeeping.id}`,
      authedJson(ctx.staff.owner.token),
    );
    expect(((await listado.json()) as { turnos: unknown[] }).turnos).toEqual([]);
  });

  it("housekeeping NO puede publicar turnos -- fuera de HOUSEKEEPING_SHIFT_PUBLISH_ROLES", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/housekeeping/turnos`,
      authedJson(ctx.staff.housekeeping.token, { staffId: ctx.staff.housekeeping.id, fromDate: "2026-09-07", toDate: "2026-09-07", shifts: [{ workDate: "2026-09-07", startTime: "08:00", endTime: "16:00" }] }),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /hoteles/:propertyId/housekeeping/turnos -- consulta de cumplimiento", () => {
  it("cualquier staff de la property puede consultar el turno publicado y su cumplimiento", async () => {
    const app = buildApp(ctx.deps);
    await app.request(
      `/hoteles/${ctx.propertyId}/housekeeping/turnos`,
      authedJson(ctx.staff.owner.token, {
        staffId: ctx.staff.housekeeping.id,
        fromDate: "2026-09-07",
        toDate: "2026-09-13",
        shifts: [
          { workDate: "2026-09-07", startTime: "08:00", endTime: "16:00" },
          { workDate: "2026-09-08", startTime: "08:00", endTime: "16:00" },
          { workDate: "2026-09-09", startTime: "08:00", endTime: "16:00" },
        ],
      }),
    );

    const res = await app.request(
      `/hoteles/${ctx.propertyId}/housekeeping/turnos?desde=2026-09-07&hasta=2026-09-13&staffId=${ctx.staff.housekeeping.id}`,
      authedJson(ctx.staff.housekeeping.token),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { turnos: { fecha: string }[]; cumplimiento: { valido: boolean; violaciones: unknown[] } };
    expect(body.turnos).toHaveLength(3);
    expect(body.cumplimiento.valido).toBe(true);
    expect(body.cumplimiento.violaciones).toEqual([]);
  });

  it("rechaza desde/hasta faltantes o mal formados", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/housekeeping/turnos`, authedJson(ctx.staff.owner.token));
    expect(res.status).toBe(400);
  });
});

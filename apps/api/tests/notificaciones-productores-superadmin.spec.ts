// Productor `superadmin.organizacion.accion_pendiente`: una solicitud con doble control (suspender con contrato vigente) avisa a los
// superadmins, UNA por solicitud (clave = id) y sin PII; una solicitud sin doble control no emite, y una emision que falla (base sin
// 0039) no cambia el 201 ni la solicitud registrada.
import { describe, expect, it } from "vitest";
import { jsonRequestInit } from "./fixtures.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

const MOTIVO = "Cliente en mora de 90 dias, se suspende con doble control del equipo.";

async function setup(opciones: { alEmitir?: () => number } = {}) {
  const s = await seguridadSetup();
  const { deps, emisiones } = conEmisiones(s.deps, opciones);
  const { buildApp } = await import("../src/app.ts");
  return { s, emisiones, app: buildApp(deps) };
}
const solicitar = (app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> }, body: unknown, token: string) => app.request("/superadmin/organizaciones/acciones", jsonRequestInit(body, bearer(token)));

describe("superadmin.organizacion.accion_pendiente", () => {
  it("una suspension con contrato vigente (doble control) emite UN aviso de plataforma con la clave de la solicitud, sin el motivo", async () => {
    const { s, emisiones, app } = await setup();
    const ana = await s.superadmin();
    s.orgs.seedContract(s.base.organizationId, { contractId: "contrato-1", version: 3 });
    const res = await solicitar(app, { tipo: "suspender", organizationId: s.base.organizationId, motivo: MOTIVO }, ana.token);
    expect(res.status).toBe(201);
    const { accion } = (await res.json()) as { accion: { id: string; requiereDobleControl: boolean } };
    expect(accion.requiereDobleControl).toBe(true);
    expect(emisiones).toHaveLength(1);
    expect(emisiones[0]).toMatchObject({
      evento: "superadmin.organizacion.accion_pendiente",
      organizationId: null,
      propertyId: null,
      categoria: "aprobaciones",
      severidad: "atencion",
      enlace: "/superadmin/organizaciones?tab=gestion",
      dedupeKey: `superadmin.organizacion.accion_pendiente:${accion.id}`,
    });
    expect(JSON.stringify(emisiones[0])).not.toContain("mora");
  });

  it("una solicitud sin doble control (sin contrato) no emite", async () => {
    const { s, emisiones, app } = await setup();
    const ana = await s.superadmin();
    expect((await solicitar(app, { tipo: "suspender", organizationId: s.base.organizationId, motivo: MOTIVO }, ana.token)).status).toBe(201);
    expect(emisiones).toHaveLength(0);
  });

  it("una emision que falla (base sin migrar) no cambia el 201 ni la solicitud registrada", async () => {
    const { s, app } = await setup({
      alEmitir: () => {
        throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" });
      },
    });
    const ana = await s.superadmin();
    s.orgs.seedContract(s.base.organizationId, { contractId: "contrato-1", version: 3 });
    const res = await solicitar(app, { tipo: "suspender", organizationId: s.base.organizationId, motivo: MOTIVO }, ana.token);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { accion: { estado: string } }).accion.estado).toBe("pending");
  });
});

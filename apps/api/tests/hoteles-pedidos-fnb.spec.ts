// Test de integración end-to-end del flujo 2 (REQ-AB-004: guardia de alergias de
// F&B) — HTTP real, ejercitando la regla de dominio de punta a punta.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";

describe("POST /hoteles/:propertyId/pedidos-fnb — detección de alergia en texto libre", () => {
  it("campo estructurado false pero nota libre declara alergia -> se marca igual (red de seguridad fail-closed)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/pedidos-fnb`,
      authedJson(ctx.staff.frontdesk.token, { items: [{ nombre: "Ensalada César", notas: "soy alérgico a los mariscos" }], alergiaDeclarada: false }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { alergiaDeclarada: boolean; alergiaDetectadaVia: string; puedeAsegurarSeguridad: boolean };
    expect(body.alergiaDeclarada).toBe(true);
    expect(body.alergiaDetectadaVia).toBe("texto_libre");
    expect(body.puedeAsegurarSeguridad).toBe(false); // sin confirmación de cocina, nunca es seguro afirmar
  });
});

describe("Confirmación de cocina y aseguramiento de seguridad (REQ-AB-004)", () => {
  it("frontdesk NO puede confirmar cocina (deliberadamente más estricto que tomar el pedido)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/hoteles/${ctx.propertyId}/pedidos-fnb`, authedJson(ctx.staff.frontdesk.token, { items: [{ nombre: "Tacos" }], alergiaDeclarada: true }));
    const { id } = (await created.json()) as { id: string };
    const res = await app.request(`/hoteles/${ctx.propertyId}/pedidos-fnb/${id}/confirmar-cocina`, authedJson(ctx.staff.frontdesk.token, {}));
    expect(res.status).toBe(403);
  });

  it("no se puede asegurar seguridad ANTES de la confirmación de cocina -> 409, la fila nunca se actualiza", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/hoteles/${ctx.propertyId}/pedidos-fnb`, authedJson(ctx.staff.fnb.token, { items: [{ nombre: "Pasta" }], alergiaDeclarada: true }));
    const { id } = (await created.json()) as { id: string };

    const blocked = await app.request(`/hoteles/${ctx.propertyId}/pedidos-fnb/${id}/asegurar-seguridad`, authedJson(ctx.staff.fnb.token, {}));
    expect(blocked.status).toBe(409);

    const afterBlocked = await app.request(`/hoteles/${ctx.propertyId}/pedidos-fnb/${id}`, authedJson(ctx.staff.fnb.token));
    expect((await afterBlocked.json() as { seguridadAseguradaEn: string | null }).seguridadAseguradaEn).toBeNull();

    const confirm = await app.request(`/hoteles/${ctx.propertyId}/pedidos-fnb/${id}/confirmar-cocina`, authedJson(ctx.staff.fnb.token, { nota: "sin gluten confirmado" }));
    expect(confirm.status).toBe(200);

    const assured = await app.request(`/hoteles/${ctx.propertyId}/pedidos-fnb/${id}/asegurar-seguridad`, authedJson(ctx.staff.fnb.token, {}));
    expect(assured.status).toBe(200);
    const assuredBody = (await assured.json()) as { puedeAsegurarSeguridad: boolean; mensajeSeguridad: string; seguridadAseguradaEn: string | null };
    expect(assuredBody.puedeAsegurarSeguridad).toBe(true);
    expect(assuredBody.mensajeSeguridad).toMatch(/es seguro/);
    expect(assuredBody.seguridadAseguradaEn).not.toBeNull();
  });

  it("un pedido sin alergia declarada no admite confirmación de cocina (nada que confirmar)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(`/hoteles/${ctx.propertyId}/pedidos-fnb`, authedJson(ctx.staff.fnb.token, { items: [{ nombre: "Agua" }], alergiaDeclarada: false }));
    const { id } = (await created.json()) as { id: string };
    const res = await app.request(`/hoteles/${ctx.propertyId}/pedidos-fnb/${id}/confirmar-cocina`, authedJson(ctx.staff.fnb.token, {}));
    expect(res.status).toBe(409);
  });
});

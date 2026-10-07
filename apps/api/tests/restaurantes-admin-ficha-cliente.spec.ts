// Cliente 360 — HTTP end-to-end de la ficha del cliente del staff (admin-customers.ts): ficha, perfil, domicilios, gustos,
// pedido falso, politica de reincidencia y ARCO. Roles, aislamiento entre organizaciones y base sin migrar.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

async function mundo() {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const cliente = await ctx.restaurantesRepo.upsertCustomer(ctx.organizationId, "9991112222", "Ana Torres");
  const ajeno = await ctx.restaurantesRepo.upsertCustomer(ctx.otherOrganizationId, "9993334444", "Cliente ajeno");
  const app = buildApp(ctx.deps);
  const base = `/v1/restaurantes/${ctx.propertyIdA}/admin/customers`;
  return { ctx, app, cliente, ajeno, base };
}

describe("ficha del cliente", () => {
  it("devuelve datos, domicilios, gustos, confiabilidad e historial de la organizacion", async () => {
    const { ctx, app, cliente, base } = await mundo();
    await ctx.restaurantesRepo.saveCustomerAddress(ctx.organizationId, cliente.id, null, { address: "Calle 1 #2", label: "casa", accessNotes: "porton verde" });
    const res = await app.request(`${base}/${cliente.id}/ficha`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(200);
    const { ficha } = (await res.json()) as { ficha: { customer: { name: string }; addresses: { label: string; accessNotes: string }[]; reliability: { umbral: number }; preferences: unknown[]; orders: unknown[] } };
    expect(ficha.customer.name).toBe("Ana Torres");
    expect(ficha.addresses[0]).toMatchObject({ label: "casa", accessNotes: "porton verde" });
    expect(ficha.reliability.umbral).toBe(2);
  });

  it("repartidor 403; otra organizacion 403; cliente de otra organizacion o inexistente 404", async () => {
    const { ctx, app, cliente, ajeno, base } = await mundo();
    expect((await app.request(`${base}/${cliente.id}/ficha`, authedGet(ctx.staff.repartidor.token))).status).toBe(403);
    expect((await app.request(`${base}/${cliente.id}/ficha`, authedGet(ctx.staff.otroOrgOwner.token))).status).toBe(403);
    expect((await app.request(`${base}/${ajeno.id}/ficha`, authedGet(ctx.staff.owner.token))).status).toBe(404);
    expect((await app.request(`${base}/${randomUUID()}/ficha`, authedGet(ctx.staff.owner.token))).status).toBe(404);
    expect((await app.request(`${base}/no-es-un-uuid/ficha`, authedGet(ctx.staff.owner.token))).status).toBe(400);
  });

  it("base sin migrar: 503 honesto 'no disponible aun' (nunca un 500 ni datos inventados)", async () => {
    const { ctx, app, cliente, base } = await mundo();
    ctx.restaurantesRepo.setCliente360Supported(false);
    const res = await app.request(`${base}/${cliente.id}/ficha`, authedGet(ctx.staff.owner.token));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toMatch(/migración 049/);
  });
});

describe("editar la ficha", () => {
  it("actualiza nombre, notas y fecha de nacimiento (dia y mes) y deja huella en la bitacora sin PII", async () => {
    const { ctx, app, cliente, base } = await mundo();
    const res = await app.request(`${base}/${cliente.id}`, authedJson(ctx.staff.staffSucursalA.token, { name: "Ana M. Torres", staffNotes: "prefiere sin picante", fechaNacimientoDia: 15, fechaNacimientoMes: 3 }, "PATCH"));
    expect(res.status).toBe(200);
    const ficha = await ctx.restaurantesRepo.getCustomerFicha(ctx.organizationId, cliente.id);
    expect(ficha?.customer).toMatchObject({ name: "Ana M. Torres", staffNotes: "prefiere sin picante", fechaNacimientoDia: 15, fechaNacimientoMes: 3 });
    const bitacora = ctx.restaurantesRepo.auditLog.filter((a) => a.action === "cliente.ficha_actualizada");
    expect(bitacora).toHaveLength(1);
    expect(JSON.stringify(bitacora)).not.toMatch(/Ana|prefiere|9991112222/);
  });

  it("valida: fecha imposible (31 de abril), dia sin mes y cuerpo vacio son 400", async () => {
    const { ctx, app, cliente, base } = await mundo();
    const owner = ctx.staff.owner.token;
    expect((await app.request(`${base}/${cliente.id}`, authedJson(owner, { fechaNacimientoDia: 31, fechaNacimientoMes: 4 }, "PATCH"))).status).toBe(400);
    expect((await app.request(`${base}/${cliente.id}`, authedJson(owner, { fechaNacimientoDia: 10 }, "PATCH"))).status).toBe(400);
    expect((await app.request(`${base}/${cliente.id}`, authedJson(owner, {}, "PATCH"))).status).toBe(400);
  });

  it("domicilios: alta, edicion, predeterminado y baja; link de Maps solo https; sucursal que no es de la organizacion negada", async () => {
    const { ctx, app, cliente, base } = await mundo();
    const owner = ctx.staff.owner.token;
    const alta = await app.request(`${base}/${cliente.id}/addresses`, authedJson(owner, { address: "Calle 9 #9", label: "oficina", access_notes: "timbre 2", maps_url: "https://maps.example.com/x", property_id: ctx.propertyIdA }, "POST"));
    expect(alta.status).toBe(201);
    const { id } = (await alta.json()) as { id: string };
    expect((await app.request(`${base}/${cliente.id}/addresses`, authedJson(owner, { address: "X", maps_url: "http://x.example.com" }, "POST"))).status).toBe(400);
    expect((await app.request(`${base}/${cliente.id}/addresses`, authedJson(owner, { address: "X", property_id: randomUUID() }, "POST"))).status).toBe(404);
    const edit = await app.request(`${base}/${cliente.id}/addresses/${id}`, authedJson(owner, { label: "trabajo", is_default: true }, "PATCH"));
    expect(edit.status).toBe(200);
    const ficha = await ctx.restaurantesRepo.getCustomerFicha(ctx.organizationId, cliente.id);
    expect(ficha?.addresses[0]).toMatchObject({ label: "trabajo", isDefault: true });
    expect((await app.request(`${base}/${cliente.id}/addresses/${id}`, authedJson(owner, undefined, "DELETE"))).status).toBe(200);
    expect((await app.request(`${base}/${cliente.id}/addresses/${id}`, authedJson(owner, undefined, "DELETE"))).status).toBe(404);
  });

  it("gustos: el staff agrega, descarta y reactiva; el repartidor no puede", async () => {
    const { ctx, app, cliente, base } = await mundo();
    const owner = ctx.staff.owner.token;
    const alta = await app.request(`${base}/${cliente.id}/preferences`, authedJson(owner, { accion: "agregar", kind: "nota", value: "sin cebolla" }, "POST"));
    expect(alta.status).toBe(201);
    const { id } = (await alta.json()) as { id: string };
    expect((await app.request(`${base}/${cliente.id}/preferences`, authedJson(owner, { accion: "descartar", prefId: id }, "POST"))).status).toBe(200);
    expect((await ctx.restaurantesRepo.getCustomerFicha(ctx.organizationId, cliente.id))?.preferences[0]?.status).toBe("descartada");
    expect((await app.request(`${base}/${cliente.id}/preferences`, authedJson(owner, { accion: "agregar", kind: "inventada", value: "x" }, "POST"))).status).toBe(400);
    expect((await app.request(`${base}/${cliente.id}/preferences`, authedJson(ctx.staff.repartidor.token, { accion: "agregar", kind: "nota", value: "x" }, "POST"))).status).toBe(403);
  });
});

describe("reincidencia y ARCO", () => {
  it("la politica la lee cualquier gestor y SOLO owner/admin la cambia; fuera de rango es 400", async () => {
    const { ctx, app, base } = await mundo();
    const leer = await app.request(`${base}/policy`, authedGet(ctx.staff.staffSucursalA.token));
    expect(leer.status).toBe(200);
    expect(((await leer.json()) as { policy: { umbralNoRecogidos: number } }).policy.umbralNoRecogidos).toBe(2);
    expect((await app.request(`${base}/policy`, authedJson(ctx.staff.staffSucursalA.token, { umbralNoRecogidos: 3, ventanaDias: 60 }, "PUT"))).status).toBe(403);
    expect((await app.request(`${base}/policy`, authedJson(ctx.staff.admin.token, { umbralNoRecogidos: 3, ventanaDias: 60 }, "PUT"))).status).toBe(200);
    expect((await ctx.restaurantesRepo.getCustomerPolicy(ctx.organizationId)).umbralNoRecogidos).toBe(3);
    expect((await app.request(`${base}/policy`, authedJson(ctx.staff.owner.token, { umbralNoRecogidos: 99, ventanaDias: 60 }, "PUT"))).status).toBe(400);
    expect((await app.request(`${base}/policy`, authedJson(ctx.staff.owner.token, { umbralNoRecogidos: 0, ventanaDias: 90 }, "PUT"))).status).toBe(200);
  });

  it("marcar un pedido como falso: gestor si, repartidor no, pedido de otra organizacion 404", async () => {
    const { ctx, app, cliente, base } = await mundo();
    const pedido = await ctx.restaurantesRepo.createOrderIdempotent(
      { organizationId: ctx.organizationId, propertyId: ctx.propertyIdA, customerId: cliente.id, customerName: "Ana", customerPhone: "9991112222", customerAddress: null, customerEmail: null, branch: "A", total: 50, items: [], source: "whatsapp", notes: null, paymentMethod: "efectivo", callTranscript: null, callRecordingUrl: null },
      "a".repeat(64),
      null,
    );
    const url = `${base}/${cliente.id}/orders/${pedido.id}/falso`;
    expect((await app.request(url, authedJson(ctx.staff.repartidor.token, { falso: true }, "POST"))).status).toBe(403);
    expect((await app.request(url, authedJson(ctx.staff.owner.token, { falso: true }, "POST"))).status).toBe(200);
    expect((await ctx.restaurantesRepo.getCustomerFicha(ctx.organizationId, cliente.id))?.reliability.pedidosFalsos).toBe(1);
    expect((await app.request(`${base}/${cliente.id}/orders/${randomUUID()}/falso`, authedJson(ctx.staff.owner.token, { falso: true }, "POST"))).status).toBe(404);
    expect((await app.request(url, authedJson(ctx.staff.owner.token, { falso: "si" }, "POST"))).status).toBe(400);
  });

  it("ARCO: exportar y borrar la memoria solo para owner/admin; el export incluye gustos y domicilios", async () => {
    const { ctx, app, cliente, base } = await mundo();
    await ctx.restaurantesRepo.saveCustomerAddress(ctx.organizationId, cliente.id, null, { address: "Calle 1 #2" });
    await ctx.restaurantesRepo.applyCustomerPreferenceAction(ctx.organizationId, cliente.id, "agregar", { kind: "nota", value: "sin cebolla" });
    expect((await app.request(`${base}/${cliente.id}/arco-export`, authedGet(ctx.staff.staffSucursalA.token))).status).toBe(403);
    const exp = await app.request(`${base}/${cliente.id}/arco-export`, authedGet(ctx.staff.owner.token));
    expect(exp.status).toBe(200);
    const { datos } = (await exp.json()) as { datos: { domicilios: unknown[]; gustos: unknown[] } };
    expect(datos.domicilios).toHaveLength(1);
    expect(datos.gustos).toHaveLength(1);
    expect((await app.request(`${base}/${cliente.id}/borrar-memoria`, authedJson(ctx.staff.staffSucursalA.token, {}, "POST"))).status).toBe(403);
    expect((await app.request(`${base}/${cliente.id}/borrar-memoria`, authedJson(ctx.staff.admin.token, {}, "POST"))).status).toBe(200);
    const despues = await ctx.restaurantesRepo.getCustomerFicha(ctx.organizationId, cliente.id);
    expect(despues?.addresses).toHaveLength(0);
    expect(despues?.preferences).toHaveLength(0);
  });
});

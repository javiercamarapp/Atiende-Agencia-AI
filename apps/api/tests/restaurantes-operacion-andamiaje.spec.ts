// Andamiaje del panel del operador (PLAN-PANEL-OPERADOR §6, commit 0): las rutas nuevas existen, autorizan por rol/sucursal ANTES de
// contestar y responden 501 `no_implementado` honesto. Nada de exitos falsos. El paquete A1 reemplaza cada 501 por la logica real.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { RUTAS_OPERACION } from "@atiende/domain-restaurantes/operacion";
import type { NombreRutaOperacion } from "@atiende/domain-restaurantes/operacion";
import { authedGet, authedJson, buildRestaurantesKpiTestContext } from "./restaurantes-admin-kpis-fixtures.ts";

const ORDER = "3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b";

const ADMIN: readonly NombreRutaOperacion[] = ["capturarPedido", "cotizarPedido", "clientePorTelefono", "cola", "despachar", "marcarListo", "viajes", "hoy"];
const CHOFER: readonly NombreRutaOperacion[] = ["entregasChofer", "entregar", "deshacerEntrega", "problema", "llamar", "hoyChofer"];

function ruta(nombre: NombreRutaOperacion, propertyId: string): string {
  return RUTAS_OPERACION[nombre].patron.replace(":propertyId", propertyId).replace(":orderId", ORDER);
}

async function contexto() {
  const ctx = await buildRestaurantesKpiTestContext(buildApp);
  const app = buildApp(ctx.deps);
  const pedir = (nombre: NombreRutaOperacion, propertyId: string, token: string | null): Promise<Response> => {
    const metodo = RUTAS_OPERACION[nombre].metodo;
    const init: RequestInit = token === null ? { method: metodo } : metodo === "GET" ? authedGet(token) : authedJson(token, {}, "POST");
    return Promise.resolve(app.request(ruta(nombre, propertyId), init));
  };
  return { ctx, app, pedir };
}

describe("rutas del encargado (andamiaje)", () => {
  for (const nombre of ADMIN) {
    const { metodo, patron } = RUTAS_OPERACION[nombre];
    it(`${metodo} ${patron}: 501 no_implementado para owner y staff de la sucursal`, async () => {
      const { ctx, pedir } = await contexto();
      for (const quien of [ctx.staff.owner, ctx.staff.staffSucursalA]) {
        const res = await pedir(nombre, ctx.propertyIdA, quien.token);
        expect(res.status).toBe(501);
        expect(await res.json()).toMatchObject({ code: "no_implementado" });
      }
    });

    it(`${metodo} ${patron}: sin sesion 401, repartidor 403 y staff de otra sucursal nunca llega al 501`, async () => {
      const { ctx, pedir } = await contexto();
      expect((await pedir(nombre, ctx.propertyIdA, null)).status).toBe(401);
      expect((await pedir(nombre, ctx.propertyIdA, ctx.staff.repartidor.token)).status).toBe(403);
      // Staff acotado a la sucursal A sobre la sucursal B: la membresia por sucursal lo rechaza antes de la ruta.
      expect((await pedir(nombre, ctx.propertyIdB, ctx.staff.staffSucursalA.token)).status).toBe(403);
    });
  }
});

describe("rutas del chofer (andamiaje)", () => {
  for (const nombre of CHOFER) {
    const { metodo, patron } = RUTAS_OPERACION[nombre];
    it(`${metodo} ${patron}: 501 para el repartidor; owner y staff 403; sin sesion 401`, async () => {
      const { ctx, pedir } = await contexto();
      const res = await pedir(nombre, ctx.propertyIdA, ctx.staff.repartidor.token);
      expect(res.status).toBe(501);
      expect(await res.json()).toMatchObject({ code: "no_implementado" });
      expect((await pedir(nombre, ctx.propertyIdA, ctx.staff.owner.token)).status).toBe(403);
      expect((await pedir(nombre, ctx.propertyIdA, ctx.staff.staffSucursalA.token)).status).toBe(403);
      expect((await pedir(nombre, ctx.propertyIdA, null)).status).toBe(401);
    });
  }
});

describe("no rompe las rutas vigentes que comparten prefijo", () => {
  it("GET admin/orders, GET admin/orders/:id y GET repartidor/orders siguen en sus handlers (no el 501)", async () => {
    const { ctx, app } = await contexto();
    const lista = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders`, authedGet(ctx.staff.owner.token));
    expect(lista.status).toBe(200);
    const inexistente = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${ORDER}`, authedGet(ctx.staff.owner.token));
    expect(inexistente.status).toBe(404);
    const chofer = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/repartidor/orders`, authedGet(ctx.staff.repartidor.token));
    expect(chofer.status).toBe(200);
    const patchViejo = await app.request(`/v1/restaurantes/${ctx.propertyIdA}/admin/orders/${ORDER}/status`, authedJson(ctx.staff.owner.token, { status: "preparando" }, "PATCH"));
    expect(patchViejo.status).toBe(404);
  });
});

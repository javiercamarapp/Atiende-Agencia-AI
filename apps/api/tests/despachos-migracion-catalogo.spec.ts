// Fase 5 (migración de catálogo contable): verifica que la ruta HTTP clasifica de
// verdad usando el motor real, persiste los mapeos, y que el flujo humano
// aprobar/rechazar/editar (con sus guardias de cardinalidad REQ-MIG-008) funciona
// de punta a punta a través de HTTP -- no solo en el dominio (ya cubierto por
// migracion-catalogo-migrador.spec.ts).
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

function cuenta(id: string, codigo: string, nombre: string, extra: Record<string, unknown> = {}) {
  return { id, codigo, nombre, nivel: 1, naturaleza: "D", tipoAgregado: "Activo", ...extra };
}

describe("POST /despachos/:propertyId/migracion-catalogo/clasificar", () => {
  it("clasifica el catálogo y persiste un mapeo exacto ya aprobado", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/despachos/${ctx.propertyId}/migracion-catalogo/clasificar`,
      authedJson(ctx.staff.contador.token, {
        catalogoOrigen: [cuenta("o1", "101-001", "Caja General")],
        catalogoDestino: [cuenta("d1", "101-001", "Caja General")],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mapeos: Array<{ tipoMatch: string; estado: string; score: number }> };
    expect(body.mapeos).toHaveLength(1);
    expect(body.mapeos[0]!.tipoMatch).toBe("exacto");
    expect(body.mapeos[0]!.estado).toBe("aprobado");
    expect(body.mapeos[0]!.score).toBe(100);
  });

  it("readonly/auditor no pueden clasificar -- 403", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/migracion-catalogo/clasificar`, authedJson(ctx.staff.readonly.token, { catalogoOrigen: [], catalogoDestino: [] }));
    expect(res.status).toBe(403);
  });
});

describe("flujo humano aprobar/rechazar/editar", () => {
  async function clasificarUnMapeoPendiente(app: ReturnType<typeof buildApp>) {
    const res = await app.request(
      `/despachos/${ctx.propertyId}/migracion-catalogo/clasificar`,
      authedJson(ctx.staff.contador.token, {
        // "Gasto Operativo" vs "Gastos Operativos" -> no exacto, no alerta (ninguno
        // coincide en código); fuzzy por encima del umbral 60 -> pendiente.
        catalogoOrigen: [cuenta("o1", "601", "Gasto Operativo Diverso")],
        catalogoDestino: [cuenta("d1", "701", "Gastos Operativos Diversos")],
      }),
    );
    const body = (await res.json()) as { mapeos: Array<{ id: string; estado: string; tipoMatch: string }> };
    return body.mapeos[0]!;
  }

  it("aprueba un mapeo pendiente", async () => {
    const app = buildApp(ctx.deps);
    const mapeo = await clasificarUnMapeoPendiente(app);
    expect(mapeo.estado).toBe("pendiente");

    const res = await app.request(`/despachos/${ctx.propertyId}/migracion-catalogo/mapeos/${mapeo.id}/aprobar`, authedJson(ctx.staff.contador.token, { decididoPor: "contador-1" }));
    expect(res.status).toBe(200);
    const actualizado = (await res.json()) as { estado: string; aprobadoPor: string };
    expect(actualizado.estado).toBe("aprobado");
    expect(actualizado.aprobadoPor).toBe("contador-1");
  });

  it("rechaza un mapeo pendiente con nota obligatoria", async () => {
    const app = buildApp(ctx.deps);
    const mapeo = await clasificarUnMapeoPendiente(app);
    const res = await app.request(`/despachos/${ctx.propertyId}/migracion-catalogo/mapeos/${mapeo.id}/rechazar`, authedJson(ctx.staff.contador.token, { decididoPor: "contador-1", nota: "no corresponde" }));
    expect(res.status).toBe(200);
    const actualizado = (await res.json()) as { estado: string };
    expect(actualizado.estado).toBe("rechazado");
  });

  it("editar sin nota -> 500/error de dominio propagado (nota obligatoria)", async () => {
    const app = buildApp(ctx.deps);
    const mapeo = await clasificarUnMapeoPendiente(app);
    const res = await app.request(
      `/despachos/${ctx.propertyId}/migracion-catalogo/mapeos/${mapeo.id}/editar`,
      authedJson(ctx.staff.contador.token, { decididoPor: "contador-1", destinoCuentaId: "d999", nota: "" }),
    );
    expect(res.status).not.toBe(200);
  });

  it("guardia 1:N -- aprobar un segundo mapeo de la MISMA cuenta origen hacia otro destino ya activo -> conflicto (409)", async () => {
    const app = buildApp(ctx.deps);
    // Dos clasificaciones con la MISMA cuenta origen contra dos destinos distintos
    // no aparecen naturalmente del clasificador (solo produce un mapeo por origen
    // por corrida) -- se simulan directamente en el repo para probar la guardia end
    // to end vía HTTP.
    const m1 = await ctx.despachosRepo.insertMapeoMigracion({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      origenCuentaId: "o1",
      destinoCuentaId: "d1",
      tipoMatch: "fuzzy",
      score: 80,
      estado: "aprobado",
      nota: null,
    });
    const m2 = await ctx.despachosRepo.insertMapeoMigracion({
      organizationId: ctx.organizationId,
      propertyId: ctx.propertyId,
      origenCuentaId: "o1",
      destinoCuentaId: "d2",
      tipoMatch: "fuzzy",
      score: 75,
      estado: "pendiente",
      nota: null,
    });
    void m1;
    const res = await app.request(`/despachos/${ctx.propertyId}/migracion-catalogo/mapeos/${m2.id}/aprobar`, authedJson(ctx.staff.contador.token, { decididoPor: "contador-1" }));
    expect(res.status).toBe(409);
  });
});

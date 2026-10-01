// Rn-18 -- HTTP end-to-end de las reglas de comision de canal configurables (GET/POST/PATCH + sembrado de sugeridas).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRentasCatalogoRepository } from "@atiende/domain-rentas";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";
import type { RentasTestContext } from "./rentas-fixtures.ts";

async function preparar() {
  const ctx = await buildRentasTestContext(buildApp);
  const catalogo = new InMemoryRentasCatalogoRepository();
  catalogo.seedPropiedad({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, nombre: "Matriz" });
  const app = buildApp({ ...ctx.deps, rentasCatalogoRepo: () => catalogo });
  return { ctx, catalogo, app };
}

const ruta = (ctx: RentasTestContext) => `/rentas/${ctx.propertyId}/finanzas/reglas-comision`;
const get = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const cuerpo = { canalCodigo: "booking", alcance: "organizacion", yaNetoDeComision: false, comisionBasisPoints: 1500, fuente: "contrato Booking 2027" };

describe("GET /rentas/:propertyId/finanzas/reglas-comision", () => {
  it("un tenant sin reglas ve la lista vacia y los canales externos sin cobertura (manual tiene default seguro)", async () => {
    const { ctx, app } = await preparar();
    const res = await app.request(ruta(ctx), get(ctx.staff.adminGestora.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reglas: unknown[]; canales: { codigo: string }[]; canalesSinRegla: string[] };
    expect(body.reglas).toEqual([]);
    expect(body.canales.map((c) => c.codigo).sort()).toEqual(["airbnb", "booking", "manual", "vrbo"]);
    expect(body.canalesSinRegla.sort()).toEqual(["airbnb", "booking", "vrbo"]);
  });

  it("admin_gestora y contador leen; operador y limpieza -> 403", async () => {
    const { ctx, app } = await preparar();
    expect((await app.request(ruta(ctx), get(ctx.staff.contador.token))).status).toBe(200);
    for (const rol of ["operadorAccesoTotal", "operadorSoloCalendario", "limpieza"] as const) {
      expect((await app.request(ruta(ctx), get(ctx.staff[rol].token))).status, rol).toBe(403);
    }
  });

  it("solo muestra las reglas globales de la organizacion y las de ESTA propiedad, nunca las de otra propiedad", async () => {
    const { ctx, catalogo, app } = await preparar();
    const otraPropiedad = randomUUID();
    catalogo.seedPropiedad({ organizationId: ctx.organizationId, propertyId: otraPropiedad, nombre: "Otra" });
    await catalogo.crearReglaComision(ctx.organizationId, ctx.propertyId, { ...cuerpo, alcance: "propiedad", canalCodigo: "vrbo" } as never);
    await catalogo.crearReglaComision(ctx.organizationId, otraPropiedad, { ...cuerpo, alcance: "propiedad", canalCodigo: "airbnb", yaNetoDeComision: true, comisionBasisPoints: 0 } as never);
    await catalogo.crearReglaComision(ctx.organizationId, ctx.propertyId, cuerpo as never);
    const res = await app.request(ruta(ctx), get(ctx.staff.adminGestora.token));
    const { reglas } = (await res.json()) as { reglas: { canalCodigo: string; alcance: string }[] };
    expect(reglas.map((r) => `${r.canalCodigo}:${r.alcance}`).sort()).toEqual(["booking:organizacion", "vrbo:propiedad"]);
  });
});

describe("POST /rentas/:propertyId/finanzas/reglas-comision", () => {
  it("admin_gestora crea una regla global: 201, queda en la lista y en la bitacora", async () => {
    const { ctx, app } = await preparar();
    const res = await app.request(ruta(ctx), authedJson(ctx.staff.adminGestora.token, cuerpo, {}, "POST"));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const lista = (await (await app.request(ruta(ctx), get(ctx.staff.adminGestora.token))).json()) as { reglas: { id: string; comisionBasisPoints: number; sugerida: boolean }[]; canalesSinRegla: string[] };
    expect(lista.reglas).toEqual([expect.objectContaining({ id, comisionBasisPoints: 1500, sugerida: false })]);
    expect(lista.canalesSinRegla).not.toContain("booking");
    expect(ctx.rentasRepo.auditLog.find((r) => r.action === "regla_comision.creada")).toMatchObject({ entityType: "regla_comision", entityId: id });
  });

  it("alcance 'propiedad' la ata a la propiedad del path", async () => {
    const { ctx, app } = await preparar();
    await app.request(ruta(ctx), authedJson(ctx.staff.adminGestora.token, { ...cuerpo, alcance: "propiedad" }, {}, "POST"));
    const { reglas } = (await (await app.request(ruta(ctx), get(ctx.staff.adminGestora.token))).json()) as { reglas: { propertyId: string | null }[] };
    expect(reglas[0]?.propertyId).toBe(ctx.propertyId);
  });

  it("duplicar canal y alcance -> 409; contador, operador y limpieza -> 403 sin escribir nada", async () => {
    const { ctx, catalogo, app } = await preparar();
    expect((await app.request(ruta(ctx), authedJson(ctx.staff.adminGestora.token, cuerpo, {}, "POST"))).status).toBe(201);
    expect((await app.request(ruta(ctx), authedJson(ctx.staff.adminGestora.token, cuerpo, {}, "POST"))).status).toBe(409);
    for (const rol of ["contador", "operadorAccesoTotal", "limpieza"] as const) {
      expect((await app.request(ruta(ctx), authedJson(ctx.staff[rol].token, { ...cuerpo, canalCodigo: "vrbo" }, {}, "POST"))).status, rol).toBe(403);
    }
    expect(catalogo.reglas.size).toBe(1);
  });

  it("validacion de borde: pb fuera de rango/decimal, ya neto con pb, fuente corta, alcance y canal invalidos -> 400", async () => {
    const { ctx, app } = await preparar();
    const casos: Record<string, unknown>[] = [
      { ...cuerpo, comisionBasisPoints: 10001 },
      { ...cuerpo, comisionBasisPoints: -1 },
      { ...cuerpo, comisionBasisPoints: 12.5 },
      { ...cuerpo, yaNetoDeComision: true, comisionBasisPoints: 100 },
      { ...cuerpo, fuente: "ab" },
      { ...cuerpo, alcance: "global" },
      { ...cuerpo, canalCodigo: "x; drop table" },
    ];
    for (const c of casos) expect((await app.request(ruta(ctx), authedJson(ctx.staff.adminGestora.token, c, {}, "POST"))).status, JSON.stringify(c)).toBe(400);
    expect((await app.request(ruta(ctx), authedJson(ctx.staff.adminGestora.token, { ...cuerpo, comisionBasisPoints: 10000 }, {}, "POST"))).status).toBe(201);
  });

  it("base sin la migracion 027 -> 503 honesto (no un 500) y la lectura sigue funcionando", async () => {
    const { ctx, catalogo, app } = await preparar();
    catalogo.migracion027Disponible = false;
    const res = await app.request(ruta(ctx), authedJson(ctx.staff.adminGestora.token, cuerpo, {}, "POST"));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { message: string }).message).toMatch(/migración 027/);
    expect((await app.request(ruta(ctx), get(ctx.staff.adminGestora.token))).status).toBe(200);
  });

  it("sin sesion -> 401", async () => {
    const { ctx, app } = await preparar();
    expect((await app.request(ruta(ctx), { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(401);
  });
});

describe("PATCH /rentas/:propertyId/finanzas/reglas-comision/:reglaId", () => {
  it("edita pb y fuente: persiste y la bitacora guarda el antes y el despues", async () => {
    const { ctx, app } = await preparar();
    const { id } = (await (await app.request(ruta(ctx), authedJson(ctx.staff.adminGestora.token, cuerpo, {}, "POST"))).json()) as { id: string };
    const res = await app.request(`${ruta(ctx)}/${id}`, authedJson(ctx.staff.adminGestora.token, { yaNetoDeComision: false, comisionBasisPoints: 1800, fuente: "contrato firmado" }, {}, "PATCH"));
    expect(res.status).toBe(200);
    const { reglas } = (await (await app.request(ruta(ctx), get(ctx.staff.adminGestora.token))).json()) as { reglas: { comisionBasisPoints: number; fuente: string }[] };
    expect(reglas[0]).toMatchObject({ comisionBasisPoints: 1800, fuente: "contrato firmado" });
    const fila = ctx.rentasRepo.auditLog.find((r) => r.action === "regla_comision.actualizada");
    expect(fila?.antes).toContain("1500pb");
    expect(fila?.despues).toContain("1800pb");
  });

  it("una regla inexistente o de OTRA propiedad -> 404; contador/limpieza -> 403; cuerpo invalido -> 400", async () => {
    const { ctx, catalogo, app } = await preparar();
    const otraPropiedad = randomUUID();
    catalogo.seedPropiedad({ organizationId: ctx.organizationId, propertyId: otraPropiedad, nombre: "Otra" });
    const ajena = await catalogo.crearReglaComision(ctx.organizationId, otraPropiedad, { ...cuerpo, alcance: "propiedad" } as never);
    const idAjena = ajena.estado === "ok" ? ajena.valor.id : "";
    const nuevo = { yaNetoDeComision: false, comisionBasisPoints: 100, fuente: "fuente valida" };
    const patch = (token: string, id: string, body: unknown) => app.request(`${ruta(ctx)}/${id}`, authedJson(token, body, {}, "PATCH"));

    expect((await patch(ctx.staff.adminGestora.token, idAjena, nuevo)).status).toBe(404);
    expect((await patch(ctx.staff.adminGestora.token, randomUUID(), nuevo)).status).toBe(404);
    expect(catalogo.reglas.get(idAjena)?.bps).toBe(1500);
    const { id } = (await (await app.request(ruta(ctx), authedJson(ctx.staff.adminGestora.token, cuerpo, {}, "POST"))).json()) as { id: string };
    expect((await patch(ctx.staff.contador.token, id, nuevo)).status).toBe(403);
    expect((await patch(ctx.staff.limpieza.token, id, nuevo)).status).toBe(403);
    expect((await patch(ctx.staff.adminGestora.token, id, { ...nuevo, comisionBasisPoints: 20000 })).status).toBe(400);
  });
});

describe("POST /rentas/:propertyId/finanzas/reglas-comision/sugeridas", () => {
  it("siembra las 4 reglas por defecto una vez (201) y es idempotente (200, 0 creadas); queda en la bitacora", async () => {
    const { ctx, app } = await preparar();
    const primera = await app.request(`${ruta(ctx)}/sugeridas`, authedJson(ctx.staff.adminGestora.token, {}, {}, "POST"));
    expect(primera.status).toBe(201);
    expect(await primera.json()).toEqual({ creadas: 4 });
    const segunda = await app.request(`${ruta(ctx)}/sugeridas`, authedJson(ctx.staff.adminGestora.token, {}, {}, "POST"));
    expect(segunda.status).toBe(200);
    expect(await segunda.json()).toEqual({ creadas: 0 });
    expect(ctx.rentasRepo.auditLog.filter((r) => r.action === "regla_comision.sugeridas_cargadas")).toHaveLength(1);
    const lista = (await (await app.request(ruta(ctx), get(ctx.staff.adminGestora.token))).json()) as { reglas: { sugerida: boolean; canalCodigo: string; yaNetoDeComision: boolean }[]; canalesSinRegla: string[] };
    expect(lista.reglas).toHaveLength(4);
    expect(lista.reglas.every((r) => r.sugerida)).toBe(true);
    expect(lista.reglas.find((r) => r.canalCodigo === "airbnb")?.yaNetoDeComision).toBe(true);
    expect(lista.canalesSinRegla).toEqual([]);
  });

  it("no pisa una regla ya configurada y solo admin_gestora puede (contador -> 403); sin migracion -> 503", async () => {
    const { ctx, catalogo, app } = await preparar();
    await app.request(ruta(ctx), authedJson(ctx.staff.adminGestora.token, cuerpo, {}, "POST"));
    const res = await app.request(`${ruta(ctx)}/sugeridas`, authedJson(ctx.staff.adminGestora.token, {}, {}, "POST"));
    expect(await res.json()).toEqual({ creadas: 3 });
    expect([...catalogo.reglas.values()].find((r) => r.canalCodigo === "booking")?.bps).toBe(1500);
    expect((await app.request(`${ruta(ctx)}/sugeridas`, authedJson(ctx.staff.contador.token, {}, {}, "POST"))).status).toBe(403);
    catalogo.migracion027Disponible = false;
    expect((await app.request(`${ruta(ctx)}/sugeridas`, authedJson(ctx.staff.adminGestora.token, {}, {}, "POST"))).status).toBe(503);
  });
});

// Rn-19 -- HTTP end-to-end del alta y edicion de propiedades, unidades y propietarios desde el panel.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryRentasCatalogoRepository } from "@atiende/domain-rentas";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";
import type { RentasTestContext } from "./rentas-fixtures.ts";

async function preparar() {
  const ctx = await buildRentasTestContext(buildApp);
  const catalogo = new InMemoryRentasCatalogoRepository();
  catalogo.seedPropiedad({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, nombre: "Matriz", zonaHoraria: "America/Cancun", moneda: "MXN" });
  const propietarioId = randomUUID();
  catalogo.seedPropietario({ id: propietarioId, nombre: "Ana Dueña", email: "ana@example.com", organizationIds: [ctx.organizationId] });
  const app = buildApp({ ...ctx.deps, rentasCatalogoRepo: () => catalogo });
  return { ctx, catalogo, app, propietarioId };
}

const raiz = (ctx: RentasTestContext) => `/v1/rentas/${ctx.propertyId}/admin/catalogo`;
const get = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const enviar = (token: string, body: unknown, method: "POST" | "PATCH") => authedJson(token, body, {}, method);

describe("GET /v1/rentas/:propertyId/admin/catalogo", () => {
  it("devuelve la propiedad con su configuracion, las unidades con su propietario y los propietarios", async () => {
    const { ctx, catalogo, app, propietarioId } = await preparar();
    catalogo.seedUnidad({ id: ctx.unidadId, organizationId: ctx.organizationId, propertyId: ctx.propertyId, nombre: "Suite 1", propietarioId, duracionMinimaNoches: 2 });
    const res = await app.request(raiz(ctx), get(ctx.staff.adminGestora.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { propiedad: { zonaHoraria: string; moneda: string }; unidades: { propietarioNombre: string }[]; propietarios: unknown[]; monedas: string[]; puedeEditar: boolean };
    expect(body.propiedad).toMatchObject({ zonaHoraria: "America/Cancun", moneda: "MXN" });
    expect(body.unidades[0]?.propietarioNombre).toBe("Ana Dueña");
    expect(body.propietarios).toHaveLength(1);
    expect(body.monedas).toEqual(["MXN", "USD"]);
    expect(body.puedeEditar).toBe(true);
  });

  it("operador de acceso total y contador leen (sin poder editar); operador de calendario y limpieza -> 403", async () => {
    const { ctx, app } = await preparar();
    for (const rol of ["operadorAccesoTotal", "contador"] as const) {
      const res = await app.request(raiz(ctx), get(ctx.staff[rol].token));
      expect(res.status, rol).toBe(200);
      expect(((await res.json()) as { puedeEditar: boolean }).puedeEditar).toBe(false);
    }
    for (const rol of ["operadorSoloCalendario", "limpieza"] as const) expect((await app.request(raiz(ctx), get(ctx.staff[rol].token))).status, rol).toBe(403);
  });

  it("nunca muestra unidades de otra propiedad", async () => {
    const { ctx, catalogo, app } = await preparar();
    const otra = randomUUID();
    catalogo.seedPropiedad({ organizationId: ctx.organizationId, propertyId: otra, nombre: "Otra" });
    catalogo.seedUnidad({ id: randomUUID(), organizationId: ctx.organizationId, propertyId: otra, nombre: "Ajena" });
    const { unidades } = (await (await app.request(raiz(ctx), get(ctx.staff.adminGestora.token))).json()) as { unidades: unknown[] };
    expect(unidades).toEqual([]);
  });
});

describe("propiedades", () => {
  it("PATCH propiedad: edita nombre, zona IANA y moneda; persiste y queda en la bitacora con el antes", async () => {
    const { ctx, app } = await preparar();
    const res = await app.request(`${raiz(ctx)}/propiedad`, enviar(ctx.staff.adminGestora.token, { nombre: "Casa Playa", zonaHoraria: "America/Mexico_City", moneda: "USD" }, "PATCH"));
    expect(res.status).toBe(200);
    const body = (await (await app.request(raiz(ctx), get(ctx.staff.adminGestora.token))).json()) as { propiedad: { nombre: string; zonaHoraria: string; moneda: string } };
    expect(body.propiedad).toEqual(expect.objectContaining({ nombre: "Casa Playa", zonaHoraria: "America/Mexico_City", moneda: "USD" }));
    const fila = ctx.rentasRepo.auditLog.find((r) => r.action === "propiedad.actualizada");
    expect(fila).toMatchObject({ entityType: "propiedad", entityId: ctx.propertyId });
    expect(fila?.antes).toContain("moneda=MXN");
    expect(fila?.despues).toContain("moneda=USD");
  });

  it("validacion: zona inventada, moneda EUR, nombre corto y cuerpo vacio -> 400; nada se escribe", async () => {
    const { ctx, catalogo, app } = await preparar();
    for (const body of [{ zonaHoraria: "Marte/Olimpo" }, { moneda: "EUR" }, { moneda: "mxn" }, { nombre: "X" }, {}]) {
      expect((await app.request(`${raiz(ctx)}/propiedad`, enviar(ctx.staff.adminGestora.token, body, "PATCH"))).status, JSON.stringify(body)).toBe(400);
    }
    expect(catalogo.propiedades.get(ctx.propertyId)).toMatchObject({ nombre: "Matriz", moneda: "MXN" });
  });

  it("cambiar la moneda de una propiedad con movimientos financieros -> 409; con otro campo si se puede", async () => {
    const { ctx, catalogo, app } = await preparar();
    catalogo.propiedadesConMovimientos.add(ctx.propertyId);
    expect((await app.request(`${raiz(ctx)}/propiedad`, enviar(ctx.staff.adminGestora.token, { moneda: "USD" }, "PATCH"))).status).toBe(409);
    expect((await app.request(`${raiz(ctx)}/propiedad`, enviar(ctx.staff.adminGestora.token, { zonaHoraria: "America/Tijuana" }, "PATCH"))).status).toBe(200);
  });

  it("D-DSD-07 (Rn-P3-11): cambiar la zona horaria con reservas o bloqueos activos -> 409 y nada se escribe; sin ocupaciones -> 200; misma zona -> 200", async () => {
    const { ctx, catalogo, app } = await preparar();
    catalogo.propiedadesConOcupacionesActivas.add(ctx.propertyId);
    const res = await app.request(`${raiz(ctx)}/propiedad`, enviar(ctx.staff.adminGestora.token, { zonaHoraria: "America/Tijuana" }, "PATCH"));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message?: string; error?: string }).message ?? "").toContain("zona horaria");
    expect(catalogo.propiedades.get(ctx.propertyId)).toMatchObject({ zonaHoraria: "America/Cancun" });
    // Reenviar la misma zona (la web manda el formulario completo) no cuenta como cambio.
    expect((await app.request(`${raiz(ctx)}/propiedad`, enviar(ctx.staff.adminGestora.token, { nombre: "Matriz 2", zonaHoraria: "America/Cancun" }, "PATCH"))).status).toBe(200);
    catalogo.propiedadesConOcupacionesActivas.delete(ctx.propertyId);
    expect((await app.request(`${raiz(ctx)}/propiedad`, enviar(ctx.staff.adminGestora.token, { zonaHoraria: "America/Tijuana" }, "PATCH"))).status).toBe(200);
    expect(catalogo.propiedades.get(ctx.propertyId)).toMatchObject({ zonaHoraria: "America/Tijuana" });
  });

  it("POST propiedades: crea una propiedad nueva de la organizacion (201); nombre repetido -> 409", async () => {
    const { ctx, catalogo, app } = await preparar();
    const body = { nombre: "Casa Nueva", zonaHoraria: "America/Cancun", moneda: "USD" };
    const res = await app.request(`${raiz(ctx)}/propiedades`, enviar(ctx.staff.adminGestora.token, body, "POST"));
    expect(res.status).toBe(201);
    const { propertyId } = (await res.json()) as { propertyId: string };
    expect(catalogo.propiedades.get(propertyId)).toMatchObject({ organizationId: ctx.organizationId, moneda: "USD" });
    expect(ctx.rentasRepo.auditLog.find((r) => r.action === "propiedad.creada")).toMatchObject({ entityType: "propiedad", entityId: propertyId });
    // El alta de la propiedad deja sembradas las reglas de comision por defecto de la organizacion.
    expect([...catalogo.reglas.values()].filter((r) => r.organizationId === ctx.organizationId)).toHaveLength(4);
    expect((await app.request(`${raiz(ctx)}/propiedades`, enviar(ctx.staff.adminGestora.token, { ...body, nombre: "casa nueva" }, "POST"))).status).toBe(409);
  });

  it("solo admin_gestora escribe: operador, contador y limpieza -> 403", async () => {
    const { ctx, catalogo, app } = await preparar();
    for (const rol of ["operadorAccesoTotal", "contador", "limpieza"] as const) {
      expect((await app.request(`${raiz(ctx)}/propiedad`, enviar(ctx.staff[rol].token, { nombre: "Hackeada" }, "PATCH"))).status, rol).toBe(403);
      expect((await app.request(`${raiz(ctx)}/propiedades`, enviar(ctx.staff[rol].token, { nombre: "Nueva", zonaHoraria: "America/Cancun", moneda: "MXN" }, "POST"))).status, rol).toBe(403);
    }
    expect(catalogo.propiedades.size).toBe(1);
    expect(catalogo.propiedades.get(ctx.propertyId)?.nombre).toBe("Matriz");
  });
});

describe("unidades", () => {
  it("POST unidades: crea con propietario y estancia minima (201) y queda en la bitacora", async () => {
    const { ctx, catalogo, app, propietarioId } = await preparar();
    const res = await app.request(`${raiz(ctx)}/unidades`, enviar(ctx.staff.adminGestora.token, { nombre: "Suite 2", propietarioId, duracionMinimaNoches: 3 }, "POST"));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(catalogo.unidades.get(id)).toMatchObject({ propertyId: ctx.propertyId, propietarioId, duracionMinimaNoches: 3 });
    expect(ctx.rentasRepo.auditLog.find((r) => r.action === "unidad.creada")).toMatchObject({ entityType: "unidad", entityId: id });
  });

  it("validacion y reglas: nombre repetido -> 409, estancia 0/366 -> 400, propietario de otra organizacion -> 400", async () => {
    const { ctx, catalogo, app } = await preparar();
    const ajeno = randomUUID();
    catalogo.seedPropietario({ id: ajeno, nombre: "Ajeno", organizationIds: [randomUUID()] });
    const crear = (body: unknown) => app.request(`${raiz(ctx)}/unidades`, enviar(ctx.staff.adminGestora.token, body, "POST"));
    expect((await crear({ nombre: "Suite 2" })).status).toBe(201);
    expect((await crear({ nombre: "Suite 2" })).status).toBe(409);
    expect((await crear({ nombre: "S", duracionMinimaNoches: 0 })).status).toBe(400);
    expect((await crear({ nombre: "S", duracionMinimaNoches: 366 })).status).toBe(400);
    expect((await crear({ nombre: "S", propietarioId: "no-uuid" })).status).toBe(400);
    expect((await crear({ nombre: "S3", propietarioId: ajeno })).status).toBe(400);
  });

  it("PATCH unidad: renombra, cambia y quita el propietario; la bitacora guarda el antes", async () => {
    const { ctx, catalogo, app, propietarioId } = await preparar();
    catalogo.seedUnidad({ id: ctx.unidadId, organizationId: ctx.organizationId, propertyId: ctx.propertyId, nombre: "Suite 1", propietarioId });
    const patch = (body: unknown) => app.request(`${raiz(ctx)}/unidades/${ctx.unidadId}`, enviar(ctx.staff.adminGestora.token, body, "PATCH"));
    expect((await patch({ nombre: "Suite Principal", duracionMinimaNoches: 4 })).status).toBe(200);
    expect((await patch({ propietarioId: null })).status).toBe(200);
    expect(catalogo.unidades.get(ctx.unidadId)).toMatchObject({ nombre: "Suite Principal", duracionMinimaNoches: 4, propietarioId: null });
    expect(ctx.rentasRepo.auditLog.find((r) => r.action === "unidad.actualizada")?.antes).toContain("nombre=Suite 1");
    expect((await patch({})).status).toBe(400);
  });

  it("una unidad de OTRA propiedad (o inexistente) -> 404, sin tocarla (aislamiento)", async () => {
    const { ctx, catalogo, app } = await preparar();
    const otra = randomUUID();
    const unidadAjena = randomUUID();
    catalogo.seedPropiedad({ organizationId: ctx.organizationId, propertyId: otra, nombre: "Otra" });
    catalogo.seedUnidad({ id: unidadAjena, organizationId: ctx.organizationId, propertyId: otra, nombre: "Ajena" });
    const patch = (id: string) => app.request(`${raiz(ctx)}/unidades/${id}`, enviar(ctx.staff.adminGestora.token, { nombre: "Cambiada" }, "PATCH"));
    expect((await patch(unidadAjena)).status).toBe(404);
    expect((await patch(randomUUID())).status).toBe(404);
    expect(catalogo.unidades.get(unidadAjena)?.nombre).toBe("Ajena");
  });

  it("solo admin_gestora escribe (operador, contador, limpieza -> 403)", async () => {
    const { ctx, catalogo, app } = await preparar();
    for (const rol of ["operadorAccesoTotal", "contador", "limpieza"] as const) {
      expect((await app.request(`${raiz(ctx)}/unidades`, enviar(ctx.staff[rol].token, { nombre: "Suite X" }, "POST"))).status, rol).toBe(403);
    }
    expect(catalogo.unidades.size).toBe(0);
  });
});

describe("propietarios", () => {
  it("POST: crea con correo en minusculas (201); la bitacora NO guarda el correo", async () => {
    const { ctx, catalogo, app } = await preparar();
    const res = await app.request(`${raiz(ctx)}/propietarios`, enviar(ctx.staff.adminGestora.token, { nombre: "Luis Pérez", email: "Luis@Example.com" }, "POST"));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(catalogo.propietarios.get(id)).toMatchObject({ nombre: "Luis Pérez", email: "luis@example.com" });
    expect(JSON.stringify(ctx.rentasRepo.auditLog)).not.toContain("luis@example.com");
    expect(ctx.rentasRepo.auditLog.find((r) => r.action === "propietario.creado")).toMatchObject({ entityType: "propietario", entityId: id });
  });

  it("validacion: correo invalido -> 400, correo repetido -> 409", async () => {
    const { ctx, app } = await preparar();
    const crear = (body: unknown) => app.request(`${raiz(ctx)}/propietarios`, enviar(ctx.staff.adminGestora.token, body, "POST"));
    expect((await crear({ nombre: "Luis", email: "sin-arroba" })).status).toBe(400);
    expect((await crear({ nombre: "X" })).status).toBe(400);
    expect((await crear({ nombre: "Otra Ana", email: "ANA@example.com" })).status).toBe(409);
  });

  it("PATCH: edita nombre y quita el correo con null; un propietario compartido con otra organizacion -> 403; uno ajeno -> 404", async () => {
    const { ctx, catalogo, app, propietarioId } = await preparar();
    const patch = (id: string, body: unknown) => app.request(`${raiz(ctx)}/propietarios/${id}`, enviar(ctx.staff.adminGestora.token, body, "PATCH"));
    expect((await patch(propietarioId, { nombre: "Ana María", email: null })).status).toBe(200);
    expect(catalogo.propietarios.get(propietarioId)).toMatchObject({ nombre: "Ana María", email: null });

    const compartido = randomUUID();
    catalogo.seedPropietario({ id: compartido, nombre: "Compartido", organizationIds: [ctx.organizationId, randomUUID()] });
    expect((await patch(compartido, { nombre: "Cambiado" })).status).toBe(403);
    expect(catalogo.propietarios.get(compartido)?.nombre).toBe("Compartido");

    const ajeno = randomUUID();
    catalogo.seedPropietario({ id: ajeno, nombre: "Ajeno", organizationIds: [randomUUID()] });
    expect((await patch(ajeno, { nombre: "Cambiado" })).status).toBe(404);
    expect(catalogo.propietarios.get(ajeno)?.nombre).toBe("Ajeno");
  });

  it("solo admin_gestora escribe (operador, contador, limpieza -> 403)", async () => {
    const { ctx, app, propietarioId } = await preparar();
    for (const rol of ["operadorAccesoTotal", "contador", "limpieza"] as const) {
      expect((await app.request(`${raiz(ctx)}/propietarios`, enviar(ctx.staff[rol].token, { nombre: "Luis" }, "POST"))).status, rol).toBe(403);
      expect((await app.request(`${raiz(ctx)}/propietarios/${propietarioId}`, enviar(ctx.staff[rol].token, { nombre: "Luis" }, "PATCH"))).status, rol).toBe(403);
    }
  });
});

describe("base sin la migracion 027", () => {
  it("toda escritura responde 503 honesto (no 500) y la lectura sigue sirviendo", async () => {
    const { ctx, catalogo, app, propietarioId } = await preparar();
    catalogo.seedUnidad({ id: ctx.unidadId, organizationId: ctx.organizationId, propertyId: ctx.propertyId, nombre: "Suite 1" });
    catalogo.migracion027Disponible = false;
    const t = ctx.staff.adminGestora.token;
    const intentos = [
      app.request(`${raiz(ctx)}/propiedad`, enviar(t, { nombre: "Nueva" }, "PATCH")),
      app.request(`${raiz(ctx)}/propiedades`, enviar(t, { nombre: "Otra", zonaHoraria: "America/Cancun", moneda: "MXN" }, "POST")),
      app.request(`${raiz(ctx)}/unidades`, enviar(t, { nombre: "Suite 9" }, "POST")),
      app.request(`${raiz(ctx)}/unidades/${ctx.unidadId}`, enviar(t, { nombre: "Suite 9" }, "PATCH")),
      app.request(`${raiz(ctx)}/propietarios`, enviar(t, { nombre: "Luis" }, "POST")),
      app.request(`${raiz(ctx)}/propietarios/${propietarioId}`, enviar(t, { nombre: "Luis" }, "PATCH")),
    ];
    for (const res of await Promise.all(intentos)) expect(res.status).toBe(503);
    expect(ctx.rentasRepo.auditLog.filter((r) => r.entityType === "propiedad" || r.entityType === "unidad" || r.entityType === "propietario")).toEqual([]);
    expect((await app.request(raiz(ctx), get(t))).status).toBe(200);
  });
});

describe("auditoria (GET .../admin/auditoria) acepta los entity_type nuevos", () => {
  it("el filtro tipo=propiedad|unidad|propietario|regla_comision es valido", async () => {
    const { ctx, app } = await preparar();
    for (const tipo of ["propiedad", "unidad", "propietario", "regla_comision", "membership"]) {
      const res = await app.request(`/v1/rentas/rentas-de-prueba/admin/auditoria?tipo=${tipo}`, get(ctx.staff.adminGestora.token));
      expect(res.status, tipo).toBe(200);
    }
  });
});

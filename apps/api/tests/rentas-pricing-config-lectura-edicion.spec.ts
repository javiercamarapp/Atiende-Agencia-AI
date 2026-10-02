// Rn-23 -- lectura, edición y borrado de la configuración de pricing, HTTP real (app.request),
// sobre el doble en memoria. Cubre: GET .../configuracion-precios, PATCH/DELETE de temporada,
// descuento por duración, min-stay y regla de canal; roles (solo admin_gestora escribe),
// cross-tenant, validación, bitácora y la degradación contra la base sin migrar (42501 -> 503
// dentro de la transacción única del request, con una sesión que reproduce el estado abortado).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { RentasRepository } from "@atiende/domain-rentas";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { authedJson, buildRentasTestContext } from "./rentas-fixtures.ts";

type Ctx = Awaited<ReturnType<typeof buildRentasTestContext>>;

const base = (ctx: Ctx, unidadId = ctx.unidadId) => `/rentas/${ctx.propertyId}/unidades/${unidadId}`;

function borrar(token: string): RequestInit {
  return { method: "DELETE", headers: { authorization: `Bearer ${token}` } };
}

async function crear(app: ReturnType<typeof buildApp>, ctx: Ctx, ruta: string, body: unknown): Promise<{ id: string }> {
  const res = await app.request(`${base(ctx)}/${ruta}`, authedJson(ctx.staff.adminGestora.token, body));
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

async function configuracion(app: ReturnType<typeof buildApp>, ctx: Ctx, token = ctx.staff.adminGestora.token) {
  const res = await app.request(`${base(ctx)}/configuracion-precios`, authedJson(token));
  expect(res.status).toBe(200);
  return (await res.json()) as {
    tarifaBaseVigente: { precioNocheCentavos: number; moneda: string } | null;
    historialTarifaBase: { vigenteDesde: string }[];
    temporadas: { id: string; nombre: string; precioNocheCentavos: number; moneda: string; rango: { inicio: string; fin: string } }[];
    descuentosDuracion: { id: string; nochesMinimas: number; porcentajeDescuentoBasisPoints: number; fuente: string }[];
    reglasMinStay: { id: string; nochesMinimas: number; diaSemanaCheckIn: number | null }[];
    reglasCanal: { id: string; canalCodigo: string; markupBasisPoints: number; activo: boolean }[];
  };
}

const TEMPORADA = { nombre: "Verano", rango: { inicio: "2027-07-01", fin: "2027-08-31" }, precioNocheCentavos: 220000, moneda: "MXN" };

describe("GET .../configuracion-precios", () => {
  it("devuelve lo configurado: tarifa vigente, historial, descuentos sembrados y lo creado después", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { id } = await crear(app, ctx, "temporadas", TEMPORADA);
    await crear(app, ctx, "min-stay", { rango: { inicio: "2027-12-20", fin: "2028-01-05" }, diaSemanaCheckIn: null, nochesMinimas: 5 });
    await crear(app, ctx, "reglas-canal", { canalCodigo: "airbnb", markupBasisPoints: 1500, activo: true });

    const cfg = await configuracion(app, ctx);
    expect(cfg.tarifaBaseVigente).toMatchObject({ precioNocheCentavos: 150000, moneda: "MXN" });
    expect(cfg.historialTarifaBase.length).toBeGreaterThanOrEqual(1);
    expect(cfg.temporadas).toEqual([expect.objectContaining({ id, nombre: "Verano", precioNocheCentavos: 220000, moneda: "MXN" })]);
    expect(cfg.descuentosDuracion).toEqual([expect.objectContaining({ nochesMinimas: 7, porcentajeDescuentoBasisPoints: 1000 })]);
    expect(cfg.reglasMinStay).toHaveLength(1);
    expect(cfg.reglasCanal).toEqual([expect.objectContaining({ canalCodigo: "airbnb", markupBasisPoints: 1500, activo: true })]);
  });

  it("un rol sin escritura (contador) SÍ puede leer; sin token es 401", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const cfg = await configuracion(app, ctx, ctx.staff.contador.token);
    expect(cfg.tarifaBaseVigente?.precioNocheCentavos).toBe(150000);
    const sinToken = await app.request(`${base(ctx)}/configuracion-precios`);
    expect(sinToken.status).toBe(401);
  });

  it("una unidad de otro tenant: 404 (no existe en esta property) y la property ajena 403/404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const ajena = randomUUID();
    ctx.rentasRepo.seedUnidad({ id: ajena, organizationId: randomUUID(), propertyId: randomUUID(), duracionMinimaNoches: 1, name: "Ajena" });
    const res = await app.request(`${base(ctx, ajena)}/configuracion-precios`, authedJson(ctx.staff.adminGestora.token));
    expect(res.status).toBe(404);
    const otraProperty = await app.request(`/rentas/${randomUUID()}/unidades/${ajena}/configuracion-precios`, authedJson(ctx.staff.adminGestora.token));
    expect([403, 404]).toContain(otraProperty.status);
  });
});

describe("PATCH/DELETE .../temporadas/:id", () => {
  it("admin_gestora edita una temporada, la cotización siguiente refleja el cambio y queda en bitácora", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { id } = await crear(app, ctx, "temporadas", TEMPORADA);
    const cot = (q: string) => app.request(`${base(ctx)}/cotizacion?${q}`, authedJson(ctx.staff.adminGestora.token));
    expect(((await (await cot("checkIn=2027-07-10&checkOut=2027-07-11")).json()) as { totalCentavos: number }).totalCentavos).toBe(220000);

    const antes = ctx.rentasRepo.auditLog.length;
    const res = await app.request(`${base(ctx)}/temporadas/${id}`, authedJson(ctx.staff.adminGestora.token, { precioNocheCentavos: 300000 }, {}, "PATCH"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, nombre: "Verano", precioNocheCentavos: 300000 });

    expect(((await (await cot("checkIn=2027-07-10&checkOut=2027-07-11")).json()) as { totalCentavos: number }).totalCentavos).toBe(300000);
    const nuevas = ctx.rentasRepo.auditLog.slice(antes);
    expect(nuevas).toHaveLength(1);
    expect(nuevas[0]).toMatchObject({ action: "pricing.temporada.actualizada", entityType: "pricing", entityId: ctx.unidadId, actorUserId: ctx.staff.adminGestora.id });
    expect(nuevas[0]!.antes).toContain("220000");
    expect(nuevas[0]!.despues).toContain("300000");
  });

  it("rechaza traslape con otra temporada (409), moneda distinta (400), cuerpo vacío (400) y precio decimal (400)", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await crear(app, ctx, "temporadas", TEMPORADA);
    const { id: otra } = await crear(app, ctx, "temporadas", { ...TEMPORADA, nombre: "Invierno", rango: { inicio: "2027-12-01", fin: "2027-12-31" } });
    const patch = (body: unknown) => app.request(`${base(ctx)}/temporadas/${otra}`, authedJson(ctx.staff.adminGestora.token, body, {}, "PATCH"));

    const solapada = await patch({ rango: { inicio: "2027-08-15", fin: "2027-09-15" } });
    expect(solapada.status).toBe(409);
    expect(((await solapada.json()) as { code: string }).code).toBe("pricing_solapado");
    const moneda = await patch({ moneda: "USD" });
    expect(moneda.status).toBe(400);
    expect(((await moneda.json()) as { code: string }).code).toBe("pricing_moneda_inconsistente");
    expect((await patch({})).status).toBe(400);
    expect((await patch({ precioNocheCentavos: 10.5 })).status).toBe(400);
    // Misma temporada con su propio rango no cuenta como traslape consigo misma.
    expect((await patch({ rango: { inicio: "2027-12-05", fin: "2027-12-20" } })).status).toBe(200);
  });

  it("operador y contador reciben 403 en PATCH y DELETE; la fila queda intacta", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { id } = await crear(app, ctx, "temporadas", TEMPORADA);
    for (const token of [ctx.staff.operadorAccesoTotal.token, ctx.staff.contador.token]) {
      expect((await app.request(`${base(ctx)}/temporadas/${id}`, authedJson(token, { precioNocheCentavos: 1 }, {}, "PATCH"))).status).toBe(403);
      expect((await app.request(`${base(ctx)}/temporadas/${id}`, borrar(token))).status).toBe(403);
    }
    expect((await configuracion(app, ctx)).temporadas).toEqual([expect.objectContaining({ id, precioNocheCentavos: 220000 })]);
  });

  it("DELETE borra la temporada, la cotización vuelve a la tarifa base y queda bitácora; un id inexistente es 404", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { id } = await crear(app, ctx, "temporadas", TEMPORADA);
    const antes = ctx.rentasRepo.auditLog.length;
    const res = await app.request(`${base(ctx)}/temporadas/${id}`, borrar(ctx.staff.adminGestora.token));
    expect(res.status).toBe(200);
    expect((await configuracion(app, ctx)).temporadas).toEqual([]);
    const cot = await app.request(`${base(ctx)}/cotizacion?checkIn=2027-07-10&checkOut=2027-07-11`, authedJson(ctx.staff.adminGestora.token));
    expect(((await cot.json()) as { totalCentavos: number }).totalCentavos).toBe(150000);
    expect(ctx.rentasRepo.auditLog.slice(antes)).toEqual([expect.objectContaining({ action: "pricing.temporada.eliminada", entityType: "pricing", despues: null })]);
    expect((await app.request(`${base(ctx)}/temporadas/${id}`, borrar(ctx.staff.adminGestora.token))).status).toBe(404);
    expect((await app.request(`${base(ctx)}/temporadas/${randomUUID()}`, borrar(ctx.staff.adminGestora.token))).status).toBe(404);
  });

  it("cross-tenant: la unidad ajena responde 404 y la temporada de otra unidad no se toca con una unidad propia", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const propia2 = randomUUID();
    ctx.rentasRepo.seedUnidad({ id: propia2, organizationId: ctx.organizationId, propertyId: ctx.propertyId, duracionMinimaNoches: 1, name: "Otra del mismo tenant" });
    const { id } = await crear(app, ctx, "temporadas", TEMPORADA);
    // Mismo id, otra unidad: no existe ahí.
    expect((await app.request(`${base(ctx, propia2)}/temporadas/${id}`, borrar(ctx.staff.adminGestora.token))).status).toBe(404);
    expect((await configuracion(app, ctx)).temporadas).toHaveLength(1);
    const ajena = randomUUID();
    ctx.rentasRepo.seedUnidad({ id: ajena, organizationId: randomUUID(), propertyId: randomUUID(), duracionMinimaNoches: 1, name: "Ajena" });
    expect((await app.request(`${base(ctx, ajena)}/temporadas/${id}`, borrar(ctx.staff.adminGestora.token))).status).toBe(404);
  });
});

describe("PATCH/DELETE descuentos-duracion, min-stay y reglas-canal", () => {
  it("descuento: edita, bloquea duplicado de noches (409) y borra con bitácora", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { id } = await crear(app, ctx, "descuentos-duracion", { nochesMinimas: 28, porcentajeDescuentoBasisPoints: 2000, fuente: "mensual" });
    const url = `${base(ctx)}/descuentos-duracion/${id}`;
    const edit = await app.request(url, authedJson(ctx.staff.adminGestora.token, { porcentajeDescuentoBasisPoints: 2500 }, {}, "PATCH"));
    expect(edit.status).toBe(200);
    expect(await edit.json()).toMatchObject({ nochesMinimas: 28, porcentajeDescuentoBasisPoints: 2500, fuente: "mensual" });
    const dup = await app.request(url, authedJson(ctx.staff.adminGestora.token, { nochesMinimas: 7 }, {}, "PATCH"));
    expect(dup.status).toBe(409);
    expect((await app.request(url, authedJson(ctx.staff.adminGestora.token, { porcentajeDescuentoBasisPoints: 20000 }, {}, "PATCH"))).status).toBe(400);
    expect((await app.request(url, authedJson(ctx.staff.operadorAccesoTotal.token, { porcentajeDescuentoBasisPoints: 1 }, {}, "PATCH"))).status).toBe(403);
    expect((await app.request(url, borrar(ctx.staff.contador.token))).status).toBe(403);
    const antes = ctx.rentasRepo.auditLog.length;
    expect((await app.request(url, borrar(ctx.staff.adminGestora.token))).status).toBe(200);
    expect((await configuracion(app, ctx)).descuentosDuracion.map((d) => d.nochesMinimas)).toEqual([7]);
    expect(ctx.rentasRepo.auditLog.slice(antes)).toEqual([expect.objectContaining({ action: "pricing.descuento_duracion.eliminado" })]);
  });

  it("min-stay: edita, bloquea traslape con el mismo día de check-in (409) y borra", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await crear(app, ctx, "min-stay", { rango: { inicio: "2027-12-20", fin: "2028-01-05" }, diaSemanaCheckIn: null, nochesMinimas: 5 });
    const { id } = await crear(app, ctx, "min-stay", { rango: { inicio: "2028-02-01", fin: "2028-02-10" }, diaSemanaCheckIn: 6, nochesMinimas: 2 });
    const url = `${base(ctx)}/min-stay/${id}`;
    const edit = await app.request(url, authedJson(ctx.staff.adminGestora.token, { nochesMinimas: 3 }, {}, "PATCH"));
    expect(edit.status).toBe(200);
    expect(await edit.json()).toMatchObject({ nochesMinimas: 3, diaSemanaCheckIn: 6 });
    // Cambiar el día a null y mover el rango dentro de la otra regla "todos los días" -> conflicto.
    const conflicto = await app.request(url, authedJson(ctx.staff.adminGestora.token, { rango: { inicio: "2027-12-25", fin: "2027-12-30" }, diaSemanaCheckIn: null }, {}, "PATCH"));
    expect(conflicto.status).toBe(409);
    expect((await app.request(url, authedJson(ctx.staff.adminGestora.token, { diaSemanaCheckIn: 9 }, {}, "PATCH"))).status).toBe(400);
    expect((await app.request(url, borrar(ctx.staff.operadorAccesoTotal.token))).status).toBe(403);
    expect((await app.request(url, borrar(ctx.staff.adminGestora.token))).status).toBe(200);
    expect((await configuracion(app, ctx)).reglasMinStay).toHaveLength(1);
  });

  it("regla de canal: desactiva, la cotización deja de aplicar el markup, y borra", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { id } = await crear(app, ctx, "reglas-canal", { canalCodigo: "airbnb", markupBasisPoints: 1500, activo: true });
    const cot = async () => ((await (await app.request(`${base(ctx)}/cotizacion?checkIn=2027-07-10&checkOut=2027-07-11&canal=airbnb`, authedJson(ctx.staff.adminGestora.token))).json()) as { totalCentavos: number }).totalCentavos;
    expect(await cot()).toBe(172500);
    const url = `${base(ctx)}/reglas-canal/${id}`;
    const off = await app.request(url, authedJson(ctx.staff.adminGestora.token, { activo: false }, {}, "PATCH"));
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ canalCodigo: "airbnb", markupBasisPoints: 1500, activo: false });
    expect(await cot()).toBe(150000);
    expect((await app.request(url, authedJson(ctx.staff.adminGestora.token, { activo: "si" }, {}, "PATCH"))).status).toBe(400);
    expect((await app.request(url, authedJson(ctx.staff.contador.token, { activo: true }, {}, "PATCH"))).status).toBe(403);
    expect((await app.request(url, borrar(ctx.staff.adminGestora.token))).status).toBe(200);
    expect((await configuracion(app, ctx)).reglasCanal).toEqual([]);
    expect((await app.request(url, borrar(ctx.staff.adminGestora.token))).status).toBe(404);
  });
});

// Una sesión que reproduce el estado ABORTADO de Postgres: tras el error 42501 dentro de la
// transacción, cualquier consulta falla con 25P02 hasta un ROLLBACK TO SAVEPOINT real. Una sesión
// falsa plana NO detecta la ausencia de SAVEPOINT.
class AbortAwareSession implements TenantDbSession {
  aborted = false;
  savepoint = false;
  async query<T>(): Promise<{ rows: T[] }> {
    if (this.aborted) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
    return { rows: [] as T[] };
  }
  async exec(sql: string): Promise<void> {
    const n = sql.trim().toLowerCase();
    if (n.startsWith("rollback to savepoint")) {
      if (!this.savepoint) throw new Error("ROLLBACK TO SAVEPOINT sin SAVEPOINT");
      this.aborted = false;
      return;
    }
    if (this.aborted) throw Object.assign(new Error("current transaction is aborted"), { code: "25P02" });
    if (n.startsWith("savepoint")) this.savepoint = true;
    if (n.startsWith("release savepoint")) this.savepoint = false;
  }
}

describe("base sin migrar (sin la migración 030)", () => {
  it("DELETE de temporada contra Postgres sin GRANT (42501) responde 503 honesto y la sesión queda utilizable", async () => {
    const ctx = await buildRentasTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const { id } = await crear(app, ctx, "temporadas", TEMPORADA);

    const sesion = new AbortAwareSession();
    const reales = ctx.deps.rentasRepo;
    const deps = {
      ...ctx.deps,
      rentasRepo: (db: TenantDbSession): RentasRepository => {
        const repo = reales(db);
        return new Proxy(repo, {
          get(target, prop, receiver) {
            if (prop === "deleteTemporada") {
              return async () => {
                sesion.aborted = true; // el DELETE sin GRANT aborta la transacción compartida
                throw Object.assign(new Error("permission denied for table tarifa_temporada"), { code: "42501" });
              };
            }
            if (prop === "registrarAuditoria") return async () => {};
            const v = Reflect.get(target, prop, receiver);
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
      },
    };
    // La ruta usa `c.get("db")` (sesión real del request) para el SAVEPOINT: se intercepta ahí.
    const appSinMigrar = buildApp({
      ...deps,
      engine: {
        ...ctx.deps.engine,
        withAppSession: (claims: { userId: string | null }, fn: (s: TenantDbSession) => Promise<unknown>) =>
          ctx.deps.engine.withAppSession(claims, async (real) => fn(Object.assign(Object.create(real), { exec: sesion.exec.bind(sesion), query: real.query.bind(real) }))),
      } as typeof ctx.deps.engine,
    });
    const res = await appSinMigrar.request(`${base(ctx)}/temporadas/${id}`, borrar(ctx.staff.adminGestora.token));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { message: string }).message).toContain("No disponible aún");
    expect(sesion.aborted).toBe(false); // ROLLBACK TO SAVEPOINT recuperó la transacción
    expect((await configuracion(app, ctx)).temporadas).toHaveLength(1);
  });
});

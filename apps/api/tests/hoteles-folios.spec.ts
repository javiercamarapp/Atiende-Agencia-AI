// Test de integración end-to-end (HTTP real vía app.request, sin mockear el motor de
// dominio) del flujo 1 elegido para Fase 1: folios/cargos con sus 3 capas
// anti-doble-captura + identidad (ver diseño Fase 1 hoteles §4.1). Ejercita
// comportamiento real: idempotencia real de punta a punta, la guarda REQ-AB-012, el
// guardia anti-alucinación de impuesto, y el filtrado de roles finos — no un
// happy-path decorativo.
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { buildHotelesTestContext, authedJson } from "./hoteles-fixtures.ts";

describe("POST /hoteles/:propertyId/folios/:folioId/cargos — idempotencia real (Idempotency-Key)", () => {
  it("exige el header Idempotency-Key", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cargos`,
      authedJson(ctx.staff.owner.token, { descripcion: "Consumo minibar", monto: 100, concepto: "extras" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "idempotency_required" });
  });

  it("mismo Idempotency-Key + mismo body -> devuelve el MISMO cargo, no crea uno duplicado", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const body = { descripcion: "Propina", monto: 100, concepto: "propina" };
    const key = "idem-key-1";
    const first = await app.request(`/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cargos`, authedJson(ctx.staff.owner.token, body, { "idempotency-key": key }));
    const second = await app.request(`/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cargos`, authedJson(ctx.staff.owner.token, body, { "idempotency-key": key }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstBody = (await first.json()) as { id: string };
    const secondBody = (await second.json()) as { id: string };
    expect(secondBody.id).toBe(firstBody.id);

    const folio = await app.request(`/hoteles/${ctx.propertyId}/folios/${ctx.folioId}`, authedJson(ctx.staff.owner.token));
    const folioBody = (await folio.json()) as { cargos: unknown[] };
    expect(folioBody.cargos).toHaveLength(1); // NUNCA un segundo cargo real por el reintento.
  });

  it("mismo Idempotency-Key + body DISTINTO -> 422 explícito, nunca aplica silenciosamente el segundo", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const key = "idem-key-2";
    const first = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cargos`,
      authedJson(ctx.staff.owner.token, { descripcion: "Propina", monto: 100, concepto: "propina" }, { "idempotency-key": key }),
    );
    expect(first.status).toBe(201);
    const second = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cargos`,
      authedJson(ctx.staff.owner.token, { descripcion: "Propina", monto: 999, concepto: "propina" }, { "idempotency-key": key }),
    );
    expect(second.status).toBe(422);
    expect((await second.json()) as { code: string }).toMatchObject({ code: "idempotency_conflict" });
  });
});

describe("POST .../cargos — REQ-AB-012: guardia anti-fraude de identidad para cargos a la habitación", () => {
  it("frontdesk SIN verificación de identidad y SIN autorización admin -> 403 (fail-closed)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cargos`,
      authedJson(ctx.staff.frontdesk.token, { descripcion: "Consumo cargado a la habitación", monto: 200, concepto: "extras" }, { "idempotency-key": "k-ab012-1" }),
    );
    expect(res.status).toBe(403);
  });

  it("frontdesk CON apellido+teléfono correctos del huésped titular -> se autoriza", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cargos`,
      authedJson(
        ctx.staff.frontdesk.token,
        { descripcion: "Consumo cargado a la habitación", monto: 200, concepto: "extras", verificacionIdentidad: { apellido: "García", telefonoUlt4: "1234" } },
        { "idempotency-key": "k-ab012-2" },
      ),
    );
    expect(res.status).toBe(201);
  });

  it("un apellido/teléfono declarado que NO coincide se rechaza aunque se invoque con autorización admin (discrepancia activa nunca overridable)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cargos`,
      authedJson(
        ctx.staff.frontdesk.token,
        {
          descripcion: "Consumo cargado a la habitación",
          monto: 200,
          concepto: "extras",
          verificacionIdentidad: { apellido: "Pérez", telefonoUlt4: "9999" },
          autorizacionIdentidadPorUserId: ctx.staff.owner.id,
        },
        { "idempotency-key": "k-ab012-3" },
      ),
    );
    expect(res.status).toBe(403);
  });

  it("sin reclamo de identidad, un owner (rol admin) SÍ puede autorizar el cargo por su propio rol", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cargos`,
      authedJson(ctx.staff.owner.token, { descripcion: "Ajuste manual", monto: 50, concepto: "otro" }, { "idempotency-key": "k-ab012-4" }),
    );
    expect(res.status).toBe(201);
  });

  it("un concepto de hospedaje nunca requiere verificación de identidad (fuera del set)", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cargos`,
      authedJson(ctx.staff.frontdesk.token, { descripcion: "Hospedaje", monto: 1000, concepto: "hospedaje" }, { "idempotency-key": "k-hosp-1" }),
    );
    expect(res.status).toBe(201);
  });
});

describe("POST .../cargos — el impuesto SIEMPRE se recalcula server-side (anti-alucinación de impuesto)", () => {
  it("un impuesto declarado por el cliente que coincide (tolerancia 1 centavo) se acepta", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    // hospedaje: IVA 16% + ISH 3% = 19% de 1000 = 190
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cargos`,
      authedJson(ctx.staff.owner.token, { descripcion: "Hospedaje", monto: 1000, concepto: "hospedaje", impuesto: 190 }, { "idempotency-key": "k-tax-1" }),
    );
    expect(res.status).toBe(201);
  });

  it("un impuesto declarado por el cliente que NO coincide se rechaza con 422, nunca se usa el valor del cliente", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cargos`,
      authedJson(ctx.staff.owner.token, { descripcion: "Hospedaje", monto: 1000, concepto: "hospedaje", impuesto: 0 }, { "idempotency-key": "k-tax-2" }),
    );
    expect(res.status).toBe(422);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "impuesto_no_coincide" });
  });
});

describe("Filtrado de roles finos en dinero (MONEY_ROLES excluye housekeeping/maintenance)", () => {
  it("housekeeping no puede crear cargos, ni siquiera con Idempotency-Key correcto", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cargos`,
      authedJson(ctx.staff.housekeeping.token, { descripcion: "Propina", monto: 10, concepto: "propina" }, { "idempotency-key": "k-hk-1" }),
    );
    expect(res.status).toBe(403);
  });

  it("housekeeping no puede ni siquiera LEER un folio", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/folios/${ctx.folioId}`, authedJson(ctx.staff.housekeeping.token));
    expect(res.status).toBe(403);
  });
});

describe("Reverso de cargo (REQ-REC-004: nunca UPDATE/DELETE del original)", () => {
  it("reversa un cargo real: inserta uno nuevo de signo contrario y marca el original", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const created = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cargos`,
      authedJson(ctx.staff.owner.token, { descripcion: "Ajuste", monto: 300, concepto: "ajuste" }, { "idempotency-key": "k-rev-1" }),
    );
    const { id: chargeId } = (await created.json()) as { id: string };

    const reverse = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cargos/${chargeId}/reverso`,
      authedJson(ctx.staff.owner.token, { motivo: "cargo por error" }, { "idempotency-key": "k-rev-2" }),
    );
    expect(reverse.status).toBe(201);

    const folio = await app.request(`/hoteles/${ctx.propertyId}/folios/${ctx.folioId}`, authedJson(ctx.staff.owner.token));
    const folioBody = (await folio.json()) as { cargos: Array<{ id: string; revertidoPor: string | null; concepto: string }>; saldo: number };
    expect(folioBody.cargos).toHaveLength(2); // original + reverso, nunca se borra
    expect(folioBody.cargos.find((c) => c.id === chargeId)?.revertidoPor).not.toBeNull();
    expect(folioBody.saldo).toBe(0);

    // No se puede reversar dos veces el mismo cargo.
    const secondReverse = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cargos/${chargeId}/reverso`,
      authedJson(ctx.staff.owner.token, { motivo: "otra vez" }, { "idempotency-key": "k-rev-3" }),
    );
    expect(secondReverse.status).toBe(409);
  });
});

describe("Cierre de folio (saldo_cero / cuenta_por_cobrar)", () => {
  it("se cierra como saldo_cero cuando el saldo real es cero", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    const res = await app.request(`/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cerrar`, authedJson(ctx.staff.owner.token, { motivo: "saldo_cero" }));
    expect(res.status).toBe(200);
    expect((await res.json()) as { estado: string }).toMatchObject({ estado: "cerrado" });
  });

  it("frontdesk NO puede cerrar con saldo pendiente como cuenta_por_cobrar sin autorización admin", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cargos`,
      authedJson(ctx.staff.frontdesk.token, { descripcion: "Hospedaje", monto: 1000, concepto: "hospedaje" }, { "idempotency-key": "k-cxc-1" }),
    );
    const res = await app.request(`/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cerrar`, authedJson(ctx.staff.frontdesk.token, { motivo: "cuenta_por_cobrar" }));
    expect(res.status).toBe(409);
  });

  it("frontdesk SÍ puede cerrar como cuenta_por_cobrar si trae la autorización de un admin verificado", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    const app = buildApp(ctx.deps);
    await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cargos`,
      authedJson(ctx.staff.frontdesk.token, { descripcion: "Hospedaje", monto: 1000, concepto: "hospedaje" }, { "idempotency-key": "k-cxc-2" }),
    );
    const res = await app.request(
      `/hoteles/${ctx.propertyId}/folios/${ctx.folioId}/cerrar`,
      authedJson(ctx.staff.frontdesk.token, { motivo: "cuenta_por_cobrar", autorizadoPorUserId: ctx.staff.owner.id }),
    );
    expect(res.status).toBe(200);
  });
});

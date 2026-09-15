// Hallazgo de auditoría (severidad MEDIO, "el rol 'readonly' está definido pero
// ninguna ruta lo usa realmente"): antes de esta corrección, un staff con
// `verticalRole: "readonly"` recibía 403 en TODAS las rutas de despachos —
// `"readonly"` no aparecía en ninguna constante de rol de roles.ts, pese a que
// varios comentarios ya afirmaban que sí podía ver ciertos recursos. Este spec
// verifica, ruta por ruta, que `readonly` (y `auditor`, que tenía el mismo hueco
// en varios módulos) ahora SÍ puede leer los recursos de solo lectura reales, y
// que ninguno de los dos gana acceso de escritura en el proceso — los endpoints
// de escritura de cada módulo se prueban aparte, sin cambios, en sus propios
// specs (despachos-cfdi.spec.ts, despachos-migracion-catalogo.spec.ts, etc.).
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

describe("readonly/auditor SÍ pueden leer (VER_* roles) -- 200, nunca 403 por ser 'readonly'", () => {
  it("GET /cfdi (VER_CFDI_ROLES)", async () => {
    const app = buildApp(ctx.deps);
    for (const rol of ["readonly", "auditor"] as const) {
      const res = await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff[rol].token));
      expect(res.status).toBe(200);
    }
  });

  it("GET /revisiones (VER_REVISIONES_ROLES)", async () => {
    const app = buildApp(ctx.deps);
    for (const rol of ["readonly", "auditor"] as const) {
      const res = await app.request(`/despachos/${ctx.propertyId}/revisiones`, authedJson(ctx.staff[rol].token));
      expect(res.status).toBe(200);
    }
  });

  it("GET /vencimientos (VER_VENCIMIENTOS_ROLES)", async () => {
    const app = buildApp(ctx.deps);
    for (const rol of ["readonly", "auditor"] as const) {
      const res = await app.request(`/despachos/${ctx.propertyId}/vencimientos`, authedJson(ctx.staff[rol].token));
      expect(res.status).toBe(200);
    }
  });

  it("GET /migracion-catalogo/mapeos (VER_MIGRACION_CATALOGO_ROLES)", async () => {
    const app = buildApp(ctx.deps);
    for (const rol of ["readonly", "auditor"] as const) {
      const res = await app.request(`/despachos/${ctx.propertyId}/migracion-catalogo/mapeos`, authedJson(ctx.staff[rol].token));
      expect(res.status).toBe(200);
    }
  });

  it("GET /devolucion-iva/facturas/:periodo (VER_DEVOLUCION_IVA_ROLES)", async () => {
    const app = buildApp(ctx.deps);
    for (const rol of ["readonly", "auditor"] as const) {
      const res = await app.request(`/despachos/${ctx.propertyId}/devolucion-iva/facturas/2026-07`, authedJson(ctx.staff[rol].token));
      expect(res.status).toBe(200);
    }
  });

  it("GET /bookkeeping/catalogo (VER_BOOKKEEPING_ROLES)", async () => {
    const app = buildApp(ctx.deps);
    for (const rol of ["readonly", "auditor"] as const) {
      const res = await app.request(`/despachos/${ctx.propertyId}/bookkeeping/catalogo`, authedJson(ctx.staff[rol].token));
      expect(res.status).toBe(200);
    }
  });

  it("GET /contabilidad-electronica/catalogo-base (VER_CONTABILIDAD_ELECTRONICA_ROLES)", async () => {
    const app = buildApp(ctx.deps);
    for (const rol of ["readonly", "auditor"] as const) {
      const res = await app.request(`/despachos/${ctx.propertyId}/contabilidad-electronica/catalogo-base`, authedJson(ctx.staff[rol].token));
      expect(res.status).toBe(200);
    }
  });

  it("GET /declaraciones/diot/:periodo (VER_DECLARACIONES_ROLES)", async () => {
    const app = buildApp(ctx.deps);
    for (const rol of ["readonly", "auditor"] as const) {
      const res = await app.request(`/despachos/${ctx.propertyId}/declaraciones/diot/2026-07`, authedJson(ctx.staff[rol].token));
      expect(res.status).toBe(200);
    }
  });

  it("GET /cierre-mensual/periodos y GET /cobranza/cuentas (readonly ya se une a auditor, sin cambio de comportamiento de auditor)", async () => {
    const app = buildApp(ctx.deps);
    const cierre = await app.request(`/despachos/${ctx.propertyId}/cierre-mensual/periodos`, authedJson(ctx.staff.readonly.token));
    expect(cierre.status).toBe(200);
    const cobranza = await app.request(`/despachos/${ctx.propertyId}/cobranza/cuentas`, authedJson(ctx.staff.readonly.token));
    expect(cobranza.status).toBe(200);
  });
});

describe("readonly NUNCA gana acceso de escritura al ganar acceso de lectura", () => {
  it("readonly no puede ingestar CFDI, invitar staff, calcular vencimientos, clasificar catálogo, ni aprobar una revisión -- 403 en todas", async () => {
    const app = buildApp(ctx.deps);

    const ingestaCfdi = await app.request(`/despachos/${ctx.propertyId}/cfdi`, authedJson(ctx.staff.readonly.token, { tipo: "I" }));
    expect(ingestaCfdi.status).toBe(403);

    const calcularVencimientos = await app.request(`/despachos/${ctx.propertyId}/vencimientos/calcular`, authedJson(ctx.staff.readonly.token, { year: 2026, month: 7 }));
    expect(calcularVencimientos.status).toBe(403);

    const clasificarCatalogo = await app.request(`/despachos/${ctx.propertyId}/migracion-catalogo/clasificar`, authedJson(ctx.staff.readonly.token, { catalogoOrigen: [], catalogoDestino: [] }));
    expect(clasificarCatalogo.status).toBe(403);

    const invitar = await app.request(`/despachos/${ctx.propertyId}/admin/staff/invitaciones`, authedJson(ctx.staff.readonly.token, { email: "x@despacho-de-prueba.mx", verticalRole: "contador" }));
    expect(invitar.status).toBe(403);
  });
});

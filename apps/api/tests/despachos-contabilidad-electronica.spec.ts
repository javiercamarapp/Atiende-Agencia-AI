// Contabilidad electrónica SAT (Anexo 24) -- hallazgo de auditoría: el motor
// completo de @atiende/domain-despachos/contabilidad-electronica/ ya existía
// con tests, pero ninguna ruta HTTP lo exponía. Verifica que la ruta invoca
// de verdad el motor real (no un objeto vacío) y que el role-gating
// (CONTABILIDAD_ELECTRONICA_ROLES = admin|contador) excluye auditor/readonly
// -- mismo criterio que despachos-conciliacion.spec.ts/
// despachos-devolucion-iva.spec.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { calcularHashSha1, CATALOGO_ANEXO24_BASE, generarBalanza, generarXmlBalanza, generarXmlCatalogo } from "@atiende/domain-despachos";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

describe("GET /despachos/:propertyId/contabilidad-electronica/catalogo-base", () => {
  it("devuelve el catálogo Anexo 24 base real del SAT", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/contabilidad-electronica/catalogo-base`, authedJson(ctx.staff.contador.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { catalogo: readonly unknown[] };
    expect(body.catalogo).toEqual(CATALOGO_ANEXO24_BASE);
  });

  // Hallazgo de auditoría (severidad MEDIO, "el rol 'readonly' está definido pero
  // ninguna ruta lo usa realmente"): este catálogo es referencia fija (sin datos
  // del cliente) -- readonly/auditor SÍ pueden verlo (VER_CONTABILIDAD_ELECTRONICA_ROLES),
  // aunque nunca generar el paquete (ver el resto de este describe block).
  it("readonly/auditor SÍ pueden ver el catálogo base -- 200 (lectura pura)", async () => {
    const app = buildApp(ctx.deps);
    const resReadonly = await app.request(`/despachos/${ctx.propertyId}/contabilidad-electronica/catalogo-base`, authedJson(ctx.staff.readonly.token));
    expect(resReadonly.status).toBe(200);
    const resAuditor = await app.request(`/despachos/${ctx.propertyId}/contabilidad-electronica/catalogo-base`, authedJson(ctx.staff.auditor.token));
    expect(resAuditor.status).toBe(200);
  });
});

describe("POST /despachos/:propertyId/contabilidad-electronica/catalogo", () => {
  it("genera el XML del catálogo usando el default SAT cuando no se manda catalogo -- invoca el motor real", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/despachos/${ctx.propertyId}/contabilidad-electronica/catalogo`,
      authedJson(ctx.staff.contador.token, { rfc: "CON950820K12", ejercicio: 2026, mes: 7, fechaModificacion: "2026-08-01T10:00:00" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { catalogo: readonly unknown[]; xml: string; sha1: string };
    expect(body.catalogo).toEqual(CATALOGO_ANEXO24_BASE);
    const xmlDirecto = generarXmlCatalogo(CATALOGO_ANEXO24_BASE, { rfc: "CON950820K12", ejercicio: 2026, mes: 7, fechaModificacion: "2026-08-01T10:00:00" });
    expect(body.xml).toBe(xmlDirecto);
    expect(body.sha1).toBe(calcularHashSha1(xmlDirecto));
  });

  it("catalogo con naturaleza inválida -> 400", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(
      `/despachos/${ctx.propertyId}/contabilidad-electronica/catalogo`,
      authedJson(ctx.staff.contador.token, { catalogo: [{ codigo: "1000", descripcion: "ACTIVO", nivel: 1, naturaleza: "X" }], ejercicio: 2026, mes: 1 }),
    );
    expect(res.status).toBe(400);
  });

  it("readonly/auditor no pueden -- 403", async () => {
    const app = buildApp(ctx.deps);
    const resReadonly = await app.request(`/despachos/${ctx.propertyId}/contabilidad-electronica/catalogo`, authedJson(ctx.staff.readonly.token, { ejercicio: 2026, mes: 1 }));
    expect(resReadonly.status).toBe(403);
    const resAuditor = await app.request(`/despachos/${ctx.propertyId}/contabilidad-electronica/catalogo`, authedJson(ctx.staff.auditor.token, { ejercicio: 2026, mes: 1 }));
    expect(resAuditor.status).toBe(403);
  });
});

describe("POST /despachos/:propertyId/contabilidad-electronica/balanza", () => {
  it("acumula asientos y genera la balanza + XML -- coincide con llamar al motor directo", async () => {
    const app = buildApp(ctx.deps);
    const asientos = [
      { cuenta: "1101", debe: 1000, haber: 0, fecha: "2026-07-05" },
      { cuenta: "4100", debe: 0, haber: 1000, fecha: "2026-07-05" },
    ];
    const res = await app.request(
      `/despachos/${ctx.propertyId}/contabilidad-electronica/balanza`,
      authedJson(ctx.staff.contador.token, { asientos, ejercicio: 2026, mes: 7, fechaModificacion: "2026-08-01T10:00:00" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resumen: { cuadrada: boolean; totalDebe: string; totalHaber: string }; xml: string; sha1: string };
    expect(body.resumen.cuadrada).toBe(true);
    expect(body.resumen.totalDebe).toBe("1000.00");
    expect(body.resumen.totalHaber).toBe("1000.00");

    const resumenDirecto = generarBalanza(CATALOGO_ANEXO24_BASE, asientos, "2026-07", null);
    const xmlDirecto = generarXmlBalanza(resumenDirecto.lineas, { ejercicio: 2026, mes: 7, fechaModificacion: "2026-08-01T10:00:00" });
    expect(body.xml).toBe(xmlDirecto);
    expect(body.sha1).toBe(calcularHashSha1(xmlDirecto));
  });

  it("asientos faltante -> balanza vacía pero cuadrada (0 == 0), no error", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/contabilidad-electronica/balanza`, authedJson(ctx.staff.contador.token, { ejercicio: 2026, mes: 1 }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resumen: { cuentas: number; cuadrada: boolean } };
    expect(body.resumen.cuentas).toBe(0);
    expect(body.resumen.cuadrada).toBe(true);
  });

  it("readonly/auditor no pueden -- 403", async () => {
    const app = buildApp(ctx.deps);
    const resReadonly = await app.request(`/despachos/${ctx.propertyId}/contabilidad-electronica/balanza`, authedJson(ctx.staff.readonly.token, { ejercicio: 2026, mes: 1 }));
    expect(resReadonly.status).toBe(403);
  });
});

describe("POST /despachos/:propertyId/contabilidad-electronica/paquete", () => {
  it("genera el paquete completo en estado listo_para_timbrar -- invoca el motor real", async () => {
    const app = buildApp(ctx.deps);
    const asientos = [
      { cuenta: "1101", debe: 500, haber: 0 },
      { cuenta: "4100", debe: 0, haber: 500 },
    ];
    const res = await app.request(
      `/despachos/${ctx.propertyId}/contabilidad-electronica/paquete`,
      authedJson(ctx.staff.contador.token, { rfc: "CON950820K12", razonSocial: "Despacho de Prueba SC", ejercicio: 2026, mes: 7, asientos }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      periodo: string;
      rfc: string;
      razonSocial: string;
      estado: string;
      catalogo: { xml: string; sha1: string; cuentas: number };
      balanza: { xml: string; sha1: string; cuadrada: boolean };
    };
    expect(body.periodo).toBe("2026-07");
    expect(body.rfc).toBe("CON950820K12");
    expect(body.razonSocial).toBe("Despacho de Prueba SC");
    expect(body.estado).toBe("listo_para_timbrar");
    expect(body.catalogo.cuentas).toBe(CATALOGO_ANEXO24_BASE.length);
    expect(body.balanza.cuadrada).toBe(true);
    expect(body.catalogo.sha1).toBe(calcularHashSha1(body.catalogo.xml));
    expect(body.balanza.sha1).toBe(calcularHashSha1(body.balanza.xml));
  });

  it("ejercicio/mes omitidos -> defaults del servidor (año de negocio, mes 1), sin 400", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/contabilidad-electronica/paquete`, authedJson(ctx.staff.admin.token, { asientos: [] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mes: number; ejercicio: number };
    expect(body.mes).toBe(1);
    expect(body.ejercicio).toBe(Number(hoyFechaNegocio().slice(0, 4)));
  });

  // Bug real (revisión r6 de PR #171, no bloqueante #6): el default de `ejercicio`
  // usaba `new Date().getFullYear()` (año UTC del proceso) -- el 31-dic de 18:00 a
  // 23:59 CDMX ya daba el año SIGUIENTE. `{ toFake: ["Date"] }` (no
  // `vi.useFakeTimers()` completo) para no congelar timers reales de la ruta.
  //
  // El reloj falso se instala ANTES de construir `ctx`/emitir el token (en vez de
  // reusar el `ctx` del `beforeEach`, minteado con el reloj REAL) -- si se saltara el
  // reloj a futuro DESPUÉS de emitir el token, el `exp` real (emitido con el reloj de
  // verdad) quedaría en el pasado respecto al reloj falso y la petición daría 401 por
  // token "expirado", no por el bug que este test busca reproducir.
  it("31-dic a las 22:00 CDMX (04:00 UTC del 1-ene) -> ejercicio default sigue siendo el año de negocio, no el año UTC siguiente", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // 2027-01-01T04:00:00Z = 2026-12-31T22:00:00 en America/Mexico_City.
      vi.setSystemTime(new Date("2027-01-01T04:00:00.000Z"));
      const finDeAnioCtx = await buildDespachosTestContext(buildApp);
      const app = buildApp(finDeAnioCtx.deps);
      const res = await app.request(
        `/despachos/${finDeAnioCtx.propertyId}/contabilidad-electronica/paquete`,
        authedJson(finDeAnioCtx.staff.admin.token, { asientos: [] }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ejercicio: number };
      // Control del bug: `new Date().getFullYear()` en un servidor con `TZ=UTC`
      // (Vercel real) en este instante ya sería 2027 -- se comprueba contra
      // `getUTCFullYear()` (nunca `getFullYear()`, que depende de la TZ local del
      // proceso que corre el test, no necesariamente UTC).
      expect(new Date().getUTCFullYear()).toBe(2027);
      expect(body.ejercicio).toBe(2026);
    } finally {
      vi.useRealTimers();
    }
  });

  it("mes fuera de rango -> 400", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/contabilidad-electronica/paquete`, authedJson(ctx.staff.admin.token, { asientos: [], mes: 13 }));
    expect(res.status).toBe(400);
  });

  it("readonly/auditor no pueden -- 403", async () => {
    const app = buildApp(ctx.deps);
    const resReadonly = await app.request(`/despachos/${ctx.propertyId}/contabilidad-electronica/paquete`, authedJson(ctx.staff.readonly.token, { asientos: [] }));
    expect(resReadonly.status).toBe(403);
    const resAuditor = await app.request(`/despachos/${ctx.propertyId}/contabilidad-electronica/paquete`, authedJson(ctx.staff.auditor.token, { asientos: [] }));
    expect(resAuditor.status).toBe(403);
  });
});

describe("POST /despachos/:propertyId/contabilidad-electronica/listo-para-timbrar", () => {
  it("transiciona borrador -> listo_para_timbrar", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/contabilidad-electronica/listo-para-timbrar`, authedJson(ctx.staff.contador.token, { estadoActual: "borrador" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: string };
    expect(body.estado).toBe("listo_para_timbrar");
  });

  it("es idempotente desde listo_para_timbrar", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/contabilidad-electronica/listo-para-timbrar`, authedJson(ctx.staff.contador.token, { estadoActual: "listo_para_timbrar" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { estado: string };
    expect(body.estado).toBe("listo_para_timbrar");
  });

  it("desde timbrado -> 409 (transición inválida, el motor de dominio la rechaza)", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/contabilidad-electronica/listo-para-timbrar`, authedJson(ctx.staff.contador.token, { estadoActual: "timbrado" }));
    expect(res.status).toBe(409);
  });

  it("estadoActual inválido -> 400", async () => {
    const app = buildApp(ctx.deps);
    const res = await app.request(`/despachos/${ctx.propertyId}/contabilidad-electronica/listo-para-timbrar`, authedJson(ctx.staff.contador.token, { estadoActual: "no-existe" }));
    expect(res.status).toBe(400);
  });

  it("readonly/auditor no pueden -- 403", async () => {
    const app = buildApp(ctx.deps);
    const resReadonly = await app.request(`/despachos/${ctx.propertyId}/contabilidad-electronica/listo-para-timbrar`, authedJson(ctx.staff.readonly.token, { estadoActual: "borrador" }));
    expect(resReadonly.status).toBe(403);
  });
});

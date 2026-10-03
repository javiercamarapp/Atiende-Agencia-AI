// SA-L-38: taxonomia por vertical del Cerebro de ventas -- precio leido de core.plan (nunca inventado), validacion de promesas de
// cifras, versionado por edicion, base sin migrar (200/503 honestos con sesion sana, AbortAwareFakeSession) y step-up MFA:
// editar la taxonomia sin step-up NO guarda.
import { describe, expect, it, vi } from "vitest";
import { totpAt } from "@atiende/core-auth";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { AbortAwareFakeSession } from "../../../packages/db/tests/support/aborting-fake-session.ts";
import { buildApp } from "../src/app.ts";
import { formatearMxn, precioDePlan, validarCoherenciaIcp, validarContenidoTaxonomia } from "../src/cerebro/index.ts";
import type { TaxonomiaVersion } from "../src/cerebro/index.ts";
import { isSensitiveRoute } from "../src/superadmin-seguridad/step-up.ts";
import { CALLER, enviar, filaTaxonomia, montarCerebro, pgError } from "./cerebro-fixtures.ts";
import { bearer, seguridadSetup } from "./superadmin-seguridad-fixtures.ts";

describe("precio de la taxonomia: sale de core.plan, nunca inventado", () => {
  it("formatea centavos como pesos sin Intl", () => {
    expect(formatearMxn(8900)).toBe("$89");
    expect(formatearMxn(79900)).toBe("$799");
    expect(formatearMxn(123456789)).toBe("$1,234,567.89");
  });

  it("con precio definido muestra el precio del plan; sin plan o con precio null dice 'Precio por definir'", () => {
    expect(precioDePlan("hoteles-estandar", 0, 8900, 5)).toMatchObject({ estado: "definido", texto: "$89 MXN al mes por asiento (5 incluidos)", asientoMxnCentavos: 8900 });
    expect(precioDePlan("rentas-estandar", null, null, 0)).toEqual({ estado: "por_definir", texto: "Precio por definir", baseMxnCentavos: null, asientoMxnCentavos: null, asientosIncluidos: 0 });
    expect(precioDePlan(null, 0, 8900, 5).estado).toBe("por_definir");
    expect(precioDePlan("x", 50000, null, null).texto).toBe("$500 MXN base al mes");
  });
});

describe("validarContenidoTaxonomia", () => {
  const mensaje = (texto: string) => ({ mensajes_base: [{ canal: "whatsapp", variante: "A", texto }] });

  it("acepta un mensaje base sin promesas de cifras (15 minutos no es una promesa de resultado)", () => {
    expect(validarContenidoTaxonomia("restaurantes", mensaje("Hola {nombre}, ¿te muestro en 15 minutos cómo quedaría? Responde BAJA si no te interesa.")).ok).toBe(true);
  });

  it.each(["Aumenta tus ventas 30% con atiende.ai", "Ahorra $5,000 al mes", "Te cuesta 500 pesos", "Garantizamos resultados"])("rechaza la promesa de cifras: %s", (texto) => {
    const r = validarContenidoTaxonomia("restaurantes", mensaje(texto));
    expect(r.ok).toBe(false);
  });

  it("en licitaciones rechaza prometer adjudicaciones o influencia", () => {
    expect(validarContenidoTaxonomia("licitaciones", mensaje("Te ayudamos a ganar la adjudicación")).ok).toBe(false);
    expect(validarContenidoTaxonomia("licitaciones", mensaje("Tenemos influencia en la dependencia")).ok).toBe(false);
    expect(validarContenidoTaxonomia("licitaciones", mensaje("Te avisamos de convocatorias de tu giro.")).ok).toBe(true);
  });

  it("valida senales: dimension, puntos enteros 1 a 100, tipo unico y como conseguirla", () => {
    const base = { tipo: "menu_en_linea", nombre: "Menú", dimension: "ajuste", puntos: 10, como_conseguirla: "Revisa su sitio." };
    expect(validarContenidoTaxonomia("citas", { senales: [base] }).ok).toBe(true);
    expect(validarContenidoTaxonomia("citas", { senales: [{ ...base, dimension: "cierre2" }] }).ok).toBe(false);
    expect(validarContenidoTaxonomia("citas", { senales: [{ ...base, puntos: 0 }] }).ok).toBe(false);
    expect(validarContenidoTaxonomia("citas", { senales: [{ ...base, puntos: 10.5 }] }).ok).toBe(false);
    expect(validarContenidoTaxonomia("citas", { senales: [{ ...base, como_conseguirla: "" }] }).ok).toBe(false);
    expect(validarContenidoTaxonomia("citas", { senales: [base, base] }).ok).toBe(false);
  });

  it("rechaza claves repetidas de subtipo y rango, y un contenido que no es objeto", () => {
    expect(validarContenidoTaxonomia("citas", { subtipos: [{ clave: "a_b", nombre: "A" }, { clave: "a_b", nombre: "B" }] }).ok).toBe(false);
    expect(validarContenidoTaxonomia("citas", { rangos_tamano: { unidad: "doctores", rangos: [{ clave: "c1", etiqueta: "1" }, { clave: "c1", etiqueta: "2" }] } }).ok).toBe(false);
    expect(validarContenidoTaxonomia("citas", "hola").ok).toBe(false);
  });

  it("el ICP debe apuntar a subtipos y rangos que existan", () => {
    const vigente = { subtipos: [{ clave: "taqueria", nombre: "T" }], rangosTamano: { unidad: "s", rangos: [{ clave: "s1", etiqueta: "1" }] }, icp: { descripcion: "x", subtipos_objetivo: [], tamanos_objetivo: [] } } as unknown as TaxonomiaVersion;
    expect(validarCoherenciaIcp({ icp: { descripcion: "x", subtipos_objetivo: ["taqueria"], tamanos_objetivo: ["s1"] } }, vigente)).toBeNull();
    expect(validarCoherenciaIcp({ icp: { descripcion: "x", subtipos_objetivo: ["fonda"], tamanos_objetivo: ["s1"] } }, vigente)).toContain("fonda");
    expect(validarCoherenciaIcp({ icp: { descripcion: "x", subtipos_objetivo: ["taqueria"], tamanos_objetivo: ["s9"] } }, vigente)).toContain("s9");
  });
});

describe("GET /superadmin/cerebro/taxonomia", () => {
  it("devuelve las versiones con el precio leido del plan", async () => {
    const { app } = montarCerebro([{ match: /list_cerebro_taxonomia_for_superadmin/, respond: () => [filaTaxonomia(), filaTaxonomia({ vertical: "rentas", plan_id: "rentas-estandar", plan_nombre: "Rentas vacacionales - por configurar", plan_precio_base_mxn_centavos: null, plan_precio_asiento_mxn_centavos: null, plan_asientos_incluidos: 0 })] }]);
    const res = await enviar(app, "GET", "/superadmin/cerebro/taxonomia");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { disponible: boolean; versiones: Array<{ vertical: string; precio: { estado: string; texto: string } }>; verticales: string[] };
    expect(body.disponible).toBe(true);
    expect(body.verticales).toHaveLength(6);
    expect(body.versiones.find((v) => v.vertical === "restaurantes")?.precio).toMatchObject({ estado: "definido", texto: "$799 MXN al mes por asiento (1 incluidos)" });
    expect(body.versiones.find((v) => v.vertical === "rentas")?.precio).toMatchObject({ estado: "por_definir", texto: "Precio por definir" });
  });

  it("base sin migrar (42P01): 200 con disponible=false y la sesion sigue sana", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app, session } = montarCerebro([{ match: /list_cerebro_taxonomia_for_superadmin/, respond: () => pgError("42P01") }, { match: /select 1/, respond: () => [] }]);
    const res = await enviar(app, "GET", "/superadmin/cerebro/taxonomia");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disponible: false, versiones: [] });
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("otro error de lectura no se disfraza de vacio: 500", async () => {
    const { app } = montarCerebro([{ match: /list_cerebro_taxonomia_for_superadmin/, respond: () => pgError("42501") }]);
    expect((await enviar(app, "GET", "/superadmin/cerebro/taxonomia")).status).toBe(500);
  });
});

describe("PUT /superadmin/cerebro/taxonomia/:vertical", () => {
  function conGuardado() {
    let guardado = false;
    return montarCerebro([
      { match: /save_cerebro_taxonomia_for_superadmin/, respond: () => { guardado = true; return [{ version: 2 }]; } },
      { match: /list_cerebro_taxonomia_for_superadmin/, respond: () => (guardado ? [filaTaxonomia({ version: 2, nota_cambio: "ajuste" }), filaTaxonomia({ version: 1, vigente: false })] : [filaTaxonomia()]) },
    ]);
  }

  it("editar crea una version nueva: manda solo el contenido enviado, el plan y la nota, y devuelve la version guardada", async () => {
    const { app, session } = conGuardado();
    const spy = vi.spyOn(session, "query");
    const res = await enviar(app, "PUT", "/superadmin/cerebro/taxonomia/restaurantes", { contenido: { icp: { descripcion: "Nuevo ICP", subtipos_objetivo: ["taqueria"], tamanos_objetivo: ["s1"] } }, planId: "restaurantes-estandar", nota: "ajuste", validada: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { taxonomia: { version: number; vigente: boolean } }).taxonomia).toMatchObject({ version: 2, vigente: true });
    const llamada = spy.mock.calls.find(([sql]) => /save_cerebro_taxonomia_for_superadmin/.test(sql))!;
    expect(llamada[1]).toEqual([CALLER, "restaurantes", JSON.stringify({ icp: { descripcion: "Nuevo ICP", subtipos_objetivo: ["taqueria"], tamanos_objetivo: ["s1"] } }), "restaurantes-estandar", "ajuste", true]);
  });

  it("un mensaje con cifras prometidas se rechaza con 400 sin llegar a la base", async () => {
    const { app, session } = conGuardado();
    const spy = vi.spyOn(session, "query");
    const res = await enviar(app, "PUT", "/superadmin/cerebro/taxonomia/restaurantes", { contenido: { mensajes_base: [{ canal: "whatsapp", variante: "A", texto: "Vende 30% más" }] } });
    expect(res.status).toBe(400);
    expect(spy.mock.calls.some(([sql]) => /save_cerebro_taxonomia/.test(sql))).toBe(false);
  });

  it("un ICP que apunta a un subtipo inexistente se rechaza con 400", async () => {
    const { app } = conGuardado();
    const res = await enviar(app, "PUT", "/superadmin/cerebro/taxonomia/restaurantes", { contenido: { icp: { descripcion: "x", subtipos_objetivo: ["fantasma"], tamanos_objetivo: ["s1"] } } });
    expect(res.status).toBe(400);
  });

  it("vertical invalida y cuerpo invalido: 400", async () => {
    const { app } = conGuardado();
    expect((await enviar(app, "PUT", "/superadmin/cerebro/taxonomia/gasolineras", { contenido: {} })).status).toBe(400);
    expect((await enviar(app, "PUT", "/superadmin/cerebro/taxonomia/restaurantes", { contenido: {}, validada: "si" })).status).toBe(400);
  });

  it("un plan de otra vertical (22023 de la funcion SQL) responde 400 y la sesion sigue sana", async () => {
    const { app, session } = montarCerebro([
      { match: /save_cerebro_taxonomia_for_superadmin/, respond: () => pgError("22023", "save_cerebro_taxonomia_for_superadmin: el plan hoteles-estandar es de la vertical hoteles, no de restaurantes") },
      { match: /list_cerebro_taxonomia_for_superadmin/, respond: () => [filaTaxonomia()] },
      { match: /select 1/, respond: () => [] },
    ]);
    const res = await enviar(app, "PUT", "/superadmin/cerebro/taxonomia/restaurantes", { contenido: {}, planId: "hoteles-estandar" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("hoteles-estandar");
    await expect(session.query("select 1;")).resolves.toEqual({ rows: [] });
  });

  it("base sin migrar: 503 honesto, nunca un 500", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { app } = montarCerebro([{ match: /list_cerebro_taxonomia_for_superadmin/, respond: () => pgError("42883") }]);
    expect((await enviar(app, "PUT", "/superadmin/cerebro/taxonomia/restaurantes", { contenido: {} })).status).toBe(503);
  });

  it("la guardia SQL de promesas (23514) se traduce a 422", async () => {
    const { app } = montarCerebro([
      { match: /save_cerebro_taxonomia_for_superadmin/, respond: () => pgError("23514", "mensajes_promesa_cifras: un mensaje base no puede prometer cifras") },
      { match: /list_cerebro_taxonomia_for_superadmin/, respond: () => [filaTaxonomia()] },
    ]);
    expect((await enviar(app, "PUT", "/superadmin/cerebro/taxonomia/restaurantes", { contenido: {} })).status).toBe(422);
  });
});

describe("step-up: editar la taxonomia sin step-up NO guarda", () => {
  it("la ruta esta declarada como sensible; la lectura no", () => {
    expect(isSensitiveRoute("PUT", "/superadmin/cerebro/taxonomia/restaurantes")).toBe(true);
    expect(isSensitiveRoute("GET", "/superadmin/cerebro/taxonomia")).toBe(false);
    expect(isSensitiveRoute("PUT", "/superadmin/cerebro/prospectos/abc")).toBe(false);
  });

  it("con factor MFA activo: sin x-stepup-token responde 403 stepup_required y no escribe; con el token guarda", async () => {
    const s = await seguridadSetup();
    let guardado = false;
    const falsa = new AbortAwareFakeSession([
      { match: /save_cerebro_taxonomia_for_superadmin/, respond: () => { guardado = true; return [{ version: 2 }]; } },
      { match: /list_cerebro_taxonomia_for_superadmin/, respond: () => (guardado ? [filaTaxonomia({ version: 2 })] : [filaTaxonomia()]) },
    ]);
    const spy = vi.spyOn(falsa, "query");
    const base = s.deps.engine;
    const engine = {
      withAppSession: <T,>(claims: { userId: string | null }, fn: (db: TenantDbSession) => Promise<T>) =>
        base.withAppSession(claims, (b) =>
          fn({
            query: (sql: string, params?: unknown[]) => (/core\.(list|save)_cerebro_taxonomia/.test(sql) ? falsa.query(sql, params) : b.query(sql, params)),
            exec: (sql: string) => falsa.exec(sql),
          } as TenantDbSession),
        ),
    } as typeof base;
    const app = buildApp({ ...s.deps, engine });
    const sa = await s.superadmin();

    const enr = await enviarApp(app, "POST", "/superadmin/mfa/enrolar", {}, bearer(sa.token));
    const { secreto } = (await enr.json()) as { secreto: string };
    const ver = await enviarApp(app, "POST", "/superadmin/mfa/verificar", { codigo: totpAt(secreto, Date.now()) }, bearer(sa.token));
    const { stepUpToken } = (await ver.json()) as { stepUpToken: string };

    const cuerpo = { contenido: { icp: { descripcion: "Nuevo ICP", subtipos_objetivo: ["taqueria"], tamanos_objetivo: ["s1"] } }, nota: "ajuste" };
    const sin = await enviarApp(app, "PUT", "/superadmin/cerebro/taxonomia/restaurantes", cuerpo, bearer(sa.token));
    expect(sin.status).toBe(403);
    expect(await sin.json()).toMatchObject({ code: "stepup_required" });
    expect(guardado).toBe(false);
    expect(spy.mock.calls.some(([sql]) => /save_cerebro_taxonomia/.test(sql))).toBe(false);

    const con = await enviarApp(app, "PUT", "/superadmin/cerebro/taxonomia/restaurantes", cuerpo, bearer(sa.token, { "x-stepup-token": stepUpToken }));
    expect(con.status).toBe(200);
    expect(guardado).toBe(true);

    // La lectura no exige step-up.
    expect((await app.request("/superadmin/cerebro/taxonomia", { headers: bearer(sa.token) })).status).toBe(200);
  });

  it("un staff normal recibe 403 y sin token 401", async () => {
    const s = await seguridadSetup();
    const st = await s.staff();
    expect((await s.app.request("/superadmin/cerebro/taxonomia", { headers: bearer(st.token) })).status).toBe(403);
    expect((await s.app.request("/superadmin/cerebro/taxonomia")).status).toBe(401);
    expect((await enviarApp(s.app, "PUT", "/superadmin/cerebro/taxonomia/restaurantes", { contenido: {} }, bearer(st.token))).status).toBe(403);
  });
});

function enviarApp(app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> }, method: string, path: string, body: unknown, headers: Record<string, string>) {
  return app.request(path, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

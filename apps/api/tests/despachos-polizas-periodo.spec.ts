// D-P3-14 -- polizas del periodo: el cron diario `/internal/despachos/polizas-periodo` y el boton `POST .../libro/polizas/generar-periodo`. Mismas reglas en ambos:
// CFDI clasificado con confianza suficiente (o por una persona), sin revision pendiente, no cancelado ni excluido, sentido conocido, periodo abierto, sin poliza vigente
// y armable sin inventar. Cubre secreto, kill switch, idempotencia, aviso in-app sin PII, roles, periodo cerrado, base sin migrar y fallo aislado.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { createPlatformSwitchGuard } from "../src/platform-switches.ts";
import { DEFAULT_MONTHLY_CLOSE_TEMPLATE } from "@atiende/domain-despachos";
import type { NewInvoiceInput } from "@atiende/domain-despachos";
import { buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

let ctx: DespachosTestContext;
beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

const CRON = "/internal/despachos/polizas-periodo";
const SECRETO = () => ({ method: "POST", headers: { "x-atiende-internal-secret": ctx.deps.env.internalSecret } });
const HOY = hoyFechaNegocio();
const MES_ACTUAL = HOY.slice(0, 7);
const FECHA = `${MES_ACTUAL}-01`;

async function cfdi(parcial: Partial<NewInvoiceInput> = {}, clasif: { categoria: string; confianza: number; metodo?: "reglas" | "claveprodserv" | "correccion"; cuenta?: string | null } | null = { categoria: "servicios_profesionales", confianza: 0.8 }) {
  const i = await ctx.despachosRepo.insertInvoice({
    organizationId: ctx.organizationId, propertyId: ctx.propertyId, folioFiscal: randomUUID(), tipo: "I", rfcEmisor: "PPP010101PP1", rfcReceptor: "CLI010101CL1", emisorNombre: null, subtotal: 1000, total: 1160, iva: 160, descuento: 0,
    categoria: "sin_clasificar", valido: true, issues: [], warnings: [], requiresHumanReview: false, diot: { proveedoresReportables: [], reportable: false } as NewInvoiceInput["diot"], fecha: FECHA, direccion: "recibido", metodoPago: "PUE", moneda: "MXN",
    subtotalCentavos: 100000, descuentoCentavos: 0, totalCentavos: 116000, ivaTrasladadoCentavos: 16000, ...parcial,
  });
  if (clasif) await ctx.clasificacionRepo.registrar(ctx.propertyId, i.id, { categoria: clasif.categoria, confianza: clasif.confianza, metodo: clasif.metodo ?? "reglas", razon: null, cuenta: clasif.cuenta ?? null, empate: false });
  return i;
}

describe(`cron ${CRON}`, () => {
  it("401 sin secreto (GET y POST) y con secreto incorrecto; con el kill switch responde skipped y no toca nada", async () => {
    const app = buildApp(ctx.deps);
    expect((await app.request(CRON, { method: "POST" })).status).toBe(401);
    expect((await app.request(CRON, { method: "GET" })).status).toBe(401);
    expect((await app.request(CRON, { method: "POST", headers: { "x-atiende-internal-secret": "incorrecto" } })).status).toBe(401);
    const i = await cfdi();
    const guard = createPlatformSwitchGuard(async () => [{ scope: "cron", target: CRON }]);
    const res = await buildApp({ ...ctx.deps, platformSwitchGuard: guard }).request(CRON, SECRETO());
    expect(await res.json()).toMatchObject({ ok: true, skipped: "kill_switch" });
    expect((await ctx.libroRepo.polizasDeCfdi(ctx.propertyId, [i.id])).size).toBe(0);
  });

  it("registra la poliza de lo clasificado y limpio, avisa una vez por cliente (solo la cantidad, sin PII) y es idempotente", async () => {
    const a = await cfdi();
    const b = await cfdi();
    const { deps, emisiones } = conEmisiones(ctx.deps);
    const app = buildApp(deps);
    const body = (await (await app.request(CRON, SECRETO())).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, status: "ok", candidatos: 2, generadas: 2, omitidas: 0, no_armables: 0, clientes_avisados: 1, cortado_por_tiempo: false, failures: [] });
    const polizas = await ctx.libroRepo.polizasDeCfdi(ctx.propertyId, [a.id, b.id]);
    expect(polizas.size).toBe(2);
    const e = emisiones.filter((x) => x.evento === "despachos.libro.polizas_generadas");
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, categoria: "automatizaciones", severidad: "info", cuerpo: "Polizas generadas: 2.", enlace: "/despachos/{orgSlug}/libro-contable", dedupeKey: `despachos.libro.polizas_generadas:${ctx.propertyId}:${HOY}`, roles: ["contador"] });
    expect(JSON.stringify(e[0])).not.toMatch(/PPP010101PP1|CLI010101CL1/);

    const segunda = (await (await app.request(CRON, SECRETO())).json()) as Record<string, unknown>;
    expect(segunda).toMatchObject({ candidatos: 0, generadas: 0, clientes_avisados: 0 });
    expect(emisiones.filter((x) => x.evento === "despachos.libro.polizas_generadas")).toHaveLength(1);
  });

  it("la poliza usa la categoria vigente: equipo de computo -> cuenta 1600000; la cuenta de la correccion reemplaza la del mapeo", async () => {
    const equipo = await cfdi({}, { categoria: "equipo_computo", confianza: 0.9 });
    const conCuenta = await cfdi({}, { categoria: "mantenimiento", confianza: 1, metodo: "correccion", cuenta: "6020999" });
    await ctx.libroRepo.sembrarCatalogo(ctx.propertyId, [
      { codigo: "1600000", descripcion: "Equipo de computo", naturaleza: "D" },
      { codigo: "6020999", descripcion: "Mantenimiento especial", naturaleza: "D" },
      { codigo: "2600300", descripcion: "IVA acreditable", naturaleza: "D" },
      { codigo: "2010000", descripcion: "Proveedores", naturaleza: "A" },
    ]);
    await buildApp(ctx.deps).request(CRON, SECRETO());
    const polizas = await ctx.libroRepo.polizasDeCfdi(ctx.propertyId, [equipo.id, conCuenta.id]);
    const cuentas = async (invoiceId: string) => (await ctx.libroRepo.obtenerPoliza(ctx.propertyId, polizas.get(invoiceId)!.id))!.movimientos.map((m) => m.cuenta);
    expect(await cuentas(equipo.id)).toEqual(["1600000", "2600300", "2010000"]);
    expect(await cuentas(conCuenta.id)).toEqual(["6020999", "2600300", "2010000"]);
  });

  it("NO contabiliza lo dudoso: clasificacion 0.65 (umbral 0.7), revision pendiente, cancelado, excluido por rechazo y sin clasificar", async () => {
    await cfdi({}, { categoria: "servicios_profesionales", confianza: 0.65 });
    const pendiente = await cfdi();
    await ctx.despachosRepo.createReview({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, invoiceId: pendiente.id, reason: "x" });
    const cancelado = await cfdi();
    await ctx.despachosRepo.registrarEstadoSatInvoice(ctx.propertyId, cancelado.id, "cancelado");
    const rechazado = await cfdi();
    const rev = await ctx.despachosRepo.createReview({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, invoiceId: rechazado.id, reason: "x" });
    await ctx.despachosRepo.resolveReview(ctx.propertyId, rev.id, ctx.staff.contador.id, "rechazado", null);
    await cfdi({}, null);
    const body = (await (await buildApp(ctx.deps).request(CRON, SECRETO())).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ candidatos: 0, generadas: 0 });
  });

  it("base sin migrar: 200 con status no_disponible, sin tocar nada ni avisar", async () => {
    const i = await cfdi();
    ctx.polizasPeriodoRepo.disponible = false;
    const { deps, emisiones } = conEmisiones(ctx.deps);
    const body = (await (await buildApp(deps).request(CRON, SECRETO())).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, status: "no_disponible", generadas: 0 });
    expect(emisiones).toHaveLength(0);
    expect((await ctx.libroRepo.polizasDeCfdi(ctx.propertyId, [i.id])).size).toBe(0);
  });

  it("un CFDI que falla no impide los demas: ok:false con el detalle en failures (sin PII) y el latido en error", async () => {
    const mala = await cfdi();
    const buena = await cfdi();
    ctx.polizasPeriodoRepo.fallarEn.add(mala.id);
    const res = await buildApp(ctx.deps).request(CRON, SECRETO());
    const body = (await res.json()) as { ok: boolean; generadas: number; failures: { invoice_id: string; error: string }[] };
    expect(body).toMatchObject({ ok: false, generadas: 1 });
    expect(body.failures.map((f) => f.invoice_id)).toEqual([mala.id]);
    expect(JSON.stringify(body.failures)).not.toMatch(/PPP010101PP1|CLI010101CL1/);
    expect((await ctx.libroRepo.polizasDeCfdi(ctx.propertyId, [buena.id])).size).toBe(1);
    expect((await ctx.libroRepo.polizasDeCfdi(ctx.propertyId, [mala.id])).size).toBe(0);
  });
});

describe("POST /despachos/:propertyId/libro/polizas/generar-periodo (boton)", () => {
  const url = () => `/despachos/${ctx.propertyId}/libro/polizas/generar-periodo`;
  const post = (token: string, cuerpo: unknown, deps = ctx.deps) => {
    const raw = JSON.stringify(cuerpo);
    return buildApp(deps).request(url(), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(new TextEncoder().encode(raw).byteLength) }, body: raw });
  };

  it("registra las polizas del periodo (siembra el catalogo), devuelve el desglose, deja bitacora y avisa con la MISMA clave que el cron", async () => {
    const a = await cfdi();
    const dudoso = await cfdi({}, { categoria: "servicios_profesionales", confianza: 0.6 });
    const sinArmar = await cfdi({ moneda: "USD" });
    const { deps, emisiones } = conEmisiones(ctx.deps);
    const res = await post(ctx.staff.contador.token, { periodo: MES_ACTUAL }, deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { generadas: number; yaTenian: number; porClasificacion: number; noArmables: { folioFiscal: string; motivo: string }[]; candidatos: number };
    expect(body).toMatchObject({ periodo: MES_ACTUAL, candidatos: 3, generadas: 1, yaTenian: 0, porClasificacion: 1 });
    expect(body.noArmables).toHaveLength(1);
    expect(body.noArmables[0]!.motivo).toMatch(/moneda extranjera/);
    expect((await ctx.libroRepo.polizasDeCfdi(ctx.propertyId, [a.id])).size).toBe(1);
    expect((await ctx.libroRepo.polizasDeCfdi(ctx.propertyId, [dudoso.id, sinArmar.id])).size).toBe(0);
    expect(ctx.auditSink.entries.filter((e) => e.action === "despachos.libro:polizas-periodo")).toMatchObject([{ metadata: { generadas: 1, periodo: MES_ACTUAL } }]);
    expect(emisiones.filter((x) => x.evento === "despachos.libro.polizas_generadas")[0]).toMatchObject({ dedupeKey: `despachos.libro.polizas_generadas:${ctx.propertyId}:${HOY}`, cuerpo: "Polizas generadas: 1." });
  });

  it("idempotente: el segundo clic no duplica (yaTenian) y no avisa de nuevo", async () => {
    await cfdi();
    await post(ctx.staff.contador.token, { periodo: MES_ACTUAL });
    const { deps, emisiones } = conEmisiones(ctx.deps);
    const segundo = (await (await post(ctx.staff.contador.token, { periodo: MES_ACTUAL }, deps)).json()) as { generadas: number; yaTenian: number };
    expect(segundo).toMatchObject({ generadas: 0, yaTenian: 1 });
    expect(emisiones).toHaveLength(0);
  });

  it("un CFDI con revision pendiente se cuenta aparte (porRevision) y NO se contabiliza", async () => {
    const i = await cfdi();
    await ctx.despachosRepo.createReview({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, invoiceId: i.id, reason: "x" });
    const body = (await (await post(ctx.staff.contador.token, { periodo: MES_ACTUAL })).json()) as { generadas: number; porRevision: number };
    expect(body).toMatchObject({ generadas: 0, porRevision: 1 });
  });

  it("periodo cerrado -> 409; periodo mal formado o ausente -> 400; auditor y readonly -> 403", async () => {
    const [anio, mes] = MES_ACTUAL.split("-").map(Number) as [number, number];
    const { periodo } = await ctx.despachosRepo.insertPeriodoCierre({ organizationId: ctx.organizationId, propertyId: ctx.propertyId, anio, mes, template: DEFAULT_MONTHLY_CLOSE_TEMPLATE });
    await ctx.despachosRepo.updatePeriodoCierre({ ...periodo, status: "closed" });
    expect((await post(ctx.staff.contador.token, { periodo: MES_ACTUAL })).status).toBe(409);
    expect((await post(ctx.staff.contador.token, { periodo: "2026-13" })).status).toBe(400);
    expect((await post(ctx.staff.contador.token, {})).status).toBe(400);
    expect((await post(ctx.staff.auditor.token, { periodo: MES_ACTUAL })).status).toBe(403);
    expect((await post(ctx.staff.readonly.token, { periodo: MES_ACTUAL })).status).toBe(403);
  });

  it("el libro sin migrar (020 pendiente): 503 honesto, nunca un 500", async () => {
    await cfdi();
    ctx.libroRepo.disponible = false;
    const res = await post(ctx.staff.contador.token, { periodo: MES_ACTUAL });
    expect(res.status).toBe(503);
  });

  it("sin clasificacion en la base (026 pendiente) se arma como siempre con la categoria gruesa del CFDI", async () => {
    ctx.clasificacionRepo.disponible = false;
    const i = await cfdi({ categoria: "honorarios" }, null);
    const body = (await (await post(ctx.staff.contador.token, { periodo: MES_ACTUAL })).json()) as { generadas: number };
    expect(body.generadas).toBe(1);
    expect((await ctx.libroRepo.polizasDeCfdi(ctx.propertyId, [i.id])).size).toBe(1);
  });

  it("GET /libro/cfdi y desde-cfdi usan la clasificacion vigente: un CFDI sin categoria gruesa pero clasificado se puede armar", async () => {
    const i = await cfdi({ categoria: "sin_clasificar" }, { categoria: "telefonia", confianza: 0.9 });
    const lista = (await (await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/libro/cfdi?periodo=${MES_ACTUAL}`, { headers: { authorization: `Bearer ${ctx.staff.readonly.token}` } })).json()) as { cfdi: { id: string; armable: boolean; categoriaContable: string | null; confianzaClasificacion: number | null }[] };
    expect(lista.cfdi.find((c) => c.id === i.id)).toMatchObject({ armable: true, categoriaContable: "telefonia", confianzaClasificacion: 0.9 });
    const raw = JSON.stringify({ invoiceId: i.id });
    const res = await buildApp(ctx.deps).request(`/despachos/${ctx.propertyId}/libro/polizas/desde-cfdi`, { method: "POST", headers: { authorization: `Bearer ${ctx.staff.contador.token}`, "content-type": "application/json", "content-length": String(raw.length) }, body: raw });
    expect(res.status).toBe(201);
  });
});

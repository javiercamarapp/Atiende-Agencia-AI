// D-11: cola de cobranza -- gestiones por factura/cliente, reporte PDF de cartera y outbox de WhatsApp (opt-in/opt-out)
// SIN envio. Rutas end-to-end con el motor de dominio real y el doble en memoria de la cola (las reglas de
// seguridad en Postgres real viven en scripts/verify-despachos-cola-cobranza). Nada de aqui toca la red.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import { InMemoryColaCobranzaRepository } from "@atiende/domain-despachos";
import type { CuentaSemilla } from "../../../packages/domain-despachos/src/cola-cobranza/in-memory-repository.ts";
import { buildApp } from "../src/app.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;
let semillas: CuentaSemilla[];
let app: ReturnType<typeof buildApp>;
let disponible: boolean;

function fechaDesplazada(dias: number): string {
  const [y, m, d] = hoyFechaNegocio().split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + dias)).toISOString().slice(0, 10);
}

async function nuevaCuenta(opts: { rfc?: string; total?: number; venceEnDias?: number; nombre?: string | null; pagada?: boolean } = {}) {
  const rfc = opts.rfc ?? "XAXX010101000";
  const invoice = await ctx.despachosRepo.insertInvoice({
    organizationId: ctx.organizationId, propertyId: ctx.propertyId, folioFiscal: randomUUID(), tipo: "I", rfcEmisor: "CON950820K12", rfcReceptor: rfc,
    emisorNombre: "CLIENTE DE PRUEBA SA DE CV", subtotal: 1000, total: opts.total ?? 1160, iva: 160, descuento: 0, categoria: "sin_clasificar", valido: true, issues: [], warnings: [],
    requiresHumanReview: false, diot: { proveedoresReportables: [], reportable: false }, fecha: "2026-01-01",
  });
  const receivable = await ctx.despachosRepo.registerReceivable({
    organizationId: ctx.organizationId, propertyId: ctx.propertyId, invoiceId: invoice.id, fechaVencimiento: fechaDesplazada(opts.venceEnDias ?? -10), clienteNombre: opts.nombre === undefined ? "Cliente de Prueba" : opts.nombre,
  });
  if (opts.pagada) await ctx.despachosRepo.markReceivablePaid(ctx.propertyId, receivable.id, new Date().toISOString(), null);
  semillas.push({ propertyId: ctx.propertyId, receivableId: receivable.id, rfcReceptor: rfc, pagada: opts.pagada });
  return { invoice, receivable };
}

const base = () => `/despachos/${ctx.propertyId}/cola-cobranza`;
const post = (token: string, ruta: string, body: unknown) => app.request(`${base()}${ruta}`, authedJson(token, body));
const put = post; // el consentimiento es un upsert por cliente expuesto como POST
const get = (token: string, ruta: string) => app.request(`${base()}${ruta}`, { headers: { authorization: `Bearer ${token}` } });
const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

beforeEach(async () => {
  semillas = [];
  disponible = true;
  ctx = await buildDespachosTestContext(buildApp);
  const cola = new InMemoryColaCobranzaRepository(semillas, { hoy: () => hoyFechaNegocio() });
  // `disponible` se evalua por peticion: simula la base sin migrar sin reconstruir la app.
  const gate = new Proxy(cola, { get: (t, k, r) => (disponible || typeof k === "symbol" ? Reflect.get(t, k, r) : (k === "listarGestiones" || k === "crearGestion" || k === "resolverGestion" || k === "listarConsentimientos" || k === "fijarConsentimiento" || k === "encolarWhatsApp" || k === "listarOutbox" ? async () => ({ disponible: false }) : Reflect.get(t, k, r))) });
  app = buildApp({ ...ctx.deps, colaCobranzaRepo: () => gate });
});

afterEach(() => vi.restoreAllMocks());

describe("gestiones: promesa de pago, recordatorio, llamada, nota", () => {
  it("un contador registra una promesa en centavos, la ve en la cola y la resuelve; la cola excluye lo resuelto", async () => {
    const { receivable } = await nuevaCuenta({ total: 1160 });
    const res = await post(ctx.staff.contador.token, "/gestiones", { receivableId: receivable.id, tipo: "promesa_pago", montoPromesaCentavos: 116000, fechaPromesa: fechaDesplazada(-1), nota: "Pagara el viernes" });
    expect(res.status).toBe(201);
    const { id } = await json<{ id: string }>(res);

    const lista = await json<{ disponible: boolean; gestiones: { id: string; estado: string; montoPromesaCentavos: number }[] }>(await get(ctx.staff.auditor.token, `/gestiones?receivableId=${receivable.id}`));
    expect(lista.disponible).toBe(true);
    expect(lista.gestiones).toMatchObject([{ id, estado: "pendiente", montoPromesaCentavos: 116000 }]);

    const cola = await json<{ items: { urgencia: string; cuenta: { saldoCentavos: number; diasVencido: number; folioFiscal: string } }[] }>(await get(ctx.staff.readonly.token, "/cola"));
    expect(cola.items).toHaveLength(1);
    expect(cola.items[0]).toMatchObject({ urgencia: "promesa_vencida", cuenta: { saldoCentavos: 116000, diasVencido: 10 } });

    const resuelta = await post(ctx.staff.admin.token, `/gestiones/${id}/estado`, { estado: "incumplida", nota: "No pago" });
    expect(resuelta.status).toBe(200);
    expect((await json<{ items: unknown[] }>(await get(ctx.staff.admin.token, "/cola"))).items).toHaveLength(0);
    // Resolver dos veces -> 409.
    expect((await post(ctx.staff.admin.token, `/gestiones/${id}/estado`, { estado: "cumplida" })).status).toBe(409);
  });

  it("llamada, recordatorio y nota: la llamada sin nota se rechaza; con seguimiento entra a la cola", async () => {
    const { receivable } = await nuevaCuenta();
    expect((await post(ctx.staff.contador.token, "/gestiones", { receivableId: receivable.id, tipo: "llamada" })).status).toBe(400);
    expect((await post(ctx.staff.contador.token, "/gestiones", { receivableId: receivable.id, tipo: "recordatorio" })).status).toBe(201);
    expect((await post(ctx.staff.contador.token, "/gestiones", { receivableId: receivable.id, tipo: "llamada", nota: "No contesto", fechaSeguimiento: fechaDesplazada(2) })).status).toBe(201);
    const cola = await json<{ items: { urgencia: string; gestion: { tipo: string } }[] }>(await get(ctx.staff.admin.token, "/cola"));
    expect(cola.items).toMatchObject([{ urgencia: "programada", gestion: { tipo: "llamada" } }]);
  });

  it("valida montos y fechas: decimal, cero, texto, fecha imposible y exceso de un ano", async () => {
    const { receivable } = await nuevaCuenta();
    const promesa = (extra: Record<string, unknown>) => post(ctx.staff.contador.token, "/gestiones", { receivableId: receivable.id, tipo: "promesa_pago", fechaPromesa: fechaDesplazada(3), ...extra });
    expect((await promesa({ montoPromesaCentavos: 100.5 })).status).toBe(400);
    expect((await promesa({ montoPromesaCentavos: 0 })).status).toBe(400);
    expect((await promesa({ montoPromesaCentavos: "100" })).status).toBe(400);
    expect((await promesa({})).status).toBe(400);
    expect((await promesa({ montoPromesaCentavos: 100, fechaPromesa: "2026-02-31" })).status).toBe(400);
    expect((await promesa({ montoPromesaCentavos: 100, fechaPromesa: fechaDesplazada(400) })).status).toBe(400);
    expect((await promesa({ montoPromesaCentavos: 100 })).status).toBe(201);
  });

  it("rechaza tipo desconocido, receivableId que no es UUID, cuenta inexistente y promesa sobre cuenta pagada", async () => {
    const { receivable } = await nuevaCuenta();
    const pagada = await nuevaCuenta({ pagada: true });
    const crear = (b: Record<string, unknown>) => post(ctx.staff.contador.token, "/gestiones", b);
    expect((await crear({ receivableId: receivable.id, tipo: "amenaza" })).status).toBe(400);
    expect((await crear({ receivableId: "no-es-uuid", tipo: "nota", nota: "x" })).status).toBe(400);
    expect((await crear({ receivableId: randomUUID(), tipo: "nota", nota: "x" })).status).toBe(404);
    expect((await crear({ receivableId: pagada.receivable.id, tipo: "promesa_pago", montoPromesaCentavos: 100, fechaPromesa: fechaDesplazada(2) })).status).toBe(409);
  });

  it("resolver una gestion inexistente o con estado invalido", async () => {
    expect((await post(ctx.staff.admin.token, `/gestiones/${randomUUID()}/estado`, { estado: "cumplida" })).status).toBe(404);
    expect((await post(ctx.staff.admin.token, `/gestiones/${randomUUID()}/estado`, { estado: "pendiente" })).status).toBe(400);
    expect((await post(ctx.staff.admin.token, "/gestiones/no-uuid/estado", { estado: "cumplida" })).status).toBe(400);
  });

  it("roles: auditor/readonly leen pero no escriben; sin token 401", async () => {
    const { receivable } = await nuevaCuenta();
    const body = { receivableId: receivable.id, tipo: "recordatorio" };
    expect((await post(ctx.staff.auditor.token, "/gestiones", body)).status).toBe(403);
    expect((await post(ctx.staff.readonly.token, "/gestiones", body)).status).toBe(403);
    expect((await get(ctx.staff.auditor.token, "/gestiones")).status).toBe(200);
    expect((await get(ctx.staff.readonly.token, "/cola")).status).toBe(200);
    expect((await app.request(`${base()}/gestiones`)).status).toBe(401);
  });

  it("cross-tenant: pedir la cola de OTRA property sin membresia es 403", async () => {
    const res = await app.request(`/despachos/${randomUUID()}/cola-cobranza/cola`, { headers: { authorization: `Bearer ${ctx.staff.admin.token}` } });
    expect(res.status).toBe(403);
  });

  it("filtros invalidos de la lista -> 400", async () => {
    expect((await get(ctx.staff.admin.token, "/gestiones?estado=otro")).status).toBe(400);
    expect((await get(ctx.staff.admin.token, "/gestiones?receivableId=x")).status).toBe(400);
  });
});

describe("compatibilidad con la base SIN migrar (017 pendiente)", () => {
  it("lecturas: disponible=false con listas vacias; escrituras: 503 honesto; el reporte de cartera sigue funcionando", async () => {
    const { receivable } = await nuevaCuenta();
    disponible = false;
    expect(await json(await get(ctx.staff.admin.token, "/gestiones"))).toEqual({ disponible: false, gestiones: [] });
    expect(await json(await get(ctx.staff.admin.token, "/cola"))).toMatchObject({ disponible: false, items: [] });
    expect(await json(await get(ctx.staff.admin.token, "/whatsapp/outbox"))).toEqual({ disponible: false, mensajes: [] });
    expect(await json(await get(ctx.staff.admin.token, "/whatsapp/consentimientos"))).toEqual({ disponible: false, consentimientos: [] });
    expect((await post(ctx.staff.admin.token, "/gestiones", { receivableId: receivable.id, tipo: "recordatorio" })).status).toBe(503);
    expect((await post(ctx.staff.admin.token, `/gestiones/${randomUUID()}/estado`, { estado: "cancelada" })).status).toBe(503);
    expect((await put(ctx.staff.admin.token, "/whatsapp/consentimientos", { rfcReceptor: "XAXX010101000", telefono: "9981234567", estado: "opt_out" })).status).toBe(503);
    expect((await post(ctx.staff.admin.token, `/cuentas/${receivable.id}/whatsapp`, {})).status).toBe(503);
    const reporte = await get(ctx.staff.admin.token, "/reporte-cartera");
    expect(reporte.status).toBe(200);
    expect((await json<{ totalesCentavos: { total: number } }>(reporte)).totalesCentavos.total).toBe(116000);
  });
});

describe("reporte de cartera y antiguedad", () => {
  it("JSON: agrupa por RFC en centavos, separa corriente y vencido, y cuadra", async () => {
    await nuevaCuenta({ rfc: "XAXX010101000", total: 1160, venceEnDias: -45, nombre: "Cliente Uno" });
    await nuevaCuenta({ rfc: "XAXX010101000", total: 580.5, venceEnDias: 5, nombre: "Cliente Uno" });
    await nuevaCuenta({ rfc: "XEXX010101000", total: 232, venceEnDias: -120, nombre: "Cliente Dos" });
    await nuevaCuenta({ total: 999, venceEnDias: -3, pagada: true });
    const res = await get(ctx.staff.auditor.token, "/reporte-cartera");
    expect(res.status).toBe(200);
    const rep = await json<{ totalesCentavos: Record<string, number>; secciones: { filas: Record<string, unknown>[]; totales: Record<string, unknown> | null }[]; etiquetaPeriodo: string; contribuyente: { rfc: string | null } }>(res);
    expect(rep.totalesCentavos).toEqual({ corriente: 58050, "1-30": 0, "31-60": 116000, "61-90": 0, "90+": 23200, total: 197250 });
    expect(rep.secciones[0]!.filas).toHaveLength(2);
    expect(rep.secciones[0]!.filas[0]).toMatchObject({ cliente: "Cliente Uno", rfc: "XAXX010101000", facturas: 2, total: 1740.5 });
    expect(rep.secciones[1]!.filas).toHaveLength(3);
    expect(rep.etiquetaPeriodo).toBe(`Corte al ${hoyFechaNegocio()}`);
    expect(rep.contribuyente.rfc).toBe("CON950820K12");
  });

  it("PDF: es un PDF real con cabeceras seguras, tambien con la cartera vacia", async () => {
    const vacio = await get(ctx.staff.readonly.token, "/reporte-cartera?formato=pdf");
    expect(vacio.status).toBe(200);
    expect(vacio.headers.get("content-type")).toBe("application/pdf");
    expect(vacio.headers.get("x-content-type-options")).toBe("nosniff");
    expect(vacio.headers.get("cache-control")).toBe("private, no-store");
    expect(vacio.headers.get("content-disposition")).toBe(`attachment; filename="cartera-antiguedad-${hoyFechaNegocio()}.pdf"`);
    expect(new TextDecoder().decode((await vacio.arrayBuffer()).slice(0, 5))).toBe("%PDF-");

    await nuevaCuenta({ nombre: "Cliente <script>alert(1)</script> Ñandú" });
    const lleno = await get(ctx.staff.readonly.token, "/reporte-cartera?formato=pdf");
    expect(lleno.status).toBe(200);
    expect(new TextDecoder().decode((await lleno.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
  });

  it("formato desconocido -> 400; sin cartera el JSON declara 'sin datos'", async () => {
    expect((await get(ctx.staff.admin.token, "/reporte-cartera?formato=xlsx")).status).toBe(400);
    const rep = await json<{ sinDatos: boolean; secciones: { sinDatosMotivo: string | null }[] }>(await get(ctx.staff.admin.token, "/reporte-cartera"));
    expect(rep.sinDatos).toBe(true);
    expect(rep.secciones[0]!.sinDatosMotivo).toMatch(/No hay cuentas/);
  });
});

describe("recordatorio por WhatsApp: outbox con opt-in/opt-out, nunca envia", () => {
  const consentir = (estado: "opt_in" | "opt_out", extra: Record<string, unknown> = {}) =>
    put(ctx.staff.contador.token, "/whatsapp/consentimientos", { rfcReceptor: "xaxx010101000", telefono: "998 123 4567", estado, evidencia: estado === "opt_in" ? "Autorizo en el contrato firmado" : undefined, ...extra });

  it("sin opt-in no se encola (409); con opt-in se encola en pendiente, sin red, idempotente por dia", async () => {
    const fetchEspia = vi.spyOn(globalThis, "fetch");
    const { receivable } = await nuevaCuenta({ total: 12500 });
    expect((await post(ctx.staff.contador.token, `/cuentas/${receivable.id}/whatsapp`, {})).status).toBe(409);

    expect((await consentir("opt_in")).status).toBe(200);
    const res = await post(ctx.staff.contador.token, `/cuentas/${receivable.id}/whatsapp`, {});
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ estado: "pendiente", enviado: false, duplicado: false });
    const otra = await post(ctx.staff.contador.token, `/cuentas/${receivable.id}/whatsapp`, {});
    expect(otra.status).toBe(200);
    expect(await json(otra)).toMatchObject({ duplicado: true });

    const outbox = await json<{ mensajes: { estado: string; cuerpo: string }[] }>(await get(ctx.staff.auditor.token, "/whatsapp/outbox"));
    expect(outbox.mensajes).toHaveLength(1);
    expect(outbox.mensajes[0]!.estado).toBe("pendiente");
    expect(outbox.mensajes[0]!.cuerpo).toContain("12,500.00");
    expect(JSON.stringify(outbox)).not.toContain("5219981234567");
    expect(fetchEspia).not.toHaveBeenCalled();
  });

  it("el telefono se guarda en E.164 y la API solo lo devuelve enmascarado", async () => {
    await nuevaCuenta();
    expect((await consentir("opt_in")).status).toBe(200);
    const lista = await json<{ consentimientos: { rfcReceptor: string; telefono: string; estado: string }[] }>(await get(ctx.staff.readonly.token, "/whatsapp/consentimientos"));
    expect(lista.consentimientos).toMatchObject([{ rfcReceptor: "XAXX010101000", estado: "opt_in" }]);
    expect(lista.consentimientos[0]!.telefono).toMatch(/^\+52\*+4567$/);
    expect(lista.consentimientos[0]!.telefono).not.toContain("998");
  });

  it("opt-out cancela los pendientes y bloquea nuevos encolados", async () => {
    const { receivable } = await nuevaCuenta();
    await consentir("opt_in");
    await post(ctx.staff.contador.token, `/cuentas/${receivable.id}/whatsapp`, {});
    expect((await consentir("opt_out", { evidencia: undefined })).status).toBe(200);
    expect((await json<{ mensajes: { estado: string }[] }>(await get(ctx.staff.admin.token, "/whatsapp/outbox"))).mensajes[0]!.estado).toBe("cancelado");
    expect((await post(ctx.staff.contador.token, `/cuentas/${receivable.id}/whatsapp`, { etapa: "vencimiento" })).status).toBe(409);
  });

  it("el opt-in de un cliente no habilita a otro; una cuenta pagada no se encola", async () => {
    const a = await nuevaCuenta({ rfc: "XAXX010101000" });
    const b = await nuevaCuenta({ rfc: "XEXX010101000" });
    const pagada = await nuevaCuenta({ rfc: "XAXX010101000", pagada: true });
    await consentir("opt_in");
    expect((await post(ctx.staff.contador.token, `/cuentas/${a.receivable.id}/whatsapp`, {})).status).toBe(201);
    expect((await post(ctx.staff.contador.token, `/cuentas/${b.receivable.id}/whatsapp`, {})).status).toBe(409);
    expect((await post(ctx.staff.contador.token, `/cuentas/${pagada.receivable.id}/whatsapp`, {})).status).toBe(409);
  });

  it("valida RFC, telefono, estado, evidencia y etapa", async () => {
    const { receivable } = await nuevaCuenta();
    expect((await consentir("opt_in", { rfcReceptor: "XX" })).status).toBe(400);
    expect((await consentir("opt_in", { telefono: "123" })).status).toBe(400);
    expect((await consentir("opt_in", { evidencia: undefined })).status).toBe(400);
    expect((await consentir("opt_in", { evidencia: "x".repeat(301) })).status).toBe(400);
    expect((await put(ctx.staff.contador.token, "/whatsapp/consentimientos", { rfcReceptor: "XAXX010101000", telefono: "9981234567", estado: "quizas" })).status).toBe(400);
    expect((await consentir("opt_in", { rfcReceptor: "ZZZZ010101000" })).status).toBe(404);
    expect((await post(ctx.staff.contador.token, `/cuentas/${receivable.id}/whatsapp`, { etapa: "amenaza" })).status).toBe(400);
    expect((await post(ctx.staff.contador.token, `/cuentas/${randomUUID()}/whatsapp`, {})).status).toBe(404);
    expect((await post(ctx.staff.contador.token, "/cuentas/no-uuid/whatsapp", {})).status).toBe(400);
  });

  it("roles: auditor/readonly no pueden fijar consentimiento ni encolar", async () => {
    const { receivable } = await nuevaCuenta();
    for (const rol of [ctx.staff.auditor, ctx.staff.readonly]) {
      expect((await put(rol.token, "/whatsapp/consentimientos", { rfcReceptor: "XAXX010101000", telefono: "9981234567", estado: "opt_out" })).status).toBe(403);
      expect((await post(rol.token, `/cuentas/${receivable.id}/whatsapp`, {})).status).toBe(403);
    }
  });
});

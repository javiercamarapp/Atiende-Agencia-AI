// D-38 -- bitacora de lecturas, descargas y exportaciones de despachos: cada documento que sale del sistema deja una fila de
// auditoria (actor, recurso, tipo de evento) SIN contenido, SIN correo y SIN nombre de archivo; y el dueno/auditor la consultan
// por GET /v1/despachos/:orgSlug/admin/bitacora. Doble en memoria del sink (el SQL real de despachos.audit_log lo cubre
// scripts/verify-despachos-* contra Postgres real).
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuditSink, AuthzAuditEntry } from "@atiende/core-authz";
import { InMemoryPortalClienteRepository, generarTokenPortal, hashTokenPortal, validarFichaCliente } from "@atiende/domain-despachos";
import { buildApp } from "../src/app.ts";
import type { AppDeps } from "../src/deps.ts";
import { authedJson, buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;
let portalRepo: InMemoryPortalClienteRepository;
let deps: AppDeps;
let app: ReturnType<typeof buildApp>;

/** Sink que, ademas de guardar la entrada, la escribe en el espejo en memoria de `despachos.audit_log` (como el sink de produccion). */
function sinkQueEscribeEnLaBitacora(): AuditSink & { readonly entries: AuthzAuditEntry[] } {
  const entries: AuthzAuditEntry[] = [];
  return {
    entries,
    record(entry) {
      entries.push(entry);
      ctx.despachosRepo.registrarAuditLogParaPruebas({ organizationId: entry.organizationId!, actorUserId: entry.actorUserId ?? null, action: entry.action, payload: { ...entry } });
    },
  };
}

let sink: ReturnType<typeof sinkQueEscribeEnLaBitacora>;

beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
  portalRepo = new InMemoryPortalClienteRepository();
  portalRepo.sembrarCliente({ propertyId: ctx.propertyId, clienteNombre: "Cliente A SA de CV", despachoNombre: "Despacho de Prueba SC", obligaciones: [], cierres: [] });
  sink = sinkQueEscribeEnLaBitacora();
  deps = { ...ctx.deps, portalClienteRepo: () => portalRepo, despachosAuditSink: sink };
  app = buildApp(deps);
});

const base = () => `/despachos/${ctx.propertyId}`;
const eventos = (accion: string) => sink.entries.filter((e) => e.action === accion);

async function sembrarFicha() {
  const f = validarFichaCliente({ rfc: "CLI010101CL1", razonSocial: "Cliente SA de CV", regimenesFiscales: ["601"], cpFiscal: "06600" });
  if (!f.ok) throw new Error("ficha invalida");
  await ctx.carteraRepo.guardarFicha(ctx.propertyId, f.valor);
}

function expectaFilaSinPii(e: AuthzAuditEntry, esperado: { actor: string; recurso: string; tipo: string }) {
  expect(e.actorUserId).toBe(esperado.actor);
  expect(e.organizationId).toBe(ctx.organizationId);
  expect(e.actorEmail).toBeNull();
  expect(e.decision).toBe("allowed");
  expect(e.method).toBe("GET");
  expect(e.metadata).toMatchObject({ tipoEvento: esperado.tipo, recurso: esperado.recurso, propertyId: ctx.propertyId });
  // Ni correo del staff ni contenido: solo identificadores y parametros de forma.
  const texto = JSON.stringify(e);
  expect(texto).not.toContain("@despacho-de-prueba.mx");
}

describe("descargas y exportaciones dejan fila de auditoria", () => {
  it("portal: descargar un documento del cliente registra la descarga (sin nombre de archivo ni contenido); un 404 no registra nada", async () => {
    const token = generarTokenPortal();
    await portalRepo.crearEnlace(ctx.propertyId, hashTokenPortal(token), "contacto", 30);
    const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF");
    const subida = await app.request("/portal-cliente/documentos", {
      method: "POST",
      headers: { "x-portal-token": token, "content-type": "application/pdf", "content-length": String(pdf.byteLength), "x-nombre-archivo": encodeURIComponent("constancia-secreta.pdf") },
      body: pdf,
    });
    expect(subida.status).toBe(201);
    const id = portalRepo.documentos[0]!.id;

    expect((await app.request(`${base()}/portal-cliente/documentos/${randomUUID()}/descargar`, authedJson(ctx.staff.auditor.token))).status).toBe(404);
    expect(eventos("despachos.portal_cliente.documento:descarga")).toHaveLength(0);

    const res = await app.request(`${base()}/portal-cliente/documentos/${id}/descargar`, authedJson(ctx.staff.auditor.token));
    expect(res.status).toBe(200);
    const filas = eventos("despachos.portal_cliente.documento:descarga");
    expect(filas).toHaveLength(1);
    expectaFilaSinPii(filas[0]!, { actor: ctx.staff.auditor.id, recurso: "portal_cliente.documento", tipo: "descarga" });
    expect(filas[0]!.metadata).toMatchObject({ documentoId: id });
    expect(JSON.stringify(filas[0])).not.toContain("constancia-secreta");
  });

  it("reportes: PDF y XLSX registran un export; JSON (pantalla) no", async () => {
    const json = await app.request(`${base()}/reportes/diot?periodo=2026-08&formato=json`, authedJson(ctx.staff.readonly.token));
    expect(json.status).toBe(200);
    expect(eventos("despachos.reporte.diot:export")).toHaveLength(0);

    expect((await app.request(`${base()}/reportes/diot?periodo=2026-08&formato=pdf`, authedJson(ctx.staff.readonly.token))).status).toBe(200);
    expect((await app.request(`${base()}/reportes/diot?periodo=2026-08&formato=xlsx`, authedJson(ctx.staff.contador.token))).status).toBe(200);
    const filas = eventos("despachos.reporte.diot:export");
    expect(filas).toHaveLength(2);
    expectaFilaSinPii(filas[0]!, { actor: ctx.staff.readonly.id, recurso: "reporte.diot", tipo: "export" });
    expect(filas[0]!.metadata).toMatchObject({ periodo: "2026-08", formato: "pdf" });
    expect(filas[1]!.metadata).toMatchObject({ periodo: "2026-08", formato: "xlsx" });
  });

  it("layout DIOT registra el export con periodo y numero de terceros (sin RFC), incluso si el periodo no tiene terceros", async () => {
    expect((await app.request(`${base()}/declaraciones/diot/2026-07/layout`, authedJson(ctx.staff.contador.token))).status).toBe(200);
    const filas = eventos("despachos.declaraciones.diot_layout:export");
    expect(filas).toHaveLength(1);
    expectaFilaSinPii(filas[0]!, { actor: ctx.staff.contador.id, recurso: "declaraciones.diot_layout", tipo: "export" });
    expect(filas[0]!.metadata).toMatchObject({ periodo: "2026-07", terceros: 0 });
  });

  it("contabilidad electronica: catalogo, balanza y paquete registran export (POST); un 400 de validacion no registra", async () => {
    const malo = await app.request(`${base()}/contabilidad-electronica/paquete`, authedJson(ctx.staff.contador.token, { asientos: "no-es-un-arreglo" }));
    expect(malo.status).toBe(400);
    expect(eventos("despachos.contabilidad_electronica.paquete:export")).toHaveLength(0);

    const asientos = [
      { cuenta: "1101", debe: 500, haber: 0 },
      { cuenta: "4100", debe: 0, haber: 500 },
    ];
    expect((await app.request(`${base()}/contabilidad-electronica/paquete`, authedJson(ctx.staff.contador.token, { rfc: "CON950820K12", ejercicio: 2026, mes: 7, asientos }))).status).toBe(200);
    expect((await app.request(`${base()}/contabilidad-electronica/catalogo`, authedJson(ctx.staff.contador.token, { rfc: "CON950820K12", ejercicio: 2026, mes: 7 }))).status).toBe(200);
    expect((await app.request(`${base()}/contabilidad-electronica/balanza`, authedJson(ctx.staff.contador.token, { rfc: "CON950820K12", ejercicio: 2026, mes: 7, asientos }))).status).toBe(200);
    for (const recurso of ["paquete", "catalogo", "balanza"]) {
      const filas = eventos(`despachos.contabilidad_electronica.${recurso}:export`);
      expect(filas, recurso).toHaveLength(1);
      expect(filas[0]!.method).toBe("POST");
      expect(filas[0]!.metadata).toMatchObject({ tipoEvento: "export", recurso: `contabilidad_electronica.${recurso}`, ejercicio: 2026, mes: 7 });
      // Ni el RFC ni las cuentas viajan en la bitacora.
      expect(JSON.stringify(filas[0])).not.toContain("CON950820K12");
    }
  });

  it("libro: el paquete de contabilidad electronica desde el libro registra export solo cuando se genera", async () => {
    await sembrarFicha();
    const url = `${base()}/libro/contabilidad-electronica?periodo=2026-07`;
    // Sin movimientos en el periodo: 409 y NADA se exporto.
    expect((await app.request(url, authedJson(ctx.staff.admin.token))).status).toBe(409);
    expect(eventos("despachos.libro.contabilidad_electronica:export")).toHaveLength(0);
    await app.request(`${base()}/libro/polizas`, authedJson(ctx.staff.admin.token, { tipo: "ingreso", fecha: "2026-07-20", concepto: "Honorarios de julio", movimientos: [{ cuenta: "1050000", debe: 116000, haber: 0 }, { cuenta: "4080000", debe: 0, haber: 100000 }, { cuenta: "2600400", debe: 0, haber: 16000 }] }));
    expect((await app.request(url, authedJson(ctx.staff.admin.token))).status).toBe(200);
    const filas = eventos("despachos.libro.contabilidad_electronica:export");
    expect(filas).toHaveLength(1);
    expectaFilaSinPii(filas[0]!, { actor: ctx.staff.admin.id, recurso: "libro.contabilidad_electronica", tipo: "export" });
    expect(filas[0]!.metadata).toMatchObject({ periodo: "2026-07" });
  });

  it("pagos provisionales: exportar PDF/XLSX registra export con periodo y formato, sin montos ni RFC", async () => {
    await sembrarFicha();
    expect((await app.request(`${base()}/pagos-provisionales/2026-07/exportar?formato=pdf`, authedJson(ctx.staff.auditor.token))).status).toBe(200);
    expect((await app.request(`${base()}/pagos-provisionales/2026-07/exportar?formato=xlsx`, authedJson(ctx.staff.auditor.token))).status).toBe(200);
    expect((await app.request(`${base()}/pagos-provisionales/2026-07/exportar?formato=csv`, authedJson(ctx.staff.auditor.token))).status).toBe(400);
    const filas = eventos("despachos.pagos_provisionales.papel:export");
    expect(filas).toHaveLength(2);
    expectaFilaSinPii(filas[0]!, { actor: ctx.staff.auditor.id, recurso: "pagos_provisionales.papel", tipo: "export" });
    expect(filas.map((f) => f.metadata?.formato)).toEqual(["pdf", "xlsx"]);
    expect(JSON.stringify(filas)).not.toContain("CLI010101CL1");
  });

  it("cartera de cobranza en PDF registra export; el JSON no", async () => {
    expect((await app.request(`${base()}/cola-cobranza/reporte-cartera`, authedJson(ctx.staff.readonly.token))).status).toBe(200);
    expect(eventos("despachos.cola_cobranza.cartera:export")).toHaveLength(0);
    expect((await app.request(`${base()}/cola-cobranza/reporte-cartera?formato=pdf`, authedJson(ctx.staff.readonly.token))).status).toBe(200);
    const filas = eventos("despachos.cola_cobranza.cartera:export");
    expect(filas).toHaveLength(1);
    expectaFilaSinPii(filas[0]!, { actor: ctx.staff.readonly.id, recurso: "cola_cobranza.cartera", tipo: "export" });
  });

  it("un rol sin permiso no deja fila: el 403 ocurre antes de exportar", async () => {
    const res = await app.request(`${base()}/contabilidad-electronica/paquete`, authedJson(ctx.staff.readonly.token, {}));
    expect(res.status).toBe(403);
    expect(sink.entries.filter((e) => e.action.endsWith(":export"))).toHaveLength(0);
  });
});

describe("GET /v1/despachos/:orgSlug/admin/bitacora", () => {
  const url = (q = "") => `/v1/despachos/despacho-de-prueba/admin/bitacora${q}`;

  async function generarEventos() {
    await app.request(`${base()}/reportes/diot?periodo=2026-08&formato=pdf`, authedJson(ctx.staff.contador.token));
    await app.request(`${base()}/declaraciones/diot/2026-07/layout`, authedJson(ctx.staff.contador.token));
  }

  it("admin y auditor ven los eventos recientes primero; la fila sale proyectada sin correo, ip ni user-agent", async () => {
    await generarEventos();
    for (const rol of ["admin", "auditor"] as const) {
      const res = await app.request(url(), authedJson(ctx.staff[rol].token));
      expect(res.status, rol).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");
      const body = (await res.json()) as { total: number; nextOffset: number | null; eventos: Record<string, unknown>[] };
      expect(body.total).toBe(2);
      expect(body.nextOffset).toBeNull();
      expect(body.eventos.map((e) => e.accion)).toEqual(["despachos.declaraciones.diot_layout:export", "despachos.reporte.diot:export"]);
      expect(body.eventos[0]).toMatchObject({ actorUserId: ctx.staff.contador.id, tipoEvento: "export", recurso: "declaraciones.diot_layout", metodo: "GET", decision: "allowed", detalle: { periodo: "2026-07", terceros: 0, propertyId: ctx.propertyId } });
      const texto = JSON.stringify(body);
      expect(texto).not.toContain("@despacho-de-prueba.mx");
      expect(texto).not.toContain("userAgent");
      expect(texto).not.toContain('"ip"');
    }
  });

  it("pagina con limit/offset y desempata de forma total", async () => {
    await generarEventos();
    await app.request(`${base()}/cola-cobranza/reporte-cartera?formato=pdf`, authedJson(ctx.staff.contador.token));
    const p1 = (await (await app.request(url("?limit=2&offset=0"), authedJson(ctx.staff.admin.token))).json()) as { total: number; nextOffset: number | null; eventos: { accion: string }[] };
    expect(p1.total).toBe(3);
    expect(p1.nextOffset).toBe(2);
    expect(p1.eventos.map((e) => e.accion)).toEqual(["despachos.cola_cobranza.cartera:export", "despachos.declaraciones.diot_layout:export"]);
    const p2 = (await (await app.request(url("?limit=2&offset=2"), authedJson(ctx.staff.admin.token))).json()) as { nextOffset: number | null; eventos: { accion: string }[] };
    expect(p2.nextOffset).toBeNull();
    expect(p2.eventos.map((e) => e.accion)).toEqual(["despachos.reporte.diot:export"]);
  });

  it("contador y readonly -> 403; sin token -> 401; otra organizacion no ve las filas; slug inexistente -> 404", async () => {
    await generarEventos();
    expect((await app.request(url(), authedJson(ctx.staff.contador.token))).status).toBe(403);
    expect((await app.request(url(), authedJson(ctx.staff.readonly.token))).status).toBe(403);
    expect((await app.request(url())).status).toBe(401);
    expect((await app.request("/v1/despachos/no-existe/admin/bitacora", authedJson(ctx.staff.admin.token))).status).toBe(404);
  });

  it("solo expone las filas de SU organizacion y descarta valores no escalares del metadata", async () => {
    ctx.despachosRepo.registrarAuditLogParaPruebas({ organizationId: randomUUID(), actorUserId: null, action: "despachos.reporte.diot:export", payload: { metadata: { recurso: "reporte.diot" } } });
    ctx.despachosRepo.registrarAuditLogParaPruebas({
      organizationId: ctx.organizationId,
      actorUserId: ctx.staff.admin.id,
      action: "despachos.cierre-mensual:auto-check",
      payload: { route: "/x", method: "POST", decision: "allowed", actorEmail: "admin@despacho-de-prueba.mx", ip: "10.0.0.1", metadata: { periodoId: "p1", tareaIds: ["a", "b"], anidado: { secreto: 1 } } },
    });
    const body = (await (await app.request(url(), authedJson(ctx.staff.admin.token))).json()) as { total: number; eventos: { detalle: Record<string, unknown>; tipoEvento: string | null }[] };
    expect(body.total).toBe(1);
    expect(body.eventos[0]).toMatchObject({ tipoEvento: null, detalle: { periodoId: "p1" } });
    expect(body.eventos[0]!.detalle).not.toHaveProperty("tareaIds");
    expect(body.eventos[0]!.detalle).not.toHaveProperty("anidado");
    expect(JSON.stringify(body)).not.toContain("10.0.0.1");
    expect(JSON.stringify(body)).not.toContain("@despacho-de-prueba.mx");
  });

  it("de punta a punta: la descarga del portal aparece en la bitacora con su actor", async () => {
    const token = generarTokenPortal();
    await portalRepo.crearEnlace(ctx.propertyId, hashTokenPortal(token), "contacto", 30);
    const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF");
    await app.request("/portal-cliente/documentos", { method: "POST", headers: { "x-portal-token": token, "content-type": "application/pdf", "content-length": String(pdf.byteLength), "x-nombre-archivo": "a.pdf" }, body: pdf });
    await app.request(`${base()}/portal-cliente/documentos/${portalRepo.documentos[0]!.id}/descargar`, authedJson(ctx.staff.readonly.token));
    const body = (await (await app.request(url(), authedJson(ctx.staff.auditor.token))).json()) as { eventos: { actorUserId: string; tipoEvento: string; recurso: string }[] };
    expect(body.eventos[0]).toMatchObject({ actorUserId: ctx.staff.readonly.id, tipoEvento: "descarga", recurso: "portal_cliente.documento" });
  });
});

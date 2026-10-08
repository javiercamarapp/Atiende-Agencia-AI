// D-P3-16/17/44 -- libro contable: código agrupador del SAT, XML conforme al XSD 1.3 (catálogo, balanza y pólizas del periodo), importación del
// catálogo y la balanza del proveedor anterior (con XML malicioso), pólizas de CFDI con retenciones/IEPS y pólizas de cobro/pago de un REP.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { CATALOGO_ANEXO24_BASE, construirCatalogoBase, generarXmlBalanza, generarXmlCatalogo, validarFichaCliente } from "@atiende/domain-despachos";
import type { NewInvoiceInput, PagoRepContable } from "@atiende/domain-despachos";
import { validarContraXsd } from "../../../packages/domain-despachos/tests/support/validar-xsd.ts";
import { buildDespachosTestContext } from "./despachos-fixtures.ts";
import type { DespachosTestContext } from "./despachos-fixtures.ts";

let ctx: DespachosTestContext;
beforeEach(async () => {
  ctx = await buildDespachosTestContext(buildApp);
});

function req(token: string, method: string, body?: unknown): RequestInit {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${token}` } };
  if (body !== undefined) {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    init.body = raw;
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    (init.headers as Record<string, string>)["content-length"] = String(new TextEncoder().encode(raw).byteLength);
  }
  return init;
}
const base = () => `/despachos/${ctx.propertyId}/libro`;
const RFC = "CLI010101CL1";
const POLIZA = {
  tipo: "ingreso",
  fecha: "2026-07-20",
  concepto: "Honorarios de julio",
  movimientos: [
    { cuenta: "1050000", debe: 116000, haber: 0 },
    { cuenta: "4080000", debe: 0, haber: 100000 },
    { cuenta: "2600400", debe: 0, haber: 16000 },
  ],
};

async function sembrarFicha(rfc = RFC) {
  const f = validarFichaCliente({ rfc, razonSocial: "Cliente SA de CV", regimenesFiscales: ["601"], cpFiscal: "06600" });
  if (!f.ok) throw new Error("ficha invalida");
  await ctx.carteraRepo.guardarFicha(ctx.propertyId, f.valor);
}
/** Catálogo como lo dejó la migración 028 en un cliente anterior: nivel 1, sin padre y SIN código agrupador. */
async function sembrarCatalogoHeredado() {
  await ctx.libroRepo.sembrarCatalogo(ctx.propertyId, construirCatalogoBase().map((c) => ({ codigo: c.codigo, descripcion: c.descripcion, naturaleza: c.naturaleza })));
}
const json = async <T>(r: Response) => (await r.json()) as T;

describe("código agrupador del SAT", () => {
  it("la lista de cuentas trae la propuesta del catálogo base y cuántas cuentas siguen sin código", async () => {
    await sembrarCatalogoHeredado();
    const app = buildApp(ctx.deps);
    const r = await json<{ sinCodigoAgrupador: number; cuentas: { codigo: string; codigoAgrupador: string | null; propuestaCodigo: string | null; nivel: number }[] }>(await app.request(`${base()}/cuentas`, req(ctx.staff.readonly.token, "GET")));
    expect(r.sinCodigoAgrupador).toBe(r.cuentas.length);
    expect(r.cuentas.find((c) => c.codigo === "1020100")).toMatchObject({ codigoAgrupador: null, propuestaCodigo: "102.01", nivel: 1 });
  });

  it("asigna códigos de la lista cerrada; uno fuera de la lista, mal formado o de una cuenta inexistente se rechaza", async () => {
    await sembrarCatalogoHeredado();
    const app = buildApp(ctx.deps);
    const ok = await app.request(`${base()}/catalogo/agrupadores`, req(ctx.staff.contador.token, "POST", { asignaciones: [{ codigo: "1050000", codigoAgrupador: "105" }, { codigo: "4080000", codigoAgrupador: "401.01" }] }));
    expect(ok.status).toBe(200);
    expect(await json<{ actualizadas: number }>(ok)).toEqual({ actualizadas: 2 });
    for (const asignaciones of [
      [{ codigo: "1050000", codigoAgrupador: "999.99" }],
      [{ codigo: "1050000", codigoAgrupador: "10.5" }],
      [{ codigo: "12", codigoAgrupador: "105" }],
      [{ codigo: "9999999", codigoAgrupador: "105" }],
      [],
    ]) {
      expect((await app.request(`${base()}/catalogo/agrupadores`, req(ctx.staff.contador.token, "POST", { asignaciones }))).status).toBe(400);
    }
    expect(ctx.auditSink.entries.some((e) => e.action === "despachos.libro:asignar-agrupadores")).toBe(true);
  });

  it("'proponer' aplica el código del catálogo base SOLO a las cuentas que no lo tienen y no pisa uno ya capturado", async () => {
    await sembrarCatalogoHeredado();
    const app = buildApp(ctx.deps);
    await app.request(`${base()}/catalogo/agrupadores`, req(ctx.staff.contador.token, "POST", { asignaciones: [{ codigo: "1050000", codigoAgrupador: "106" }] }));
    const r = await json<{ aplicadas: number; sinPropuesta: number }>(await app.request(`${base()}/catalogo/agrupadores/proponer`, req(ctx.staff.contador.token, "POST", {})));
    expect(r.aplicadas).toBeGreaterThan(30);
    expect(r.sinPropuesta).toBe(0);
    const cuentas = await json<{ sinCodigoAgrupador: number; cuentas: { codigo: string; codigoAgrupador: string }[] }>(await app.request(`${base()}/cuentas`, req(ctx.staff.readonly.token, "GET")));
    expect(cuentas.sinCodigoAgrupador).toBe(0);
    expect(cuentas.cuentas.find((c) => c.codigo === "1050000")?.codigoAgrupador).toBe("106"); // el que ya tenía no se pisa
  });

  it("guardar una cuenta con jerarquía y código; fuera de la lista, mal formado o nivel sin padre se rechaza", async () => {
    await sembrarCatalogoHeredado();
    const app = buildApp(ctx.deps);
    const put = (body: unknown) => app.request(`${base()}/cuentas`, req(ctx.staff.contador.token, "PUT", body));
    const buena = { codigo: "1020900", descripcion: "Banco X", naturaleza: "D", nivel: 2, cuentaPadre: "1020000", codigoAgrupador: "102.02" };
    expect((await put(buena)).status).toBe(200);
    const lista = await json<{ cuentas: { codigo: string; nivel: number; cuentaPadre: string | null; codigoAgrupador: string | null }[] }>(await app.request(`${base()}/cuentas`, req(ctx.staff.readonly.token, "GET")));
    expect(lista.cuentas.find((c) => c.codigo === "1020900")).toMatchObject({ nivel: 2, cuentaPadre: "1020000", codigoAgrupador: "102.02" });
    expect((await put({ ...buena, codigoAgrupador: "999.99" })).status).toBe(400);
    expect((await put({ ...buena, codigoAgrupador: "10.2" })).status).toBe(400);
    expect((await put({ ...buena, cuentaPadre: undefined })).status).toBe(400); // nivel 2 sin cuenta padre
    expect((await put({ ...buena, cuentaPadre: "4080000" })).status).toBe(400); // padre de otro rubro
    expect((await put({ ...buena, nivel: 11 })).status).toBe(400);
    // Editar solo la descripción (como lo hacía la pantalla antes) no borra jerarquía ni código.
    expect((await put({ codigo: "1020900", descripcion: "Banco X (editada)", naturaleza: "D" })).status).toBe(200);
    const despues = await json<{ cuentas: { codigo: string; cuentaPadre: string | null; codigoAgrupador: string | null }[] }>(await app.request(`${base()}/cuentas`, req(ctx.staff.readonly.token, "GET")));
    expect(despues.cuentas.find((c) => c.codigo === "1020900")).toMatchObject({ cuentaPadre: "1020000", codigoAgrupador: "102.02" });
  });
});

describe("XML de contabilidad electrónica conforme al XSD 1.3 desde el libro", () => {
  it("con cuentas sin código agrupador responde 409 con la lista; tras asignarlas el catálogo y la balanza VALIDAN contra el XSD oficial", async () => {
    await sembrarCatalogoHeredado();
    await sembrarFicha();
    const app = buildApp(ctx.deps);
    await app.request(`${base()}/polizas`, req(ctx.staff.admin.token, "POST", POLIZA));
    const sin = await app.request(`${base()}/contabilidad-electronica?periodo=2026-07`, req(ctx.staff.admin.token, "GET"));
    expect(sin.status).toBe(409);
    const cuerpo = await json<{ code: string; total: number; cuentasSinCodigo: { codigo: string; motivo: string }[] }>(sin);
    expect(cuerpo.code).toBe("catalogo_sin_codigo_agrupador");
    expect(cuerpo.cuentasSinCodigo.map((c) => c.codigo)).toContain("1050000");
    expect(cuerpo.cuentasSinCodigo.every((c) => c.motivo === "faltante")).toBe(true);

    await app.request(`${base()}/catalogo/agrupadores/proponer`, req(ctx.staff.contador.token, "POST", {}));
    const ok = await app.request(`${base()}/contabilidad-electronica?periodo=2026-07`, req(ctx.staff.admin.token, "GET"));
    expect(ok.status).toBe(200);
    const body = await json<{ catalogo: { xml: string }; balanza: { xml: string; cuadrada: boolean } }>(ok);
    expect((await validarContraXsd(body.catalogo.xml, "CatalogoCuentas_1_3")).errores).toEqual([]);
    expect((await validarContraXsd(body.balanza.xml, "BalanzaComprobacion_1_3")).errores).toEqual([]);
    expect(body.balanza.xml).toContain('TipoEnvio="N"');
    expect(body.balanza.xml).not.toContain("FechaModificacion");
  });

  it("balanza complementaria: exige FechaModBal; TipoEnvio inválido -> 400", async () => {
    await sembrarFicha();
    const app = buildApp(ctx.deps);
    await app.request(`${base()}/polizas`, req(ctx.staff.admin.token, "POST", POLIZA));
    const url = (q: string) => `${base()}/contabilidad-electronica?periodo=2026-07&${q}`;
    expect((await app.request(url("tipoEnvio=C"), req(ctx.staff.admin.token, "GET"))).status).toBe(409);
    expect((await app.request(url("tipoEnvio=B"), req(ctx.staff.admin.token, "GET"))).status).toBe(400);
    const c = await app.request(url("tipoEnvio=C&fechaModBal=2026-08-15"), req(ctx.staff.admin.token, "GET"));
    expect(c.status).toBe(200);
    const body = await json<{ balanza: { xml: string } }>(c);
    expect(body.balanza.xml).toContain('TipoEnvio="C" FechaModBal="2026-08-15"');
    expect((await validarContraXsd(body.balanza.xml, "BalanzaComprobacion_1_3")).errores).toEqual([]);
  });

  it("pólizas del periodo: XML válido contra PolizasPeriodo_1_3; exige tipo de solicitud y su número de orden o trámite", async () => {
    await sembrarFicha();
    const app = buildApp(ctx.deps);
    const url = (q: string) => `${base()}/contabilidad-electronica/polizas?periodo=2026-07&${q}`;
    await app.request(`${base()}/catalogo/sembrar`, req(ctx.staff.admin.token, "POST", {}));
    expect((await app.request(url("tipoSolicitud=AF&numOrden=ABC1234567/26"), req(ctx.staff.admin.token, "GET"))).status).toBe(409); // sin pólizas
    await app.request(`${base()}/polizas`, req(ctx.staff.admin.token, "POST", POLIZA));
    const ok = await app.request(url("tipoSolicitud=AF&numOrden=ABC1234567/26"), req(ctx.staff.readonly.token, "GET"));
    expect(ok.status).toBe(200);
    const body = await json<{ polizas: number; xml: string; sha1: string }>(ok);
    expect(body.polizas).toBe(1);
    expect(body.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(body.xml).toContain('NumUnIdenPol="I-202607-0001"');
    expect((await validarContraXsd(body.xml, "PolizasPeriodo_1_3")).errores).toEqual([]);
    expect((await app.request(url(""), req(ctx.staff.admin.token, "GET"))).status).toBe(400);
    expect((await app.request(url("tipoSolicitud=AF"), req(ctx.staff.admin.token, "GET"))).status).toBe(400);
    expect((await app.request(url("tipoSolicitud=DE&numOrden=ABC1234567/26"), req(ctx.staff.admin.token, "GET"))).status).toBe(400);
    expect((await app.request(url("tipoSolicitud=DE&numTramite=AB123456789012"), req(ctx.staff.admin.token, "GET"))).status).toBe(200);
    expect(ctx.auditSink.entries.some((e) => e.action.includes("libro.contabilidad_electronica_polizas") || JSON.stringify(e).includes("contabilidad_electronica_polizas"))).toBe(true);
  });
});

describe("importación del catálogo del proveedor anterior", () => {
  const catalogoXml = (rfc = RFC) =>
    generarXmlCatalogo(CATALOGO_ANEXO24_BASE, { rfc, ejercicio: 2026, mes: 7 });

  it("sin confirmar es una vista previa que no escribe; confirmando agrega las cuentas sin borrar las que ya había", async () => {
    await sembrarFicha();
    const app = buildApp(ctx.deps);
    await app.request(`${base()}/catalogo/sembrar`, req(ctx.staff.admin.token, "POST", {}));
    const antes = (await ctx.libroRepo.listarCuentas(ctx.propertyId)).datos.length;
    const previa = await app.request(`${base()}/catalogo/importar`, req(ctx.staff.contador.token, "POST", { xml: catalogoXml() }));
    expect(previa.status).toBe(200);
    const p = await json<{ confirmado: boolean; aceptadas: number; nuevas: number; rechazadasTotal: number }>(previa);
    expect(p).toMatchObject({ confirmado: false, aceptadas: CATALOGO_ANEXO24_BASE.length, nuevas: CATALOGO_ANEXO24_BASE.length, rechazadasTotal: 0 });
    expect((await ctx.libroRepo.listarCuentas(ctx.propertyId)).datos).toHaveLength(antes);

    const conf = await app.request(`${base()}/catalogo/importar`, req(ctx.staff.contador.token, "POST", { xml: catalogoXml(), confirmar: true }));
    expect(conf.status).toBe(200);
    expect(await json<{ confirmado: boolean; agregadas: number; actualizadas: number }>(conf)).toMatchObject({ confirmado: true, agregadas: CATALOGO_ANEXO24_BASE.length, actualizadas: 0 });
    const despues = (await ctx.libroRepo.listarCuentas(ctx.propertyId)).datos;
    expect(despues).toHaveLength(antes + CATALOGO_ANEXO24_BASE.length);
    expect(despues.find((c) => c.codigo === "1101")).toMatchObject({ nivel: 3, cuentaPadre: "1100", codigoAgrupador: "102.01" });
    expect(despues.find((c) => c.codigo === "1020000")).toBeDefined(); // lo que el XML no menciona sigue ahí
    expect(ctx.auditSink.entries.some((e) => e.action === "despachos.libro:importar-catalogo")).toBe(true);
    const otraVez = await json<{ nuevas: number; actualizadas: number }>(await app.request(`${base()}/catalogo/importar`, req(ctx.staff.contador.token, "POST", { xml: catalogoXml() })));
    expect(otraVez).toMatchObject({ nuevas: 0, actualizadas: CATALOGO_ANEXO24_BASE.length });
  });

  it("reporta las cuentas que no puede importar con su motivo y no las importa", async () => {
    await sembrarFicha();
    const xml = catalogoXml().replace('NumCta="1000"', 'NumCta="1-000"');
    const r = await json<{ rechazadasTotal: number; rechazadas: { numCta: string; motivo: string }[] }>(await buildApp(ctx.deps).request(`${base()}/catalogo/importar`, req(ctx.staff.contador.token, "POST", { xml })));
    expect(r.rechazadasTotal).toBeGreaterThanOrEqual(3); // la cuenta y sus hijas
    expect(r.rechazadas[0]).toMatchObject({ numCta: "1-000", motivo: expect.stringMatching(/numérico/) });
  });

  it("XML malicioso o inválido se rechaza con 400 y NO toca el libro", async () => {
    await sembrarFicha();
    const app = buildApp(ctx.deps);
    const intento = (xml: unknown, confirmar = true) => app.request(`${base()}/catalogo/importar`, req(ctx.staff.contador.token, "POST", { xml, confirmar }));
    const buena = catalogoXml();
    const malos: unknown[] = [
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>\n${buena.split("\n").slice(1).join("\n").replace('Desc="ACTIVO"', 'Desc="&xxe;"')}`,
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]>\n${buena.split("\n").slice(1).join("\n")}`,
      buena.replace('encoding="UTF-8"', 'encoding="ISO-8859-1"'),
      "<catalogocuentas:Catalogo>",
      "no es xml",
      "",
      42,
      buena.replace("</catalogocuentas:Catalogo>", `<!-- ${"x".repeat(2 * 1024 * 1024 + 10)} --></catalogocuentas:Catalogo>`),
    ];
    for (const xml of malos) expect((await intento(xml)).status, String(xml).slice(0, 60)).toBe(400);
    expect((await ctx.libroRepo.listarCuentas(ctx.propertyId)).datos).toHaveLength(0);
    expect((await app.request(`${base()}/catalogo/importar`, req(ctx.staff.contador.token, "POST", { xml: buena, confirmar: "si" }))).status).toBe(400);
  });

  it("el catálogo de OTRO contribuyente (RFC distinto) se rechaza con 409; sin ficha también", async () => {
    const app = buildApp(ctx.deps);
    expect((await app.request(`${base()}/catalogo/importar`, req(ctx.staff.contador.token, "POST", { xml: catalogoXml() }))).status).toBe(409);
    await sembrarFicha();
    const r = await app.request(`${base()}/catalogo/importar`, req(ctx.staff.contador.token, "POST", { xml: catalogoXml("OTR010101OT1"), confirmar: true }));
    expect(r.status).toBe(409);
    expect((await ctx.libroRepo.listarCuentas(ctx.propertyId)).datos).toHaveLength(0);
  });
});

describe("importación de la balanza del proveedor anterior como póliza de apertura", () => {
  const lin = (cuenta: string, saldoInicial: string, naturaleza: "D" | "A") => ({ cuenta, descripcion: cuenta, nivel: 3, naturaleza, saldoInicial, debe: "0.00", haber: "0.00", saldoFinal: saldoInicial });
  const balanzaXml = (lineas: ReturnType<typeof lin>[], mes = 7, rfc = RFC) => generarXmlBalanza(lineas, { rfc, ejercicio: 2026, mes });

  async function prepararCatalogo(app: ReturnType<typeof buildApp>) {
    await sembrarFicha();
    await app.request(`${base()}/catalogo/importar`, req(ctx.staff.contador.token, "POST", { xml: generarXmlCatalogo(CATALOGO_ANEXO24_BASE, { rfc: RFC, ejercicio: 2026, mes: 7 }), confirmar: true }));
  }

  it("vista previa, confirmación y póliza de apertura fechada el último día del mes anterior; el saldo inicial aparece en la balanza", async () => {
    const app = buildApp(ctx.deps);
    await prepararCatalogo(app);
    const xml = balanzaXml([lin("1101", "1000.00", "D"), lin("3100", "1000.00", "A")]);
    const previa = await json<{ confirmado: boolean; fecha: string; partidas: number; totalCentavos: number }>(await app.request(`${base()}/apertura/importar`, req(ctx.staff.contador.token, "POST", { xml })));
    expect(previa).toMatchObject({ confirmado: false, fecha: "2026-06-30", partidas: 2, totalCentavos: 100000 });
    expect((await ctx.libroRepo.listarPolizas(ctx.propertyId, { ejercicio: 2026, limit: 50, offset: 0 })).datos).toHaveLength(0);

    const conf = await app.request(`${base()}/apertura/importar`, req(ctx.staff.contador.token, "POST", { xml, confirmar: true }));
    expect(conf.status).toBe(201);
    const polizas = (await ctx.libroRepo.listarPolizas(ctx.propertyId, { ejercicio: 2026, mes: 6, limit: 50, offset: 0 })).datos;
    expect(polizas).toHaveLength(1);
    expect(polizas[0]).toMatchObject({ tipo: "diario", fecha: "2026-06-30", totalCentavos: 100000 });
    const balanza = (await ctx.libroRepo.balanza(ctx.propertyId, 2026, 7)).datos;
    expect(balanza.find((l) => l.cuenta === "1101")?.saldoInicialCentavos).toBe(100000);
    expect(ctx.auditSink.entries.some((e) => e.action === "despachos.libro:importar-apertura")).toBe(true);
    // No se vuelve a registrar la misma apertura.
    expect((await app.request(`${base()}/apertura/importar`, req(ctx.staff.contador.token, "POST", { xml, confirmar: true }))).status).toBe(409);
  });

  it("no hay apertura si faltan cuentas en el catálogo, la balanza no cuadra o es del mes 13", async () => {
    const app = buildApp(ctx.deps);
    await prepararCatalogo(app);
    const intento = (xml: string) => app.request(`${base()}/apertura/importar`, req(ctx.staff.contador.token, "POST", { xml, confirmar: true }));
    const faltante = await intento(balanzaXml([lin("1101", "10.00", "D"), lin("9999", "10.00", "A")]));
    expect(faltante.status).toBe(409);
    expect(await json<{ code: string; cuentasFaltantes: string[] }>(faltante)).toMatchObject({ code: "apertura_no_posible", cuentasFaltantes: ["9999"] });
    expect((await intento(balanzaXml([lin("1101", "10.00", "D"), lin("3100", "9.99", "A")]))).status).toBe(409);
    expect((await intento(balanzaXml([lin("1101", "10.00", "D"), lin("3100", "10.00", "A")], 13))).status).toBe(409);
    expect((await ctx.libroRepo.listarPolizas(ctx.propertyId, { ejercicio: 2026, limit: 50, offset: 0 })).datos).toHaveLength(0);
  });

  it("XML malicioso o de otro contribuyente se rechaza", async () => {
    const app = buildApp(ctx.deps);
    await prepararCatalogo(app);
    const bueno = balanzaXml([lin("1101", "10.00", "D"), lin("3100", "10.00", "A")]);
    const intento = (xml: string) => app.request(`${base()}/apertura/importar`, req(ctx.staff.contador.token, "POST", { xml, confirmar: true }));
    expect((await intento(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE x [<!ENTITY a "b">]>\n${bueno.split("\n").slice(1).join("\n")}`)).status).toBe(400);
    expect((await intento(bueno.replace('TipoEnvio="N"', 'TipoEnvio="Z"'))).status).toBe(400);
    expect((await intento(balanzaXml([lin("1101", "10.00", "D"), lin("3100", "10.00", "A")], 7, "OTR010101OT1"))).status).toBe(409);
    expect((await ctx.libroRepo.listarPolizas(ctx.propertyId, { ejercicio: 2026, limit: 50, offset: 0 })).datos).toHaveLength(0);
  });
});

async function sembrarCfdiRecibido(parcial: Partial<NewInvoiceInput>) {
  return ctx.despachosRepo.insertInvoice({
    organizationId: ctx.organizationId, propertyId: ctx.propertyId, folioFiscal: randomUUID(), tipo: "I", rfcEmisor: "PFI010101PF1", rfcReceptor: RFC, emisorNombre: null,
    subtotal: 10000, total: 9533.33, iva: 1600, descuento: 0, categoria: "honorarios", valido: true, issues: [], warnings: [], requiresHumanReview: false,
    diot: { reportable: false } as NewInvoiceInput["diot"], fecha: "2026-07-10", direccion: "recibido", metodoPago: "PUE", moneda: "MXN", subtotalCentavos: 1_000_000, descuentoCentavos: 0,
    totalCentavos: 953_333, ivaTrasladadoCentavos: 160_000, isrRetenidoCentavos: 100_000, ivaRetenidoCentavos: 106_667, ...parcial,
  });
}

describe("póliza de un CFDI con retenciones o IEPS", () => {
  it("honorarios de persona física: la póliza lleva ISR e IVA retenidos por pagar y cuadra; las cuentas nuevas se agregan al catálogo del cliente", async () => {
    const app = buildApp(ctx.deps);
    await app.request(`${base()}/catalogo/sembrar`, req(ctx.staff.admin.token, "POST", {}));
    const f = await sembrarCfdiRecibido({});
    const r = await app.request(`${base()}/polizas/desde-cfdi`, req(ctx.staff.contador.token, "POST", { invoiceId: f.id }));
    expect(r.status).toBe(201);
    const { polizaId } = await json<{ polizaId: string }>(r);
    const p = await json<{ movimientos: { cuenta: string; debeCentavos: number; haberCentavos: number }[] }>(await app.request(`${base()}/polizas/${polizaId}`, req(ctx.staff.readonly.token, "GET")));
    expect(p.movimientos.map((m) => [m.cuenta, m.debeCentavos, m.haberCentavos])).toEqual([
      ["6020100", 1_000_000, 0], ["2600300", 160_000, 0], ["2010000", 0, 953_333], ["2600600", 0, 100_000], ["2600700", 0, 106_667],
    ]);
  });

  it("un cliente con el catálogo de antes (sin las cuentas de retenidos) recibe esas cuentas al contabilizar", async () => {
    const app = buildApp(ctx.deps);
    await ctx.libroRepo.sembrarCatalogo(ctx.propertyId, construirCatalogoBase().filter((c) => !["2600600", "2600700"].includes(c.codigo)));
    const f = await sembrarCfdiRecibido({});
    expect((await app.request(`${base()}/polizas/desde-cfdi`, req(ctx.staff.contador.token, "POST", { invoiceId: f.id }))).status).toBe(201);
    const codigos = (await ctx.libroRepo.listarCuentas(ctx.propertyId)).datos.map((c) => c.codigo);
    expect(codigos).toContain("2600600");
  });

  it("arrendamiento: el staff elige la cuenta de rentas; con IEPS acreditable va a su cuenta; opciones inválidas -> 400", async () => {
    const app = buildApp(ctx.deps);
    await app.request(`${base()}/catalogo/sembrar`, req(ctx.staff.admin.token, "POST", {}));
    const f = await sembrarCfdiRecibido({ categoria: "gasto_operativo", subtotalCentavos: 100000, ivaTrasladadoCentavos: 17280, isrRetenidoCentavos: 0, ivaRetenidoCentavos: 0, iepsCentavos: 8000, totalCentavos: 125280 });
    expect((await app.request(`${base()}/polizas/desde-cfdi`, req(ctx.staff.contador.token, "POST", { invoiceId: f.id, cuentaGasto: "12" }))).status).toBe(400);
    expect((await app.request(`${base()}/polizas/desde-cfdi`, req(ctx.staff.contador.token, "POST", { invoiceId: f.id, tratamientoIeps: "otro" }))).status).toBe(400);
    const r = await app.request(`${base()}/polizas/desde-cfdi`, req(ctx.staff.contador.token, "POST", { invoiceId: f.id, cuentaGasto: "6020400", tratamientoIeps: "acreditable" }));
    expect(r.status).toBe(201);
    const { polizaId } = await json<{ polizaId: string }>(r);
    const p = await json<{ movimientos: { cuenta: string; debeCentavos: number }[] }>(await app.request(`${base()}/polizas/${polizaId}`, req(ctx.staff.readonly.token, "GET")));
    expect(p.movimientos.map((m) => m.cuenta)).toEqual(["6020400", "2600300", "2600320", "2010000"]);
  });

  it("el listado de CFDI del periodo ya marca como armable el CFDI con retenciones", async () => {
    const app = buildApp(ctx.deps);
    await sembrarCfdiRecibido({});
    const r = await json<{ cfdi: { armable: boolean; motivo: string | null }[] }>(await app.request(`${base()}/cfdi?periodo=2026-07`, req(ctx.staff.readonly.token, "GET")));
    expect(r.cfdi[0]).toMatchObject({ armable: true, motivo: null });
  });

  it("un total que no cuadra con base + IVA + IEPS - retenciones se reporta como motivo (409) y no se contabiliza", async () => {
    const app = buildApp(ctx.deps);
    const f = await sembrarCfdiRecibido({ totalCentavos: 953_334 });
    const r = await app.request(`${base()}/polizas/desde-cfdi`, req(ctx.staff.contador.token, "POST", { invoiceId: f.id }));
    expect(r.status).toBe(409);
  });
});

describe("pólizas de cobro / pago de un complemento de pago (REP)", () => {
  const REP = "22222222-2222-2222-2222-222222222222";
  const pago = (parcial: Partial<PagoRepContable> = {}): PagoRepContable => ({
    pagoId: randomUUID(), folioFiscalRep: REP, pagoIndex: 0, fechaPago: "2026-07-28", flujo: "trasladado", numParcialidad: 1, importePagadoCentavos: 58000, baseCentavos: 50000, ivaCentavos: 8000,
    ivaRetenidoCentavos: 0, folioFiscalCfdi: "11111111-1111-1111-1111-111111111111", direccionCfdi: "emitido", metodoPagoCfdi: "PPD", monedaCfdi: "MXN", estadoSatCfdi: "vigente", ...parcial,
  });

  it("lista los pagos con su póliza y si se pueden contabilizar; desde-rep registra, y no duplica", async () => {
    const app = buildApp(ctx.deps);
    const p1 = pago();
    const p2 = pago({ pagoIndex: 1, numParcialidad: 2, fechaPago: "2026-07-30", metodoPagoCfdi: "PUE" });
    ctx.libroRepo.agregarPagoRep(ctx.propertyId, p1);
    ctx.libroRepo.agregarPagoRep(ctx.propertyId, p2);
    const lista = await json<{ pagos: { pagoId: string; armable: boolean; motivo: string | null; poliza: unknown }[] }>(await app.request(`${base()}/pagos-rep?periodo=2026-07`, req(ctx.staff.readonly.token, "GET")));
    expect(lista.pagos.map((p) => p.armable)).toEqual([true, false]);
    expect(lista.pagos[1]!.motivo).toMatch(/PPD/);

    const r = await app.request(`${base()}/polizas/desde-rep`, req(ctx.staff.contador.token, "POST", { folioFiscalRep: REP }));
    expect(r.status).toBe(201);
    const cuerpo = await json<{ registradas: number; resultados: { pagoId: string; estado: string }[] }>(r);
    expect(cuerpo.registradas).toBe(1);
    expect(cuerpo.resultados.map((x) => x.estado)).toEqual(["registrada", "omitida"]);
    const balanza = (await ctx.libroRepo.balanza(ctx.propertyId, 2026, 7)).datos;
    expect(balanza.find((l) => l.cuenta === "2600410")?.saldoFinalCentavos).toBe(8000);
    expect(balanza.reduce((s, l) => s + l.debeCentavos, 0)).toBe(balanza.reduce((s, l) => s + l.haberCentavos, 0));

    const otra = await app.request(`${base()}/polizas/desde-rep`, req(ctx.staff.contador.token, "POST", { folioFiscalRep: REP }));
    expect(otra.status).toBe(200);
    expect((await json<{ resultados: { estado: string }[] }>(otra)).resultados.map((x) => x.estado)).toEqual(["ya_existia", "omitida"]);
    const despues = await json<{ pagos: { poliza: { folio: number } | null }[] }>(await app.request(`${base()}/pagos-rep?folioFiscalRep=${REP}`, req(ctx.staff.readonly.token, "GET")));
    expect(despues.pagos[0]!.poliza).toMatchObject({ folio: 1 });
    expect(ctx.auditSink.entries.some((e) => e.action === "despachos.libro:poliza-desde-rep")).toBe(true);
  });

  it("pago (recibido): póliza de egreso; un pago por id; periodo cerrado se reporta por pago sin tumbar los demás", async () => {
    const app = buildApp(ctx.deps);
    const recibido = pago({ flujo: "acreditable", direccionCfdi: "recibido", fechaPago: "2026-07-29" });
    const cerrado = pago({ pagoIndex: 1, fechaPago: "2026-06-15" });
    ctx.libroRepo.agregarPagoRep(ctx.propertyId, recibido);
    ctx.libroRepo.agregarPagoRep(ctx.propertyId, cerrado);
    ctx.libroRepo.periodosCerrados.add(`${ctx.propertyId}|2026-06`);
    const r = await app.request(`${base()}/polizas/desde-rep`, req(ctx.staff.contador.token, "POST", { folioFiscalRep: REP }));
    const cuerpo = await json<{ registradas: number; resultados: { estado: string; motivo?: string }[] }>(r);
    expect(cuerpo.resultados.map((x) => x.estado)).toEqual(["error", "registrada"]); // ordenados por fecha de pago: junio (cerrado) y luego julio
    expect(cuerpo.resultados[0]!.motivo).toMatch(/cerrado/);
    const uno = await app.request(`${base()}/polizas/desde-rep`, req(ctx.staff.contador.token, "POST", { folioFiscalRep: REP, pagoId: recibido.pagoId }));
    expect((await json<{ resultados: { estado: string }[] }>(uno)).resultados.map((x) => x.estado)).toEqual(["ya_existia"]);
  });

  it("validaciones: UUID del REP, pago inexistente, cuenta de bancos; roles", async () => {
    const app = buildApp(ctx.deps);
    ctx.libroRepo.agregarPagoRep(ctx.propertyId, pago());
    const post = (body: unknown, token = ctx.staff.contador.token) => app.request(`${base()}/polizas/desde-rep`, req(token, "POST", body));
    expect((await post({})).status).toBe(400);
    expect((await post({ folioFiscalRep: "no-es-uuid" })).status).toBe(400);
    expect((await post({ folioFiscalRep: REP, pagoId: "x" })).status).toBe(400);
    expect((await post({ folioFiscalRep: REP, cuentaBancos: "12" })).status).toBe(400);
    expect((await post({ folioFiscalRep: "33333333-3333-3333-3333-333333333333" })).status).toBe(404);
    expect((await post({ folioFiscalRep: REP }, ctx.staff.readonly.token)).status).toBe(403);
    expect((await post({ folioFiscalRep: REP, cuentaBancos: "1020100" })).status).toBe(201);
    expect((await app.request(`${base()}/pagos-rep?folioFiscalRep=zzz`, req(ctx.staff.readonly.token, "GET"))).status).toBe(400);
  });
});

describe("base sin la migración 028", () => {
  it("las lecturas nuevas devuelven vacío honesto y las escrituras 503; nunca 500", async () => {
    await sembrarFicha();
    ctx.libroRepo.disponible = false;
    const app = buildApp(ctx.deps);
    expect(await json<{ estado: string; pagos: unknown[] }>(await app.request(`${base()}/pagos-rep?periodo=2026-07`, req(ctx.staff.readonly.token, "GET")))).toEqual({ estado: "no_disponible", pagos: [] });
    const posts: Array<[string, unknown]> = [
      ["catalogo/agrupadores", { asignaciones: [{ codigo: "1050000", codigoAgrupador: "105" }] }],
      ["catalogo/agrupadores/proponer", {}],
      ["catalogo/importar", { xml: generarXmlCatalogo(CATALOGO_ANEXO24_BASE, { rfc: RFC, ejercicio: 2026, mes: 7 }) }],
      ["polizas/desde-rep", { folioFiscalRep: "22222222-2222-2222-2222-222222222222" }],
    ];
    for (const [ruta, body] of posts) expect((await app.request(`${base()}/${ruta}`, req(ctx.staff.contador.token, "POST", body))).status, ruta).toBe(503);
    expect((await app.request(`${base()}/contabilidad-electronica/polizas?periodo=2026-07&tipoSolicitud=DE&numTramite=AB123456789012`, req(ctx.staff.admin.token, "GET"))).status).toBe(503);
  });
});

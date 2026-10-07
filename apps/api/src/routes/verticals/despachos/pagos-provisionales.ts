// D-25 -- pagos provisionales de ISR e IVA por flujo de efectivo (migración 020), alimentados por los CFDI emitidos/recibidos (D-22) y
// los pagos del complemento de pago 2.0 persistidos (D-23). SIN llamadas al SAT ni a un PAC: es un papel de trabajo para el contador.
//
//  GET  /despachos/:propertyId/pagos-provisionales/:periodo            papel calculado en vivo (con los parámetros guardados)
//  POST /despachos/:propertyId/pagos-provisionales/:periodo/calcular   calcula con parámetros nuevos (no guarda)
//  PUT  /despachos/:propertyId/pagos-provisionales/:periodo            calcula con parámetros y GUARDA el borrador (ISR si se pudo, e IVA)
//  POST /despachos/:propertyId/pagos-provisionales/:periodo/presentar  marca el papel como presentado (monto pagado y fecha) y cierra el vencimiento
//  GET  /despachos/:propertyId/pagos-provisionales/:periodo/exportar?formato=pdf|xlsx
//  POST /despachos/:propertyId/pagos-provisionales/rep                 registra los pagos de un complemento de pago (REP) sobre CFDI PPD
//
// Autorización: ver = VER_PAGOS_PROVISIONALES_ROLES; escribir = GESTIONAR_PAGOS_PROVISIONALES_ROLES. Cada escritura deja bitácora.
// Compatibilidad con la base sin migrar: sin el modelo CFDI completo (018) el cálculo responde 503 "no disponible aún"; sin la 020
// el papel se calcula pero los PPD quedan excluidos con su aviso y guardar/presentar/registrar REP responden 503. Nunca un 500.
import { Hono } from "hono";
import type { Context } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { CfdiXmlParseError, parseComplementoPagoXml } from "@atiende/billing";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import type { TenantDbSession } from "@atiende/core-tenancy";
import {
  GESTIONAR_PAGOS_PROVISIONALES_ROLES,
  PagosDatosInvalidosError,
  PagosNoDisponiblesError,
  PagosNoEncontradoError,
  PagosSinPermisoError,
  PapelYaPresentadoError,
  PostgresCarteraRepository,
  PostgresPagosProvisionalesRepository,
  REGIMENES_ISR_SOPORTADOS,
  RepRfcAjenoError,
  VER_PAGOS_PROVISIONALES_ROLES,
  analizarComplementoPago,
  calcularPapelProvisional,
  coeficienteAMicros,
  construirReportePagosProvisionales,
  esFechaValida,
  prepararPagosDesdeRep,
  reporteAXlsx,
  XLSX_CONTENT_TYPE,
} from "@atiende/domain-despachos";
import type { CarteraRepository, ClienteFichaRecord, FacturaLigable, FacturaParaPago, PagosProvisionalesRepository, PapelGuardado, PapelProvisional } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { auditarAccesoDespachos } from "./auditoria-acceso.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { reporteAPdf } from "./reporte-pdf.ts";
import { resolverZonaHorariaDespachosProperty } from "./zona-horaria.ts";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_REP_BODY_BYTES = 640 * 1024;
const MAX_XML_BYTES = 512 * 1024;
const PERIODO_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Tope de un monto capturado: $10,000,000,000.00 (en centavos). */
const MAX_CENTAVOS = 1_000_000_000_000;

export function traducirPagos(err: unknown): never {
  if (err instanceof PagosNoDisponiblesError) throw Errors.serviceUnavailable(err.message);
  if (err instanceof PagosSinPermisoError) throw Errors.forbidden(err.message);
  if (err instanceof PapelYaPresentadoError) throw Errors.conflict(err.message);
  if (err instanceof PagosNoEncontradoError) throw Errors.notFound(err.message);
  if (err instanceof PagosDatosInvalidosError) throw Errors.validation(err.message);
  throw err;
}

export interface ParametrosCapturados {
  coeficienteUtilidad?: string | null;
  perdidasPendientesCentavos?: number | null;
  ajustePagosPreviosCentavos?: number | null;
  saldoFavorAnteriorCentavos?: number | null;
}

function centavosOpcional(valor: unknown, campo: string): number | null {
  if (valor === undefined || valor === null || valor === "") return null;
  if (typeof valor !== "number" || !Number.isSafeInteger(valor) || valor < 0 || valor > MAX_CENTAVOS) throw Errors.validation(`${campo}: centavos enteros entre 0 y ${MAX_CENTAVOS}.`);
  return valor;
}

/** Parámetros del cuerpo, validados (un decimal en centavos o un coeficiente mal formado se rechaza, nunca se redondea). */
function leerParametros(raw: Record<string, unknown>): ParametrosCapturados {
  const out: ParametrosCapturados = {};
  if (raw.coeficienteUtilidad !== undefined && raw.coeficienteUtilidad !== null && raw.coeficienteUtilidad !== "") {
    if (typeof raw.coeficienteUtilidad !== "string" || coeficienteAMicros(raw.coeficienteUtilidad) === null) throw Errors.validation("coeficienteUtilidad: decimal de 0 a 9.999999 con hasta 6 decimales (p. ej. 0.234567).");
    out.coeficienteUtilidad = raw.coeficienteUtilidad.trim();
  }
  const perdidas = centavosOpcional(raw.perdidasPendientesCentavos, "perdidasPendientesCentavos");
  if (perdidas !== null) out.perdidasPendientesCentavos = perdidas;
  const ajuste = centavosOpcional(raw.ajustePagosPreviosCentavos, "ajustePagosPreviosCentavos");
  if (ajuste !== null) out.ajustePagosPreviosCentavos = ajuste;
  const saldo = centavosOpcional(raw.saldoFavorAnteriorCentavos, "saldoFavorAnteriorCentavos");
  if (saldo !== null) out.saldoFavorAnteriorCentavos = saldo;
  return out;
}

/** Parámetros guardados en los papeles del mes (ISR e IVA) para usarlos como valor por defecto. */
function parametrosGuardados(papeles: readonly PapelGuardado[], mes: number): ParametrosCapturados {
  const del = (imp: string) => papeles.find((p) => p.mes === mes && p.impuesto === imp)?.parametros ?? {};
  const isr = del("ISR");
  const iva = del("IVA");
  const out: ParametrosCapturados = {};
  if (typeof isr.coeficienteUtilidad === "string") out.coeficienteUtilidad = isr.coeficienteUtilidad;
  if (typeof isr.perdidasPendientesCentavos === "number") out.perdidasPendientesCentavos = isr.perdidasPendientesCentavos;
  if (typeof isr.ajustePagosPreviosCentavos === "number") out.ajustePagosPreviosCentavos = isr.ajustePagosPreviosCentavos;
  if (typeof iva.saldoFavorAnteriorCentavos === "number") out.saldoFavorAnteriorCentavos = iva.saldoFavorAnteriorCentavos;
  return out;
}

/** Resultado de registrar un complemento de pago (REP) como pagos de los CFDI PPD que liquida. */
export interface RegistroRepResultado {
  readonly folioFiscalRep: string;
  readonly flujo: string;
  readonly registrados: number;
  readonly yaExistian: number;
  readonly omitidos: readonly { readonly idDocumento: string; readonly motivo: string }[];
  readonly rechazados: readonly { readonly idDocumento: string; readonly motivo: string }[];
  readonly advertencias: readonly string[];
}

const repoDe = (deps: AppDeps, db: TenantDbSession): PagosProvisionalesRepository => (deps.pagosProvisionalesRepo ? deps.pagosProvisionalesRepo(db) : new PostgresPagosProvisionalesRepository(db));
const carteraDe = (deps: AppDeps, db: TenantDbSession): CarteraRepository => (deps.carteraRepo ? deps.carteraRepo(db) : new PostgresCarteraRepository(db));

/**
 * Ingesta de un REP (D-23/D-25): parsea, liga cada DoctoRelacionado a las facturas del despacho y registra los pagos. UNA sola
 * implementación para `POST .../pagos-provisionales/rep` y para la carga masiva de CFDI (`cfdi-lote.ts`). El RFC del contribuyente
 * sale de la ficha del cliente. Lanza `ApiError` (validación/conflicto) igual que la ruta; el llamador decide el rol requerido.
 */
export async function registrarRepDespachos(deps: AppDeps, db: TenantDbSession, organizationId: string, propertyId: string, xml: string): Promise<RegistroRepResultado> {
  // El RFC del contribuyente sale de la FICHA del cliente (nunca del cuerpo): decide si el flujo es trasladado o acreditable.
  const ficha = await carteraDe(deps, db).obtenerFicha(propertyId);
  if (!ficha) throw Errors.conflict("Captura la ficha del cliente (RFC) en Cartera antes de registrar complementos de pago.");

  let rep;
  try {
    rep = parseComplementoPagoXml(xml);
  } catch (err) {
    if (err instanceof CfdiXmlParseError) throw Errors.validation(err.message);
    throw err;
  }
  const despachos = deps.despachosRepo(db);
  const ids = [...new Set(rep.pagos.flatMap((p) => p.documentos.map((d) => d.idDocumento)))].filter((id) => UUID_RE.test(id));
  const ligables = new Map<string, FacturaLigable>();
  const paraPago = new Map<string, FacturaParaPago>();
  for (const id of ids) {
    const inv = await despachos.findInvoiceByFolioFiscal(organizationId, id);
    if (!inv || inv.propertyId !== propertyId) continue;
    const total = inv.totalCentavos ?? Math.round(inv.total * 100);
    ligables.set(id, { folioFiscal: inv.folioFiscal, rfcEmisor: inv.rfcEmisor, rfcReceptor: inv.rfcReceptor, totalCentavos: total, ivaCentavos: inv.ivaTrasladadoCentavos ?? (inv.iva === null ? null : Math.round(inv.iva * 100)), metodoPago: inv.metodoPago ?? null });
    paraPago.set(id, { id: inv.id, subtotalCentavos: inv.subtotalCentavos ?? Math.round(inv.subtotal * 100), descuentoCentavos: inv.descuentoCentavos ?? Math.round(inv.descuento * 100), totalCentavos: total });
  }
  let analisis;
  try {
    analisis = analizarComplementoPago(rep, ficha.rfc, ligables);
  } catch (err) {
    if (err instanceof RepRfcAjenoError) throw Errors.validation("El RFC del cliente no es ni el emisor ni el receptor del complemento de pago.");
    throw err;
  }
  const { aRegistrar, omitidos } = prepararPagosDesdeRep(analisis, paraPago);
  const repo = repoDe(deps, db);
  let registrados = 0;
  let yaExistian = 0;
  const rechazados: { idDocumento: string; motivo: string }[] = [];
  for (const p of aRegistrar) {
    try {
      // Un pago a la vez; cada llamada corre en su propio SAVEPOINT, así que un rechazo (p. ej. sobrepago) no tumba la transacción.
      if (await repo.registrarPago(propertyId, p)) registrados += 1;
      else yaExistian += 1;
    } catch (err) {
      if (err instanceof PagosDatosInvalidosError || err instanceof PagosNoEncontradoError) {
        rechazados.push({ idDocumento: ids.find((id) => paraPago.get(id)?.id === p.invoiceId) ?? p.invoiceId, motivo: err.message });
      } else return traducirPagos(err);
    }
  }
  return { folioFiscalRep: analisis.folioFiscalRep, flujo: analisis.flujo, registrados, yaExistian, omitidos, rechazados, advertencias: analisis.advertencias };
}

export interface ContextoPapelProvisional {
  readonly ficha: ClienteFichaRecord;
  readonly regimen: string;
  readonly papel: PapelProvisional;
  readonly guardados: readonly PapelGuardado[];
  readonly papelesDisponibles: boolean;
  readonly parametros: ParametrosCapturados;
}

/**
 * Calcula el papel de un periodo (ISR e IVA) con los parametros guardados + los capturados. UNA sola implementacion para las rutas de pagos
 * provisionales y para la pre-generacion al cerrar el periodo (cierre-mensual.ts). Lanza `ApiError` (conflicto/validacion/503) igual que la ruta.
 */
export async function calcularPapelPeriodo(deps: AppDeps, db: TenantDbSession, propertyId: string, ejercicio: number, mes: number, capturados: ParametrosCapturados, regimenSolicitado: string | undefined): Promise<ContextoPapelProvisional> {
  const ficha = await carteraDe(deps, db).obtenerFicha(propertyId);
  if (!ficha) throw Errors.conflict("Captura la ficha del cliente (RFC y régimen fiscal) en Cartera antes de calcular pagos provisionales.");
  let regimen = regimenSolicitado;
  if (regimen !== undefined && !ficha.regimenesFiscales.includes(regimen)) throw Errors.validation(`regimen: el cliente no tiene el régimen ${regimen} en su ficha (${ficha.regimenesFiscales.join(", ")}).`);
  regimen ??= ficha.regimenesFiscales.find((r) => (REGIMENES_ISR_SOPORTADOS as readonly string[]).includes(r)) ?? ficha.regimenesFiscales[0]!;

  const repo = repoDe(deps, db);
  // Secuencial a propósito: una sola transacción compartida por request (nunca Promise.all sobre la sesión).
  const base = await repo.leerBase(propertyId, ejercicio, mes);
  if (!base.facturasDisponibles) throw Errors.serviceUnavailable("Los pagos provisionales aún no están disponibles en esta base: falta aplicar la migración 018 (CFDI completo, emitido/recibido).");
  if (base.truncado) throw Errors.conflict("El ejercicio tiene más de 20,000 CFDI: no se calcula un papel incompleto. Divide el trabajo por cliente o contacta a soporte.");
  const lectura = await repo.listarPapeles(propertyId, ejercicio);
  const guardados = lectura.papeles;

  const pagosPrevios = guardados.filter((p) => p.impuesto === "ISR" && p.estado === "presentado" && p.mes < mes).reduce((s, p) => s + (p.montoPagadoCentavos ?? 0), 0);
  const ivaAnterior = guardados.find((p) => p.impuesto === "IVA" && p.estado === "presentado" && p.mes === mes - 1);
  const parametros: ParametrosCapturados = { ...parametrosGuardados(guardados, mes), ...capturados };
  const papel = calcularPapelProvisional({
    ejercicio,
    mes,
    regimen,
    rfc: ficha.rfc,
    facturas: base.facturas,
    pagos: base.pagos,
    pagosDisponibles: base.pagosDisponibles,
    isr: { coeficienteUtilidad: parametros.coeficienteUtilidad ?? null, perdidasPendientesCentavos: parametros.perdidasPendientesCentavos ?? null, ajustePagosPreviosCentavos: parametros.ajustePagosPreviosCentavos ?? null },
    iva: { saldoFavorAnteriorCentavos: parametros.saldoFavorAnteriorCentavos ?? null },
    pagosPreviosIsrPresentadosCentavos: pagosPrevios,
    saldoFavorIvaMesAnteriorCentavos: ivaAnterior ? ivaAnterior.aFavorCentavos : null,
  });
  return { ficha, regimen, papel, guardados, papelesDisponibles: lectura.estado === "disponible", parametros };
}

/** Guarda el borrador (ISR si se pudo calcular, e IVA) del papel ya calculado. Mismo cuerpo que `PUT .../pagos-provisionales/:periodo`; no presenta nada. */
export async function guardarBorradorPapel(deps: AppDeps, db: TenantDbSession, propertyId: string, x: ContextoPapelProvisional, ejercicio: number, mes: number): Promise<{ isr: boolean; iva: boolean }> {
  const repo = repoDe(deps, db);
  const guardado: { isr: boolean; iva: boolean } = { isr: false, iva: false };
  try {
    if (x.papel.isr.estado === "calculado") {
      await repo.guardarPapel(propertyId, {
        ejercicio, mes, impuesto: "ISR", regimen: x.regimen,
        baseCentavos: x.papel.isr.baseCentavos, determinadoCentavos: x.papel.isr.determinadoCentavos, acreditableCentavos: x.papel.isr.acreditableCentavos,
        aCargoCentavos: x.papel.isr.aCargoCentavos, aFavorCentavos: x.papel.isr.aFavorCentavos,
        parametros: { regimen: x.regimen, coeficienteUtilidad: x.parametros.coeficienteUtilidad ?? null, perdidasPendientesCentavos: x.parametros.perdidasPendientesCentavos ?? 0, ajustePagosPreviosCentavos: x.parametros.ajustePagosPreviosCentavos ?? 0 },
        advertencias: x.papel.advertencias.length,
      });
      guardado.isr = true;
    }
    await repo.guardarPapel(propertyId, {
      ejercicio, mes, impuesto: "IVA", regimen: x.regimen,
      baseCentavos: x.papel.iva.baseCentavos, determinadoCentavos: x.papel.iva.determinadoCentavos, acreditableCentavos: x.papel.iva.acreditableCentavos,
      aCargoCentavos: x.papel.iva.aCargoCentavos, aFavorCentavos: x.papel.iva.aFavorCentavos,
      parametros: { saldoFavorAnteriorCentavos: x.parametros.saldoFavorAnteriorCentavos ?? 0 },
      advertencias: x.papel.advertencias.length,
    });
    guardado.iva = true;
  } catch (err) {
    return traducirPagos(err);
  }
  return guardado;
}

export function despachosPagosProvisionalesRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  const repoDeApp = (db: TenantDbSession): PagosProvisionalesRepository => repoDe(deps, db);
  const carteraDeApp = (db: TenantDbSession): CarteraRepository => carteraDe(deps, db);

  app.use("/despachos/:propertyId/pagos-provisionales/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  async function auditar(c: Context<CoreAuthHonoEnv>, action: string, metadata: Record<string, unknown>): Promise<void> {
    await deps.despachosAuditSink.record({
      at: new Date().toISOString(),
      actorUserId: c.get("userId"),
      actorEmail: c.get("userEmail") ?? null,
      organizationId: c.get("organizationId"),
      action,
      route: c.req.path,
      method: c.req.method,
      decision: "allowed",
      metadata,
    });
  }

  function leerPeriodo(c: Context<CoreAuthHonoEnv>): { ejercicio: number; mes: number; periodo: string } {
    const periodo = c.req.param("periodo") ?? "";
    const m = PERIODO_RE.exec(periodo);
    if (!m) throw Errors.validation("periodo: se esperaba el formato YYYY-MM.");
    return { ejercicio: Number(m[1]), mes: Number(m[2]), periodo };
  }

  type Contexto = ContextoPapelProvisional;

  /** Calcula el papel de un periodo. `parametros` = lo capturado en esta petición (si hay) sobre lo guardado. */
  function calcular(c: Context<CoreAuthHonoEnv>, ejercicio: number, mes: number, capturados: ParametrosCapturados, regimenSolicitado: string | undefined): Promise<Contexto> {
    return calcularPapelPeriodo(deps, c.get("db"), c.req.param("propertyId") ?? "", ejercicio, mes, capturados, regimenSolicitado);
  }

  const respuesta = (x: Contexto, extra: Record<string, unknown> = {}) => ({
    ejercicio: x.papel.ejercicio,
    mes: x.papel.mes,
    cliente: { rfc: x.ficha.rfc, razonSocial: x.ficha.razonSocial, regimenes: x.ficha.regimenesFiscales },
    regimen: x.regimen,
    parametros: x.parametros,
    papel: x.papel,
    guardados: x.guardados.filter((p) => p.mes === x.papel.mes),
    guardadoDisponible: x.papelesDisponibles,
    ...extra,
  });

  app.get("/despachos/:propertyId/pagos-provisionales/:periodo", async (c) => {
    assertVerticalRole(c, VER_PAGOS_PROVISIONALES_ROLES);
    const { ejercicio, mes } = leerPeriodo(c);
    return c.json(respuesta(await calcular(c, ejercicio, mes, {}, c.req.query("regimen"))));
  });

  app.post("/despachos/:propertyId/pagos-provisionales/:periodo/calcular", async (c) => {
    assertVerticalRole(c, VER_PAGOS_PROVISIONALES_ROLES);
    const { ejercicio, mes } = leerPeriodo(c);
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, MAX_BODY_BYTES);
    const regimen = typeof raw.regimen === "string" ? raw.regimen : undefined;
    return c.json(respuesta(await calcular(c, ejercicio, mes, leerParametros(raw), regimen)));
  });

  app.put("/despachos/:propertyId/pagos-provisionales/:periodo", async (c) => {
    assertVerticalRole(c, GESTIONAR_PAGOS_PROVISIONALES_ROLES);
    const { ejercicio, mes, periodo } = leerPeriodo(c);
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, MAX_BODY_BYTES);
    const regimen = typeof raw.regimen === "string" ? raw.regimen : undefined;
    const capturados = leerParametros(raw);
    const x = await calcular(c, ejercicio, mes, capturados, regimen);
    const propertyId = c.req.param("propertyId");
    const repo = repoDeApp(c.get("db"));
    const guardado = await guardarBorradorPapel(deps, c.get("db"), propertyId, x, ejercicio, mes);
    await auditar(c, "despachos.pagos-provisionales:guardar", { propertyId, periodo, regimen: x.regimen, isr: guardado.isr, iva: guardado.iva });
    const lectura = await repo.listarPapeles(propertyId, ejercicio);
    return c.json(respuesta({ ...x, guardados: lectura.papeles, papelesDisponibles: lectura.estado === "disponible" }, { guardado }));
  });

  app.post("/despachos/:propertyId/pagos-provisionales/:periodo/presentar", async (c) => {
    assertVerticalRole(c, GESTIONAR_PAGOS_PROVISIONALES_ROLES);
    const { ejercicio, mes, periodo } = leerPeriodo(c);
    const raw = await readJsonCapped<Record<string, unknown>>(c.req.raw, MAX_BODY_BYTES);
    const impuesto = raw.impuesto;
    if (impuesto !== "ISR" && impuesto !== "IVA") throw Errors.validation("impuesto: ISR o IVA.");
    const monto = centavosOpcional(raw.montoPagadoCentavos, "montoPagadoCentavos");
    if (monto === null) throw Errors.validation("montoPagadoCentavos: monto efectivamente pagado, en centavos enteros (0 si no hubo pago).");
    if (!esFechaValida(raw.fechaPresentacion)) throw Errors.validation("fechaPresentacion: fecha (AAAA-MM-DD) en que se presentó la declaración.");
    const esperado = `${impuesto} ${periodo}`;
    if (raw.confirmacion !== esperado) throw Errors.validation(`confirmacion: escribe "${esperado}" para confirmar. Presentar cierra el vencimiento y ya no se recalcula.`);
    const propertyId = c.req.param("propertyId");
    const hoy = hoyFechaNegocio(await resolverZonaHorariaDespachosProperty(deps.despachosRepo(c.get("db")), propertyId));
    if (raw.fechaPresentacion > hoy) throw Errors.validation("fechaPresentacion: no puede ser una fecha futura.");
    try {
      await repoDeApp(c.get("db")).presentarPapel(propertyId, ejercicio, mes, impuesto, monto, raw.fechaPresentacion);
    } catch (err) {
      return traducirPagos(err);
    }
    await auditar(c, "despachos.pagos-provisionales:presentar", { propertyId, periodo, impuesto, montoPagadoCentavos: monto });
    return c.json({ impuesto, periodo, estado: "presentado", montoPagadoCentavos: monto, fechaPresentacion: raw.fechaPresentacion });
  });

  app.get("/despachos/:propertyId/pagos-provisionales/:periodo/exportar", async (c) => {
    assertVerticalRole(c, VER_PAGOS_PROVISIONALES_ROLES);
    const { ejercicio, mes, periodo } = leerPeriodo(c);
    const formato = c.req.query("formato") ?? "pdf";
    if (formato !== "pdf" && formato !== "xlsx") throw Errors.validation("formato: pdf o xlsx.");
    const x = await calcular(c, ejercicio, mes, {}, c.req.query("regimen"));
    const propertyId = c.req.param("propertyId");
    const hoy = hoyFechaNegocio(await resolverZonaHorariaDespachosProperty(deps.despachosRepo(c.get("db")), propertyId));
    const reporte = construirReportePagosProvisionales(x.papel, { nombre: x.ficha.razonSocial, rfc: x.ficha.rfc, generadoEn: hoy });
    // D-38: export del papel de trabajo (PDF/XLSX) -> fila de bitacora (periodo y formato; sin montos ni RFC).
    await auditarAccesoDespachos(deps, c, { recurso: "pagos_provisionales.papel", tipo: "export", metadata: { periodo, formato } });
    const cabeceras = { "content-disposition": `attachment; filename="pagos-provisionales-${periodo}.${formato}"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
    if (formato === "xlsx") return new Response(reporteAXlsx(reporte), { headers: { ...cabeceras, "content-type": XLSX_CONTENT_TYPE } });
    return new Response(await reporteAPdf(reporte), { headers: { ...cabeceras, "content-type": "application/pdf" } });
  });

  app.post("/despachos/:propertyId/pagos-provisionales/rep", async (c) => {
    assertVerticalRole(c, GESTIONAR_PAGOS_PROVISIONALES_ROLES);
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<{ xml?: unknown }>(c.req.raw, MAX_REP_BODY_BYTES);
    if (typeof raw.xml !== "string" || raw.xml.trim() === "") throw Errors.validation("xml: se esperaba el XML del complemento de pago como texto.");
    if (raw.xml.length > MAX_XML_BYTES) throw Errors.payloadTooLarge();
    const r = await registrarRepDespachos(deps, c.get("db"), c.get("organizationId"), propertyId, raw.xml);
    if (r.registrados > 0) await auditar(c, "despachos.pagos-provisionales:registrar-rep", { propertyId, folioFiscalRep: r.folioFiscalRep, registrados: r.registrados, yaExistian: r.yaExistian });
    return c.json(r, r.registrados > 0 ? 201 : 200);
  });

  return app;
}

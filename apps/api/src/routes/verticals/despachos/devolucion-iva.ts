// Fase 6 (papel de trabajo de devolución de IVA): expone el motor completo de
// `@atiende/domain-despachos` (puerto de `b2b_ai/features/devolucion_iva/`,
// ver domain-despachos/src/devolucion-iva/). Mismo criterio "endpoint puro/
// calculadora" que declaraciones.ts/conciliacion.ts: las facturas/DIOT/
// declaraciones se mandan ya armadas (o, para la DIOT, se reconstruyen desde
// los invoices YA ingeridos de esta property vía `repo.listInvoices`, igual
// que la ruta DIOT de declaraciones.ts) — ninguna tabla nueva de "solicitud
// de devolución" se persiste en esta fase (ver comentario de
// `preparar_solicitud`/`SolicitudDevolucion` en calculo.ts: el resultado es
// responsabilidad del cliente HTTP guardarlo donde corresponda).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  DEVOLUCION_IVA_ROLES,
  VER_DEVOLUCION_IVA_ROLES,
  recopilarFacturas,
  clasificarIva,
  generarDiotDevolucionIva,
  validarDiot,
  conciliarFacturasDiot,
  conciliarDiotDeclaracion,
  conciliarDeclaracionSaldo,
  calcularSaldoFavor,
  calcularMontoDevolucion,
  validarCongruenciaDiotCfdiDeclaracion,
  prepararSolicitud,
  calcularFechaLimiteResolucion,
  generarPapelTrabajo,
} from "@atiende/domain-despachos";
import type { DeclaracionMensualIva, DiotEntryIva, FacturaCfdiIva, TipoFacturaIva } from "@atiende/domain-despachos";
import { randomUUID } from "node:crypto";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

const TIPO_COMPROBANTE_A_TIPO_FACTURA: Record<string, TipoFacturaIva> = { I: "Ingreso", E: "Egreso", T: "Traslado", P: "Pago", N: "Nómina" };

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw Errors.validation(`${field}: se esperaba un texto no vacío.`);
  return value.trim();
}

function optionalNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw Errors.validation(`${field}: se esperaba un número.`);
  return value;
}

interface FacturaBody {
  readonly uuid?: unknown;
  readonly rfcEmisor?: unknown;
  readonly nombreEmisor?: unknown;
  readonly rfcReceptor?: unknown;
  readonly fecha?: unknown;
  readonly subtotal?: unknown;
  readonly iva?: unknown;
  readonly total?: unknown;
  readonly tipo?: unknown;
  readonly categoria?: unknown;
  readonly bancoPago?: unknown;
  readonly fechaPago?: unknown;
  readonly proporcionalidad?: unknown;
  readonly folioFactura?: unknown;
  readonly formaPago?: unknown;
  readonly metodoPago?: unknown;
  readonly referenciaComplementoPago?: unknown;
  readonly concepto?: unknown;
}

function parseFactura(raw: unknown, idx: number): FacturaCfdiIva {
  if (typeof raw !== "object" || raw === null) throw Errors.validation(`facturas[${idx}]: se esperaba un objeto.`);
  const f = raw as FacturaBody;
  const categoria = typeof f.categoria === "string" && ["acreditable_100", "acreditable_proporcional", "no_acreditable"].includes(f.categoria) ? (f.categoria as FacturaCfdiIva["categoria"]) : "acreditable_100";
  const tipo = typeof f.tipo === "string" && ["Ingreso", "Egreso", "Traslado", "Nómina", "Pago"].includes(f.tipo) ? (f.tipo as TipoFacturaIva) : "Ingreso";
  return {
    uuid: requireString(f.uuid, `facturas[${idx}].uuid`),
    rfcEmisor: requireString(f.rfcEmisor, `facturas[${idx}].rfcEmisor`).toUpperCase(),
    nombreEmisor: typeof f.nombreEmisor === "string" ? f.nombreEmisor : "",
    rfcReceptor: requireString(f.rfcReceptor, `facturas[${idx}].rfcReceptor`).toUpperCase(),
    fecha: requireString(f.fecha, `facturas[${idx}].fecha`),
    subtotal: optionalNumber(f.subtotal, `facturas[${idx}].subtotal`, 0),
    iva: optionalNumber(f.iva, `facturas[${idx}].iva`, 0),
    total: optionalNumber(f.total, `facturas[${idx}].total`, 0),
    tipo,
    categoria,
    bancoPago: typeof f.bancoPago === "string" ? f.bancoPago : null,
    fechaPago: typeof f.fechaPago === "string" ? f.fechaPago : null,
    proporcionalidad: optionalNumber(f.proporcionalidad, `facturas[${idx}].proporcionalidad`, 1.0),
    folioFactura: typeof f.folioFactura === "string" ? f.folioFactura : null,
    formaPago: typeof f.formaPago === "string" ? f.formaPago : null,
    metodoPago: typeof f.metodoPago === "string" ? f.metodoPago : null,
    referenciaComplementoPago: typeof f.referenciaComplementoPago === "string" ? f.referenciaComplementoPago : null,
    concepto: typeof f.concepto === "string" ? f.concepto : null,
  };
}

function parseFacturas(raw: unknown): readonly FacturaCfdiIva[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw Errors.validation("facturas: se esperaba un arreglo.");
  return raw.map(parseFactura);
}

function parseDeclaracion(raw: unknown, idx: number): DeclaracionMensualIva {
  if (typeof raw !== "object" || raw === null) throw Errors.validation(`declaraciones[${idx}]: se esperaba un objeto.`);
  const d = raw as Record<string, unknown>;
  return {
    mes: optionalNumber(d.mes, `declaraciones[${idx}].mes`, NaN),
    año: optionalNumber(d.año ?? d.anio, `declaraciones[${idx}].año`, NaN),
    ivaCobrado: optionalNumber(d.ivaCobrado, `declaraciones[${idx}].ivaCobrado`, 0),
    ivaPagado: optionalNumber(d.ivaPagado, `declaraciones[${idx}].ivaPagado`, 0),
    saldoFavor: optionalNumber(d.saldoFavor, `declaraciones[${idx}].saldoFavor`, 0),
    saldoContra: optionalNumber(d.saldoContra, `declaraciones[${idx}].saldoContra`, 0),
  };
}

function parseDeclaraciones(raw: unknown): readonly DeclaracionMensualIva[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw Errors.validation("declaraciones: se esperaba un arreglo.");
  return raw.map(parseDeclaracion);
}

function parseDiotEntries(raw: unknown): readonly DiotEntryIva[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw Errors.validation("diotEntries: se esperaba un arreglo.");
  return raw as DiotEntryIva[]; // Estructura ya viene de un `generarDiotDevolucionIva` previo — se re-envía tal cual.
}

export function despachosDevolucionIvaRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/despachos/:propertyId/devolucion-iva/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  /** Recopila+clasifica facturas de un periodo, ya sea desde el body o
   * auto-ingeridas desde los invoices ya guardados de esta property (mismo
   * patrón que la ruta DIOT de declaraciones.ts). */
  // Hallazgo de auditoría (severidad MEDIO, "el rol 'readonly' está definido pero
  // ninguna ruta lo usa realmente"): ver/clasificar facturas ya ingestadas para
  // devolución de IVA es lectura -- auditor/readonly SÍ pueden verla
  // (VER_DEVOLUCION_IVA_ROLES), aunque nunca correr el papel de trabajo completo
  // (DEVOLUCION_IVA_ROLES, sin cambios, en el resto de rutas de este archivo).
  app.get("/despachos/:propertyId/devolucion-iva/facturas/:periodo", async (c) => {
    assertVerticalRole(c, VER_DEVOLUCION_IVA_ROLES);
    const periodo = c.req.param("periodo");
    if (!/^\d{4}-\d{2}$/.test(periodo)) throw Errors.validation("periodo: se esperaba el formato YYYY-MM.");
    const repo = deps.despachosRepo(c.get("db"));
    // `repo.listInvoices({ periodo })` (migración 006) ya filtra por la fecha REAL
    // de emisión del CFDI (`invoice.fecha`), no por el jsonb de DIOT (que solo
    // existe para un CFDI tipo 'I' con subtotal>0) ni por `createdAt` — así que un
    // CFDI de cualquier tipo (E/T/P/N incluidos) que antes desaparecía del período
    // ahora se recopila correctamente aquí.
    const invoices = await repo.listInvoices(c.req.param("propertyId"), { periodo });
    const facturas: FacturaCfdiIva[] = invoices.map((inv) => ({
      uuid: inv.folioFiscal,
      rfcEmisor: inv.rfcEmisor,
      nombreEmisor: inv.emisorNombre ?? "",
      rfcReceptor: inv.rfcReceptor,
      fecha: inv.fecha,
      subtotal: inv.subtotal,
      iva: inv.iva ?? 0,
      total: inv.total,
      tipo: TIPO_COMPROBANTE_A_TIPO_FACTURA[inv.tipo] ?? "Ingreso",
      categoria: "acreditable_100",
      proporcionalidad: 1.0,
      concepto: inv.emisorNombre,
    }));
    const clasificacion = clasificarIva(facturas);
    return c.json({ facturas, clasificacion });
  });

  app.post("/despachos/:propertyId/devolucion-iva/diot", async (c) => {
    assertVerticalRole(c, DEVOLUCION_IVA_ROLES);
    const raw = await readJsonCapped<{ readonly facturas?: unknown; readonly periodo?: unknown }>(c.req.raw, 512 * 1024);
    const periodo = typeof raw.periodo === "string" ? raw.periodo : undefined;
    const facturas = recopilarFacturas(parseFacturas(raw.facturas), periodo);
    const diotEntries = generarDiotDevolucionIva(facturas);
    const errores = validarDiot(diotEntries);
    return c.json({ diotEntries, errores });
  });

  app.post("/despachos/:propertyId/devolucion-iva/conciliacion", async (c) => {
    assertVerticalRole(c, DEVOLUCION_IVA_ROLES);
    const raw = await readJsonCapped<{ readonly facturas?: unknown; readonly diotEntries?: unknown; readonly declaraciones?: unknown }>(c.req.raw, 512 * 1024);
    const facturas = parseFacturas(raw.facturas);
    const diotEntries = parseDiotEntries(raw.diotEntries);
    const declaraciones = parseDeclaraciones(raw.declaraciones);
    return c.json({
      facturasVsDiot: conciliarFacturasDiot(facturas, diotEntries),
      diotVsDeclaracion: conciliarDiotDeclaracion(diotEntries, declaraciones),
    });
  });

  app.post("/despachos/:propertyId/devolucion-iva/saldo-favor", async (c) => {
    assertVerticalRole(c, DEVOLUCION_IVA_ROLES);
    const raw = await readJsonCapped<{ readonly declaraciones?: unknown }>(c.req.raw, 128 * 1024);
    const declaraciones = parseDeclaraciones(raw.declaraciones);
    const saldoFavor = calcularSaldoFavor(declaraciones);
    const montoDevolucion = calcularMontoDevolucion(saldoFavor, declaraciones);
    const verificacion = conciliarDeclaracionSaldo(declaraciones, saldoFavor);
    return c.json({ saldoFavor, montoDevolucion, verificacion });
  });

  app.post("/despachos/:propertyId/devolucion-iva/congruencia", async (c) => {
    assertVerticalRole(c, DEVOLUCION_IVA_ROLES);
    const raw = await readJsonCapped<{ readonly periodo?: unknown; readonly facturas?: unknown; readonly diotEntries?: unknown; readonly declaraciones?: unknown; readonly tolerancia?: unknown }>(c.req.raw, 512 * 1024);
    const periodo = requireString(raw.periodo, "periodo");
    const facturas = parseFacturas(raw.facturas);
    const diotEntries = parseDiotEntries(raw.diotEntries);
    const declaraciones = parseDeclaraciones(raw.declaraciones);
    const tolerancia = optionalNumber(raw.tolerancia, "tolerancia", 1.0);
    return c.json(validarCongruenciaDiotCfdiDeclaracion(periodo, facturas, diotEntries, declaraciones, tolerancia));
  });

  app.post("/despachos/:propertyId/devolucion-iva/solicitud", async (c) => {
    assertVerticalRole(c, DEVOLUCION_IVA_ROLES);
    const raw = await readJsonCapped<{
      readonly periodo?: unknown;
      readonly saldo?: unknown;
      readonly cuentaBanco?: unknown;
      readonly clabe?: unknown;
      readonly documentos?: unknown;
      readonly tenantId?: unknown;
      readonly facturas?: unknown;
      readonly diotEntries?: unknown;
      readonly declaraciones?: unknown;
    }>(c.req.raw, 512 * 1024);
    const periodo = requireString(raw.periodo, "periodo");
    if (typeof raw.saldo !== "object" || raw.saldo === null) throw Errors.validation("saldo: se esperaba un objeto ({ montoDevolucionSugerido } o { saldoFavorOriginal }).");
    try {
      const solicitud = prepararSolicitud(periodo, raw.saldo as { montoDevolucionSugerido?: number; saldoFavorOriginal?: number }, {
        cuentaBanco: typeof raw.cuentaBanco === "string" ? raw.cuentaBanco : null,
        clabe: typeof raw.clabe === "string" ? raw.clabe : null,
        documentos: Array.isArray(raw.documentos) ? (raw.documentos as string[]) : [],
        tenantId: typeof raw.tenantId === "string" ? raw.tenantId : null,
        facturas: parseFacturas(raw.facturas),
        diotEntries: parseDiotEntries(raw.diotEntries),
        declaraciones: parseDeclaraciones(raw.declaraciones),
        now: new Date().toISOString(),
        solicitudId: randomUUID(),
      });
      return c.json(solicitud);
    } catch (err) {
      if (err instanceof Error) throw Errors.validation(err.message);
      throw err;
    }
  });

  app.post("/despachos/:propertyId/devolucion-iva/plazo-resolucion", async (c) => {
    assertVerticalRole(c, DEVOLUCION_IVA_ROLES);
    const raw = await readJsonCapped<{ readonly fechaPresentacion?: unknown; readonly hayDictamenOGarantia?: unknown }>(c.req.raw, 8 * 1024);
    const fechaPresentacion = requireString(raw.fechaPresentacion, "fechaPresentacion");
    try {
      const fechaLimite = calcularFechaLimiteResolucion(fechaPresentacion, raw.hayDictamenOGarantia === true);
      return c.json({ fechaPresentacion, fechaLimite });
    } catch (err) {
      if (err instanceof Error) throw Errors.validation(err.message);
      throw err;
    }
  });

  app.post("/despachos/:propertyId/devolucion-iva/papel-trabajo", async (c) => {
    assertVerticalRole(c, DEVOLUCION_IVA_ROLES);
    const raw = await readJsonCapped<{
      readonly periodo?: unknown;
      readonly facturas?: unknown;
      readonly diotEntries?: unknown;
      readonly declaraciones?: unknown;
      readonly tenantId?: unknown;
      readonly documentosSoporte?: unknown;
    }>(c.req.raw, 1024 * 1024);
    const periodo = requireString(raw.periodo, "periodo");
    const facturas = parseFacturas(raw.facturas);
    const diotEntries = raw.diotEntries !== undefined ? parseDiotEntries(raw.diotEntries) : generarDiotDevolucionIva(recopilarFacturas(facturas, periodo));
    const declaraciones = parseDeclaraciones(raw.declaraciones);
    const papel = generarPapelTrabajo(periodo, facturas, diotEntries, declaraciones, {
      tenantId: typeof raw.tenantId === "string" ? raw.tenantId : null,
      documentosSoporte: Array.isArray(raw.documentosSoporte) ? (raw.documentosSoporte as string[]) : [],
    });
    return c.json(papel);
  });

  return app;
}

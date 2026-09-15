// Flujo 1 (Fase 1 despachos §4): ingesta y validación fiscal de un CFDI — la arteria
// central del producto (DIOT, conciliación, declaraciones, cobranza, todo lee de
// `despachos.invoice`). El motor SIEMPRE es `validarCfdiDespachos()`
// (@atiende/domain-despachos, compone sobre `validarCfdi()` de @atiende/billing con
// la capa de reglas fiscales avanzadas) — ningún cálculo de coherencia fiscal vive en
// esta ruta ni se delega a un LLM. `folioFiscal` es la llave natural de idempotencia:
// reingestar el mismo CFDI (mismo UUID de timbre) nunca duplica la fila (ver
// domain-despachos/src/repository.ts).
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import { validarCfdiDespachos, InvoiceAlreadyExistsError, INGESTA_CFDI_ROLES, VER_CFDI_ROLES, estaPeriodoCerrado } from "@atiende/domain-despachos";
import type { CategoriaContable, DatosCfdiDespachos, DespachosRepository, InvoiceRecord } from "@atiende/domain-despachos";
import { CfdiXmlParseError, parseCfdiXml } from "@atiende/billing";
import { Errors } from "../../../errors.ts";
import { readJsonCapped, readTextCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";

/** Un CFDI real timbrado rara vez pasa de ~100 KB incluso con varias decenas de
 * conceptos; 512 KB deja margen holgado (complementos, muchos conceptos) sin abrir
 * la puerta a un XML gigante como vector de denegación de servicio. */
const MAX_CFDI_XML_BYTES = 512 * 1024;

const TIPOS_COMPROBANTE_VALIDOS = new Set(["I", "E", "T", "P", "N"]);

interface ConceptoBody {
  readonly cantidad?: unknown;
  readonly valorUnitario?: unknown;
  readonly importe?: unknown;
}

interface IngestaCfdiBody {
  readonly folioFiscal?: unknown;
  readonly tipo?: unknown;
  readonly subtotal?: unknown;
  readonly total?: unknown;
  readonly descuento?: unknown;
  readonly iva?: unknown;
  readonly conceptos?: unknown;
  readonly usoCfdi?: unknown;
  readonly formaPago?: unknown;
  readonly metodoPago?: unknown;
  readonly regimenFiscalEmisor?: unknown;
  readonly rfcEmisor?: unknown;
  readonly rfcReceptor?: unknown;
  readonly emisorNombre?: unknown;
  readonly tieneSello?: unknown;
  readonly noCertificado?: unknown;
  readonly fecha?: unknown;
  readonly fechaTimbrado?: unknown;
  readonly retencionIsr?: unknown;
  readonly retencionIva?: unknown;
  readonly ieps?: unknown;
  readonly cfdiRelacionados?: unknown;
  readonly tipoRelacion?: unknown;
  readonly nomina?: { totalPercepciones?: unknown } | null;
  readonly categoria?: unknown;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw Errors.validation(`${field}: se esperaba un texto no vacío.`);
  return value.trim();
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw Errors.validation(`${field}: se esperaba un número.`);
  return value;
}

function optionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  return requireNumber(value, field);
}

/** `{}` (nómina presente pero sin TotalPercepciones aún) se preserva TAL CUAL — el
 * motor (`validarCfdiDespachos`) replica a propósito la semántica de Python donde un
 * dict vacío no dispara los checks internos pero SÍ cuenta para `requiresHumanReview`
 * (ver reglas-fiscales-avanzadas.ts, NOTA DE FIDELIDAD del bloque de nómina). */
function parseNomina(raw: IngestaCfdiBody["nomina"]): { totalPercepciones?: number } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (Object.keys(raw).length === 0) return {};
  return { totalPercepciones: optionalNumber(raw.totalPercepciones, "nomina.totalPercepciones") ?? undefined };
}

const CATEGORIAS_VALIDAS = new Set<CategoriaContable>(["gasto_operativo", "activo_fijo", "inversion", "honorarios", "nomina", "sin_clasificar"]);

function parseIngestaBody(raw: IngestaCfdiBody): DatosCfdiDespachos & { categoria: CategoriaContable } {
  if (!Array.isArray(raw.conceptos)) throw Errors.validation("conceptos: se esperaba un arreglo.");
  const conceptos = (raw.conceptos as ConceptoBody[]).map((c, i) => ({
    cantidad: requireNumber(c.cantidad, `conceptos[${i}].cantidad`),
    valorUnitario: requireNumber(c.valorUnitario, `conceptos[${i}].valorUnitario`),
    importe: requireNumber(c.importe, `conceptos[${i}].importe`),
  }));

  const tipo = requireString(raw.tipo, "tipo");
  if (!["I", "E", "T", "P", "N"].includes(tipo)) throw Errors.validation("tipo: se esperaba I|E|T|P|N.");

  const categoria = typeof raw.categoria === "string" && CATEGORIAS_VALIDAS.has(raw.categoria as CategoriaContable) ? (raw.categoria as CategoriaContable) : "sin_clasificar";

  const cfdiRelacionados = Array.isArray(raw.cfdiRelacionados) ? (raw.cfdiRelacionados as unknown[]).filter((x): x is string => typeof x === "string") : undefined;

  return {
    folioFiscal: requireString(raw.folioFiscal, "folioFiscal"),
    tipo: tipo as DatosCfdiDespachos["tipo"],
    subtotal: requireNumber(raw.subtotal, "subtotal"),
    total: requireNumber(raw.total, "total"),
    descuento: optionalNumber(raw.descuento, "descuento") ?? 0,
    iva: optionalNumber(raw.iva, "iva"),
    conceptos,
    usoCfdi: requireString(raw.usoCfdi, "usoCfdi"),
    formaPago: requireString(raw.formaPago, "formaPago"),
    metodoPago: requireString(raw.metodoPago, "metodoPago"),
    regimenFiscalEmisor: requireString(raw.regimenFiscalEmisor, "regimenFiscalEmisor"),
    rfcEmisor: requireString(raw.rfcEmisor, "rfcEmisor"),
    rfcReceptor: requireString(raw.rfcReceptor, "rfcReceptor"),
    emisorNombre: typeof raw.emisorNombre === "string" ? raw.emisorNombre : undefined,
    tieneSello: raw.tieneSello === true,
    noCertificado: typeof raw.noCertificado === "string" ? raw.noCertificado : "",
    retencionIsr: optionalNumber(raw.retencionIsr, "retencionIsr"),
    retencionIva: optionalNumber(raw.retencionIva, "retencionIva"),
    ieps: optionalNumber(raw.ieps, "ieps"),
    fecha: typeof raw.fecha === "string" ? raw.fecha : undefined,
    fechaTimbrado: typeof raw.fechaTimbrado === "string" ? raw.fechaTimbrado : undefined,
    cfdiRelacionados,
    tipoRelacion: typeof raw.tipoRelacion === "string" ? raw.tipoRelacion : undefined,
    nomina: parseNomina(raw.nomina),
    categoria,
  };
}

function serializeInvoice(invoice: InvoiceRecord) {
  return {
    id: invoice.id,
    folioFiscal: invoice.folioFiscal,
    tipo: invoice.tipo,
    rfcEmisor: invoice.rfcEmisor,
    rfcReceptor: invoice.rfcReceptor,
    emisorNombre: invoice.emisorNombre,
    subtotal: invoice.subtotal,
    total: invoice.total,
    iva: invoice.iva,
    descuento: invoice.descuento,
    categoria: invoice.categoria,
    valido: invoice.valido,
    issues: invoice.issues,
    warnings: invoice.warnings,
    requiereRevisionHumana: invoice.requiresHumanReview,
    diot: invoice.diot,
    fecha: invoice.fecha,
    creadoEn: invoice.createdAt,
  };
}

function resumirMotivoRevision(result: ReturnType<typeof validarCfdiDespachos>, tipo: string): string {
  const motivos: string[] = [];
  if (result.issues.length > 0) motivos.push(`${result.issues.length} hallazgo(s): ${result.issues.map((i) => i.codigo).join(", ")}`);
  if (result.diot.reportable) motivos.push("proveedor reportable en DIOT");
  if (tipo === "E") motivos.push("nota de crédito (tipo E)");
  if (tipo === "P") motivos.push("comprobante de pago (tipo P)");
  return motivos.length > 0 ? motivos.join("; ") : "requiere confirmación humana";
}

/** Flujo 1 compartido por AMBAS rutas de ingesta (JSON ya desarmado a mano vía
 * `POST /cfdi`, y XML crudo del PAC vía `POST /cfdi/importar-xml`) — el único
 * punto donde se corre `validarCfdiDespachos`, se persiste el invoice y se
 * encola la revisión humana. Ninguna de las dos rutas duplica esta lógica: solo
 * difieren en CÓMO llegan a un `DatosCfdiDespachos` (parseando JSON o XML). */
async function ingestarCfdiDespachos(
  repo: DespachosRepository,
  organizationId: string,
  propertyId: string,
  datos: DatosCfdiDespachos,
  categoria: CategoriaContable,
): Promise<InvoiceRecord> {
  // Migración 006 (hallazgo de auditoría): `fecha` (fecha REAL de emisión del
  // CFDI) ahora se persiste en `despachos.invoice.fecha` (columna NOT NULL) —
  // conciliación bancaria, DIOT, devolución de IVA y declaraciones dependen de
  // ella para resolver "a qué período pertenece este CFDI" (nunca `createdAt`, la
  // fecha de INGESTA). Un CFDI real siempre trae su fecha de emisión, así que se
  // exige aquí en vez de inventar un fallback silencioso.
  if (!datos.fecha) throw Errors.validation("fecha: se esperaba un texto (fecha de emisión del CFDI, ISO 8601).");
  const fechaInvoice = datos.fecha.slice(0, 10);

  // Fase 6 (cierre mensual) — bloqueo de edición de movimientos ya cerrados:
  // funcionalidad NUEVA (ver domain-despachos/src/errors.ts,
  // `PeriodoCerradoError`, y el comentario de cabecera de
  // `cierre-mensual/engine.ts` — ni close_management ni monthly_close del
  // origen Python implementan este bloqueo en ningún punto real de
  // escritura). Se engancha aquí, en la ingesta de CFDI, porque es el único
  // flujo de escritura de "movimientos" que ya existe en esta vertical; el
  // período se resuelve por (property, año, mes) de la FECHA del propio
  // CFDI (`fechaInvoice`, "YYYY-MM-DD").
  {
    const [anioStr, mesStr] = fechaInvoice.split("-");
    const anio = Number(anioStr);
    const mes = Number(mesStr);
    if (Number.isInteger(anio) && Number.isInteger(mes)) {
      const periodo = await repo.findPeriodoCierrePorAnioMes(propertyId, anio, mes);
      if (estaPeriodoCerrado(periodo)) throw Errors.despachosPeriodoCerrado(fechaInvoice.slice(0, 7));
    }
  }

  const resultado = validarCfdiDespachos(datos);

  try {
    const invoice = await repo.insertInvoice({
      organizationId,
      propertyId,
      folioFiscal: datos.folioFiscal,
      tipo: datos.tipo as InvoiceRecord["tipo"],
      rfcEmisor: datos.rfcEmisor,
      rfcReceptor: datos.rfcReceptor,
      emisorNombre: datos.emisorNombre ?? null,
      subtotal: datos.subtotal,
      total: datos.total,
      iva: datos.iva ?? null,
      descuento: datos.descuento ?? 0,
      categoria,
      fecha: fechaInvoice,
      valido: resultado.ok,
      issues: resultado.issues,
      warnings: resultado.warnings,
      requiresHumanReview: resultado.requiresHumanReview,
      diot: resultado.diot,
    });

    // Flujo 2 (cola de revisión humana): gateado ESTRICTAMENTE por el flag
    // `requiresHumanReview` que acaba de calcular el motor determinista — nunca se
    // decide "a ojo" en la ruta si un CFDI necesita revisión.
    if (resultado.requiresHumanReview) {
      await repo.createReview({
        organizationId,
        propertyId,
        invoiceId: invoice.id,
        reason: resumirMotivoRevision(resultado, datos.tipo),
      });
    }

    return invoice;
  } catch (err) {
    if (err instanceof InvoiceAlreadyExistsError) throw Errors.conflict(err.message);
    throw err;
  }
}

export function despachosCfdiRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();

  app.use("/despachos/:propertyId/cfdi/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));
  app.use("/despachos/:propertyId/cfdi", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  app.post("/despachos/:propertyId/cfdi", async (c) => {
    assertVerticalRole(c, INGESTA_CFDI_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const raw = await readJsonCapped<IngestaCfdiBody>(c.req.raw, 64 * 1024);
    const { categoria, ...datos } = parseIngestaBody(raw);

    const invoice = await ingestarCfdiDespachos(repo, organizationId, propertyId, datos, categoria);
    return c.json(serializeInvoice(invoice), 201);
  });

  // ALCANCE (ver TAREA): consume el CFDI 4.0 tal como lo entrega el PAC —
  // camino feliz (un `cfdi:Comprobante`, N conceptos, IVA trasladado estándar,
  // `tfd:TimbreFiscalDigital` para el folio fiscal). Deliberadamente NO cubre
  // comercio exterior, complemento de pagos ni nómina vía XML — ver el
  // encabezado de `@atiende/billing/cfdi/xml-parser.ts` para el detalle exacto
  // de qué queda fuera. `categoria` nunca viaja en el XML del SAT (es
  // clasificación contable interna del despacho, no un dato fiscal), así que
  // entra siempre como "sin_clasificar" — el staff la reclasifica después,
  // igual que cualquier CFDI ingestado sin categoría explícita por `POST /cfdi`.
  app.post("/despachos/:propertyId/cfdi/importar-xml", async (c) => {
    assertVerticalRole(c, INGESTA_CFDI_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const organizationId = c.get("organizationId");
    const propertyId = c.req.param("propertyId");
    const xml = await readTextCapped(c.req.raw, MAX_CFDI_XML_BYTES);

    let datos: DatosCfdiDespachos;
    try {
      const parsed = parseCfdiXml(xml);
      if (!TIPOS_COMPROBANTE_VALIDOS.has(parsed.tipo)) {
        throw Errors.validation(`TipoDeComprobante: '${parsed.tipo}' — se esperaba I|E|T|P|N.`);
      }
      datos = { ...parsed, tipo: parsed.tipo as DatosCfdiDespachos["tipo"] };
    } catch (err) {
      if (err instanceof CfdiXmlParseError) throw Errors.validation(err.message);
      throw err;
    }

    const invoice = await ingestarCfdiDespachos(repo, organizationId, propertyId, datos, "sin_clasificar");
    return c.json(serializeInvoice(invoice), 201);
  });

  // Hallazgo de auditoría (severidad MEDIO, "el rol 'readonly' está definido pero
  // ninguna ruta lo usa realmente"): ver un CFDI ya ingestado es lectura de un
  // registro ya persistido -- auditor/readonly SÍ pueden verlo (VER_CFDI_ROLES),
  // aunque nunca ingestar uno nuevo (INGESTA_CFDI_ROLES, sin cambios, arriba).
  app.get("/despachos/:propertyId/cfdi/:invoiceId", async (c) => {
    assertVerticalRole(c, VER_CFDI_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const invoice = await repo.findInvoice(c.req.param("propertyId"), c.req.param("invoiceId"));
    if (!invoice) throw Errors.notFound("CFDI no encontrado.");
    return c.json(serializeInvoice(invoice));
  });

  app.get("/despachos/:propertyId/cfdi", async (c) => {
    assertVerticalRole(c, VER_CFDI_ROLES);
    const repo = deps.despachosRepo(c.get("db"));
    const soloRevision = c.req.query("requiereRevisionHumana");
    const invoices = await repo.listInvoices(c.req.param("propertyId"), soloRevision !== undefined ? { requiresHumanReview: soloRevision === "true" } : undefined);
    return c.json(invoices.map(serializeInvoice));
  });

  return app;
}

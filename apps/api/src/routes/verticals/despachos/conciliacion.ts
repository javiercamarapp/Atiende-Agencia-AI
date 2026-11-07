// Fase 5 (conciliación bancaria): expone el motor de matching determinístico de niveles 1-3 (ver
// @atiende/domain-despachos/conciliacion/matching-engine.ts) más las reglas de alerta (comisiones, movimientos
// grandes, aging, duplicados). Los endpoints de ESTE archivo `/matching`, `/alertas`, `/clasificar-deposito`,
// `/verificar-spei` y `/importar-estado-de-cuenta` son calculadoras/vistas previas: no guardan conciliaciones.
//
// D-35 + D-02: la conciliación PERSISTIDA (sesiones por periodo, matches confirmados, deshacer, sugerencias del
// nivel 4 con aprobación humana obligatoria) vive en ./conciliacion-persistida.ts y se registra al final de
// `despachosConciliacionRoutes` (migración 021). El nivel 4 (LLM) responde 503 honesto sin `deps.llmGateway`.
//
// `/matching` recibe movimientos ya parseados y los concilia contra los CFDI YA INGERIDOS de esta property
// (`repo.listInvoices`); el parsing de CSV/OFX lo hace `POST .../importar-estado-de-cuenta`, D-03.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { authMiddleware, assertVerticalRole, dbSession, requirePropertyMembership } from "@atiende/core-auth";
import type { CoreAuthHonoEnv } from "@atiende/core-auth";
import {
  CONCILIACION_ROLES,
  conciliarMovimientos,
  revisarMovimiento,
  revisarDuplicados,
  revisarDiscrepanciaIngresos,
  clasificarDeposito,
  verificarSpeiContraMovimientos,
  verificarPagoProveedor,
  BANCOS_MX,
  construirVistaPreviaImportacion,
  leerFuenteOpcional,
  parsearEstadoDeCuenta,
} from "@atiende/domain-despachos";
import type { BancoMx, FormatoEstadoCuenta, MovimientoBancario, RegistroConciliable, InvoiceRecord } from "@atiende/domain-despachos";
import { Errors } from "../../../errors.ts";
import { readJsonCapped } from "../../../http-security.ts";
import type { AppDeps } from "../../../deps.ts";
import { registrarConciliacionPersistida } from "./conciliacion-persistida.ts";
import type { PilotoConciliacion } from "./conciliacion-piloto.ts";

interface MovimientoBody {
  readonly fecha?: unknown;
  readonly descripcion?: unknown;
  readonly referencia?: unknown;
  readonly cargo?: unknown;
  readonly abono?: unknown;
  readonly saldo?: unknown;
  readonly monto?: unknown;
  readonly banco?: unknown;
  readonly formato?: unknown;
}

interface MatchingBody {
  readonly movimientos?: unknown;
  readonly dateToleranceDays?: unknown;
  readonly montoTolerancePct?: unknown;
  readonly fuzzyThreshold?: unknown;
}

/** Tope del cuerpo JSON de la importación (CSV/OFX como texto): 2 MB cubren holgadamente
 * MAX_RENGLONES_ESTADO renglones y quedan por debajo del límite de cuerpo de Vercel. */
const MAX_BODY_IMPORTACION_BYTES = 2 * 1024 * 1024;

interface ImportarBody {
  readonly contenido?: unknown;
  readonly formato?: unknown;
  readonly banco?: unknown;
  readonly cuenta?: unknown;
  readonly dateToleranceDays?: unknown;
  readonly montoTolerancePct?: unknown;
  readonly fuzzyThreshold?: unknown;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw Errors.validation(`${field}: se esperaba un string no vacío.`);
  return value;
}

function optionalNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw Errors.validation(`${field}: se esperaba un número.`);
  return value;
}

function parseMovimiento(raw: unknown, idx: number): MovimientoBancario {
  if (typeof raw !== "object" || raw === null) throw Errors.validation(`movimientos[${idx}]: se esperaba un objeto.`);
  const m = raw as MovimientoBody;
  const fecha = requireString(m.fecha, `movimientos[${idx}].fecha`);
  const descripcion = typeof m.descripcion === "string" ? m.descripcion : "";
  const referencia = typeof m.referencia === "string" ? m.referencia : null;
  const cargo = typeof m.cargo === "number" ? m.cargo : null;
  const abono = typeof m.abono === "number" ? m.abono : null;
  const saldo = typeof m.saldo === "number" ? m.saldo : null;
  // `monto` con signo — si no viene explícito, se deriva de cargo/abono igual que
  // los parsers del origen (`monto = abono - cargo`).
  const monto = typeof m.monto === "number" ? m.monto : (abono ?? 0) - (cargo ?? 0);
  const banco = typeof m.banco === "string" ? m.banco : "generic";
  const formato = typeof m.formato === "string" ? m.formato : "csv";
  return { fecha, descripcion, referencia, cargo, abono, saldo, monto, banco, formato };
}

/** Aplana un `InvoiceRecord` ya ingerido a `RegistroConciliable` — usa la fecha REAL
 * del CFDI (`invoice.fecha`, migración 006) directamente. Antes de esa migración
 * solo sobrevivía `diot.proveedoresReportables[0].fecha` (únicamente para un CFDI
 * tipo 'I' con subtotal>0) con fallback a `createdAt` (fecha de INGESTA, no de
 * emisión) — con tolerancia de días, un CFDI cargado días después del movimiento
 * bancario real nunca hacía match. `invoice.fecha` es NOT NULL desde la migración
 * 006, así que ya no hace falta ningún fallback. */
function invoiceARegistroConciliable(inv: InvoiceRecord): RegistroConciliable {
  return {
    id: inv.id,
    fecha: inv.fecha,
    total: inv.total,
    descripcion: inv.emisorNombre,
    referencia: inv.folioFiscal,
    folioFiscal: inv.folioFiscal,
    // D-P3-11: sentido del CFDI (D-22). Sin dato (CFDI anterior a la migración 018 o aún sin clasificar: `undefined`/`null`) no se filtra, como antes; `indeterminado` SÍ se
    // propone pero solo con revisión humana, y el piloto automático exige una dirección explícita (emitido/recibido).
    ...(inv.direccion === undefined || inv.direccion === null ? {} : { direccion: inv.direccion }),
  };
}

export function despachosConciliacionRoutes(deps: AppDeps): Hono<CoreAuthHonoEnv> {
  const app = new Hono<CoreAuthHonoEnv>();
  // D-P3-12: lo asigna el registro de la conciliación persistida (al final); los handlers lo leen al atender cada request.
  const pilotoRef: { actual?: PilotoConciliacion } = {};

  app.use("/despachos/:propertyId/conciliacion/*", authMiddleware(deps.env), dbSession(deps.engine), requirePropertyMembership("propertyId"));

  /** Corre el motor de matching contra los CFDI ya ingeridos de esta property. */
  app.post("/despachos/:propertyId/conciliacion/matching", async (c) => {
    assertVerticalRole(c, CONCILIACION_ROLES);
    const raw = await readJsonCapped<MatchingBody>(c.req.raw, 512 * 1024);
    if (!Array.isArray(raw.movimientos)) throw Errors.validation("movimientos: se esperaba un arreglo.");
    const movimientos = raw.movimientos.map(parseMovimiento);

    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const invoices = await repo.listInvoices(propertyId);
    const registros = invoices.filter((i) => i.estadoSat !== "cancelado").map(invoiceARegistroConciliable);

    const resultado = conciliarMovimientos(movimientos, registros, {
      dateToleranceDays: optionalNumber(raw.dateToleranceDays, "dateToleranceDays", 3),
      montoTolerancePct: optionalNumber(raw.montoTolerancePct, "montoTolerancePct", 5.0),
      fuzzyThreshold: optionalNumber(raw.fuzzyThreshold, "fuzzyThreshold", 80),
    });

    return c.json(resultado);
  });

  /** Valida el cuerpo de la importación y parsea el archivo (compartido por la vista previa y
   * el guardado: el servidor SIEMPRE re-parsea el contenido, nunca confía en movimientos que
   * mande el cliente). */
  function prepararImportacion(raw: ImportarBody) {
    if (typeof raw.contenido !== "string" || raw.contenido.trim().length === 0) throw Errors.validation("contenido: se esperaba el texto del archivo (no vacío).");
    let formato: FormatoEstadoCuenta | undefined;
    if (raw.formato !== undefined && raw.formato !== null) {
      if (raw.formato !== "csv" && raw.formato !== "ofx") throw Errors.validation("formato: se esperaba 'csv' u 'ofx'.");
      formato = raw.formato;
    }
    let banco: BancoMx | undefined;
    if (raw.banco !== undefined && raw.banco !== null && raw.banco !== "") {
      if (typeof raw.banco !== "string" || !(BANCOS_MX as readonly string[]).includes(raw.banco)) throw Errors.validation(`banco: se esperaba uno de ${BANCOS_MX.join(", ")}.`);
      banco = raw.banco as BancoMx;
    }
    let cuenta: string | null | undefined;
    if (raw.cuenta !== undefined && raw.cuenta !== null && raw.cuenta !== "") {
      if (typeof raw.cuenta !== "string" || !/^[0-9A-Za-z-]{4,34}$/.test(raw.cuenta.trim())) throw Errors.validation("cuenta: se esperaba una CLABE o número de cuenta (4 a 34 caracteres alfanuméricos).");
      cuenta = raw.cuenta.trim();
    }
    return parsearEstadoDeCuenta(raw.contenido, {
      ...(formato ? { formato } : {}),
      ...(banco ? { banco } : {}),
      ...(cuenta ? { cuenta } : {}),
    });
  }

  /** D-03 -- vista previa de la importación de un estado de cuenta (CSV u OFX): parsea, valida
   * renglón por renglón (los errores se devuelven con su número de línea, no abortan el
   * archivo), calcula el hash de idempotencia de cada movimiento, marca los que YA se habían
   * importado (libro `despachos.estado_cuenta_movimiento`, migración 015) y concilia el resto
   * contra los CFDI ya ingeridos reutilizando el motor de niveles 1-3; si hay cuentas por
   * cobrar pendientes de los CFDI conciliados con un abono, las sugiere. SOLO lectura: no
   * persiste nada ni marca cuentas como pagadas. El contenido llega ya decodificado como texto
   * (el navegador decodifica UTF-8 o Windows-1252). Libro y cobranza se leen cada uno en su
   * propio SAVEPOINT (`leerFuenteOpcional`): contra una base sin esas tablas responden
   * `libroDisponible`/`cobranzaDisponible: false`, nunca un 500. */
  app.post("/despachos/:propertyId/conciliacion/importar-estado-de-cuenta", async (c) => {
    assertVerticalRole(c, CONCILIACION_ROLES);
    const raw = await readJsonCapped<ImportarBody>(c.req.raw, MAX_BODY_IMPORTACION_BYTES);
    const parseo = prepararImportacion(raw);

    const repo = deps.despachosRepo(c.get("db"));
    const propertyId = c.req.param("propertyId");
    const hayMovimientos = parseo.movimientos.length > 0;
    const invoices = hayMovimientos ? await repo.listInvoices(propertyId) : [];
    const registros = invoices.map(invoiceARegistroConciliable);
    const hashesYaImportados = hayMovimientos ? await leerFuenteOpcional(repo, () => repo.listEstadoCuentaHashesExistentes(propertyId, parseo.movimientos.map((m) => m.hash))) : new Set<string>();
    const cartera = hayMovimientos && invoices.length > 0 ? await leerFuenteOpcional(repo, () => repo.listReceivables(propertyId, { pendiente: true })) : [];

    return c.json(
      construirVistaPreviaImportacion({
        parseo,
        registros,
        cuentasPorCobrarPendientes: cartera === null ? null : cartera.map((r) => ({ id: r.id, invoiceId: r.invoiceId })),
        hashesYaImportados,
        opciones: {
          dateToleranceDays: optionalNumber(raw.dateToleranceDays, "dateToleranceDays", 3),
          montoTolerancePct: optionalNumber(raw.montoTolerancePct, "montoTolerancePct", 5.0),
          fuzzyThreshold: optionalNumber(raw.fuzzyThreshold, "fuzzyThreshold", 80),
        },
      }),
    );
  });

  /** D-03 -- guarda en el libro los movimientos del archivo, de forma IDEMPOTENTE por hash
   * (`insert ... on conflict (property_id, hash) do nothing`): subir dos veces el mismo archivo,
   * o dos archivos con periodos traslapados, no duplica nada (`yaExistentes` cuenta lo descartado).
   * Todo o nada respecto a errores de parseo: si el archivo tiene renglones con error se rechaza
   * completo (400) para no importar a medias un estado de cuenta que el contador aún debe corregir.
   * No marca cuentas por cobrar como pagadas ni concilia nada: eso sigue siendo decisión humana.
   * Contra una base sin la migración 015 responde 503 honesto (SAVEPOINT vía `leerFuenteOpcional`). */
  app.post("/despachos/:propertyId/conciliacion/importar-estado-de-cuenta/guardar", async (c) => {
    assertVerticalRole(c, CONCILIACION_ROLES);
    const raw = await readJsonCapped<ImportarBody>(c.req.raw, MAX_BODY_IMPORTACION_BYTES);
    const parseo = prepararImportacion(raw);
    if (parseo.errores.length > 0) throw Errors.validation(`El archivo tiene ${parseo.errores.length} renglón(es) con error (primero: renglón ${parseo.errores[0]!.renglon}, ${parseo.errores[0]!.mensaje}). Corrígelos y vuelve a subirlo.`);
    if (parseo.movimientos.length === 0) throw Errors.validation("El archivo no trae movimientos que guardar.");

    const repo = deps.despachosRepo(c.get("db"));
    const resultado = await leerFuenteOpcional(repo, () =>
      repo.insertEstadoCuentaMovimientos({
        organizationId: c.get("organizationId"),
        propertyId: c.req.param("propertyId"),
        loteId: randomUUID(),
        movimientos: parseo.movimientos.map((m) => ({
          hash: m.hash,
          cuenta: parseo.cuenta,
          banco: parseo.banco,
          formato: parseo.formato,
          fecha: m.fecha,
          descripcion: m.descripcion,
          referencia: m.referencia,
          cargo: m.cargo,
          abono: m.abono,
          monto: m.monto,
          saldo: m.saldo,
          renglon: m.renglon,
        })),
      }),
    );
    if (resultado === null) throw Errors.serviceUnavailable("Guardar estados de cuenta aún no está disponible en esta base de datos: falta aplicar la migración 015 (libro de movimientos importados).");
    // D-P3-12: piloto automático (sesión del periodo, propuestas guardadas, autoconfirmación de nivel 1 si el cliente la encendió, avisos). Nunca falla el guardado.
    const conciliacion =
      pilotoRef.actual && resultado.insertados > 0
        ? await pilotoRef.actual.trasImportar(c, { propertyId: c.req.param("propertyId"), cuenta: parseo.cuenta ?? null, periodos: parseo.movimientos.map((m) => m.fecha.slice(0, 7)) })
        : null;
    return c.json({ ...resultado, totalMovimientos: parseo.movimientos.length, conciliacion }, resultado.insertados > 0 ? 201 : 200);
  });

  /** Alertas de antigüedad/comisión/duplicados sobre un lote de movimientos ya
   * parseados — no requiere conciliarlos primero (opera sobre los movimientos tal
   * cual, el cliente decide si son ya el subconjunto "sin conciliar"). */
  app.post("/despachos/:propertyId/conciliacion/alertas", async (c) => {
    assertVerticalRole(c, CONCILIACION_ROLES);
    const raw = await readJsonCapped<{ readonly movimientos?: unknown; readonly declaredIncome?: unknown }>(c.req.raw, 512 * 1024);
    if (!Array.isArray(raw.movimientos)) throw Errors.validation("movimientos: se esperaba un arreglo.");
    const movimientos = raw.movimientos.map(parseMovimiento);

    const porMovimiento = movimientos.flatMap((m) => revisarMovimiento(m));
    const duplicados = revisarDuplicados(movimientos);
    const totalDeposits = movimientos.filter((m) => m.monto > 0).reduce((acc, m) => acc + m.monto, 0);
    const declaredIncome = typeof raw.declaredIncome === "number" ? raw.declaredIncome : 0;
    const discrepanciaIngresos = revisarDiscrepanciaIngresos(totalDeposits, declaredIncome);

    return c.json({
      alertas: [...porMovimiento, ...duplicados, ...(discrepanciaIngresos ? [discrepanciaIngresos] : [])],
    });
  });

  /** Clasificación automática de un depósito (ingreso/financiamiento/aportación de
   * socio/garantía/otro) — CFF Art. 59 fr. III. */
  app.post("/despachos/:propertyId/conciliacion/clasificar-deposito", async (c) => {
    assertVerticalRole(c, CONCILIACION_ROLES);
    const raw = await readJsonCapped<{ readonly descripcion?: unknown; readonly referencia?: unknown }>(c.req.raw, 8 * 1024);
    const descripcion = requireString(raw.descripcion, "descripcion");
    const referencia = typeof raw.referencia === "string" ? raw.referencia : null;
    return c.json(clasificarDeposito(descripcion, referencia));
  });

  /** Verificación de un pago SPEI/proveedor contra los movimientos ya parseados —
   * SOLO el matching por clave de rastreo/RFC (100% portable); la consulta real a
   * STP/Banxico CEP no está conectada en esta fase (ver spei-matching.ts). */
  app.post("/despachos/:propertyId/conciliacion/verificar-spei", async (c) => {
    assertVerticalRole(c, CONCILIACION_ROLES);
    const raw = await readJsonCapped<{ readonly movimientos?: unknown; readonly claveRastreo?: unknown; readonly rfc?: unknown; readonly monto?: unknown; readonly fecha?: unknown; readonly dateToleranceDays?: unknown }>(c.req.raw, 512 * 1024);
    if (!Array.isArray(raw.movimientos)) throw Errors.validation("movimientos: se esperaba un arreglo.");
    const movimientos = raw.movimientos.map(parseMovimiento);
    const monto = optionalNumber(raw.monto, "monto", NaN);
    if (!Number.isFinite(monto)) throw Errors.validation("monto: se esperaba un número.");
    const fecha = requireString(raw.fecha, "fecha");
    const dateToleranceDays = optionalNumber(raw.dateToleranceDays, "dateToleranceDays", 3);

    if (typeof raw.claveRastreo === "string" && raw.claveRastreo.length > 0) {
      return c.json(verificarSpeiContraMovimientos(raw.claveRastreo, monto, fecha, movimientos, dateToleranceDays));
    }
    if (typeof raw.rfc === "string" && raw.rfc.length > 0) {
      return c.json(verificarPagoProveedor(raw.rfc, monto, fecha, movimientos, dateToleranceDays));
    }
    throw Errors.validation("Se requiere claveRastreo o rfc.");
  });

  // D-35 + D-02: sesiones persistidas, confirmar/deshacer y nivel 4 (LLM) con aprobación humana. Comparten la cadena de middleware de arriba.
  pilotoRef.actual = registrarConciliacionPersistida(app, deps, invoiceARegistroConciliable);

  return app;
}

// D-32 -- motor de honorarios: generacion idempotente de prefacturas del mes, timbrado con PacClient inyectado (reserva compare-and-set
// ANTES del PAC, nunca un UUID inventado) y cancelacion con guardas. NO conoce ningun PAC concreto ni llama a la red por su cuenta.
import { cancelarCfdiDeFactura, timbrarFactura } from "@atiende/billing";
import type { PacClient } from "@atiende/billing";
import { calcularDesglose, evaluarTimbrabilidad, importesParaPac, DesgloseInvalidoError } from "./desglose.ts";
import {
  HonorariosDatosInvalidosError,
  HonorariosEstadoInvalidoError,
  HonorariosNoEncontradoError,
  HonorariosSinPermisoError,
  HonorariosTopeExcedidoError,
} from "./repository.ts";
import type { HonorariosRepository } from "./repository.ts";
import { EXPIRA_RESERVA_SEGUNDOS, MAX_IGUALAS_POR_CLIENTE, MOTIVOS_CANCELACION } from "./types.ts";
import type { CancelacionDatos, IgualaInput, MotivoCancelacion, PrefacturaRecord } from "./types.ts";

export const PERIODO_HONORARIOS_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** No hay credencial de PAC configurada (D-20): la prefactura queda aprobada y la API responde 503 honesto. */
export class HonorariosPacNoConfiguradoError extends Error {
  constructor() {
    super("timbrado pendiente: falta credencial del PAC (D-20)");
    this.name = "HonorariosPacNoConfiguradoError";
  }
}
/** La prefactura no cumple un invariante de timbrado (sin desglose, no cuadra, lleva retenciones sin verificar). Nada se reservo ni se llamo al PAC. */
export class HonorariosNoTimbrableError extends Error {
  constructor(readonly codigo: string, message: string) {
    super(message);
    this.name = "HonorariosNoTimbrableError";
  }
}
/** El PAC fallo (o rechazo): la reserva se libero, la prefactura quedo `fallida` con un codigo corto y puede reintentarse. */
export class HonorariosTimbradoFalloError extends Error {
  constructor(readonly codigo: string) {
    super("El PAC no pudo timbrar la prefactura; puedes reintentar.");
    this.name = "HonorariosTimbradoFalloError";
  }
}
/** El PAC SI timbro pero no se pudo guardar el resultado: NO reintentar a ciegas (crearia un segundo CFDI); hay que conciliar con el UUID. */
export class HonorariosTimbreNoRegistradoError extends Error {
  constructor(readonly uuid: string) {
    super("El CFDI se timbró pero no se pudo guardar el resultado. No reintentes: contacta a soporte con el folio fiscal.");
    this.name = "HonorariosTimbreNoRegistradoError";
  }
}
export class HonorariosCancelacionPacError extends Error {
  constructor() {
    super("El PAC no pudo cancelar el CFDI; la prefactura sigue timbrada.");
    this.name = "HonorariosCancelacionPacError";
  }
}
/** El PAC acepto la solicitud pero el SAT todavia no confirma (p. ej. espera la aceptacion del receptor): la prefactura sigue timbrada. */
export class HonorariosCancelacionPendienteError extends Error {
  constructor() {
    super("El PAC recibió la cancelación pero el SAT aún no la confirma; la prefactura sigue timbrada. Reintenta más tarde.");
    this.name = "HonorariosCancelacionPendienteError";
  }
}

// ----------------------------------------------------------------------------- validacion de una iguala capturada

export interface ErrorCampoHonorarios {
  readonly campo: string;
  readonly mensaje: string;
}

const centavosDe = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);

/** Valida el cuerpo de una iguala. `tasaIvaPorcentaje` y `retencionIsrPorcentaje` llegan como numeros con hasta 2 decimales; se pasan a puntos base. */
export function validarIgualaCapturada(raw: Record<string, unknown>): { ok: true; valor: IgualaInput } | { ok: false; errores: readonly ErrorCampoHonorarios[] } {
  const errores: ErrorCampoHonorarios[] = [];
  const concepto = typeof raw.concepto === "string" ? raw.concepto.trim() : "";
  if (concepto.length < 3 || concepto.length > 200) errores.push({ campo: "concepto", mensaje: "De 3 a 200 caracteres." });
  const claveProdServ = typeof raw.claveProdServ === "string" ? raw.claveProdServ.trim() : "84111500";
  if (!/^[0-9]{8}$/.test(claveProdServ)) errores.push({ campo: "claveProdServ", mensaje: "Clave de producto o servicio del SAT: 8 dígitos (por verificar con el fiscalista)." });
  const claveUnidad = typeof raw.claveUnidad === "string" ? raw.claveUnidad.trim().toUpperCase() : "E48";
  if (!/^[A-Z0-9]{2,3}$/.test(claveUnidad)) errores.push({ campo: "claveUnidad", mensaje: "Clave de unidad del SAT: 2 o 3 caracteres." });
  const monto = centavosDe(raw.montoBaseCentavos);
  if (monto === null || monto <= 0) errores.push({ campo: "montoBaseCentavos", mensaje: "Monto base en centavos enteros, mayor que 0." });
  const tasaIvaBp = centavosDe(raw.tasaIvaBp ?? 1600);
  const retencionIsrBp = centavosDe(raw.retencionIsrBp ?? 0);
  const retieneIva = raw.retieneIvaDosTercios === undefined ? false : raw.retieneIvaDosTercios;
  if (typeof retieneIva !== "boolean") errores.push({ campo: "retieneIvaDosTercios", mensaje: "Verdadero o falso." });
  const diaEmision = centavosDe(raw.diaEmision ?? 1);
  if (diaEmision === null || diaEmision < 1 || diaEmision > 28) errores.push({ campo: "diaEmision", mensaje: "Día del mes de 1 a 28." });
  const usoCfdi = typeof raw.usoCfdi === "string" ? raw.usoCfdi.trim().toUpperCase() : "G03";
  if (!/^[A-Z][0-9]{2}$/.test(usoCfdi)) errores.push({ campo: "usoCfdi", mensaje: "Uso de CFDI del SAT (p. ej. G03)." });
  const activa = raw.activa === undefined ? true : raw.activa;
  if (typeof activa !== "boolean") errores.push({ campo: "activa", mensaje: "Verdadero o falso." });
  if (errores.length === 0) {
    try {
      calcularDesglose({ montoBaseCentavos: monto!, tasaIvaBp: tasaIvaBp ?? -1, retencionIsrBp: retencionIsrBp ?? -1, retieneIvaDosTercios: retieneIva as boolean });
    } catch (err) {
      if (err instanceof DesgloseInvalidoError) errores.push({ campo: "montoBaseCentavos", mensaje: err.message });
      else throw err;
    }
  }
  if (errores.length > 0) return { ok: false, errores };
  return { ok: true, valor: { concepto, claveProdServ, claveUnidad, montoBaseCentavos: monto!, tasaIvaBp: tasaIvaBp!, retencionIsrBp: retencionIsrBp!, retieneIvaDosTercios: retieneIva as boolean, diaEmision: diaEmision!, usoCfdi, activa: activa as boolean } };
}

// ----------------------------------------------------------------------------- generacion

export interface ResultadoGeneracion {
  readonly periodo: string;
  readonly generadas: number;
  readonly yaExistian: number;
  readonly omitidas: readonly { readonly igualaId: string; readonly concepto: string; readonly motivo: string }[];
}

/**
 * Genera la prefactura (borrador) del periodo de cada iguala ACTIVA del cliente. Idempotente: una iguala que ya tiene su prefactura del periodo
 * se cuenta en `yaExistian` y no se toca. Una iguala que la base rechaza por datos (p. ej. el cliente sin ficha fiscal) queda en `omitidas` con
 * su motivo y no impide las demas.
 */
export async function generarPrefacturasDelPeriodo(repo: HonorariosRepository, propertyId: string, periodo: string): Promise<ResultadoGeneracion> {
  if (!PERIODO_HONORARIOS_RE.test(periodo)) throw new HonorariosDatosInvalidosError("periodo: se esperaba el formato AAAA-MM.");
  const lectura = await repo.listarIgualas(propertyId);
  let generadas = 0;
  let yaExistian = 0;
  const omitidas: { igualaId: string; concepto: string; motivo: string }[] = [];
  for (const iguala of lectura.igualas.filter((i) => i.activa)) {
    try {
      const id = await repo.generarPrefactura(propertyId, iguala.id, periodo, calcularDesglose(iguala));
      if (id === null) yaExistian += 1;
      else generadas += 1;
    } catch (err) {
      if (err instanceof HonorariosDatosInvalidosError || err instanceof HonorariosEstadoInvalidoError || err instanceof DesgloseInvalidoError) {
        omitidas.push({ igualaId: iguala.id, concepto: iguala.concepto, motivo: err.message });
      } else throw err;
    }
  }
  return { periodo, generadas, yaExistian, omitidas };
}

// ----------------------------------------------------------------------------- timbrado

/** Unidad de trabajo: cada llamada corre en su PROPIA transaccion (la reserva y el resultado se confirman aunque el PAC tarde o falle). */
export type EnSesion = <T>(fn: (repo: HonorariosRepository) => Promise<T>) => Promise<T>;

export interface DepsTimbrado {
  readonly pac: PacClient | null | undefined;
  readonly enSesion: EnSesion;
  readonly expiraReservaSegundos?: number;
  /** Se invoca despues de dejar la prefactura `fallida` (para emitir el aviso in-app dentro de la misma sesion). */
  readonly alFallar?: (p: PrefacturaRecord, codigo: string, repo: HonorariosRepository) => Promise<void>;
}

export interface ResultadoTimbrado {
  readonly prefactura: PrefacturaRecord;
  /** true si ya estaba timbrada: no se llamo al PAC. */
  readonly yaTimbrada: boolean;
  /** true si el total del CFDI que devolvio el PAC difiere del cobrado (el CFDI ya existe: se avisa, no se oculta). */
  readonly totalNoCuadraConCobro: boolean;
}

/** Codigo corto del fallo (nunca el mensaje crudo del PAC, que podria traer datos del receptor). */
export function codigoDeFalloPac(err: unknown): string {
  const code = err && typeof err === "object" && "code" in err ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[a-z0-9_]{1,40}$/.test(code) ? code : "pac_error";
}

export async function timbrarPrefactura(deps: DepsTimbrado, propertyId: string, prefacturaId: string): Promise<ResultadoTimbrado> {
  const p = await deps.enSesion((repo) => repo.obtenerPrefactura(propertyId, prefacturaId));
  if (!p) throw new HonorariosNoEncontradoError("la prefactura no existe en ese cliente");
  if (p.estado === "timbrada") return { prefactura: p, yaTimbrada: true, totalNoCuadraConCobro: false };
  if (p.estado === "borrador" || p.estado === "cancelada") throw new HonorariosEstadoInvalidoError(`solo se timbra una prefactura aprobada (estado actual: ${p.estado})`);
  if (p.estado === "timbrando") throw new HonorariosEstadoInvalidoError("otra solicitud está timbrando esta prefactura");
  // Sin credencial no se reserva ni se inventa nada: la prefactura se queda como esta (aprobada).
  if (!deps.pac) throw new HonorariosPacNoConfiguradoError();
  const timbrabilidad = evaluarTimbrabilidad(p);
  if (!timbrabilidad.ok) throw new HonorariosNoTimbrableError(timbrabilidad.codigo, timbrabilidad.mensaje);

  // 1) Reserva compare-and-set en su propia transaccion, ANTES de llamar al PAC.
  const gano = await deps.enSesion((repo) => repo.reservarTimbrado(propertyId, prefacturaId, deps.expiraReservaSegundos ?? EXPIRA_RESERVA_SEGUNDOS));
  if (!gano) throw new HonorariosEstadoInvalidoError("otra solicitud ya está timbrando esta prefactura o su estado cambió");

  // 2) El PAC. `referencia` = id de la prefactura, para que el PAC pueda deduplicar un reintento tras un corte.
  const importes = importesParaPac(p);
  let cfdi;
  try {
    cfdi = await timbrarFactura(
      deps.pac,
      { id: p.id, total: importes.total, subtotal: importes.subtotal, iva: importes.iva, referencia: p.id, descripcion: p.concepto },
      { rfc: p.receptor.rfc, razonSocial: p.receptor.razonSocial, regimenFiscal: p.receptor.regimenFiscal, codigoPostal: p.receptor.codigoPostal, usoCfdi: p.usoCfdi },
    );
  } catch (err) {
    const codigo = codigoDeFalloPac(err);
    await deps.enSesion(async (repo) => {
      await repo.registrarFallo(propertyId, prefacturaId, codigo);
      await deps.alFallar?.(p, codigo, repo);
    });
    throw new HonorariosTimbradoFalloError(codigo);
  }

  // 3) El resultado, en su propia transaccion. El CFDI YA existe ante el SAT: si no se puede guardar, no se reintenta a ciegas.
  const totalNoCuadraConCobro = (cfdi as { totalNoCuadraConCobro?: boolean }).totalNoCuadraConCobro === true;
  try {
    await deps.enSesion((repo) => repo.registrarTimbre(propertyId, prefacturaId, { uuid: cfdi.uuid, pacId: cfdi.id, urlPdf: cfdi.urlPdf, urlXml: cfdi.urlXml }));
  } catch {
    throw new HonorariosTimbreNoRegistradoError(cfdi.uuid);
  }
  const final = await deps.enSesion((repo) => repo.obtenerPrefactura(propertyId, prefacturaId));
  return { prefactura: final ?? p, yaTimbrada: false, totalNoCuadraConCobro };
}

// ----------------------------------------------------------------------------- cancelacion

const ESTADOS_CANCELACION_CONFIRMADA = new Set(["cancelado", "cancelada", "canceled", "cancelled"]);

export function validarCancelacion(raw: Record<string, unknown>): { motivo: MotivoCancelacion; folioSustitucion: string | null } {
  const motivo = raw.motivo;
  if (typeof motivo !== "string" || !(MOTIVOS_CANCELACION as readonly string[]).includes(motivo)) throw new HonorariosDatosInvalidosError("motivo: 01, 02, 03 o 04.");
  const folioRaw = raw.folioSustitucion;
  const folio = typeof folioRaw === "string" && folioRaw.trim() !== "" ? folioRaw.trim().toLowerCase() : null;
  if (folioRaw !== undefined && folioRaw !== null && folioRaw !== "" && folio === null) throw new HonorariosDatosInvalidosError("folioSustitucion: UUID del CFDI que sustituye.");
  if (motivo === "01" && (folio === null || !UUID_RE.test(folio))) throw new HonorariosDatosInvalidosError("folioSustitucion: el motivo 01 exige el folio fiscal (UUID) del CFDI que lo sustituye.");
  if (motivo !== "01" && folio !== null) throw new HonorariosDatosInvalidosError("folioSustitucion: solo el motivo 01 lleva folio de sustitución.");
  return { motivo: motivo as MotivoCancelacion, folioSustitucion: folio };
}

export interface DepsCancelacion {
  readonly pac: PacClient | null | undefined;
  readonly enSesion: EnSesion;
}

/**
 * Cancela una prefactura. Una timbrada primero se cancela ante el PAC (sin PAC configurado: 503 y sigue timbrada); solo con el acuse se marca
 * cancelada en la base. Borrador, aprobada y fallida nunca llegaron al PAC: se cancelan localmente. `timbrando` y `cancelada` se rechazan.
 */
export async function cancelarPrefactura(deps: DepsCancelacion, propertyId: string, prefacturaId: string, datos: { motivo: MotivoCancelacion; folioSustitucion: string | null }): Promise<PrefacturaRecord> {
  const p = await deps.enSesion((repo) => repo.obtenerPrefactura(propertyId, prefacturaId));
  if (!p) throw new HonorariosNoEncontradoError("la prefactura no existe en ese cliente");
  if (p.estado === "cancelada") throw new HonorariosEstadoInvalidoError("la prefactura ya está cancelada");
  if (p.estado === "timbrando") throw new HonorariosEstadoInvalidoError("hay un timbrado en curso; espera a que termine");
  let acusePac = false;
  if (p.estado === "timbrada") {
    if (!deps.pac) throw new HonorariosPacNoConfiguradoError();
    if (!p.pacId) throw new HonorariosEstadoInvalidoError("la prefactura timbrada no tiene id del PAC: cancélala desde el portal del PAC");
    let respuesta: { estado: string };
    try {
      respuesta = await cancelarCfdiDeFactura(deps.pac, p.pacId, datos.motivo, datos.folioSustitucion ?? undefined);
    } catch {
      throw new HonorariosCancelacionPacError();
    }
    if (!ESTADOS_CANCELACION_CONFIRMADA.has(String(respuesta.estado).toLowerCase())) throw new HonorariosCancelacionPendienteError();
    acusePac = true;
  }
  const cancelacion: CancelacionDatos = { motivo: datos.motivo, folioSustitucion: datos.folioSustitucion, acusePac };
  await deps.enSesion((repo) => repo.cancelar(propertyId, prefacturaId, cancelacion));
  return (await deps.enSesion((repo) => repo.obtenerPrefactura(propertyId, prefacturaId))) ?? p;
}

// Reexports utiles para las rutas.
export { HonorariosSinPermisoError, HonorariosTopeExcedidoError, MAX_IGUALAS_POR_CLIENTE };

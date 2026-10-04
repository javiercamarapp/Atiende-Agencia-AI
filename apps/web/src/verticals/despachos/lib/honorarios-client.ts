// D-32 -- cliente de honorarios (igualas y prefacturas). Llama a las rutas de apps/api/.../despachos/honorarios.ts. Todo en CENTAVOS ENTEROS;
// el servidor recalcula el desglose y la base lo valida: aqui solo se capturan datos y se muestra el resultado (nada fiscal se calcula en el navegador).
import { deleteJson, fetchJson, postJson, putJson } from "./admin-client.ts";

export type EstadoPrefactura = "borrador" | "aprobada" | "timbrando" | "timbrada" | "cancelada" | "fallida";
export type MotivoCancelacion = "01" | "02" | "03" | "04";

export interface Iguala {
  readonly id: string;
  readonly concepto: string;
  readonly claveProdServ: string;
  readonly claveUnidad: string;
  readonly claveSatEstado: "por_verificar" | "verificada";
  readonly montoBaseCentavos: number;
  readonly tasaIvaBp: number;
  readonly retencionIsrBp: number;
  readonly retieneIvaDosTercios: boolean;
  readonly periodicidad: "mensual";
  readonly diaEmision: number;
  readonly usoCfdi: string;
  readonly activa: boolean;
}

export interface Prefactura {
  readonly id: string;
  readonly igualaId: string;
  readonly periodo: string;
  readonly estado: EstadoPrefactura;
  readonly concepto: string;
  readonly receptor: { readonly rfc: string; readonly razonSocial: string; readonly regimenFiscal: string; readonly codigoPostal: string };
  readonly fechaEmision: string;
  readonly baseCentavos: number;
  readonly ivaCentavos: number;
  readonly retencionIsrCentavos: number;
  readonly retencionIvaCentavos: number;
  readonly totalCentavos: number;
  readonly uuid: string | null;
  readonly urlPdf: string | null;
  readonly urlXml: string | null;
  readonly errorTimbrado: string | null;
  readonly motivoCancelacion: MotivoCancelacion | null;
  readonly timbrable: { readonly ok: true } | { readonly ok: false; readonly motivo: string };
}

export interface ListaIgualas {
  readonly estado: "disponible" | "no_disponible";
  readonly igualas: readonly Iguala[];
}
export interface ListaPrefacturas {
  readonly estado: "disponible" | "no_disponible";
  readonly periodo: string | null;
  readonly pac: { readonly configurado: boolean; readonly mensaje: string | null };
  readonly prefacturas: readonly Prefactura[];
}
export interface ResultadoGeneracion {
  readonly periodo: string;
  readonly generadas: number;
  readonly yaExistian: number;
  readonly omitidas: readonly { readonly igualaId: string; readonly concepto: string; readonly motivo: string }[];
}

export interface IgualaFormulario {
  readonly concepto: string;
  readonly montoPesos: string;
  readonly tasaIvaBp: string;
  readonly retencionIsrPorcentaje: string;
  readonly retieneIvaDosTercios: boolean;
  readonly diaEmision: string;
  readonly usoCfdi: string;
  readonly claveProdServ: string;
  readonly claveUnidad: string;
  readonly activa: boolean;
}

export const FORMULARIO_IGUALA_VACIO: IgualaFormulario = { concepto: "", montoPesos: "", tasaIvaBp: "1600", retencionIsrPorcentaje: "0", retieneIvaDosTercios: false, diaEmision: "1", usoCfdi: "G03", claveProdServ: "84111500", claveUnidad: "E48", activa: true };

export const ETIQUETAS_ESTADO: Readonly<Record<EstadoPrefactura, string>> = { borrador: "Borrador", aprobada: "Aprobada", timbrando: "Timbrando", timbrada: "Timbrada", cancelada: "Cancelada", fallida: "Fallida" };
export const TONOS_ESTADO: Readonly<Record<EstadoPrefactura, "neutral" | "info" | "success" | "warning" | "danger">> = { borrador: "neutral", aprobada: "info", timbrando: "warning", timbrada: "success", cancelada: "neutral", fallida: "danger" };
export const MOTIVOS_CANCELACION: ReadonlyArray<{ readonly clave: MotivoCancelacion; readonly etiqueta: string }> = [
  { clave: "01", etiqueta: "01 · Comprobante emitido con errores con relación" },
  { clave: "02", etiqueta: "02 · Comprobante emitido con errores sin relación" },
  { clave: "03", etiqueta: "03 · No se llevó a cabo la operación" },
  { clave: "04", etiqueta: "04 · Operación nominativa relacionada en una factura global" },
];

const base = (apiBaseUrl: string, propertyId: string) => `${apiBaseUrl}/despachos/${propertyId}/honorarios`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "10" / "10.5" / "0" -> puntos base enteros (1000 / 1050 / 0), sin flotantes; null si no es un porcentaje de 0 a 35 con hasta 2 decimales. */
export function porcentajeABp(texto: string): number | null {
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(texto.trim());
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return bp <= 3500 ? bp : null;
}
export const bpAPorcentaje = (bp: number): string => (bp % 100 === 0 ? String(bp / 100) : (bp / 100).toFixed(2).replace(/0$/, ""));

export function formularioDesdeIguala(i: Iguala, centavosAPesos: (c: number) => string): IgualaFormulario {
  return {
    concepto: i.concepto,
    montoPesos: centavosAPesos(i.montoBaseCentavos),
    tasaIvaBp: String(i.tasaIvaBp),
    retencionIsrPorcentaje: bpAPorcentaje(i.retencionIsrBp),
    retieneIvaDosTercios: i.retieneIvaDosTercios,
    diaEmision: String(i.diaEmision),
    usoCfdi: i.usoCfdi,
    claveProdServ: i.claveProdServ,
    claveUnidad: i.claveUnidad,
    activa: i.activa,
  };
}

/** Errores por campo (vacio = se puede enviar). El servidor y la base repiten TODO. */
export function erroresIguala(f: IgualaFormulario, pesosACentavos: (t: string) => number | null): Record<string, string> {
  const e: Record<string, string> = {};
  if (f.concepto.trim().length < 3 || f.concepto.trim().length > 200) e.concepto = "De 3 a 200 caracteres.";
  const monto = pesosACentavos(f.montoPesos);
  if (monto === null || monto <= 0) e.montoPesos = "Escribe un monto mayor que 0, con hasta 2 decimales.";
  if (porcentajeABp(f.retencionIsrPorcentaje) === null) e.retencionIsrPorcentaje = "Porcentaje de 0 a 35, con hasta 2 decimales.";
  const dia = Number(f.diaEmision);
  if (!Number.isInteger(dia) || dia < 1 || dia > 28) e.diaEmision = "Día del mes de 1 a 28.";
  if (!/^[A-Za-z][0-9]{2}$/.test(f.usoCfdi.trim())) e.usoCfdi = "Uso de CFDI del SAT, p. ej. G03.";
  if (!/^[0-9]{8}$/.test(f.claveProdServ.trim())) e.claveProdServ = "8 dígitos.";
  if (!/^[A-Za-z0-9]{2,3}$/.test(f.claveUnidad.trim())) e.claveUnidad = "2 o 3 caracteres.";
  return e;
}

export function cuerpoIguala(f: IgualaFormulario, pesosACentavos: (t: string) => number | null) {
  return {
    concepto: f.concepto.trim(),
    montoBaseCentavos: pesosACentavos(f.montoPesos),
    tasaIvaBp: Number(f.tasaIvaBp),
    retencionIsrBp: porcentajeABp(f.retencionIsrPorcentaje),
    retieneIvaDosTercios: f.retieneIvaDosTercios,
    diaEmision: Number(f.diaEmision),
    usoCfdi: f.usoCfdi.trim().toUpperCase(),
    claveProdServ: f.claveProdServ.trim(),
    claveUnidad: f.claveUnidad.trim().toUpperCase(),
    activa: f.activa,
  };
}

/** Valida motivo y folio antes de enviar (el servidor y la base repiten la regla). Devuelve un mensaje o null. */
export function errorCancelacion(motivo: string, folio: string): string | null {
  if (!MOTIVOS_CANCELACION.some((m) => m.clave === motivo)) return "Elige el motivo de cancelación del SAT.";
  if (motivo === "01" && !UUID_RE.test(folio.trim())) return "El motivo 01 exige el folio fiscal (UUID) del CFDI que lo sustituye.";
  if (motivo !== "01" && folio.trim() !== "") return "Solo el motivo 01 lleva folio de sustitución.";
  return null;
}

export const fetchIgualas = (f: typeof fetch, api: string, token: string, propertyId: string) => fetchJson<ListaIgualas>(f, `${base(api, propertyId)}/igualas`, token);
export const crearIguala = (f: typeof fetch, api: string, token: string, propertyId: string, cuerpo: unknown) => postJson<{ igualaId: string }>(f, `${base(api, propertyId)}/igualas`, token, cuerpo);
export const editarIguala = (f: typeof fetch, api: string, token: string, propertyId: string, igualaId: string, cuerpo: unknown) => putJson<{ igualaId: string }>(f, `${base(api, propertyId)}/igualas/${igualaId}`, token, cuerpo);
export const eliminarIguala = (f: typeof fetch, api: string, token: string, propertyId: string, igualaId: string) => deleteJson<{ ok: true }>(f, `${base(api, propertyId)}/igualas/${igualaId}`, token);
export const fetchPrefacturas = (f: typeof fetch, api: string, token: string, propertyId: string, periodo: string | null) =>
  fetchJson<ListaPrefacturas>(f, `${base(api, propertyId)}/prefacturas${periodo ? `?periodo=${encodeURIComponent(periodo)}` : ""}`, token);
export const generarPrefacturas = (f: typeof fetch, api: string, token: string, propertyId: string, periodo: string) =>
  postJson<ResultadoGeneracion>(f, `${base(api, propertyId)}/generar-prefacturas?periodo=${encodeURIComponent(periodo)}`, token, {});
export const aprobarPrefactura = (f: typeof fetch, api: string, token: string, propertyId: string, id: string) => postJson<{ prefactura: Prefactura }>(f, `${base(api, propertyId)}/prefacturas/${id}/aprobar`, token, {});
export const timbrarPrefactura = (f: typeof fetch, api: string, token: string, propertyId: string, id: string) =>
  postJson<{ prefactura: Prefactura; yaTimbrada: boolean; advertencias: readonly string[] }>(f, `${base(api, propertyId)}/prefacturas/${id}/timbrar`, token, {});
export const cancelarPrefactura = (f: typeof fetch, api: string, token: string, propertyId: string, id: string, motivo: MotivoCancelacion, folioSustitucion: string | null) =>
  postJson<{ prefactura: Prefactura }>(f, `${base(api, propertyId)}/prefacturas/${id}/cancelar`, token, folioSustitucion ? { motivo, folioSustitucion } : { motivo });

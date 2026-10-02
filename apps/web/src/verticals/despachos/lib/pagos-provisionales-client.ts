// D-25 -- cliente de pagos provisionales de ISR e IVA (papel de trabajo por flujo de efectivo). Llama a las rutas de
// apps/api/.../despachos/pagos-provisionales.ts. Todo en CENTAVOS ENTEROS; el servidor calcula y valida, aqui solo se capturan
// parametros y se muestra el resultado (nada se calcula en el navegador).
import { fetchBlob, fetchJson, postJson, putJson } from "./admin-client.ts";
import { centavosAPesos, pesosACentavos } from "./libro-client.ts";

export type ImpuestoProvisional = "ISR" | "IVA";
export type EstadoCalculo = "calculado" | "no_soportado" | "faltan_parametros";

export interface LineaPapel {
  readonly clave: string;
  readonly concepto: string;
  readonly centavos: number;
  readonly detalle?: string;
}
export interface ResultadoImpuesto {
  readonly impuesto: ImpuestoProvisional;
  readonly estado: EstadoCalculo;
  readonly motivo: string | null;
  readonly lineas: readonly LineaPapel[];
  readonly baseCentavos: number;
  readonly determinadoCentavos: number;
  readonly acreditableCentavos: number;
  readonly aCargoCentavos: number;
  readonly aFavorCentavos: number;
}
export interface ExclusionPapel {
  readonly motivo: string;
  readonly cantidad: number;
  readonly importeCentavos: number;
}
export interface PapelProvisional {
  readonly ejercicio: number;
  readonly mes: number;
  readonly regimen: string;
  readonly isr: ResultadoImpuesto;
  readonly iva: ResultadoImpuesto;
  readonly documentosIncluidos: number;
  readonly exclusiones: readonly ExclusionPapel[];
  readonly pendientesPpd: { readonly cantidad: number; readonly importeCentavos: number };
  readonly advertencias: readonly string[];
}
export interface PapelGuardado {
  readonly id: string;
  readonly mes: number;
  readonly impuesto: ImpuestoProvisional;
  readonly estado: "borrador" | "presentado";
  readonly aCargoCentavos: number;
  readonly aFavorCentavos: number;
  readonly montoPagadoCentavos: number | null;
  readonly fechaPresentacion: string | null;
  readonly updatedAt: string;
}
export interface ParametrosPapel {
  readonly coeficienteUtilidad?: string | null;
  readonly perdidasPendientesCentavos?: number | null;
  readonly ajustePagosPreviosCentavos?: number | null;
  readonly saldoFavorAnteriorCentavos?: number | null;
}
export interface RespuestaPapel {
  readonly ejercicio: number;
  readonly mes: number;
  readonly cliente: { readonly rfc: string; readonly razonSocial: string; readonly regimenes: readonly string[] };
  readonly regimen: string;
  readonly parametros: ParametrosPapel;
  readonly papel: PapelProvisional;
  readonly guardados: readonly PapelGuardado[];
  readonly guardadoDisponible: boolean;
  readonly guardado?: { readonly isr: boolean; readonly iva: boolean };
}
export interface ResultadoRep {
  readonly folioFiscalRep: string;
  readonly flujo: "trasladado" | "acreditable";
  readonly registrados: number;
  readonly yaExistian: number;
  readonly omitidos: readonly { readonly idDocumento: string; readonly motivo: string }[];
  readonly rechazados: readonly { readonly idDocumento: string; readonly motivo: string }[];
  readonly advertencias: readonly string[];
}

export const ETIQUETA_REGIMEN: Readonly<Record<string, string>> = {
  "601": "General de Ley Personas Morales",
  "612": "Personas Físicas con Actividades Empresariales y Profesionales",
  "626": "Régimen Simplificado de Confianza (RESICO)",
};

/** Formulario de parametros (todo texto): pesos para los montos, decimal para el coeficiente. */
export interface ParametrosFormulario {
  readonly regimen: string;
  readonly coeficienteUtilidad: string;
  readonly perdidasPendientes: string;
  readonly ajustePagosPrevios: string;
  readonly saldoFavorAnterior: string;
}

export function formularioDesdeRespuesta(r: RespuestaPapel): ParametrosFormulario {
  const pesos = (c: number | null | undefined) => (c ? centavosAPesos(c) : "");
  return {
    regimen: r.regimen,
    coeficienteUtilidad: r.parametros.coeficienteUtilidad ?? "",
    perdidasPendientes: pesos(r.parametros.perdidasPendientesCentavos),
    ajustePagosPrevios: pesos(r.parametros.ajustePagosPreviosCentavos),
    saldoFavorAnterior: pesos(r.parametros.saldoFavorAnteriorCentavos),
  };
}

export function erroresParametros(f: ParametrosFormulario): Record<string, string> {
  const e: Record<string, string> = {};
  if (f.coeficienteUtilidad.trim() !== "" && !/^\d(\.\d{1,6})?$/.test(f.coeficienteUtilidad.trim())) e.coeficienteUtilidad = "Decimal de 0 a 9.999999 con hasta 6 decimales (p. ej. 0.234567).";
  for (const [campo, valor] of [["perdidasPendientes", f.perdidasPendientes], ["ajustePagosPrevios", f.ajustePagosPrevios], ["saldoFavorAnterior", f.saldoFavorAnterior]] as const) {
    if (valor.trim() !== "" && pesosACentavos(valor) === null) e[campo] = "Monto en pesos con hasta 2 decimales.";
  }
  return e;
}

export function cuerpoParametros(f: ParametrosFormulario): Record<string, unknown> {
  const centavos = (t: string) => (t.trim() === "" ? undefined : (pesosACentavos(t) ?? undefined));
  return {
    regimen: f.regimen,
    ...(f.coeficienteUtilidad.trim() !== "" ? { coeficienteUtilidad: f.coeficienteUtilidad.trim() } : {}),
    ...(centavos(f.perdidasPendientes) !== undefined ? { perdidasPendientesCentavos: centavos(f.perdidasPendientes) } : {}),
    ...(centavos(f.ajustePagosPrevios) !== undefined ? { ajustePagosPreviosCentavos: centavos(f.ajustePagosPrevios) } : {}),
    ...(centavos(f.saldoFavorAnterior) !== undefined ? { saldoFavorAnteriorCentavos: centavos(f.saldoFavorAnterior) } : {}),
  };
}

export interface PresentarFormulario {
  readonly monto: string;
  readonly fecha: string;
  readonly confirmacion: string;
}
export function erroresPresentar(f: PresentarFormulario, impuesto: ImpuestoProvisional, periodo: string, hoy: string): Record<string, string> {
  const e: Record<string, string> = {};
  if (f.monto.trim() === "" || pesosACentavos(f.monto) === null) e.monto = "Monto efectivamente pagado en pesos (0.00 si no hubo pago).";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.fecha)) e.fecha = "Fecha en que se presentó la declaración.";
  else if (f.fecha > hoy) e.fecha = "La fecha no puede ser futura.";
  if (f.confirmacion !== `${impuesto} ${periodo}`) e.confirmacion = `Escribe «${impuesto} ${periodo}» para confirmar.`;
  return e;
}

const base = (apiBaseUrl: string, propertyId: string): string => `${apiBaseUrl}/despachos/${propertyId}/pagos-provisionales`;

export async function fetchPapel(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, periodo: string, regimen?: string): Promise<RespuestaPapel> {
  return fetchJson(f, `${base(apiBaseUrl, propertyId)}/${periodo}${regimen ? `?regimen=${encodeURIComponent(regimen)}` : ""}`, token);
}
export async function calcularPapel(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, periodo: string, form: ParametrosFormulario): Promise<RespuestaPapel> {
  return postJson(f, `${base(apiBaseUrl, propertyId)}/${periodo}/calcular`, token, cuerpoParametros(form));
}
export async function guardarPapel(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, periodo: string, form: ParametrosFormulario): Promise<RespuestaPapel> {
  return putJson(f, `${base(apiBaseUrl, propertyId)}/${periodo}`, token, cuerpoParametros(form));
}
export async function presentarPapel(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, periodo: string, impuesto: ImpuestoProvisional, form: PresentarFormulario): Promise<unknown> {
  return postJson(f, `${base(apiBaseUrl, propertyId)}/${periodo}/presentar`, token, { impuesto, montoPagadoCentavos: pesosACentavos(form.monto), fechaPresentacion: form.fecha, confirmacion: form.confirmacion });
}
export async function exportarPapel(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, periodo: string, formato: "pdf" | "xlsx", regimen: string): Promise<{ readonly blob: Blob; readonly nombre: string }> {
  return fetchBlob(f, `${base(apiBaseUrl, propertyId)}/${periodo}/exportar?formato=${formato}&regimen=${encodeURIComponent(regimen)}`, token, `pagos-provisionales-${periodo}.${formato}`);
}
export async function registrarRep(f: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, xml: string): Promise<ResultadoRep> {
  return postJson(f, `${base(apiBaseUrl, propertyId)}/rep`, token, { xml });
}

// D-21 -- cliente de la cartera de clientes del despacho (ficha fiscal por property). Llama a
// `GET/POST /v1/despachos/:orgSlug/admin/cartera` y `GET/PUT /despachos/:propertyId/cartera/ficha`
// (apps/api/.../despachos/cartera.ts). La validacion de verdad vive en el servidor y en la base; las funciones puras
// de aqui (RFC, payload, resumen) solo dan retroalimentacion inmediata y se prueban sin DOM.
import { fetchJson, postJson, putJson } from "./admin-client.ts";

export type TipoPersona = "fisica" | "moral";
export type PeriodicidadPagos = "mensual" | "bimestral";

export interface RegimenFiscalFicha {
  readonly clave: string;
  readonly nombre: string;
}

export interface ClienteFicha {
  readonly propertyId: string;
  readonly rfc: string;
  readonly tipoPersona: TipoPersona;
  readonly razonSocial: string;
  readonly regimenesFiscales: readonly RegimenFiscalFicha[];
  readonly cpFiscal: string;
  readonly periodicidad: PeriodicidadPagos;
  readonly responsableId: string | null;
  readonly creadoEn: string;
  readonly actualizadoEn: string;
}

export type SemaforoDocumentos = "verde" | "amarillo" | "rojo" | "sin_solicitud";

/** Documentos que el despacho le pidio al cliente para el periodo que se cierra (paridad3 D-31). `null` = base sin la migracion 027. */
export interface DocumentosCliente {
  readonly semaforo: SemaforoDocumentos;
  readonly total: number;
  readonly pendientes: number;
  readonly enRevision: number;
  readonly recibidos: number;
  readonly noAplica: number;
}

export interface ClienteCartera {
  readonly propertyId: string;
  readonly nombre: string;
  readonly ficha: ClienteFicha | null;
  readonly documentos?: DocumentosCliente | null;
}

export interface CarteraRespuesta {
  /** `no_disponible`: la base aun no tiene la migracion de cartera; los clientes llegan SIN ficha. */
  readonly estado: "disponible" | "no_disponible";
  readonly puedeDarDeAlta: boolean;
  /** Periodo (AAAA-MM) al que se refiere el semaforo de documentos; `disponible: false` = base sin la migracion 027. */
  readonly documentosPeriodo?: { readonly periodo: string; readonly disponible: boolean };
  readonly clientes: readonly ClienteCartera[];
}

/** Datos del formulario (alta o edicion de ficha). */
export interface FichaFormulario {
  readonly nombre: string;
  readonly rfc: string;
  readonly razonSocial: string;
  readonly regimenesFiscales: readonly string[];
  readonly cpFiscal: string;
  readonly periodicidad: PeriodicidadPagos;
  readonly responsableId: string;
}

/** Catalogo c_RegimenFiscal del SAT que el servidor acepta (duplicado a proposito: apps/web no depende de los paquetes de dominio; el servidor es la fuente de verdad). */
export const REGIMENES_FISCALES: readonly { readonly clave: string; readonly nombre: string }[] = [
  { clave: "601", nombre: "General de Ley Personas Morales" },
  { clave: "603", nombre: "Personas Morales con Fines no Lucrativos" },
  { clave: "605", nombre: "Sueldos y Salarios e Ingresos Asimilados a Salarios" },
  { clave: "606", nombre: "Arrendamiento" },
  { clave: "607", nombre: "Régimen de Enajenación o Adquisición de Bienes" },
  { clave: "608", nombre: "Demás ingresos" },
  { clave: "610", nombre: "Residentes en el Extranjero sin Establecimiento Permanente en México" },
  { clave: "611", nombre: "Ingresos por Dividendos (socios y accionistas)" },
  { clave: "612", nombre: "Personas Físicas con Actividades Empresariales y Profesionales" },
  { clave: "614", nombre: "Ingresos por intereses" },
  { clave: "615", nombre: "Régimen de los ingresos por obtención de premios" },
  { clave: "616", nombre: "Sin obligaciones fiscales" },
  { clave: "620", nombre: "Sociedades Cooperativas de Producción" },
  { clave: "621", nombre: "Incorporación Fiscal" },
  { clave: "622", nombre: "Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras" },
  { clave: "623", nombre: "Opcional para Grupos de Sociedades" },
  { clave: "624", nombre: "Coordinados" },
  { clave: "625", nombre: "Actividades Empresariales con ingresos por Plataformas Tecnológicas" },
  { clave: "626", nombre: "Régimen Simplificado de Confianza (RESICO)" },
  { clave: "628", nombre: "Hidrocarburos" },
  { clave: "629", nombre: "Regímenes Fiscales Preferentes y Empresas Multinacionales" },
  { clave: "630", nombre: "Enajenación de acciones en bolsa de valores" },
];

export const PERIODICIDAD_ETIQUETAS: Record<PeriodicidadPagos, string> = { mensual: "Mensual", bimestral: "Bimestral" };

export function etiquetaTipoPersona(tipo: TipoPersona): string {
  return tipo === "moral" ? "Persona moral" : "Persona física";
}

const RFC_GENERICOS = new Set(["XAXX010101000", "XEXX010101000"]);
const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/;
const DIAS_MES = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Retroalimentacion inmediata del RFC mientras se escribe (estructura y fecha); `null` = parece valido. El servidor y la base repiten la validacion. */
export function mensajeRfc(crudo: string): string | null {
  const rfc = crudo.trim().toUpperCase();
  if (rfc === "") return "El RFC es obligatorio.";
  if (RFC_GENERICOS.has(rfc)) return "Un RFC genérico no identifica a un cliente.";
  if (rfc.length !== 12 && rfc.length !== 13) return "El RFC tiene 12 (persona moral) o 13 (persona física) caracteres.";
  if (!RFC_RE.test(rfc)) return "El RFC tiene caracteres o una estructura inválidos.";
  const letras = rfc.length === 12 ? 3 : 4;
  const mes = Number(rfc.slice(letras + 2, letras + 4));
  const dia = Number(rfc.slice(letras + 4, letras + 6));
  if (mes < 1 || mes > 12 || dia < 1 || dia > DIAS_MES[mes - 1]!) return "La fecha dentro del RFC no es válida.";
  return null;
}

export function tipoPersonaDeRfc(crudo: string): TipoPersona | null {
  const rfc = crudo.trim().toUpperCase();
  if (mensajeRfc(rfc) !== null) return null;
  return rfc.length === 12 ? "moral" : "fisica";
}

export function mensajeCp(crudo: string): string | null {
  return /^\d{5}$/.test(crudo.trim()) ? null : "El código postal fiscal debe tener 5 dígitos.";
}

/** Errores por campo del formulario (vacio = se puede enviar). */
export function erroresFormulario(f: FichaFormulario, opciones: { readonly alta: boolean }): Record<string, string> {
  const e: Record<string, string> = {};
  if (opciones.alta && f.nombre.trim() === "") e.nombre = "El nombre del cliente es obligatorio.";
  const rfc = mensajeRfc(f.rfc);
  if (rfc) e.rfc = rfc;
  if (f.razonSocial.trim() === "") e.razonSocial = "La razón social es obligatoria.";
  if (f.regimenesFiscales.length === 0) e.regimenesFiscales = "Elige al menos un régimen fiscal.";
  const cp = mensajeCp(f.cpFiscal);
  if (cp) e.cpFiscal = cp;
  return e;
}

/** Cuerpo que espera el servidor; `responsableId` vacio se omite. */
export function cuerpoFicha(f: FichaFormulario, opciones: { readonly alta: boolean }): Record<string, unknown> {
  return {
    ...(opciones.alta ? { nombre: f.nombre.trim() } : {}),
    rfc: f.rfc.trim().toUpperCase(),
    razonSocial: f.razonSocial.trim(),
    regimenesFiscales: [...f.regimenesFiscales],
    cpFiscal: f.cpFiscal.trim(),
    periodicidad: f.periodicidad,
    ...(f.responsableId ? { responsableId: f.responsableId } : {}),
  };
}

export function formularioDesdeCliente(c: ClienteCartera): FichaFormulario {
  return {
    nombre: c.nombre,
    rfc: c.ficha?.rfc ?? "",
    razonSocial: c.ficha?.razonSocial ?? "",
    regimenesFiscales: c.ficha?.regimenesFiscales.map((r) => r.clave) ?? [],
    cpFiscal: c.ficha?.cpFiscal ?? "",
    periodicidad: c.ficha?.periodicidad ?? "mensual",
    responsableId: c.ficha?.responsableId ?? "",
  };
}

export const FORMULARIO_VACIO: FichaFormulario = { nombre: "", rfc: "", razonSocial: "", regimenesFiscales: [], cpFiscal: "", periodicidad: "mensual", responsableId: "" };

/** Resumen de la cartera para el encabezado: cuantos clientes tienen ficha fiscal y cuantos faltan. */
export function resumenCartera(r: CarteraRespuesta): { readonly total: number; readonly conFicha: number; readonly sinFicha: number; readonly mensaje: string } {
  const total = r.clientes.length;
  const conFicha = r.clientes.filter((c) => c.ficha !== null).length;
  const sinFicha = total - conFicha;
  if (r.estado === "no_disponible") {
    return { total, conFicha: 0, sinFicha: total, mensaje: "La cartera fiscal aún no está habilitada en esta base: los clientes se muestran sin ficha." };
  }
  if (total === 0) return { total, conFicha, sinFicha, mensaje: "Todavía no hay clientes en la cartera." };
  if (sinFicha === 0) return { total, conFicha, sinFicha, mensaje: `${total} ${total === 1 ? "cliente" : "clientes"} con ficha fiscal completa.` };
  return { total, conFicha, sinFicha, mensaje: `${sinFicha} de ${total} ${total === 1 ? "cliente" : "clientes"} sin ficha fiscal: sin RFC no se puede distinguir CFDI emitidos de recibidos.` };
}

export async function fetchCartera(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string): Promise<CarteraRespuesta> {
  return fetchJson<CarteraRespuesta>(fetchImpl, `${apiBaseUrl}/v1/despachos/${orgSlug}/admin/cartera`, token);
}

export async function crearCliente(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, orgSlug: string, f: FichaFormulario): Promise<{ readonly propertyId: string; readonly nombre: string }> {
  return postJson<{ propertyId: string; nombre: string }>(fetchImpl, `${apiBaseUrl}/v1/despachos/${orgSlug}/admin/cartera`, token, cuerpoFicha(f, { alta: true }));
}

export async function guardarFicha(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, f: FichaFormulario): Promise<ClienteFicha | null> {
  const r = await putJson<{ ficha: ClienteFicha | null }>(fetchImpl, `${apiBaseUrl}/despachos/${propertyId}/cartera/ficha`, token, cuerpoFicha(f, { alta: false }));
  return r.ficha;
}

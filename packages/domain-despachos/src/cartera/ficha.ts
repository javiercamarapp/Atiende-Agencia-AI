// D-21 -- ficha fiscal de un cliente del despacho (una por property). Validación y normalización puras; la base
// repite las comprobaciones de formato (defensa en profundidad, migración 018) pero la regla de compatibilidad
// régimen <-> tipo de persona vive solo aquí.
import { cfdiCatalogs } from "@atiende/billing";
import { validarRfcCliente } from "./rfc.ts";
import type { TipoPersona } from "./rfc.ts";

export const PERIODICIDADES_PAGOS = ["mensual", "bimestral"] as const;
export type PeriodicidadPagos = (typeof PERIODICIDADES_PAGOS)[number];

/** c_RegimenFiscal solo para personas morales / solo para personas físicas (el resto aplica a ambas). */
const REGIMENES_SOLO_MORAL: ReadonlySet<string> = new Set(["601", "603", "620", "623", "624", "628"]);
const REGIMENES_SOLO_FISICA: ReadonlySet<string> = new Set(["605", "606", "608", "611", "612", "614", "615", "621", "625"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export interface FichaClienteNormalizada {
  readonly rfc: string;
  readonly tipoPersona: TipoPersona;
  readonly razonSocial: string;
  readonly regimenesFiscales: readonly string[];
  readonly cpFiscal: string;
  readonly periodicidad: PeriodicidadPagos;
  readonly responsableId: string | null;
}

export interface ErrorCampo {
  readonly campo: string;
  readonly mensaje: string;
}

export type ResultadoFicha =
  | { readonly ok: true; readonly valor: FichaClienteNormalizada }
  | { readonly ok: false; readonly errores: readonly ErrorCampo[] };

export function validarFichaCliente(crudo: unknown): ResultadoFicha {
  const errores: ErrorCampo[] = [];
  const o = (typeof crudo === "object" && crudo !== null ? crudo : {}) as Record<string, unknown>;

  const rfcRes = validarRfcCliente(o.rfc);
  if (!rfcRes.ok) errores.push({ campo: "rfc", mensaje: rfcRes.motivo });

  const razon = typeof o.razonSocial === "string" ? o.razonSocial.trim().replace(/\s+/g, " ") : "";
  if (razon.length < 1 || razon.length > 250 || CONTROL_RE.test(razon)) errores.push({ campo: "razonSocial", mensaje: "La razón social debe tener de 1 a 250 caracteres." });

  let regimenes: string[] = [];
  if (!Array.isArray(o.regimenesFiscales) || o.regimenesFiscales.length === 0) {
    errores.push({ campo: "regimenesFiscales", mensaje: "Indica al menos un régimen fiscal." });
  } else {
    const limpios = o.regimenesFiscales.map((r) => (typeof r === "string" ? r.trim() : ""));
    const desconocido = limpios.find((r) => !cfdiCatalogs.esRegimenValido(r));
    regimenes = [...new Set(limpios)].sort();
    if (desconocido !== undefined) {
      errores.push({ campo: "regimenesFiscales", mensaje: `'${desconocido}' no es una clave del catálogo c_RegimenFiscal del SAT.` });
    } else if (regimenes.length > 10) {
      errores.push({ campo: "regimenesFiscales", mensaje: "Máximo 10 regímenes fiscales." });
    } else if (rfcRes.ok) {
      const incompatible = regimenes.find((r) => (rfcRes.tipoPersona === "fisica" ? REGIMENES_SOLO_MORAL.has(r) : REGIMENES_SOLO_FISICA.has(r)));
      if (incompatible !== undefined) {
        errores.push({ campo: "regimenesFiscales", mensaje: `El régimen ${incompatible} no aplica a una persona ${rfcRes.tipoPersona === "fisica" ? "física" : "moral"}.` });
      }
    }
  }

  const cp = typeof o.cpFiscal === "string" ? o.cpFiscal.trim() : "";
  if (!/^\d{5}$/.test(cp)) errores.push({ campo: "cpFiscal", mensaje: "El código postal fiscal debe tener 5 dígitos." });

  const periodicidad = o.periodicidad === undefined || o.periodicidad === null ? "mensual" : o.periodicidad;
  if (!(PERIODICIDADES_PAGOS as readonly unknown[]).includes(periodicidad)) errores.push({ campo: "periodicidad", mensaje: "La periodicidad debe ser mensual o bimestral." });

  let responsableId: string | null = null;
  if (o.responsableId !== undefined && o.responsableId !== null && o.responsableId !== "") {
    if (typeof o.responsableId !== "string" || !UUID_RE.test(o.responsableId)) errores.push({ campo: "responsableId", mensaje: "El responsable debe ser un identificador de staff válido." });
    else responsableId = o.responsableId.toLowerCase();
  }

  if (errores.length > 0 || !rfcRes.ok) return { ok: false, errores };
  return {
    ok: true,
    valor: { rfc: rfcRes.rfc, tipoPersona: rfcRes.tipoPersona, razonSocial: razon, regimenesFiscales: regimenes, cpFiscal: cp, periodicidad: periodicidad as PeriodicidadPagos, responsableId },
  };
}

/** Nombre visible del cliente (la property): 1 a 120 caracteres sin controles. */
export function validarNombreCliente(crudo: unknown): { readonly ok: true; readonly nombre: string } | { readonly ok: false; readonly mensaje: string } {
  const nombre = typeof crudo === "string" ? crudo.trim().replace(/\s+/g, " ") : "";
  if (nombre.length < 1 || nombre.length > 120 || CONTROL_RE.test(nombre)) return { ok: false, mensaje: "El nombre del cliente debe tener de 1 a 120 caracteres." };
  return { ok: true, nombre };
}

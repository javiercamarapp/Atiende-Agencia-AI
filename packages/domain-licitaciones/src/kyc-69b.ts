// L-08 -- KYC negativo contra la lista 69-B del SAT (art. 69-B del CFF: contribuyentes con
// operaciones presuntamente inexistentes) para el RFC de proveedores y competidores.
// Piezas PURAS (sin I/O): normalizacion y validacion estricta del RFC, tope de lote,
// clasificacion de la situacion en un semaforo y alerta de proveedor propio. El acceso a la
// base (lector definer de la migracion 031) vive en `kyc-69b-repository.ts`.
//
// Terminologia: la lista la publica el SAT; las situaciones son las del propio SAT
// (presunto, desvirtuado, definitivo, sentencia favorable). "No aparece" significa que el
// RFC no figura en la edicion vigente que cargo la plataforma -- NO es una constancia
// oficial de que el contribuyente este limpio: la fuente de verdad es el SAT. Es una
// herramienta de debida diligencia previa a contratar o competir en ComprasMX / LAASSP.

/** Tope de RFC por consulta (espejo del tope de la funcion SQL `kyc_consultar_69b`). */
export const KYC_MAX_BATCH = 50;
/** Tope de fichas (proveedores + competidores) por organizacion (espejo del trigger SQL). */
export const KYC_MAX_PARTIES = 500;

export const KYC_ROLES = ["proveedor", "competidor"] as const;
export type KycRole = (typeof KYC_ROLES)[number];

export function isKycRole(value: unknown): value is KycRole {
  return typeof value === "string" && (KYC_ROLES as readonly string[]).includes(value);
}

export type Kyc69bSituacion = "presunto" | "desvirtuado" | "definitivo" | "sentencia_favorable";
export const KYC_SITUACIONES: readonly Kyc69bSituacion[] = ["presunto", "desvirtuado", "definitivo", "sentencia_favorable"];

export function isKycSituacion(value: unknown): value is Kyc69bSituacion {
  return typeof value === "string" && (KYC_SITUACIONES as readonly string[]).includes(value);
}

export type KycRfcTipo = "moral" | "fisica";

export class KycValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KycValidationError";
  }
}

/** La base no tiene aun la migracion 031 (o la lista 69-B de despachos): el llamador degrada a "no disponible". */
export class KycNotAvailableError extends Error {
  constructor(message = "El KYC contra la lista 69-B aun no esta disponible en este ambiente.") {
    super(message);
    this.name = "KycNotAvailableError";
  }
}

/** Se alcanzo el tope de RFC consultados por organizacion en 24 horas (anti-scraping). */
export class KycRateLimitError extends Error {
  constructor(message = "Se alcanzo el tope diario de consultas de RFC de tu organizacion. Intenta de nuevo mas tarde.") {
    super(message);
    this.name = "KycRateLimitError";
  }
}

const RFC_GENERICOS: ReadonlySet<string> = new Set(["XAXX010101000", "XEXX010101000"]);

// Persona moral: 3 letras (A-Z, Ñ, &) + fecha AAMMDD + homoclave de 3. Persona fisica: 4 letras.
// Homoclave: 2 caracteres alfanumericos + digito verificador (0-9 o A).
const RFC_RE = /^([A-ZÑ&]{3,4})(\d{2})(\d{2})(\d{2})([A-Z0-9]{2})([0-9A])$/;

const DIAS_POR_MES = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const; // febrero admite 29: el RFC solo trae 2 digitos de anio

/** Mayusculas y sin espacios en los extremos. No transforma nada mas (un RFC con guiones es invalido, no se "arregla"). */
export function normalizeRfc(raw: string): string {
  return raw.trim().toUpperCase();
}

export interface RfcValido {
  readonly rfc: string;
  readonly tipo: KycRfcTipo;
}

/**
 * Valida la FORMA de un RFC ya normalizado o crudo: 12 caracteres (persona moral) o 13
 * (persona fisica), fecha de constitucion/nacimiento calendario valida y homoclave bien
 * formada. NO valida el digito verificador (modulo 11): no se rechaza un RFC real por una
 * excepcion historica; la existencia del contribuyente la confirma el SAT, no esta funcion.
 * Lanza `KycValidationError` con un mensaje apto para el usuario.
 */
export function parseRfc(raw: unknown): RfcValido {
  if (typeof raw !== "string") throw new KycValidationError("El RFC debe ser texto.");
  const rfc = normalizeRfc(raw);
  if (rfc.length === 0) throw new KycValidationError("El RFC esta vacio.");
  if (rfc.length !== 12 && rfc.length !== 13) {
    throw new KycValidationError(`RFC "${rfc.slice(0, 20)}": debe tener 12 caracteres (persona moral) o 13 (persona fisica).`);
  }
  const m = RFC_RE.exec(rfc);
  if (!m) throw new KycValidationError(`RFC "${rfc}": formato invalido (letras, fecha AAMMDD y homoclave).`);
  const mes = Number(m[3]);
  const dia = Number(m[4]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > DIAS_POR_MES[mes - 1]!) {
    throw new KycValidationError(`RFC "${rfc}": la fecha de constitucion o nacimiento no es valida.`);
  }
  if (RFC_GENERICOS.has(rfc)) {
    throw new KycValidationError(`RFC "${rfc}": es un RFC generico (publico en general o extranjero) y no identifica a un contribuyente.`);
  }
  return { rfc, tipo: m[1]!.length === 3 ? "moral" : "fisica" };
}

/**
 * Normaliza y valida un lote: quita duplicados conservando el orden de aparicion y aplica el
 * tope. Un RFC invalido rechaza TODO el lote (nunca se consulta "lo que se pueda"): el
 * mensaje indica cual fue. Nunca devuelve un lote vacio.
 */
export function parseRfcBatch(raw: unknown, max: number = KYC_MAX_BATCH): readonly string[] {
  if (!Array.isArray(raw)) throw new KycValidationError("rfcs debe ser una lista de RFC.");
  if (raw.length === 0) throw new KycValidationError("Indica al menos un RFC.");
  // El tope se aplica a la entrada cruda: un cliente no puede pedir 10 000 duplicados para saltarselo.
  if (raw.length > max) throw new KycValidationError(`Maximo ${max} RFC por consulta.`);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const { rfc } = parseRfc(item);
    if (!seen.has(rfc)) {
      seen.add(rfc);
      out.push(rfc);
    }
  }
  return out;
}

/** Parte un texto pegado por el usuario (comas, espacios, saltos de linea, punto y coma) en candidatos a RFC. */
export function splitRfcText(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Semaforo
// ---------------------------------------------------------------------------

export type KycSemaforo = "rojo" | "ambar" | "verde" | "sin_datos";

export interface KycSemaforoInfo {
  readonly semaforo: KycSemaforo;
  /** Texto corto para la insignia. */
  readonly etiqueta: string;
  /** Explicacion en lenguaje llano, con la terminologia del SAT. */
  readonly detalle: string;
  /** `true` si la situacion justifica alertar a un proveedor propio (presunto o definitivo). */
  readonly accionable: boolean;
}

/**
 * Clasifica la situacion de un RFC en la edicion vigente de la lista 69-B.
 *  - definitivo           -> rojo: el SAT ya publico que las operaciones son inexistentes.
 *  - presunto             -> ambar: el contribuyente puede aun desvirtuar la presuncion.
 *  - desvirtuado /
 *    sentencia favorable  -> verde con nota: salio de la presuncion (el historial no se borra).
 *  - no aparece           -> verde: no figura en la edicion vigente (no es constancia oficial).
 *  - sin lista cargada    -> sin_datos: no se puede afirmar nada.
 */
export function clasificarSituacion(situacion: Kyc69bSituacion | null, listaDisponible: boolean): KycSemaforoInfo {
  if (!listaDisponible) {
    return { semaforo: "sin_datos", etiqueta: "Sin lista", detalle: "La lista 69-B del SAT aun no esta cargada en la plataforma: no se puede decir nada de este RFC.", accionable: false };
  }
  switch (situacion) {
    case "definitivo":
      return { semaforo: "rojo", etiqueta: "Definitivo", detalle: "Figura como definitivo en la lista del art. 69-B del CFF: el SAT publico que sus operaciones son inexistentes.", accionable: true };
    case "presunto":
      return { semaforo: "ambar", etiqueta: "Presunto", detalle: "Figura como presunto en la lista del art. 69-B del CFF: aun puede desvirtuar la presuncion ante el SAT. Evita operar con el hasta que se aclare.", accionable: true };
    case "desvirtuado":
      return { semaforo: "verde", etiqueta: "Desvirtuado", detalle: "Estuvo como presunto en la lista del art. 69-B del CFF y desvirtuo la presuncion. Sin riesgo vigente, pero conserva ese antecedente.", accionable: false };
    case "sentencia_favorable":
      return { semaforo: "verde", etiqueta: "Sentencia favorable", detalle: "Estuvo en la lista del art. 69-B del CFF y obtuvo una sentencia o resolucion favorable. Sin riesgo vigente, pero conserva ese antecedente.", accionable: false };
    default:
      return { semaforo: "verde", etiqueta: "No aparece", detalle: "No figura en la edicion vigente de la lista 69-B del SAT cargada en la plataforma. No es una constancia oficial: verifica en el portal del SAT si el contrato lo amerita.", accionable: false };
  }
}

export interface KycConsultaFila {
  readonly rfc: string;
  readonly encontrado: boolean;
  readonly periodo: string | null;
  readonly nombre: string | null;
  readonly situacion: Kyc69bSituacion | null;
  readonly oficioPresuncion: string | null;
  /** Fecha de publicacion en el SAT de la etapa vigente (YYYY-MM-DD), segun la situacion. */
  readonly fechaPublicacion: string | null;
  readonly fechaPresuncionSat: string | null;
  readonly fechaDesvirtuadoSat: string | null;
  readonly fechaDefinitivoSat: string | null;
  readonly fechaSentenciaFavorableSat: string | null;
}

export interface KycConsultaResultado {
  /** `false` si no hay ninguna edicion cargada de la lista (ningun RFC se puede evaluar). */
  readonly listaDisponible: boolean;
  readonly periodo: string | null;
  readonly filas: readonly (KycConsultaFila & KycSemaforoInfo)[];
}

export interface KycFicha {
  readonly id: string;
  readonly rfc: string;
  readonly rol: KycRole;
  readonly nombre: string;
  readonly creadaEn: string;
  readonly periodo: string | null;
  readonly encontrado: boolean;
  readonly situacion: Kyc69bSituacion | null;
  readonly fechaPublicacion: string | null;
}

export type KycFichaConSemaforo = KycFicha & KycSemaforoInfo;

export interface KycFichasResultado {
  readonly listaDisponible: boolean;
  readonly periodo: string | null;
  readonly fichas: readonly KycFichaConSemaforo[];
  /** Proveedores propios con situacion accionable (presunto o definitivo): la alerta. */
  readonly alertas: readonly KycFichaConSemaforo[];
}

/** Arma el resultado de fichas con semaforo y la alerta de proveedor propio. */
export function armarFichasResultado(fichas: readonly KycFicha[]): KycFichasResultado {
  const periodo = fichas.find((f) => f.periodo !== null)?.periodo ?? null;
  const listaDisponible = periodo !== null;
  const conSemaforo = fichas.map((f) => ({ ...f, ...clasificarSituacion(f.situacion, listaDisponible) }));
  const alertas = conSemaforo.filter((f) => f.rol === "proveedor" && f.accionable);
  return { listaDisponible, periodo, fichas: conSemaforo, alertas };
}

export function armarConsultaResultado(filas: readonly KycConsultaFila[]): KycConsultaResultado {
  const periodo = filas.find((f) => f.periodo !== null)?.periodo ?? null;
  const listaDisponible = periodo !== null;
  return { listaDisponible, periodo, filas: filas.map((f) => ({ ...f, ...clasificarSituacion(f.situacion, listaDisponible) })) };
}

/** Normaliza el nombre de una ficha (opcional, hasta 200 caracteres, espacios colapsados). */
export function parseNombreFicha(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") throw new KycValidationError("El nombre debe ser texto.");
  const nombre = raw.replace(/\s+/g, " ").trim();
  if (nombre.length > 200) throw new KycValidationError("El nombre no puede pasar de 200 caracteres.");
  return nombre;
}

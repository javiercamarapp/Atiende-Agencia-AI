// F4c (3) -- SUBIR PDF o IMAGEN a la base de conocimiento (voz y WhatsApp comparten `conocimiento_negocio`, 053).
// Flujo: validar (tamano, tipo REAL por firma, nombre) -> escanear (adaptador; heuristico por omision) -> extraer texto (adaptador; la extraccion REAL es una interfaz
// y hoy NO esta configurada) -> trocear -> validar cada trozo como cualquier conocimiento (sin precios ni nombres del menu) -> BORRADORES (origen 'importado') que el dueno
// revisa y publica. El archivo NO se guarda: solo su registro (nombre, tipo, tamano, huella, ids de los borradores). Borrar el archivo borra sus borradores.
// Sin extractor configurado la carga responde "no disponible aun" (nada de maquetas): el codigo de este modulo ya es real y se prueba con un extractor FALSO.
import { createHash } from "node:crypto";
import { runWithSavepointFallback } from "@atiende/db";
import type { TenantDbSession } from "@atiende/core-tenancy";
import { validarEntradaConocimiento } from "../conocimiento/dominio.ts";
import type { ConocimientoEntrada, NuevaConocimientoEntrada } from "../conocimiento/types.ts";
import { sanitizeInlineText } from "../text-sanitize.ts";
import { ParidadNoDisponibleError, ParidadRechazadaError, codigoPg, esBaseSinMigrar, esErrorEscrituraConocido, iso } from "./comun.ts";

export const ARCHIVO_TIPOS = Object.freeze({ "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const);
export type MimeArchivo = keyof typeof ARCHIVO_TIPOS;
/** Topes por tipo. El archivo viaja en base64 dentro de un JSON y la funcion de Vercel acepta ~4.5 MB por peticion: 3 MiB de PDF (4 MiB en base64) es lo que cabe. El CHECK de la base acepta hasta 5 MiB. */
export const ARCHIVO_MAX_BYTES: Readonly<Record<MimeArchivo, number>> = Object.freeze({ "application/pdf": 3 * 1024 * 1024, "image/png": 2 * 1024 * 1024, "image/jpeg": 2 * 1024 * 1024, "image/webp": 2 * 1024 * 1024 });
/** Tope del cuerpo JSON de la carga (el mayor archivo en base64 + sobre). */
export const ARCHIVO_CUERPO_MAX_BYTES = Math.ceil((3 * 1024 * 1024 * 4) / 3) + 8 * 1024;
export const ARCHIVOS_MAX_POR_ORGANIZACION = 20;
export const TROZO_MAX_CARACTERES = 1800;
export const TROZOS_MAX_POR_ARCHIVO = 20;
export const TEXTO_EXTRAIDO_MAX = 40_000;

export type MotivoArchivoInvalido = "vacio" | "demasiado_grande" | "tipo_no_permitido" | "tipo_no_coincide" | "nombre_invalido" | "contenido_sospechoso";

export type ResultadoValidacionArchivo =
  | { readonly ok: true; readonly mime: MimeArchivo; readonly nombre: string; readonly sha256: string; readonly tamanoBytes: number }
  | { readonly ok: false; readonly motivo: MotivoArchivoInvalido; readonly mensaje: string };

const startsWith = (b: Uint8Array, firma: readonly number[], desde = 0): boolean => firma.every((v, i) => b[desde + i] === v);

/** Tipo REAL por firma (magic bytes); nunca confia en la extension ni en el Content-Type declarado. `null` = no es de los permitidos. */
export function detectarMimeReal(b: Uint8Array): MimeArchivo | null {
  if (b.length >= 5 && startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (b.length >= 8 && startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (b.length >= 3 && startsWith(b, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (b.length >= 12 && startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp"; // RIFF....WEBP
  return null;
}

const EXTENSIONES: Readonly<Record<MimeArchivo, readonly string[]>> = { "application/pdf": ["pdf"], "image/png": ["png"], "image/jpeg": ["jpg", "jpeg"], "image/webp": ["webp"] };

/** Nombre mostrable: sin ruta, sin controles, acotado. `null` si queda vacio. */
export function nombreArchivoSeguro(nombre: string): string | null {
  const base = nombre.replace(/\\/g, "/").split("/").pop() ?? "";
  const limpio = sanitizeInlineText(base, 120).replace(/[<>:"|?*]/g, "_");
  return limpio === "" || limpio === "." || limpio === ".." ? null : limpio;
}

export function validarArchivoEntrante(e: { readonly nombre: string; readonly mimeDeclarado: string; readonly bytes: Uint8Array }): ResultadoValidacionArchivo {
  if (e.bytes.length === 0) return { ok: false, motivo: "vacio", mensaje: "El archivo esta vacio." };
  const nombre = nombreArchivoSeguro(e.nombre);
  if (!nombre) return { ok: false, motivo: "nombre_invalido", mensaje: "El nombre del archivo no es valido." };
  const mime = detectarMimeReal(e.bytes);
  if (!mime) return { ok: false, motivo: "tipo_no_permitido", mensaje: "Solo se aceptan PDF e imagenes PNG, JPG o WebP (el contenido real del archivo no coincide con ninguno)." };
  if (e.bytes.length > ARCHIVO_MAX_BYTES[mime]) return { ok: false, motivo: "demasiado_grande", mensaje: `El archivo pesa ${(e.bytes.length / 1048576).toFixed(1)} MB; el maximo para este tipo es ${ARCHIVO_MAX_BYTES[mime] / 1048576} MB.` };
  if (e.mimeDeclarado.split(";")[0]!.trim().toLowerCase() !== mime) return { ok: false, motivo: "tipo_no_coincide", mensaje: "El tipo declarado no coincide con el contenido real del archivo." };
  const ext = (nombre.includes(".") ? nombre.split(".").pop()! : "").toLowerCase();
  if (!EXTENSIONES[mime].includes(ext)) return { ok: false, motivo: "tipo_no_coincide", mensaje: "La extension del archivo no coincide con su contenido real." };
  return { ok: true, mime, nombre, tamanoBytes: e.bytes.length, sha256: createHash("sha256").update(e.bytes).digest("hex") };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Escaneo. La interfaz admite un antivirus real (p. ej. ClamAV por socket); hoy NO hay uno configurado: el heuristico de abajo es una barrera barata, NO un antivirus.
export type ResultadoEscaneo = { readonly limpio: true } | { readonly limpio: false; readonly motivo: string };
export interface EscanerArchivo {
  escanear(bytes: Uint8Array, mime: MimeArchivo): Promise<ResultadoEscaneo>;
}

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
/** Claves de PDF con contenido activo; se buscan DESPUES de deshacer los escapes `#xx` de los nombres (`/J#61vaScript`). */
const PDF_ACTIVO = /\/(JavaScript|JS|Launch|EmbeddedFile|EmbeddedFiles|OpenAction|AA|RichMedia|XFA|SubmitForm|ImportData|GoToR|GoToE)(?![A-Za-z0-9])/;
const POLIGLOTA = /<\?php|<script|<%@|<%=|#!\/bin\/|#!\/usr\/bin\/|powershell|cmd\.exe/i;

export class EscanerHeuristico implements EscanerArchivo {
  async escanear(bytes: Uint8Array, mime: MimeArchivo): Promise<ResultadoEscaneo> {
    const texto = Buffer.from(bytes).toString("latin1");
    if (texto.includes(EICAR)) return { limpio: false, motivo: "firma de prueba antivirus (EICAR)" };
    if (mime === "application/pdf") {
      const normal = texto.replace(/#([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
      if (PDF_ACTIVO.test(normal)) return { limpio: false, motivo: "el PDF trae contenido activo (scripts, archivos incrustados o acciones automaticas)" };
    }
    if (mime !== "application/pdf" && POLIGLOTA.test(texto)) return { limpio: false, motivo: "la imagen trae codigo incrustado" };
    // Un ejecutable (PE / ELF) escondido DESPUES de la cabecera valida: se busca la firma en el cuerpo (la de ELF son 4 bytes: un falso positivo en datos comprimidos es posible pero raro).
    // eslint-disable-next-line no-control-regex
    if (/MZ[\x00-\xff]{2}PE\x00\x00|\x7fELF/.test(texto)) return { limpio: false, motivo: "contiene un ejecutable incrustado" };
    return { limpio: true };
  }
}

/** Escaner que sirve a las pruebas: marca como infectado lo que se le pida. */
export class EscanerFalso implements EscanerArchivo {
  readonly escaneados: string[] = [];
  constructor(private readonly infectados: ReadonlySet<string> = new Set()) {}
  async escanear(bytes: Uint8Array): Promise<ResultadoEscaneo> {
    const sha = createHash("sha256").update(bytes).digest("hex");
    this.escaneados.push(sha);
    return this.infectados.has(sha) ? { limpio: false, motivo: "marcado por el escaner de prueba" } : { limpio: true };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Extraccion de texto: interfaz. La implementacion real (parser de PDF / OCR de imagenes) NO existe todavia.
export type ResultadoExtraccion = { readonly ok: true; readonly texto: string } | { readonly ok: false; readonly motivo: "extractor_no_configurado" | "sin_texto" | "error" };
export interface ExtractorTexto {
  /** `false` = no hay extractor real: las rutas responden "no disponible aun" en vez de aceptar el archivo y no hacer nada. */
  readonly disponible: boolean;
  extraer(entrada: { readonly bytes: Uint8Array; readonly mime: MimeArchivo; readonly nombre: string }): Promise<ResultadoExtraccion>;
}

export class ExtractorTextoNoConfigurado implements ExtractorTexto {
  readonly disponible = false;
  async extraer(): Promise<ResultadoExtraccion> {
    return { ok: false, motivo: "extractor_no_configurado" };
  }
}

/** Extractor FALSO para pruebas y desarrollo: devuelve el texto que se le dio (por huella del archivo) o uno fijo. Nunca lee los bytes. */
export class ExtractorTextoFalso implements ExtractorTexto {
  readonly disponible = true;
  readonly llamadas: string[] = [];
  constructor(private readonly textoPorDefecto: string | null = null, private readonly porHuella: ReadonlyMap<string, string> = new Map()) {}
  async extraer(e: { readonly bytes: Uint8Array; readonly mime: MimeArchivo; readonly nombre: string }): Promise<ResultadoExtraccion> {
    const sha = createHash("sha256").update(e.bytes).digest("hex");
    this.llamadas.push(sha);
    const texto = this.porHuella.get(sha) ?? this.textoPorDefecto;
    return texto && texto.trim() !== "" ? { ok: true, texto } : { ok: false, motivo: "sin_texto" };
  }
}

/** Parte el texto extraido en trozos de hasta `TROZO_MAX_CARACTERES` respetando parrafos; descarta los vacios. */
export function trocearTexto(texto: string): { readonly trozos: readonly string[]; readonly truncado: boolean } {
  const limpio = texto.replace(/\r\n?/g, "\n").slice(0, TEXTO_EXTRAIDO_MAX);
  const parrafos = limpio.split(/\n{2,}/).map((p) => p.replace(/[ \t]+/g, " ").trim()).filter((p) => p !== "");
  const trozos: string[] = [];
  let actual = "";
  const cerrar = () => {
    if (actual.trim() !== "") trozos.push(actual.trim());
    actual = "";
  };
  for (const parrafo of parrafos) {
    for (let i = 0; i < parrafo.length; i += TROZO_MAX_CARACTERES) {
      const pedazo = parrafo.slice(i, i + TROZO_MAX_CARACTERES);
      if (actual !== "" && actual.length + pedazo.length + 2 > TROZO_MAX_CARACTERES) cerrar();
      actual = actual === "" ? pedazo : `${actual}\n\n${pedazo}`;
    }
  }
  cerrar();
  return { trozos: trozos.slice(0, TROZOS_MAX_POR_ARCHIVO), truncado: trozos.length > TROZOS_MAX_POR_ARCHIVO || texto.length > TEXTO_EXTRAIDO_MAX };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Registro de cargas
export interface ArchivoConocimiento {
  readonly id: string;
  readonly organizationId: string;
  readonly nombre: string;
  readonly mime: MimeArchivo;
  readonly tamanoBytes: number;
  readonly sha256: string;
  readonly caracteresTexto: number;
  readonly entradasIds: readonly string[];
  readonly subidoPor: string | null;
  readonly createdAt: string;
}
export type NuevoArchivoConocimiento = Omit<ArchivoConocimiento, "id" | "createdAt" | "organizationId">;

export interface LecturaArchivos {
  /** false = la base todavia no tiene la migracion 182. */
  readonly disponible: boolean;
  readonly archivos: readonly ArchivoConocimiento[];
}

export interface ArchivosConocimientoRepository {
  listar(organizationId: string): Promise<LecturaArchivos>;
  buscarPorHuella(organizationId: string, sha256: string): Promise<ArchivoConocimiento | null>;
  obtener(organizationId: string, id: string): Promise<ArchivoConocimiento | null>;
  crear(organizationId: string, archivo: NuevoArchivoConocimiento): Promise<ArchivoConocimiento>;
  borrar(organizationId: string, id: string): Promise<boolean>;
}

interface FilaArchivo {
  id: string;
  organization_id: string;
  nombre: string;
  mime: string;
  tamano_bytes: number;
  sha256: string;
  caracteres_texto: number;
  entradas_ids: readonly string[];
  subido_por: string | null;
  created_at: Date | string;
}
const COLS = "id, organization_id, nombre, mime, tamano_bytes, sha256, caracteres_texto, entradas_ids, subido_por, created_at";
const mapFila = (f: FilaArchivo): ArchivoConocimiento => ({
  id: f.id,
  organizationId: f.organization_id,
  nombre: f.nombre,
  mime: f.mime as MimeArchivo,
  tamanoBytes: f.tamano_bytes,
  sha256: f.sha256,
  caracteresTexto: f.caracteres_texto,
  entradasIds: f.entradas_ids ?? [],
  subidoPor: f.subido_por,
  createdAt: iso(f.created_at),
});

export class PostgresArchivosConocimientoRepository implements ArchivosConocimientoRepository {
  constructor(private readonly db: TenantDbSession) {}

  async listar(organizationId: string): Promise<LecturaArchivos> {
    return runWithSavepointFallback<LecturaArchivos>({
      session: this.db,
      savepointName: "sp_conocimiento_archivos_list",
      primary: async () => {
        const { rows } = await this.db.query<FilaArchivo>(`select ${COLS} from restaurantes.conocimiento_archivos where organization_id = $1 order by created_at desc limit 100;`, [organizationId]);
        return { disponible: true, archivos: rows.map(mapFila) };
      },
      isRecoverable: esBaseSinMigrar,
      fallback: async () => ({ disponible: false, archivos: [] }),
    });
  }

  async buscarPorHuella(organizationId: string, sha256: string): Promise<ArchivoConocimiento | null> {
    const { rows } = await this.db.query<FilaArchivo>(`select ${COLS} from restaurantes.conocimiento_archivos where organization_id = $1 and sha256 = $2;`, [organizationId, sha256]);
    return rows[0] ? mapFila(rows[0]) : null;
  }

  async obtener(organizationId: string, id: string): Promise<ArchivoConocimiento | null> {
    const { rows } = await this.db.query<FilaArchivo>(`select ${COLS} from restaurantes.conocimiento_archivos where organization_id = $1 and id = $2;`, [organizationId, id]);
    return rows[0] ? mapFila(rows[0]) : null;
  }

  async crear(organizationId: string, a: NuevoArchivoConocimiento): Promise<ArchivoConocimiento> {
    return runWithSavepointFallback<ArchivoConocimiento>({
      session: this.db,
      savepointName: "sp_conocimiento_archivos_insert",
      primary: async () => {
        const { rows } = await this.db.query<FilaArchivo>(
          `insert into restaurantes.conocimiento_archivos (organization_id, nombre, mime, tamano_bytes, sha256, caracteres_texto, entradas_ids, subido_por)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning ${COLS};`,
          [organizationId, a.nombre, a.mime, a.tamanoBytes, a.sha256, a.caracteresTexto, [...a.entradasIds], a.subidoPor],
        );
        return mapFila(rows[0]!);
      },
      isRecoverable: esErrorEscrituraConocido,
      fallback: async (err) => {
        if (codigoPg(err) === "42501") throw new ParidadRechazadaError("No tienes permiso para subir archivos de conocimiento.");
        throw new ParidadNoDisponibleError("Subir archivos de conocimiento requiere aplicar la migracion 182; no se guardo nada.");
      },
    });
  }

  async borrar(organizationId: string, id: string): Promise<boolean> {
    const { rows } = await this.db.query<{ id: string }>(`delete from restaurantes.conocimiento_archivos where organization_id = $1 and id = $2 returning id;`, [organizationId, id]);
    return rows.length > 0;
  }
}

/** Adaptador en memoria para pruebas. `migrada = false` simula la base sin la 182. */
export class InMemoryArchivosConocimientoRepository implements ArchivosConocimientoRepository {
  migrada = true;
  private readonly filas: ArchivoConocimiento[] = [];
  private seq = 0;

  async listar(organizationId: string): Promise<LecturaArchivos> {
    if (!this.migrada) return { disponible: false, archivos: [] };
    return { disponible: true, archivos: this.filas.filter((f) => f.organizationId === organizationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)) };
  }
  async buscarPorHuella(organizationId: string, sha256: string): Promise<ArchivoConocimiento | null> {
    return this.filas.find((f) => f.organizationId === organizationId && f.sha256 === sha256) ?? null;
  }
  async obtener(organizationId: string, id: string): Promise<ArchivoConocimiento | null> {
    return this.filas.find((f) => f.organizationId === organizationId && f.id === id) ?? null;
  }
  async crear(organizationId: string, a: NuevoArchivoConocimiento): Promise<ArchivoConocimiento> {
    if (!this.migrada) throw new ParidadNoDisponibleError("Subir archivos de conocimiento requiere aplicar la migracion 182; no se guardo nada.");
    if (this.filas.some((f) => f.organizationId === organizationId && f.sha256 === a.sha256)) throw Object.assign(new Error("duplicado"), { code: "23505" });
    this.seq += 1;
    const fila: ArchivoConocimiento = { ...a, id: `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`, organizationId, createdAt: new Date().toISOString() };
    this.filas.push(fila);
    return fila;
  }
  async borrar(organizationId: string, id: string): Promise<boolean> {
    const i = this.filas.findIndex((f) => f.organizationId === organizationId && f.id === id);
    if (i < 0) return false;
    this.filas.splice(i, 1);
    return true;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Servicio
/** Lo minimo del repositorio de conocimiento que usa el servicio (lo cumple `RestaurantesRepository`). */
export interface PuertoConocimiento {
  crearConocimiento(organizationId: string, actorId: string, input: NuevaConocimientoEntrada): Promise<ConocimientoEntrada>;
  borrarConocimiento(organizationId: string, id: string): Promise<boolean>;
}

export interface DependenciasCarga {
  readonly escaner: EscanerArchivo;
  readonly extractor: ExtractorTexto;
  readonly archivos: ArchivosConocimientoRepository;
  readonly conocimiento: PuertoConocimiento;
  /** Nombres del menu: un trozo que los nombre se omite (el producto sale siempre de las herramientas). */
  readonly nombresCatalogo: readonly string[];
}

export type ResultadoCarga =
  | { readonly estado: "procesado"; readonly archivo: ArchivoConocimiento; readonly borradores: number; readonly omitidos: readonly { readonly parte: number; readonly motivo: string }[]; readonly truncado: boolean }
  | { readonly estado: "rechazado"; readonly motivo: MotivoArchivoInvalido | "infectado" | "limite_de_archivos" | "duplicado" | "sin_contenido_utilizable" | "sin_texto"; readonly mensaje: string }
  | { readonly estado: "no_disponible"; readonly mensaje: string };

export async function procesarCargaArchivo(
  deps: DependenciasCarga,
  e: { readonly organizationId: string; readonly actorId: string; readonly nombre: string; readonly mimeDeclarado: string; readonly bytes: Uint8Array },
): Promise<ResultadoCarga> {
  const v = validarArchivoEntrante(e);
  if (!v.ok) return { estado: "rechazado", motivo: v.motivo, mensaje: v.mensaje };
  if (!deps.extractor.disponible) {
    return { estado: "no_disponible", mensaje: "No disponible aun: falta configurar la extraccion de texto de PDF e imagenes (OCR). Mientras tanto, escribe el conocimiento a mano en Conocimiento del negocio." };
  }
  const lectura = await deps.archivos.listar(e.organizationId);
  if (!lectura.disponible) return { estado: "no_disponible", mensaje: "No disponible aun: la base de datos requiere la migracion 182 (archivos de conocimiento)." };
  if (lectura.archivos.length >= ARCHIVOS_MAX_POR_ORGANIZACION) return { estado: "rechazado", motivo: "limite_de_archivos", mensaje: `Ya hay ${ARCHIVOS_MAX_POR_ORGANIZACION} archivos cargados; borra uno antes de subir otro.` };
  if (lectura.archivos.some((a) => a.sha256 === v.sha256)) return { estado: "rechazado", motivo: "duplicado", mensaje: "Ese archivo ya se cargo antes." };

  const escaneo = await deps.escaner.escanear(e.bytes, v.mime);
  if (!escaneo.limpio) return { estado: "rechazado", motivo: "infectado", mensaje: `Archivo rechazado: ${escaneo.motivo}.` };

  const extraccion = await deps.extractor.extraer({ bytes: e.bytes, mime: v.mime, nombre: v.nombre });
  if (!extraccion.ok) {
    if (extraccion.motivo === "extractor_no_configurado") return { estado: "no_disponible", mensaje: "No disponible aun: falta configurar la extraccion de texto." };
    return { estado: "rechazado", motivo: "sin_texto", mensaje: "No se pudo leer texto en el archivo." };
  }
  const { trozos, truncado } = trocearTexto(extraccion.texto);
  const aceptados: { titulo: string; texto: string }[] = [];
  const omitidos: { parte: number; motivo: string }[] = [];
  trozos.forEach((trozo, i) => {
    const titulo = `${v.nombre.replace(/\.[^.]+$/, "")} (parte ${i + 1})`.slice(0, 120);
    const r = validarEntradaConocimiento({ titulo, texto: trozo }, deps.nombresCatalogo);
    if (r.ok) aceptados.push({ titulo: r.titulo, texto: r.texto });
    else omitidos.push({ parte: i + 1, motivo: r.motivo });
  });
  if (aceptados.length === 0) return { estado: "rechazado", motivo: "sin_contenido_utilizable", mensaje: "El archivo no dejo ningun trozo utilizable (precios, nombres del menu o texto vacio)." };

  const creadas: ConocimientoEntrada[] = [];
  for (const a of aceptados) {
    creadas.push(
      await deps.conocimiento.crearConocimiento(e.organizationId, e.actorId, { titulo: a.titulo, texto: a.texto, tipo: "faq", prioridad: 30, estado: "borrador", origen: "importado", activo: true }),
    );
  }
  const archivo = await deps.archivos.crear(e.organizationId, {
    nombre: v.nombre,
    mime: v.mime,
    tamanoBytes: v.tamanoBytes,
    sha256: v.sha256,
    caracteresTexto: aceptados.reduce((n, a) => n + a.texto.length, 0),
    entradasIds: creadas.map((c) => c.id),
    subidoPor: e.actorId,
  });
  return { estado: "procesado", archivo, borradores: creadas.length, omitidos, truncado };
}

/** Borra el registro y TODOS los borradores/entradas que genero. `null` = no existe. */
export async function borrarArchivoConocimiento(deps: Pick<DependenciasCarga, "archivos" | "conocimiento">, organizationId: string, id: string): Promise<{ readonly archivo: ArchivoConocimiento; readonly entradasBorradas: number } | null> {
  const archivo = await deps.archivos.obtener(organizationId, id);
  if (!archivo) return null;
  let entradasBorradas = 0;
  for (const entradaId of archivo.entradasIds) {
    if (await deps.conocimiento.borrarConocimiento(organizationId, entradaId)) entradasBorradas += 1;
  }
  await deps.archivos.borrar(organizationId, id);
  return { archivo, entradasBorradas };
}

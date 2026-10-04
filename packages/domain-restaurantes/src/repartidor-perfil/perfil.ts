// R-15: perfil operativo del repartidor (migracion 043). Tipos, validacion de la entrada y las reglas puras de la licencia.
// Los telefonos se validan con `canonicalizeMexicanPhone` (phone.ts): se guardan SOLO los 10 digitos nacionales, igual que
// `restaurantes.customers`. La base repite estas validaciones (la fuente de verdad es SQL).
import { canonicalizeMexicanPhone } from "../phone.ts";
import { fechaNegocioValida } from "../cierres/cierre.ts";

export const VEHICULO_TIPOS = ["moto", "bicicleta", "auto", "a_pie", "otro"] as const;
export type VehiculoTipo = (typeof VEHICULO_TIPOS)[number];
export const VEHICULO_ETIQUETAS: Readonly<Record<VehiculoTipo, string>> = { moto: "Moto", bicicleta: "Bicicleta", auto: "Auto", a_pie: "A pie", otro: "Otro" };

export const DISPONIBILIDADES = ["disponible", "en_descanso", "fuera_de_turno"] as const;
export type Disponibilidad = (typeof DISPONIBILIDADES)[number];
export const DISPONIBILIDAD_ETIQUETAS: Readonly<Record<Disponibilidad, string>> = { disponible: "Disponible", en_descanso: "En descanso", fuera_de_turno: "Fuera de turno" };

/** Dias de anticipacion con los que la licencia se marca "por vencer" (alerta visual y aviso al owner). */
export const LICENCIA_AVISO_DIAS = 30;

export interface RepartidorPerfilEntrada {
  readonly vehiculoTipo: VehiculoTipo | null;
  readonly placas: string | null;
  readonly disponibilidad: Disponibilidad;
  readonly turno: string | null;
  readonly licenciaNumero: string | null;
  /** YYYY-MM-DD. */
  readonly licenciaVigencia: string | null;
  readonly emergenciaNombre: string | null;
  /** 10 digitos. */
  readonly emergenciaTelefono: string | null;
}

export interface RepartidorPerfil extends RepartidorPerfilEntrada {
  readonly userId: string;
  readonly updatedAt: string;
}

export type ValidacionPerfil = { readonly ok: true; readonly valor: RepartidorPerfilEntrada } | { readonly ok: false; readonly error: string };

function texto(raw: unknown, campo: string, max: number): { ok: true; valor: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, valor: null };
  if (typeof raw !== "string") return { ok: false, error: `${campo}: debe ser texto.` };
  const t = raw.trim();
  if (t === "") return { ok: true, valor: null };
  if (t.length > max) return { ok: false, error: `${campo}: máximo ${max} caracteres.` };
  // Sin caracteres de control (saltos de linea, tabuladores): estos campos son de una sola linea.
  if ([...t].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) return { ok: false, error: `${campo}: contiene caracteres no permitidos.` };
  return { ok: true, valor: t };
}

/** Valida y normaliza el cuerpo de GET/PUT del perfil. Reemplazo completo: lo que no llegue se guarda vacio. */
export function validarPerfilEntrada(raw: unknown): ValidacionPerfil {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "El cuerpo debe ser un objeto JSON." };
  const b = raw as Record<string, unknown>;

  let vehiculoTipo: VehiculoTipo | null = null;
  if (b.vehiculoTipo !== undefined && b.vehiculoTipo !== null && b.vehiculoTipo !== "") {
    if (typeof b.vehiculoTipo !== "string" || !(VEHICULO_TIPOS as readonly string[]).includes(b.vehiculoTipo)) {
      return { ok: false, error: `vehiculoTipo: debe ser uno de ${VEHICULO_TIPOS.join(", ")}.` };
    }
    vehiculoTipo = b.vehiculoTipo as VehiculoTipo;
  }

  const disponibilidadRaw = b.disponibilidad ?? "disponible";
  if (typeof disponibilidadRaw !== "string" || !(DISPONIBILIDADES as readonly string[]).includes(disponibilidadRaw)) {
    return { ok: false, error: `disponibilidad: debe ser una de ${DISPONIBILIDADES.join(", ")}.` };
  }

  const placas = texto(b.placas, "placas", 15);
  if (!placas.ok) return placas;
  const turno = texto(b.turno, "turno", 120);
  if (!turno.ok) return turno;
  const licenciaNumero = texto(b.licenciaNumero, "licenciaNumero", 40);
  if (!licenciaNumero.ok) return licenciaNumero;
  const emergenciaNombre = texto(b.emergenciaNombre, "emergenciaNombre", 100);
  if (!emergenciaNombre.ok) return emergenciaNombre;

  let licenciaVigencia: string | null = null;
  if (b.licenciaVigencia !== undefined && b.licenciaVigencia !== null && b.licenciaVigencia !== "") {
    if (typeof b.licenciaVigencia !== "string" || !fechaNegocioValida(b.licenciaVigencia)) return { ok: false, error: "licenciaVigencia: debe ser una fecha YYYY-MM-DD válida." };
    if (b.licenciaVigencia < "2000-01-01" || b.licenciaVigencia > "2100-01-01") return { ok: false, error: "licenciaVigencia: fuera de rango." };
    licenciaVigencia = b.licenciaVigencia;
  }
  if ((licenciaNumero.valor === null) !== (licenciaVigencia === null)) return { ok: false, error: "La licencia lleva número y vigencia juntos." };

  let emergenciaTelefono: string | null = null;
  const telRaw = b.emergenciaTelefono;
  if (telRaw !== undefined && telRaw !== null && telRaw !== "") {
    if (typeof telRaw !== "string") return { ok: false, error: "emergenciaTelefono: debe ser texto." };
    emergenciaTelefono = canonicalizeMexicanPhone(telRaw);
    if (emergenciaTelefono === null) return { ok: false, error: "emergenciaTelefono: debe ser un teléfono de 10 dígitos." };
  }
  if ((emergenciaNombre.valor === null) !== (emergenciaTelefono === null)) return { ok: false, error: "El contacto de emergencia lleva nombre y teléfono juntos." };

  return {
    ok: true,
    valor: {
      vehiculoTipo,
      placas: placas.valor,
      disponibilidad: disponibilidadRaw as Disponibilidad,
      turno: turno.valor,
      licenciaNumero: licenciaNumero.valor,
      licenciaVigencia,
      emergenciaNombre: emergenciaNombre.valor,
      emergenciaTelefono,
    },
  };
}

export type LicenciaEstado = "sin_licencia" | "vigente" | "por_vencer" | "vencida";

/** Dias entre `hoy` y la vigencia (negativo si ya vencio). Ambas YYYY-MM-DD; la licencia sigue valida el propio dia de vigencia. */
export function diasParaVencer(vigencia: string, hoy: string): number {
  return Math.round((Date.parse(`${vigencia}T00:00:00Z`) - Date.parse(`${hoy}T00:00:00Z`)) / 86_400_000);
}

export function estadoLicencia(vigencia: string | null, hoy: string): { readonly estado: LicenciaEstado; readonly dias: number | null } {
  if (vigencia === null) return { estado: "sin_licencia", dias: null };
  const dias = diasParaVencer(vigencia, hoy);
  if (dias < 0) return { estado: "vencida", dias };
  if (dias < LICENCIA_AVISO_DIAS) return { estado: "por_vencer", dias };
  return { estado: "vigente", dias };
}

/** Fecha de hoy YYYY-MM-DD en UTC (la base calcula el barrido con current_date; ver notificar.ts). */
export function hoyUtc(ahora: Date): string {
  return ahora.toISOString().slice(0, 10);
}

// ---- Repositorio ----

export type GuardarPerfilResultado =
  | { readonly estado: "ok" }
  | { readonly estado: "no_disponible" }
  | { readonly estado: "prohibido" }
  | { readonly estado: "no_es_repartidor" }
  | { readonly estado: "invalido"; readonly detalle: string };

export interface PerfilLectura {
  /** false = la base aun no tiene la migracion 043 (estado honesto "no disponible aun"). */
  readonly disponible: boolean;
  readonly perfil: RepartidorPerfil | null;
}

export interface LicenciaPorVencer {
  readonly organizationId: string;
  readonly userId: string;
  /** Negativo = ya vencio. */
  readonly diasRestantes: number;
}

export interface RepartidorPerfilRepository {
  /** Lee el perfil de (organizacion, usuario) con la sesion RLS: el propio repartidor u owner/admin ven los dos bloques. */
  obtener(organizationId: string, userId: string): Promise<PerfilLectura>;
  guardar(organizationId: string, userId: string, entrada: RepartidorPerfilEntrada): Promise<GuardarPerfilResultado>;
  /** ARCO cancelacion. true = habia algo que borrar. */
  suprimir(organizationId: string, userId: string): Promise<{ readonly disponible: boolean; readonly borrado: boolean; readonly prohibido: boolean }>;
  /** Solo sesion de sistema. */
  licenciasPorVencer(dias: number): Promise<{ readonly disponible: boolean; readonly valor: readonly LicenciaPorVencer[] }>;
}

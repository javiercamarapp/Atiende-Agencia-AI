// Variables disponibles en las plantillas de mensajes automaticos. Fuente unica: la API las
// publica (GET .../mensajes-automaticos) para la vista previa de la pantalla de Plantillas, y el
// cron las construye con `construirVariables`. Una plantilla que use otra variable no se puede
// aprobar (la API la rechaza) y, si llegara a programarse, el cron la OMITE en vez de enviar
// un hueco o inventar un valor (renderizarPlantilla lanza VariablePlantillaFaltanteError).
import { calcularNoches, esRangoValido } from "../fechas.ts";
import { extraerVariables } from "../mensajeria/plantillas.ts";
import type { CandidatoMensajeAutomatico } from "./tipos.ts";

export interface VariablePlantillaInfo {
  readonly nombre: string;
  readonly descripcion: string;
  /** Valor de EJEMPLO solo para la vista previa de la pantalla; nunca se envia. */
  readonly ejemplo: string;
}

export const VARIABLES_PLANTILLA: readonly VariablePlantillaInfo[] = [
  { nombre: "huesped", descripcion: "Nombre del huésped (si la reserva no lo trae: «huésped»)", ejemplo: "Ana" },
  { nombre: "propiedad", descripcion: "Nombre de la propiedad", ejemplo: "Casa Mar" },
  { nombre: "unidad", descripcion: "Nombre de la unidad reservada", ejemplo: "Depto 1" },
  { nombre: "fecha_check_in", descripcion: "Fecha de llegada", ejemplo: "lunes 10 de junio de 2030" },
  { nombre: "fecha_check_out", descripcion: "Fecha de salida", ejemplo: "miércoles 12 de junio de 2030" },
  { nombre: "noches", descripcion: "Número de noches", ejemplo: "2" },
];

const NOMBRES_CONOCIDOS: ReadonlySet<string> = new Set(VARIABLES_PLANTILLA.map((v) => v.nombre));

/** Variables del cuerpo que el sistema no sabe llenar (vacio = la plantilla es valida). */
export function variablesNoSoportadas(cuerpo: string): string[] {
  return extraerVariables(cuerpo).filter((v) => !NOMBRES_CONOCIDOS.has(v));
}

function fechaLarga(fecha: string): string {
  return new Intl.DateTimeFormat("es-MX", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${fecha}T00:00:00Z`));
}

export function construirVariables(c: Pick<CandidatoMensajeAutomatico, "huespedNombre" | "propiedadNombre" | "unidadNombre" | "checkIn" | "checkOut">): Record<string, string> {
  const rango = { inicio: c.checkIn, fin: c.checkOut };
  return {
    huesped: c.huespedNombre?.trim() || "huésped",
    propiedad: c.propiedadNombre,
    unidad: c.unidadNombre,
    fecha_check_in: fechaLarga(c.checkIn),
    fecha_check_out: fechaLarga(c.checkOut),
    noches: esRangoValido(rango) ? String(calcularNoches(rango)) : "",
  };
}

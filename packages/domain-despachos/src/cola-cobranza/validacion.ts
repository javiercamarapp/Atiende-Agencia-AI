// D-11 -- validacion pura de las entradas de la cola de cobranza (la API la corre ANTES de tocar la base y el
// repositorio en memoria la reutiliza; la base repite las mismas reglas como defensa en profundidad).
import { esCentavosValidos } from "./montos.ts";
import { GESTION_TIPOS } from "./types.ts";
import type { GestionTipo, NuevaGestionInput } from "./types.ts";

export const FECHA_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_NOTA = 1000;
const DIAS_MAX_FUTURO = 365;

function fechaIsoValida(v: string): boolean {
  if (!FECHA_ISO_RE.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}

function diasEntre(desde: string, hasta: string): number {
  return Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86_400_000);
}

export function esGestionTipo(v: unknown): v is GestionTipo {
  return typeof v === "string" && (GESTION_TIPOS as readonly string[]).includes(v);
}

/** Devuelve el primer motivo de rechazo en espanol, o `null` si la gestion es valida. `hoy` = fecha de negocio. */
export function validarNuevaGestion(g: Pick<NuevaGestionInput, "tipo" | "nota" | "montoPromesaCentavos" | "fechaPromesa" | "fechaSeguimiento">, hoy: string): string | null {
  if (g.nota !== null && (g.nota.trim().length < 1 || g.nota.trim().length > MAX_NOTA)) return `nota: debe tener entre 1 y ${MAX_NOTA} caracteres.`;
  if ((g.tipo === "llamada" || g.tipo === "nota") && g.nota === null) return "nota: es obligatoria para una llamada o una nota.";
  if (g.fechaSeguimiento !== null) {
    if (!fechaIsoValida(g.fechaSeguimiento)) return "fechaSeguimiento: se esperaba una fecha 'YYYY-MM-DD'.";
    if (diasEntre(hoy, g.fechaSeguimiento) > DIAS_MAX_FUTURO) return "fechaSeguimiento: no puede ser a mas de un ano.";
  }
  if (g.tipo === "promesa_pago") {
    if (!esCentavosValidos(g.montoPromesaCentavos)) return "montoPromesaCentavos: se esperaba un entero positivo en centavos MXN.";
    if (g.fechaPromesa === null || !fechaIsoValida(g.fechaPromesa)) return "fechaPromesa: se esperaba una fecha 'YYYY-MM-DD'.";
    if (diasEntre(hoy, g.fechaPromesa) > DIAS_MAX_FUTURO) return "fechaPromesa: no puede ser a mas de un ano.";
  } else if (g.montoPromesaCentavos !== null || g.fechaPromesa !== null) {
    return "montoPromesaCentavos/fechaPromesa: solo aplican a una promesa de pago.";
  }
  return null;
}

// Resolucion de "que propiedad(es)" consulta una pregunta del chat con datos, compartida por las
// verticales cuyo catalogo es POR PROPIEDAD (hoteles, rentas). Misma garantia que la de restaurantes:
// la propiedad se pide por NOMBRE (nunca por id) y se resuelve SOLO entre las que el usuario puede ver;
// un nombre fuera de ese conjunto responde igual que uno inexistente (nunca confirma que exista una
// propiedad ajena). El alcance (`allowed`) lo fijo el servidor a partir de la membership.
import type { ParamsSpec } from "./params.js";

export interface VisibleProperty {
  readonly propertyId: string;
  readonly name: string;
  /** Texto alterno por el que tambien se puede nombrar (puede ser igual al nombre). */
  readonly slug: string;
}

export type PropertyResolution =
  | { readonly ok: true; readonly propertyIds: readonly string[] | null; readonly label: string }
  | { readonly ok: false; readonly message: string };

export interface PropertyNouns {
  /** "hotel" / "propiedad" */
  readonly singular: string;
  /** "hoteles" / "propiedades" */
  readonly plural: string;
  /** Genero gramatical del sustantivo (todas / asignadas / esa). Por defecto masculino. */
  readonly feminine?: boolean;
}

const gender = (n: PropertyNouns, masculine: string, feminine: string): string => (n.feminine ? feminine : masculine);

/** Parametro de nombre de propiedad (`key` = "hotel", "propiedad"...): SIEMPRE texto, nunca un id. */
export function propertyParam(key: string, nouns: PropertyNouns): ParamsSpec {
  return {
    [key]: {
      type: "string",
      maxLength: 60,
      optional: true,
      description: `Nombre de UN ${nouns.singular} (opcional). Omítelo para consultar todos los ${nouns.plural} a los que tiene acceso el usuario. No inventes nombres.`,
    },
  };
}

export const foldText = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export function resolvePropertySelection(
  visible: readonly VisibleProperty[],
  allowed: readonly string[] | null,
  requested: string | undefined,
  nouns: PropertyNouns,
): PropertyResolution {
  if (requested === undefined || requested === "") {
    if (allowed === null) return { ok: true, propertyIds: null, label: `${gender(nouns, "todos", "todas")} tus ${nouns.plural}` };
    const n = visible.length;
    return { ok: true, propertyIds: allowed, label: n === 1 ? `${nouns.singular} ${visible[0]!.name}` : `tus ${n} ${nouns.plural} ${gender(nouns, "asignados", "asignadas")}` };
  }
  const needle = foldText(requested);
  const exact = visible.filter((b) => foldText(b.name) === needle || foldText(b.slug) === needle);
  const matches = exact.length > 0 ? exact : visible.filter((b) => foldText(b.name).includes(needle) || foldText(b.slug).includes(needle));
  if (matches.length === 1) return { ok: true, propertyIds: [matches[0]!.propertyId], label: `${nouns.singular} ${matches[0]!.name}` };
  const names = visible.map((b) => b.name).join(", ");
  if (matches.length > 1) return { ok: false, message: `Hay ${gender(nouns, "varios", "varias")} ${nouns.plural} que coinciden con "${requested}": ${matches.map((b) => b.name).join(", ")}. ¿Cuál quieres?` };
  return { ok: false, message: `No encontré ${gender(nouns, "ese", "esa")} ${nouns.singular} entre ${gender(nouns, "los", "las")} que puedes consultar${names ? `: ${names}` : ""}.` };
}

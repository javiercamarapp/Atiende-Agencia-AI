// Gustos del cliente: se DERIVAN de pedidos confirmados (nunca de lo que el modelo supone) y se PROPONEN al cliente.
// Funciones puras: sin base de datos, sin reloj implicito.
import { sanitizeInlineText } from "../text-sanitize.ts";
import type { CreateOrderInput, DefaultComplement, PersistedOrderItem } from "../types.ts";
import type { ClosureAddress, ClosureObservation, CustomerPreference, PreferenceKind, TasteProposal } from "./types.ts";

/** Veces minimas que debe verse un gusto aprendido para proponerlo ("como siempre"). Una sola vez no es un gusto. */
export const MIN_VECES_PARA_PROPONER = 2;
/** Maximo de gustos de varios valores (salsas, omisiones, notas) que se proponen a la vez. */
const MAX_PROPUESTAS_MULTIVALOR = 3;
const SINGLE_VALUED: readonly PreferenceKind[] = ["tortilla", "pago", "propina", "canal", "sucursal"];

function canonical(complement: DefaultComplement): string {
  return complement === "cebolla" ? "cebolla_cilantro" : complement;
}

function cleanValue(raw: string): string {
  return sanitizeInlineText(raw, 120).toLowerCase();
}

/**
 * Observaciones de un pedido ya confirmado, a partir de lo que el cliente pidio de verdad (items, complementos,
 * notas, pago, canal, propina, sucursal). Una por categoria y valor.
 */
export function extraerObservaciones(args: {
  readonly items: readonly PersistedOrderItem[];
  readonly input: Pick<CreateOrderInput, "requestedComplements" | "omitDefaultComplements" | "doubleSalsas" | "notes" | "paymentMethod" | "canal" | "propina">;
  readonly branchName: string | null;
}): ClosureObservation[] {
  const out = new Map<string, ClosureObservation>();
  const add = (kind: PreferenceKind, value: string | null | undefined) => {
    if (!value) return;
    const clean = cleanValue(value);
    if (!clean) return;
    out.set(`${kind}\u0000${clean}`, { kind, value: clean });
  };
  for (const item of args.items) add("tortilla", item.tortilla);
  for (const salsa of [...(args.input.requestedComplements ?? []), ...(args.input.doubleSalsas ?? [])]) add("salsa", salsa);
  for (const omitted of args.input.omitDefaultComplements ?? []) add("omision", canonical(omitted));
  // Una nota solo es "recurrente" si es corta y estable ("sin cebolla"); un parrafo largo no es un gusto.
  const nota = typeof args.input.notes === "string" ? sanitizeInlineText(args.input.notes, 200) : "";
  if (nota.length > 0 && nota.length <= 120) add("nota", nota);
  add("pago", args.input.paymentMethod);
  if (typeof args.input.propina === "number" && args.input.propina > 0) add("propina", String(Math.round(args.input.propina)));
  add("canal", args.input.canal);
  add("sucursal", args.branchName);
  return [...out.values()];
}

/** Domicilio del pedido para el cierre: solo si el pedido llevaba direccion (domicilio). */
export function extraerDomicilio(input: Pick<CreateOrderInput, "customerAddress" | "colonia"> & { readonly addressLabel?: string; readonly accessNotes?: string; readonly mapsUrl?: string }, propertyId: string | null): ClosureAddress | null {
  const address = typeof input.customerAddress === "string" ? sanitizeInlineText(input.customerAddress, 1000) : "";
  if (!address) return null;
  const mapsUrl = typeof input.mapsUrl === "string" && /^https:\/\/[^\s]+$/.test(input.mapsUrl.trim()) && input.mapsUrl.trim().length <= 500 ? input.mapsUrl.trim() : undefined;
  const label = typeof input.addressLabel === "string" ? sanitizeInlineText(input.addressLabel, 60) : "";
  const access = typeof input.accessNotes === "string" ? sanitizeInlineText(input.accessNotes, 300) : "";
  const colonia = typeof input.colonia === "string" ? sanitizeInlineText(input.colonia, 120) : "";
  return {
    address,
    ...(label ? { label } : {}),
    ...(access ? { accessNotes: access } : {}),
    ...(mapsUrl ? { mapsUrl } : {}),
    ...(colonia ? { colonia } : {}),
    ...(propertyId ? { propertyId } : {}),
  };
}

/**
 * Gustos que el agente PROPONE ("¿como siempre, con tortilla de harina y salsa verde?"). Reglas explicables:
 *  - los que escribio el staff se proponen siempre;
 *  - los aprendidos se proponen desde MIN_VECES_PARA_PROPONER veces;
 *  - en categorias de un solo valor (tortilla, pago, canal...) gana el mas visto, salvo que el MAS RECIENTE ya se haya
 *    visto 2 o mas veces: entonces el cliente cambio de gusto y gana el nuevo;
 *  - nunca se propone un gusto descartado.
 */
export function proponerGustos(preferences: readonly CustomerPreference[]): TasteProposal[] {
  const activas = preferences.filter((p) => p.status === "activa");
  const proposals: TasteProposal[] = [];
  const toProposal = (p: CustomerPreference): TasteProposal => ({ kind: p.kind, value: p.value, fuente: p.source, veces: p.timesSeen, ultimaVez: p.lastSeenAt });

  for (const kind of SINGLE_VALUED) {
    const delTipo = activas.filter((p) => p.kind === kind);
    const staff = delTipo.find((p) => p.source === "staff");
    if (staff) {
      proposals.push(toProposal(staff));
      continue;
    }
    if (delTipo.length === 0) continue;
    const masReciente = [...delTipo].sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))[0]!;
    const masVisto = [...delTipo].sort((a, b) => b.timesSeen - a.timesSeen || Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))[0]!;
    const elegido = masReciente.timesSeen >= MIN_VECES_PARA_PROPONER ? masReciente : masVisto;
    if (elegido.timesSeen >= MIN_VECES_PARA_PROPONER) proposals.push(toProposal(elegido));
  }
  for (const kind of ["salsa", "omision", "nota"] as const) {
    const delTipo = activas.filter((p) => p.kind === kind);
    const staff = delTipo.filter((p) => p.source === "staff");
    const aprendidas = delTipo
      .filter((p) => p.source === "pedido" && p.timesSeen >= MIN_VECES_PARA_PROPONER)
      .sort((a, b) => b.timesSeen - a.timesSeen || Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))
      .slice(0, MAX_PROPUESTAS_MULTIVALOR);
    for (const p of [...staff, ...aprendidas]) proposals.push(toProposal(p));
  }
  return proposals;
}

const ETIQUETA_KIND: Record<PreferenceKind, string> = {
  tortilla: "tortilla",
  salsa: "salsa",
  omision: "sin",
  nota: "nota",
  pago: "paga con",
  propina: "propina habitual (pesos)",
  canal: "canal habitual",
  sucursal: "sucursal habitual",
};

/** Texto corto y legible de un gusto para el prompt del agente ("tortilla harina (3 veces)"). */
export function describirGusto(p: TasteProposal): string {
  const valor = p.value.replace(/_/g, " ");
  const origen = p.fuente === "staff" ? "anotado por el restaurante" : `${p.veces} ${p.veces === 1 ? "vez" : "veces"}`;
  return `${ETIQUETA_KIND[p.kind]}: ${valor} (${origen})`;
}

// Rn-36 -- cliente del checklist de onboarding de rentas (GET /v1/rentas/:propertyId/admin/onboarding). Solo lectura. Los textos y las
// cifras las calcula el servidor con datos reales; aqui solo se valida la forma (un estado desconocido se trata como no disponible).
import { fetchJson, RentasAdminError } from "./admin-client.ts";

export type EstadoPuntoOnboarding = "hecho" | "pendiente" | "no_disponible";

export interface PuntoOnboarding {
  readonly clave: string;
  readonly titulo: string;
  readonly descripcion: string;
  readonly estado: EstadoPuntoOnboarding;
  readonly detalle: string | null;
  /** Segmento de ruta relativo a `/rentas/:org/` de la pantalla que resuelve el punto. */
  readonly pantalla: string;
  readonly obligatorio: boolean;
}

export interface ChecklistOnboarding {
  readonly puntos: readonly PuntoOnboarding[];
  readonly medibles: number;
  readonly hechos: number;
  readonly porcentaje: number;
  readonly listoParaOperar: boolean;
}

/** `sin_acceso`: el servidor respondio 403 (membership acotada a algunas propiedades): la tarjeta simplemente no se muestra. */
export type ResultadoChecklist = { readonly estado: "ok"; readonly checklist: ChecklistOnboarding } | { readonly estado: "sin_acceso" };

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const ESTADOS: readonly EstadoPuntoOnboarding[] = ["hecho", "pendiente", "no_disponible"];

export async function fetchChecklistOnboarding(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<ResultadoChecklist> {
  try {
    const w = await fetchJson<{ puntos?: readonly Record<string, unknown>[]; medibles?: unknown; hechos?: unknown; porcentaje?: unknown; listoParaOperar?: unknown }>(fetchImpl, `${apiBaseUrl}/v1/rentas/${propertyId}/admin/onboarding`, token);
    const puntos = (w.puntos ?? []).map((p): PuntoOnboarding => ({
      clave: String(p.clave ?? ""),
      titulo: String(p.titulo ?? ""),
      descripcion: String(p.descripcion ?? ""),
      estado: ESTADOS.includes(p.estado as EstadoPuntoOnboarding) ? (p.estado as EstadoPuntoOnboarding) : "no_disponible",
      detalle: typeof p.detalle === "string" ? p.detalle : null,
      pantalla: String(p.pantalla ?? ""),
      obligatorio: p.obligatorio === true,
    }));
    return { estado: "ok", checklist: { puntos, medibles: num(w.medibles), hechos: num(w.hechos), porcentaje: num(w.porcentaje), listoParaOperar: w.listoParaOperar === true } };
  } catch (err) {
    // El servidor responde 403 con "...de toda la organización..." cuando la membership esta acotada: no es un error que mostrar.
    if (err instanceof RentasAdminError && /toda la organizaci[oó]n/i.test(err.message)) return { estado: "sin_acceso" };
    throw err;
  }
}

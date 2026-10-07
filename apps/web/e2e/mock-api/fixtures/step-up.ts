// Token de step-up de UN SOLO USO de la API simulada (igual que `requireStepUp` en el servidor, L-P3-12): cada `POST /auth/step-up` emite un
// token distinto y la primera accion que lo presenta lo consume; reusarlo da 403 "ya se uso". Solo existe en la API simulada de e2e.
import type { EstadoEscenario, Peticion } from "../tipos.ts";

const CLAVE = "stepUp.emitidos";
interface Registro {
  contador: number;
  gastados: string[];
}
const registro = (estado: EstadoEscenario): Registro => estado.obtener<Registro>(CLAVE, () => ({ contador: 0, gastados: [] }));

export const MENSAJE_STEP_UP = "Esta acción requiere confirmar tu identidad con el código de tu app de autenticación.";
export const MENSAJE_STEP_UP_USADO = "Esta confirmación ya se usó. Vuelve a confirmar con tu código para esta acción.";

export function emitirStepUp(estado: EstadoEscenario, personaId: string): string {
  const r = registro(estado);
  r.contador += 1;
  return `mock-step-up.${personaId}.${r.contador}`;
}

/** `null` = el token es valido y se CONSUMIO; si no, el mensaje del 403 que da el servidor. */
export function consumirStepUp(p: Peticion): string | null {
  const token = p.cabeceras["x-step-up-token"];
  const prefijo = `mock-step-up.${p.persona!.id}.`;
  if (typeof token !== "string" || !token.startsWith(prefijo)) return MENSAJE_STEP_UP;
  const r = registro(p.estado);
  if (r.gastados.includes(token)) return MENSAJE_STEP_UP_USADO;
  r.gastados.push(token);
  return null;
}

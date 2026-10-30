// Aislamiento del banco: reutiliza TAL CUAL las guardas de #696 (API y base en loopback, Meta simulado, variables heredadas en loopback). Si algo no es local, se detiene el stack y se aborta
// ANTES de cualquier llamada. Los adaptadores de telefonia (LiveKit/SIP/Twilio) no se importan en el banco.
import { AbortoDeSeguridad, validarAislamiento, validarEntorno } from "../voz-medicion-real/guardas.ts";

export { AbortoDeSeguridad };

/** `stack` es lo que devuelve `startStack()` del directorio de QA. Valida el entorno y el stack; ante cualquier fallo intenta detener el stack y vuelve a lanzar el aborto. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- el stack viene del directorio de QA sin tipos
export async function exigirAislamiento(stack: any, env: Record<string, string | undefined>): Promise<void> {
  try {
    validarEntorno(env);
    validarAislamiento(stack, env);
  } catch (x) {
    try { await stack?.stop?.(); } catch { /* ya se aborta */ }
    throw x;
  }
}

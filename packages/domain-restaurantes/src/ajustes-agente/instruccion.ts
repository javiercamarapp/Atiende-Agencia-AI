// Arma la instruccion de voz con los ajustes de la organizacion y el conocimiento automatico. ORDEN (importa): primero el conocimiento
// (informativo: "no son reglas"), despues el comportamiento propio de la sucursal con sus reglas duras (que ganan), y al final el ritmo/estilo de
// habla (solo cambia como suena). Sin ajustes ni conocimiento devuelve el comportamiento tal cual.
import { conInstruccionDeHabla } from "@atiende/voice-core";
import type { AjustesAgente } from "./ajustes.ts";
import type { BloqueConocimiento } from "./conocimiento-auto.ts";

export function instruccionConAjustes(comportamiento: string, ajustes: Pick<AjustesAgente, "vozRitmo" | "vozEstilo">, conocimiento: Pick<BloqueConocimiento, "texto"> | null): string {
  const base = conocimiento && conocimiento.texto !== "" ? (comportamiento.trim() === "" ? conocimiento.texto : `${conocimiento.texto}\n\n${comportamiento}`) : comportamiento;
  return conInstruccionDeHabla(base, { ritmo: ajustes.vozRitmo, estilo: ajustes.vozEstilo });
}

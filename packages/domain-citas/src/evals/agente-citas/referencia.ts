// Agente de referencia GUIONADO: reproduce la trayectoria dorada de cada caso (`caso.guion`, un arreglo de pasos
// por mensaje del cliente) contra el mundo. No es un LLM: demuestra que el mundo y los graders aceptan la
// conducta correcta, y es la base de las pruebas de mutacion (agentes malos que los graders deben rechazar).
// Plantillas en los textos: `{h:YYYY-MM-DD HH:MM}` -> hora local amigable ("4:30 pm"); en argumentos, un valor
// "@iso:YYYY-MM-DD HH:MM" se convierte al instante UTC exacto en la zona del negocio.
import { Mundo, horaAmigable, localAIso } from "./mundo.ts";
import type { CasoEval, PasoGuion, Traza } from "./tipos.ts";

function resolverArgs(args: Readonly<Record<string, unknown>> | undefined, tz: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args ?? {})) out[k] = typeof v === "string" && v.startsWith("@iso:") ? localAIso(v.slice(5), tz) : v;
  return out;
}

function resolverTexto(texto: string): string {
  return texto.replace(/\{h:(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\}/g, (_m, _f: string, hhmm: string) => horaAmigable(hhmm));
}

export function ejecutarReferencia(caso: CasoEval, mundo: Mundo = new Mundo(caso)): Traza {
  caso.mensajes.forEach((mensaje, i) => {
    mundo.cliente(mensaje);
    if (mundo.guardrailRespondio) return; // crisis/ARCO: responde la capa determinista, el agente no interviene
    for (const paso of caso.guion[i] ?? ([] as readonly PasoGuion[])) {
      if ("say" in paso) mundo.agente(resolverTexto(paso.say));
      else mundo.ejecutar(paso.tool, resolverArgs(paso.args, caso.tz));
    }
  });
  return mundo.traza();
}

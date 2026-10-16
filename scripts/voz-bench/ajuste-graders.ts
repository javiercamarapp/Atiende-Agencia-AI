// Ajuste honesto de dos graders que marcaban como "inventadas" cifras que NO lo son:
//  * lo que dijo el CLIENTE (p. ej. "pagare con $500 para el cambio") y el minimo de $200 (viene del prompt, no de una herramienta);
//  * (voz) el total/importes que el agente repite y que el cliente dijo.
// Se conservan los fallos brutos; el ajuste solo quita esos falsos positivos y queda registrado en `ajustes`.
import { importesHablados } from "../../packages/voice-core/src/simulador/importes-hablados.ts";

const PESOS_RE = /\$\s?(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*pesos/gi;
export function pesosEscritos(t: string): number[] {
  return [...t.matchAll(PESOS_RE)].map((m) => Number((m[1] ?? m[2] ?? "").replace(/,/g, "")));
}
export function importesDelCliente(textos: readonly string[], escrito: boolean): number[] {
  return textos.flatMap((t) => (escrito ? pesosEscritos(t) : importesHablados(t)));
}
export interface Fallo { grader: string; detalle: string }
/** Quita G_REGLA_R6 (texto) / G_PRECIO_HABLADO (voz) si la cifra senalada es una que dijo el cliente o el minimo de $200. */
export function ajustarFallos(fallos: readonly Fallo[], clienteTextos: readonly string[], escrito: boolean): { fallos: Fallo[]; ajustes: string[] } {
  const permitidos = new Set<number>([200, ...importesDelCliente(clienteTextos, escrito)]);
  const ajustes: string[] = [];
  const out = fallos.filter((f) => {
    const m = /(?:cifra inventada \$|el agente dijo \$|el agente presento \$)(\d+(?:\.\d+)?)/.exec(f.detalle);
    if ((f.grader === "G_REGLA_R6" || f.grader === "G_PRECIO_HABLADO") && m && permitidos.has(Number(m[1]))) {
      ajustes.push(`${f.grader}: $${m[1]} es cifra del cliente o minimo de 200 (falso positivo)`);
      return false;
    }
    return true;
  });
  return { fallos: out, ajustes };
}

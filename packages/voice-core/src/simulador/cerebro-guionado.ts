// "Cerebro" del proveedor falso: el agente guionado. Cada turno del cliente dispara la lista de pasos que trae el
// guion (decir algo, llamar una herramienta con argumentos armados a partir de resultados anteriores). Sirve para probar
// las politicas de la llamada, las reglas del servidor y los graders sin proveedor; NO prueba que un modelo entienda
// es-MX (eso lo hace la corrida manual contra Gemini real). La memoria es de la vertical (`MemoriaObservable`).
import type { ManejadoresSesion } from "../llamada/sesion.ts";
import type { MemoriaObservable, PasoAgente } from "./tipos.ts";

export class CerebroGuionado<M extends MemoriaObservable = MemoriaObservable> {
  private indice = 0;
  private n = 0;

  constructor(
    private readonly respuestas: readonly (readonly PasoAgente<M>[])[],
    readonly memoria: M,
  ) {}

  /** Responde al siguiente turno del cliente. `interrumpida()` consulta si el cliente corto al agente a mitad. */
  async responder(h: ManejadoresSesion, interrumpida: () => boolean): Promise<void> {
    const pasos = this.respuestas[this.indice++];
    if (!pasos) {
      h.agenteDijo("Disculpe, no tengo más pasos para este guion.");
      h.agenteTermino();
      return;
    }
    for (const paso of pasos) {
      if (interrumpida()) return;
      if ("dice" in paso) {
        h.agenteDijo(paso.dice);
        if (paso.largo) return; // el agente sigue hablando: no termina el turno
        continue;
      }
      const args = typeof paso.args === "function" ? paso.args(this.memoria) : paso.args;
      const resultado = await h.ejecutarTool({ id: `fake-${++this.n}`, nombre: paso.tool, args });
      this.memoria.observar(paso.tool, resultado);
    }
    if (!interrumpida()) h.agenteTermino();
  }
}

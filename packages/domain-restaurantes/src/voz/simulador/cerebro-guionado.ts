// "Cerebro" del proveedor falso: el agente guionado. Cada turno del cliente dispara la lista de pasos que trae el
// guion (decir algo, llamar una herramienta con argumentos armados a partir de resultados anteriores). Sirve para probar
// las politicas de la llamada, las reglas del servidor y los graders sin proveedor; NO prueba que un modelo entienda
// es-MX (eso lo hace la corrida manual contra Gemini real).
import type { ManejadoresSesion } from "../llamada/sesion.ts";
import type { MemoriaTools, PasoAgente } from "./tipos.ts";

const sinAcentos = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

class Memoria implements MemoriaTools {
  private readonly porTool = new Map<string, unknown>();
  private hash: string | undefined;
  guardar(nombre: string, resultado: unknown): void {
    this.porTool.set(nombre, resultado);
    const h = (resultado as { quote_hash?: unknown } | null)?.quote_hash;
    if (nombre === "cotizar_pedido" && typeof h === "string") this.hash = h;
  }
  ultimo(nombre: string): unknown {
    return this.porTool.get(nombre);
  }
  private catalogo: { id: string; name: string; price: number; pack_size: number }[] = [];
  registrarBusqueda(resultado: unknown): void {
    if (Array.isArray(resultado)) for (const p of resultado) if (p && typeof p === "object" && "id" in p) this.catalogo.push(p as never);
  }
  producto(fragmento: string) {
    const f = sinAcentos(fragmento);
    const p = this.catalogo.find((x) => sinAcentos(x.name).includes(f));
    if (!p) throw new Error(`El guion usa un producto que no se busco antes: ${fragmento}`);
    return p;
  }
  quoteHash(): string | undefined {
    return this.hash;
  }
}

export class CerebroGuionado {
  readonly memoria = new Memoria();
  private indice = 0;
  private n = 0;

  constructor(private readonly respuestas: readonly (readonly PasoAgente[])[]) {}

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
      this.memoria.guardar(paso.tool, resultado);
      if (paso.tool === "buscar_producto") this.memoria.registrarBusqueda(resultado);
    }
    if (!interrumpida()) h.agenteTermino();
  }
}

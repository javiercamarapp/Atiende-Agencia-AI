// Memoria del agente guionado de restaurantes: recuerda el `quote_hash` de la ultima cotizacion y los productos que `buscar_producto`
// devolvio, para que los pasos del guion armen los argumentos del siguiente paso.
import type { MemoriaTools } from "./tipos.ts";

const sinAcentos = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

class Memoria implements MemoriaTools {
  private readonly porTool = new Map<string, unknown>();
  private hash: string | undefined;
  private catalogo: { id: string; name: string; price: number; pack_size: number }[] = [];

  observar(nombre: string, resultado: unknown): void {
    this.porTool.set(nombre, resultado);
    const h = (resultado as { quote_hash?: unknown } | null)?.quote_hash;
    if (nombre === "cotizar_pedido" && typeof h === "string") this.hash = h;
    if (nombre === "buscar_producto" && Array.isArray(resultado)) for (const p of resultado) if (p && typeof p === "object" && "id" in p) this.catalogo.push(p as never);
  }
  ultimo(nombre: string): unknown {
    return this.porTool.get(nombre);
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

export function crearMemoriaPm(): MemoriaTools {
  return new Memoria();
}

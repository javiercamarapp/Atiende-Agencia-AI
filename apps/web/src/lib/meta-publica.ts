// SEO basico de las paginas publicas sin login (demo, reservas de citas, privacidad de hoteles): titulo, descripcion y robots por pagina.
// `globalThis` y no `document` a proposito (mismo motivo que shell/use-document-title.ts: este .ts tambien lo
// compila el tsconfig raiz sin DOM). En el entorno "node" de vitest simplemente no hace nada.
import { useEffect } from "react";

interface MetaTagLike {
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  remove(): void;
}
interface DocLike {
  title: string;
  head: { appendChild(node: MetaTagLike): void };
  querySelector(selector: string): MetaTagLike | null;
  createElement(tag: "meta"): MetaTagLike;
}

function doc(): DocLike | null {
  return (globalThis as { document?: DocLike }).document ?? null;
}

function fijarMeta(d: DocLike, name: string, content: string, atributo: "name" | "property" = "name"): () => void {
  let el = d.querySelector(`meta[${atributo}="${name}"]`);
  const creado = !el;
  const anterior = el?.getAttribute("content") ?? null;
  if (!el) {
    el = d.createElement("meta");
    el.setAttribute(atributo, name);
    d.head.appendChild(el);
  }
  el.setAttribute("content", content);
  return () => {
    if (creado) el!.remove();
    else if (anterior !== null) el!.setAttribute("content", anterior);
  };
}

export interface MetaPublica {
  readonly titulo: string;
  readonly descripcion: string;
  readonly indexable: boolean;
}

export function useMetaPublica({ titulo, descripcion, indexable }: MetaPublica): void {
  useEffect(() => {
    const d = doc();
    if (!d) return;
    const tituloAnterior = d.title;
    d.title = titulo;
    const restaurarDescripcion = fijarMeta(d, "description", descripcion);
    const restaurarRobots = fijarMeta(d, "robots", indexable ? "index,follow" : "noindex,nofollow");
    // Open Graph (vista previa al compartir el enlace). Un rastreador que no ejecuta JavaScript no lo ve (SPA).
    const restaurar = [
      fijarMeta(d, "og:title", titulo, "property"),
      fijarMeta(d, "og:description", descripcion, "property"),
      fijarMeta(d, "og:type", "website", "property"),
    ];
    return () => {
      d.title = tituloAnterior;
      restaurarDescripcion();
      restaurarRobots();
      for (const r of restaurar) r();
    };
  }, [titulo, descripcion, indexable]);
}

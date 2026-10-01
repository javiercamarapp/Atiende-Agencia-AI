// SEO basico de las paginas publicas del storefront: titulo, descripcion y robots por pagina. Las paginas de
// rastreo y de checkout NO se indexan (son de un pedido concreto); el menu y la lista de sucursales si.
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

function fijarMeta(d: DocLike, name: string, content: string): () => void {
  let el = d.querySelector(`meta[name="${name}"]`);
  const creado = !el;
  const anterior = el?.getAttribute("content") ?? null;
  if (!el) {
    el = d.createElement("meta");
    el.setAttribute("name", name);
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
    return () => {
      d.title = tituloAnterior;
      restaurarDescripcion();
      restaurarRobots();
    };
  }, [titulo, descripcion, indexable]);
}

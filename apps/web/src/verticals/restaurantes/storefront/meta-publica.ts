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
  /** Imagen para la vista previa al compartir (og:image); solo se publica si es una URL https. */
  readonly imagen?: string | null;
}

/** og:image solo acepta una URL absoluta https (nada de data: ni javascript:). */
export function imagenOgValida(url: string | null | undefined): string | null {
  return typeof url === "string" && /^https:\/\/[^\s<>"']+$/.test(url) ? url : null;
}

export function useMetaPublica({ titulo, descripcion, indexable, imagen }: MetaPublica): void {
  useEffect(() => {
    const d = doc();
    if (!d) return;
    const tituloAnterior = d.title;
    d.title = titulo;
    const restaurarDescripcion = fijarMeta(d, "description", descripcion);
    const restaurarRobots = fijarMeta(d, "robots", indexable ? "index,follow" : "noindex,nofollow");
    // Open Graph (R-38): vista previa al compartir el enlace. Un rastreador que no ejecuta JavaScript no lo ve (SPA): ver el PR.
    const restaurar = [
      fijarMeta(d, "og:title", titulo, "property"),
      fijarMeta(d, "og:description", descripcion, "property"),
      fijarMeta(d, "og:type", "website", "property"),
    ];
    const og = imagenOgValida(imagen);
    if (og) restaurar.push(fijarMeta(d, "og:image", og, "property"));
    return () => {
      d.title = tituloAnterior;
      restaurarDescripcion();
      restaurarRobots();
      for (const r of restaurar) r();
    };
  }, [titulo, descripcion, indexable, imagen]);
}

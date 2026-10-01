// Lectura estructural del Sidebar de escritorio (marco de Likida) para las pruebas de los 7 shells: que categorias
// pinta y en que orden, que links muestra la categoria abierta y que dice la tarjeta de usuario. Solo lee el DOM.
import { click } from "./render.tsx";

/** Titulos de las categorias del acordeon, en orden (las secciones raiz no llevan titulo ni boton). */
export function categoriasSidebar(root: HTMLElement): string[] {
  return [...root.querySelectorAll("aside button[aria-expanded]")].map((b) => b.textContent?.trim() ?? "");
}

/** Categorias con `aria-expanded="true"` (el acordeon es exclusivo: como maximo una). */
export function categoriasAbiertas(root: HTMLElement): string[] {
  return [...root.querySelectorAll("aside button[aria-expanded='true']")].map((b) => b.textContent?.trim() ?? "");
}

/** Etiquetas de TODOS los links del <nav> del Sidebar (raiz + categoria abierta), en orden. */
export function linksSidebar(root: HTMLElement): string[] {
  return [...root.querySelectorAll("aside nav a")].map((a) => a.getAttribute("aria-label") ?? a.textContent?.trim() ?? "");
}

/** Abre una categoria por su titulo (click real en su boton). */
export function abrirCategoria(root: HTMLElement, titulo: string): void {
  const boton = [...root.querySelectorAll<HTMLButtonElement>("aside button[aria-expanded]")].find((b) => b.textContent?.trim() === titulo);
  if (!boton) throw new Error(`No hay categoria "${titulo}" en el Sidebar`);
  click(boton);
}

/** Nombre y rol que pinta la tarjeta de usuario del pie (ultimo bloque del <aside>). */
export function tarjetaUsuario(root: HTMLElement): { nombre: string; rol: string } {
  const aside = root.querySelector("aside")!;
  const nombre = aside.querySelector("p[title]");
  return { nombre: nombre?.textContent?.trim() ?? "", rol: nombre?.nextElementSibling?.textContent?.trim() ?? "" };
}

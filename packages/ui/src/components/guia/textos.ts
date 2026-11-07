// Textos de la «Guía» (recorrido, menu, invitacion y «Primeros pasos») en español e inglés, como diccionario TIPADO: el carril de i18n
// lo absorbe tal cual (mismas claves `guia.*`), sin tocar los componentes. Ninguna cifra va escrita a mano: todo numero entra por
// `{variable}`. Patron de copy de Rovaq (AUDITORIA-VEXA-3 §4.12): tuteo, frases cortas y honestas, verbos en las acciones.
//
// Idioma: misma convencion que el selector del pie del sidebar (carril del shell): `?lang=` -> localStorage «atiende-idioma» -> «es»,
// y el evento «atiende:idioma:cambio» para cambiar en caliente. Se repiten aqui las dos constantes para no depender de ese PR.
import * as React from "react";

export type IdiomaGuia = "es" | "en";
export const CLAVE_IDIOMA_GUIA = "atiende-idioma";
export const EVENTO_IDIOMA_GUIA = "atiende:idioma:cambio";

export const TEXTOS_GUIA = {
  es: {
    "guia.boton": "Guía",
    "guia.menu.aria": "Menú de la guía",
    "guia.menu.contexto": "{organizacion} · {rol}",
    "guia.menu.corto": "Recorrido corto ({n} pasos)",
    "guia.menu.completo": "Recorrido completo ({n} pasos)",
    "guia.menu.repetir": "Repetir el recorrido",
    "guia.menu.retomar": "Retomar donde lo dejé",
    "guia.menu.pantallas": "Saltar a una pantalla",
    "guia.menu.primerosPasos": "Ver la lista de primeros pasos",
    "guia.menu.noVolver": "Omitir y no volver a mostrar",
    "guia.menu.volverAMostrar": "Volver a mostrar la invitación",
    "guia.inv.titulo": "Conoce Atiende",
    "guia.inv.elige": "Te muestro dónde está cada cosa. Elige un recorrido; puedes salir cuando quieras con Esc.",
    "guia.inv.cuerpo": "Te muestro dónde está cada cosa en un recorrido corto. Puedes salir cuando quieras con Esc.",
    "guia.inv.omitir": "Omitir",
    "guia.inv.empezar": "Empezar recorrido",
    "guia.tarjeta.paso": "Paso {n} de {total}",
    "guia.tarjeta.pantalla": "Pantalla {n} de {total}",
    "guia.tarjeta.progreso": "Avance del recorrido",
    "guia.tarjeta.ruta": "Pantallas del recorrido",
    "guia.tarjeta.aviso": "Paso {n} de {total}: {titulo}",
    "guia.tarjeta.siguiente": "Siguiente",
    "guia.tarjeta.anterior": "Anterior",
    "guia.tarjeta.terminar": "Terminar",
    "guia.tarjeta.omitir": "Omitir recorrido",
    "guia.tarjeta.noVisible": "Esta parte de la pantalla aún no está visible; sigue la explicación de aquí.",
    "guia.ir.titulo": "Vamos a {pantalla}",
    "guia.ir.cuerpoViaja": "Te señalo «{nombre}» en el menú. Haz clic o espera y te llevo.",
    "guia.ir.cuerpo": "Haz clic en «{nombre}» en el menú, o pulsa Siguiente.",
    "guia.ir.cuenta": "Te llevo a {nombre} en {n} s.",
    "guia.ir.anuncio": "En unos segundos te llevo a {nombre}. Pulsa «Quedarme aquí» para no ir.",
    "guia.ir.abriendo": "Abriendo {nombre}…",
    "guia.ir.fallo": "No pude abrir esta pantalla.",
    "guia.ir.continuar": "Continuar",
    "guia.ir.quedarme": "Quedarme aquí",
    "guia.ir.manual": "Ir a {nombre}",
    "guia.etiqueta.clic": "Haz clic aquí: {nombre}",
    "guia.etiqueta.aqui": "Aquí: {nombre}",
    "guia.cierre.titulo": "Terminaste el recorrido",
    "guia.cierre.cuerpo": "Puedes repetirlo o saltar a cualquier pantalla desde «Guía».",
    "guia.cierre.primerosPasos": "Ver primeros pasos",
    "guia.pp.titulo": "Primeros pasos",
    "guia.pp.viendoComo": "Estás viendo la configuración como {rol}.",
    "guia.pp.progreso": "{hechos} de {total} que puedes hacer ahora",
    "guia.pp.progresoAria": "Avance de la configuración",
    "guia.pp.enEspera": "{n} en espera",
    "guia.pp.recomendado": "Recomendado ahora",
    "guia.pp.quePide": "Qué se pide",
    "guia.pp.quien": "Quién lo cierra",
    "guia.pp.faltan": "Falta en: {lista}",
    "guia.pp.abrir": "Ir a hacerlo",
    "guia.pp.obligatorio": "Obligatorio",
    "guia.pp.verMas": "Ver {n} tareas más",
    "guia.pp.listo.titulo": "Todo listo para operar",
    "guia.pp.listo.cuerpo": "Cerraste los pasos obligatorios. Lo que queda es opcional o depende de alguien más.",
    "guia.pp.paso.titulo": "Paso cerrado: {titulo}",
    "guia.pp.error": "No se pudo calcular tu avance ahora.",
    "guia.pp.reintentar": "Reintentar",
    "guia.pp.recorrido": "Hacer el recorrido",
    "guia.estado.hecho": "Hecho",
    "guia.estado.parcial": "En progreso",
    "guia.estado.pendiente": "Pendiente",
    "guia.estado.externo": "En espera",
    "guia.estado.bloqueado": "Bloqueado",
    "guia.estado.informativo": "Para revisar",
  },
  en: {
    "guia.boton": "Guide",
    "guia.menu.aria": "Guide menu",
    "guia.menu.contexto": "{organizacion} · {rol}",
    "guia.menu.corto": "Short tour ({n} steps)",
    "guia.menu.completo": "Full tour ({n} steps)",
    "guia.menu.repetir": "Repeat the tour",
    "guia.menu.retomar": "Resume where I left off",
    "guia.menu.pantallas": "Jump to a screen",
    "guia.menu.primerosPasos": "See the getting-started list",
    "guia.menu.noVolver": "Skip and don't show again",
    "guia.menu.volverAMostrar": "Show the invitation again",
    "guia.inv.titulo": "Meet Atiende",
    "guia.inv.elige": "I'll show you where everything is. Pick a tour; press Esc to leave at any time.",
    "guia.inv.cuerpo": "I'll show you where everything is in a short tour. Press Esc to leave at any time.",
    "guia.inv.omitir": "Skip",
    "guia.inv.empezar": "Start tour",
    "guia.tarjeta.paso": "Step {n} of {total}",
    "guia.tarjeta.pantalla": "Screen {n} of {total}",
    "guia.tarjeta.progreso": "Tour progress",
    "guia.tarjeta.ruta": "Tour screens",
    "guia.tarjeta.aviso": "Step {n} of {total}: {titulo}",
    "guia.tarjeta.siguiente": "Next",
    "guia.tarjeta.anterior": "Back",
    "guia.tarjeta.terminar": "Finish",
    "guia.tarjeta.omitir": "Skip tour",
    "guia.tarjeta.noVisible": "This part of the screen isn't visible yet; follow the explanation here.",
    "guia.ir.titulo": "Let's go to {pantalla}",
    "guia.ir.cuerpoViaja": "I'm pointing at “{nombre}” in the menu. Click it, or wait and I'll take you.",
    "guia.ir.cuerpo": "Click “{nombre}” in the menu, or press Next.",
    "guia.ir.cuenta": "Taking you to {nombre} in {n} s.",
    "guia.ir.anuncio": "In a few seconds I'll take you to {nombre}. Press “Stay here” to stay.",
    "guia.ir.abriendo": "Opening {nombre}…",
    "guia.ir.fallo": "I couldn't open this screen.",
    "guia.ir.continuar": "Continue",
    "guia.ir.quedarme": "Stay here",
    "guia.ir.manual": "Go to {nombre}",
    "guia.etiqueta.clic": "Click here: {nombre}",
    "guia.etiqueta.aqui": "Here: {nombre}",
    "guia.cierre.titulo": "You finished the tour",
    "guia.cierre.cuerpo": "You can repeat it or jump to any screen from “Guide”.",
    "guia.cierre.primerosPasos": "See getting started",
    "guia.pp.titulo": "Getting started",
    "guia.pp.viendoComo": "You're viewing the setup as {rol}.",
    "guia.pp.progreso": "{hechos} of {total} you can do now",
    "guia.pp.progresoAria": "Setup progress",
    "guia.pp.enEspera": "{n} waiting",
    "guia.pp.recomendado": "Recommended now",
    "guia.pp.quePide": "What it asks",
    "guia.pp.quien": "Who closes it",
    "guia.pp.faltan": "Missing in: {lista}",
    "guia.pp.abrir": "Go do it",
    "guia.pp.obligatorio": "Required",
    "guia.pp.verMas": "See {n} more tasks",
    "guia.pp.listo.titulo": "Ready to operate",
    "guia.pp.listo.cuerpo": "You closed the required steps. What's left is optional or depends on someone else.",
    "guia.pp.paso.titulo": "Step done: {titulo}",
    "guia.pp.error": "We couldn't calculate your progress right now.",
    "guia.pp.reintentar": "Retry",
    "guia.pp.recorrido": "Take the tour",
    "guia.estado.hecho": "Done",
    "guia.estado.parcial": "In progress",
    "guia.estado.pendiente": "Pending",
    "guia.estado.externo": "Waiting",
    "guia.estado.bloqueado": "Blocked",
    "guia.estado.informativo": "To review",
  },
} as const satisfies Record<IdiomaGuia, Record<string, string>>;

export type ClaveGuia = keyof (typeof TEXTOS_GUIA)["es"];
export type TraductorGuia = (clave: ClaveGuia, vars?: Readonly<Record<string, string | number>>) => string;

/** Sustituye `{var}`; una variable que falta queda visible (`{var}`) en vez de inventarse. */
export function interpolar(plantilla: string, vars?: Readonly<Record<string, string | number>>): string {
  if (!vars) return plantilla;
  return plantilla.replace(/\{([a-zA-Z]+)\}/g, (todo, k: string) => (Object.hasOwn(vars, k) ? String(vars[k]) : todo));
}

export function traductorGuia(idioma: IdiomaGuia): TraductorGuia {
  const tabla = TEXTOS_GUIA[idioma];
  return (clave, vars) => interpolar(tabla[clave] ?? TEXTOS_GUIA.es[clave], vars);
}

/** Texto bilingue del contenido de una pantalla en el idioma activo. */
export const enIdioma = (t: { es: string; en: string } | null | undefined, idioma: IdiomaGuia): string => (t ? t[idioma] || t.es : "");

export function leerIdiomaGuia(): IdiomaGuia {
  if (typeof window === "undefined") return "es";
  try {
    const q = new URLSearchParams(window.location.search).get("lang");
    if (q === "es" || q === "en") return q;
  } catch {
    // URL ilegible
  }
  try {
    const g = window.localStorage.getItem(CLAVE_IDIOMA_GUIA);
    if (g === "es" || g === "en") return g;
  } catch {
    // sin almacenamiento
  }
  return "es";
}

/** Idioma activo, que cambia en caliente con el selector del pie del sidebar. */
export function useIdiomaGuia(): IdiomaGuia {
  const [idioma, setIdioma] = React.useState<IdiomaGuia>(leerIdiomaGuia);
  React.useEffect(() => {
    const alCambiar = (e: Event) => {
      const d = (e as CustomEvent<unknown>).detail;
      setIdioma(d === "en" || d === "es" ? d : leerIdiomaGuia());
    };
    window.addEventListener(EVENTO_IDIOMA_GUIA, alCambiar);
    return () => window.removeEventListener(EVENTO_IDIOMA_GUIA, alCambiar);
  }, []);
  return idioma;
}

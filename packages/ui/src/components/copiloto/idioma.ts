// Textos de la "carroceria" del Copiloto (historial, temas, «Cómo se calculó») en ES y EN. Las preguntas sugeridas, las
// categorias y las respuestas vienen de cada vertical y del servidor (en espanol): esto solo traduce los controles del shell.
// El idioma lo decide la preferencia de la consola (`leerIdioma`: ?lang= -> localStorage -> "es") y se escucha su cambio en vivo.
// En espanol los textos son EXACTAMENTE los de antes: sin la bandera ds3 y sin ?lang=en la pantalla no cambia.
import { useEffect, useState } from "react";
import { IDIOMA_CAMBIO_EVENTO, leerIdioma, type Idioma } from "../../lib/idioma";

const ES = {
  historial: "Historial",
  historialAria: "Historial de chats",
  nuevoChat: "Nuevo chat",
  chatNuevo: "Chat nuevo",
  cerrarHistorial: "Cerrar historial",
  buscar: "Buscar chats",
  sinChats: "Sin chats recientes.",
  sinChatsDs3: "Aún no tienes chats guardados.",
  sinResultados: "Sin resultados.",
  subtituloVacio: "Aún sin chats guardados",
  subtituloUno: "1 chat guardado en tu cuenta",
  subtituloVarios: "{n} chats guardados en tu cuenta",
  pieHistorial: "Se guardan en tu cuenta de Atiende y solo tú los ves. Los adjuntos no se guardan.",
  renombrar: "Renombrar {t}",
  borrar: "Borrar {t}",
  nuevoNombre: "Nuevo nombre del chat",
  grupoFijadas: "Fijadas",
  grupoHoy: "Hoy",
  grupoAyer: "Ayer",
  grupoSemana: "Últimos 7 días",
  grupoMes: "Últimos 30 días",
  grupoAnteriores: "Anteriores",
  temasAria: "Temas sugeridos",
  comoSeCalculo: "Cómo se calculó",
  verComoLoCalcule: "Ver cómo lo calculé",
  pensamientoVivo: "Pensamiento del sistema en vivo · {n}",
  comoLlegue: "Cómo llegué a esto · {n} pasos · {t}",
  comoLlegueUno: "Cómo llegué a esto · 1 paso · {t}",
  notaTraza: "Pasos que reportó el servidor, con su tiempo medido en tu navegador. Nunca es texto del modelo.",
  comoSeCalculoDe: "Cómo se calculó: {t}",
  deDondeSale: "De dónde sale",
  periodo: "Periodo",
  alcance: "Alcance",
  consultas: "Consultas ejecutadas",
  filas: "{n} filas",
  queNoSabemos: "Qué no sabemos",
  recortado: "La tabla se recortó: hay más filas en el sistema de las que se muestran.",
  sinFuente: "Sin fuente declarada para esta consulta.",
  notaCalculo: "Cifras leídas por consultas fijas del catálogo de Atiende: el modelo no inventa números.",
  coberturaUna: "{x} de 1 fuente con datos",
  coberturaVarias: "{x} de {y} fuentes con datos",
} as const;

export type ClaveCopiloto = keyof typeof ES;

const EN: Readonly<Record<ClaveCopiloto, string>> = {
  historial: "History",
  historialAria: "Chat history",
  nuevoChat: "New chat",
  chatNuevo: "New chat",
  cerrarHistorial: "Close history",
  buscar: "Search chats",
  sinChats: "No recent chats.",
  sinChatsDs3: "You have no saved chats yet.",
  sinResultados: "No results.",
  subtituloVacio: "No saved chats yet",
  subtituloUno: "1 chat saved to your account",
  subtituloVarios: "{n} chats saved to your account",
  pieHistorial: "Saved to your Atiende account and visible only to you. Attachments are not stored.",
  renombrar: "Rename {t}",
  borrar: "Delete {t}",
  nuevoNombre: "New chat name",
  grupoFijadas: "Pinned",
  grupoHoy: "Today",
  grupoAyer: "Yesterday",
  grupoSemana: "Last 7 days",
  grupoMes: "Last 30 days",
  grupoAnteriores: "Older",
  temasAria: "Suggested topics",
  comoSeCalculo: "How it was calculated",
  verComoLoCalcule: "See how I calculated it",
  pensamientoVivo: "Live system reasoning · {n}",
  comoLlegue: "How I got here · {n} steps · {t}",
  comoLlegueUno: "How I got here · 1 step · {t}",
  notaTraza: "Steps reported by the server, timed in your browser. Never model text.",
  comoSeCalculoDe: "How it was calculated: {t}",
  deDondeSale: "Where it comes from",
  periodo: "Period",
  alcance: "Scope",
  consultas: "Queries run",
  filas: "{n} rows",
  queNoSabemos: "What we don't know",
  recortado: "The table was cut: the system has more rows than shown.",
  sinFuente: "No source declared for this query.",
  notaCalculo: "Figures read by fixed queries from Atiende's catalog: the model never makes up numbers.",
  coberturaUna: "{x} of 1 source with data",
  coberturaVarias: "{x} of {y} sources with data",
};

const CATALOGOS: Readonly<Record<Idioma, Readonly<Record<ClaveCopiloto, string>>>> = { es: ES, en: EN };

export type TraducirCopiloto = (clave: ClaveCopiloto, vars?: Readonly<Record<string, string | number>>) => string;

/** Traductor puro (para pruebas y para quien ya tiene el idioma). Las variables `{x}` se sustituyen tal cual (React escapa). */
export function traductorCopiloto(idioma: Idioma): TraducirCopiloto {
  const cat = CATALOGOS[idioma] ?? ES;
  return (clave, vars) => {
    const base = cat[clave] ?? ES[clave];
    return vars ? base.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : base;
  };
}

/** Idioma de la consola, vivo: se actualiza cuando el selector del pie del menu lo cambia. */
export function useIdiomaCopiloto(): { idioma: Idioma; t: TraducirCopiloto } {
  const [idioma, setIdioma] = useState<Idioma>(() => leerIdioma());
  useEffect(() => {
    if (typeof window === "undefined") return;
    const alCambiar = () => setIdioma(leerIdioma());
    window.addEventListener(IDIOMA_CAMBIO_EVENTO, alCambiar);
    return () => window.removeEventListener(IDIOMA_CAMBIO_EVENTO, alCambiar);
  }, []);
  return { idioma, t: traductorCopiloto(idioma) };
}

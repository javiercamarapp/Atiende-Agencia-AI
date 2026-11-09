// Textos de los componentes de contenido ds3 (Resumen, aviso de error, «Cómo se calculó»). Modulo tipado y aparte para que el carril
// de i18n (#744/#745/#748) los absorba en su diccionario sin buscar cadenas sueltas en el TSX: cada clave es estable y las funciones
// reciben solo lo que interpolan.
// Un const por superficie. Los del aviso de error viven en ds3-error-textos.ts: EstadoError va en la entrada y no debe arrastrar estos.
export const TEXTOS_DS3_RESUMEN = {
  /** H1 del Resumen bajo ds3 (Rovaq «Hoy»): el nombre de la pagina, no el saludo. */
  titulo: "Resumen",
  estadoDatos: "Estado de los datos",
  atencion: "Requiere tu atención",
  atencionVacia: "Nada requiere tu atención ahora.",
} as const;

export const TEXTOS_DS3_INFO = {
  comoSeCalculo: "Cómo se calculó",
  comoSeCalcula: "Cómo se calcula",
  deDondeSale: "De dónde sale",
  periodo: "Periodo",
  alcance: "Alcance",
  queNoSabemos: "Qué no sabemos",
  claseDeDato: "Clase de dato",
} as const;

export const TEXTOS_DS3_CONTENIDO = { resumen: TEXTOS_DS3_RESUMEN, info: TEXTOS_DS3_INFO } as const;

export type TextosDs3Contenido = typeof TEXTOS_DS3_CONTENIDO;

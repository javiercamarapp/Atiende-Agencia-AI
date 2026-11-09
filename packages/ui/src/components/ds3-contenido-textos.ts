// Textos de los componentes de contenido ds3 (Resumen, aviso de error, «Cómo se calculó»). Modulo tipado y aparte para que el carril
// de i18n (#744/#745/#748) los absorba en su diccionario sin buscar cadenas sueltas en el TSX: cada clave es estable y las funciones
// reciben solo lo que interpolan.
export const TEXTOS_DS3_CONTENIDO = {
  resumen: {
    /** H1 del Resumen bajo ds3 (Rovaq «Hoy»): el nombre de la pagina, no el saludo. */
    titulo: "Resumen",
    estadoDatos: "Estado de los datos",
    atencion: "Requiere tu atención",
    atencionVacia: "Nada requiere tu atención ahora.",
  },
} as const;

export type TextosDs3Contenido = typeof TEXTOS_DS3_CONTENIDO;

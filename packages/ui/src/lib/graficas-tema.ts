/*
 * Tema UNICO de graficas con el aspecto de las del repo suelto (AdminDashboard.tsx, recharts): linea monotona
 * de 2 px con puntos de radio 3 rellenos (activo 5), barras con esquina superior de 4 px, ticks de 10 px en
 * IBM Plex Mono sin linea de eje ni marcas, tooltip compacto sobre la superficie flotante y entrada de 450 ms
 * ease-out. Son constantes sobre tokens (nunca hex): lo que dibuje la grafica (el kit SVG de `graficas.tsx` o una
 * libreria) las lee de aqui, de modo que cambiar el aspecto es tocar un solo lugar.
 */
export const GRAFICA_TEMA = {
  /** Color por serie: ventas en verde, clientes en azul de marca, ordenes en el secundario. */
  colores: {
    ventas: "hsl(var(--chart-ventas))",
    clientes: "hsl(var(--primary))",
    ordenes: "hsl(var(--franja-fin))",
    linea: "hsl(var(--primary))",
  },
  linea: { tipo: "monotone", grosor: 2, radioPunto: 3, radioPuntoActivo: 5 },
  barra: { radioEsquina: [4, 4, 0, 0] as const },
  eje: {
    tamanoTick: 10,
    familia: "IBM Plex Mono, ui-monospace, monospace",
    color: "hsl(var(--muted-foreground))",
    conLineaDeEje: false,
    conMarcas: false,
    prefijoDinero: "$",
  },
  rejilla: { color: "hsl(var(--border))", punteado: "3 3" },
  tooltip: {
    fondo: "hsl(var(--popover))",
    texto: "hsl(var(--popover-foreground))",
    etiqueta: "hsl(var(--muted-foreground))",
    borde: "hsl(var(--border))",
    radio: "0.5rem",
    relleno: "0.375rem 0.625rem",
    tamano: "0.75rem",
  },
  animacion: { entradaMs: 450, easing: "ease-out" },
} as const;

/** Duracion de entrada de la grafica: 0 con prefers-reduced-motion (sin animacion). */
export function duracionEntradaGrafica(reducirMovimiento: boolean): number {
  return reducirMovimiento ? 0 : GRAFICA_TEMA.animacion.entradaMs;
}

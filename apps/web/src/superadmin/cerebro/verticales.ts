// Verticales del Cerebro de ventas y su COLOR. El color de cada luz, pin, racimo, chip y leyenda es el de su VERTICAL
// (orden de Javier, 3-oct: "cada vertical tiene su color y de ese color se ven los clientes, y puedes filtrar asi").
// Los tonos viven en UN solo lugar: los tokens `--vertical-*` de packages/ui/src/index.css (claro y oscuro, contraste
// verificado en packages/ui/tests/tokens-vertical.spec.ts); aqui solo se nombra la clase CSS (cerebro.css) que los lee.
// Sin hex ni estilos en linea: el guard del DS v2 lo prohibe.

export const VERTICALES_CEREBRO = ["restaurantes", "hoteles", "rentas", "licitaciones", "despachos", "citas"] as const;
export type VerticalCerebro = (typeof VERTICALES_CEREBRO)[number];

export const NOMBRE_VERTICAL: Readonly<Record<VerticalCerebro, string>> = {
  restaurantes: "Restaurantes",
  hoteles: "Hoteles",
  rentas: "Rentas vacacionales",
  licitaciones: "Licitaciones",
  despachos: "Despachos",
  citas: "Citas",
};

/** Clase que fija `--cv` (el color de la vertical) en el elemento; los pines y racimos de Leaflet usan las mismas clases. */
export const CLASE_VERTICAL: Readonly<Record<VerticalCerebro, string>> = {
  restaurantes: "cerebro-v-restaurantes",
  hoteles: "cerebro-v-hoteles",
  rentas: "cerebro-v-rentas",
  licitaciones: "cerebro-v-licitaciones",
  despachos: "cerebro-v-despachos",
  citas: "cerebro-v-citas",
};

/** Clase para una vertical desconocida (una vertical nueva que aun no tiene color): gris neutro, nunca un color inventado. */
export const CLASE_VERTICAL_DESCONOCIDA = "cerebro-v-otra";

export function esVerticalCerebro(v: string): v is VerticalCerebro {
  return (VERTICALES_CEREBRO as readonly string[]).includes(v);
}

export function claseVertical(v: string): string {
  return esVerticalCerebro(v) ? CLASE_VERTICAL[v] : CLASE_VERTICAL_DESCONOCIDA;
}

export function nombreVertical(v: string): string {
  return esVerticalCerebro(v) ? NOMBRE_VERTICAL[v] : v;
}

// Etapas del embudo de Atiende (las 8 de la migracion 0012: 5 de avance + 3 desenlaces terminales). En el Cerebro la ETAPA ya no
// es el color principal (lo es la vertical): es un filtro, un dato de la tarjeta/ficha/tooltip y un anillo secundario del pin.

export const ETAPAS_EMBUDO = ["nuevo", "contactado", "demo", "propuesta", "negociacion", "ganado", "perdido", "descartado"] as const;
export type EtapaEmbudo = (typeof ETAPAS_EMBUDO)[number];

export const NOMBRE_ETAPA: Readonly<Record<EtapaEmbudo, string>> = {
  nuevo: "Nuevo",
  contactado: "Contactado",
  demo: "Demo",
  propuesta: "Propuesta",
  negociacion: "Negociación",
  ganado: "Ganado",
  perdido: "Perdido",
  descartado: "Descartado",
};

export function nombreEtapa(e: string): string {
  return (NOMBRE_ETAPA as Readonly<Record<string, string>>)[e] ?? e;
}

/** Desenlace terminal: ya no se redacta ni se contacta (equivale a `esProspectoTerminal` de Likida). */
export function esEtapaTerminal(e: string): boolean {
  return e === "ganado" || e === "perdido" || e === "descartado";
}

/** Anillo secundario del pin: ganado resalta, perdido/descartado se apagan, el resto no lleva anillo propio. */
export function claseAnilloEtapa(e: string): string {
  if (e === "ganado") return "cerebro-pin-ganado";
  if (e === "perdido" || e === "descartado") return "cerebro-pin-cerrado";
  return "";
}

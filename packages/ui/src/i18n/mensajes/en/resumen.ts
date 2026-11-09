import type { Traduccion } from "../../tipos.ts";
import type { resumen } from "../resumen.ts";

export const resumenEn: Traduccion<typeof resumen> = {
  "resumen.eyebrow": "Overview",
  "resumen.titulo": "Overview",
  "resumen.estadoDatos": "Data status",
  "resumen.atencion": "Needs your attention",
  "resumen.atencionVacia": "Nothing needs your attention right now.",
  "resumen.info.comoSeCalculo": "How it was calculated",
  "resumen.info.comoSeCalcula": "How it is calculated",
  "resumen.info.deDondeSale": "Where it comes from",
  "resumen.info.periodo": "Period",
  "resumen.info.alcance": "Scope",
  "resumen.info.queNoSabemos": "What we don't know",
  "resumen.info.claseDeDato": "Data type",
  "resumen.info.clase.observado": "Observed",
  "resumen.info.clase.estimado": "Estimated",
  "resumen.info.clase.inferido": "Inferred",
};

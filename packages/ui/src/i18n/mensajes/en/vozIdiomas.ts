import type { Traduccion } from "../../tipos.ts";
import type { vozIdiomas } from "../vozIdiomas.ts";

export const vozIdiomasEn: Traduccion<typeof vozIdiomas> = {
  "vozIdiomas.titulo": "Voice agent languages",
  "vozIdiomas.descripcion": "The language the agent greets in and the ones it can switch to during a call. It only changes how the agent speaks; no business rule changes.",
  "vozIdiomas.principal": "Main language",
  "vozIdiomas.adicionales": "Additional languages",
  "vozIdiomas.adicionales.vacio": "No additional languages: the agent only speaks the main language.",
  "vozIdiomas.adicionales.agregar": "Add language",
  "vozIdiomas.adicionales.elegir": "Choose a language…",
  "vozIdiomas.adicionales.quitar": "Remove {idioma}",
  "vozIdiomas.adicionales.tope": { one: "Up to {count} additional language.", other: "Up to {count} additional languages." },
  "vozIdiomas.deteccion": "Detect the caller's language",
  "vozIdiomas.deteccion.ayuda": "If the caller speaks one of the additional languages, the agent answers in that language for the rest of the call.",
  "vozIdiomas.deteccion.requiereAdicional": "Add at least one additional language to turn on detection.",
  "vozIdiomas.guardar": "Save languages",
  "vozIdiomas.guardando": "Saving…",
  "vozIdiomas.descartar": "Discard",
  "vozIdiomas.guardado": "Languages saved.",
  "vozIdiomas.noDisponible": "Not available yet: requires PR #712 and migration 181 in the database. Until then the agent only speaks Spanish (Mexico).",
  "vozIdiomas.error.cargar": "Couldn't load the agent's languages.",
  "vozIdiomas.error.guardar": "Couldn't save the languages.",
  "vozIdiomas.soloVoz": "Applies to this branch's phone calls. The WhatsApp agent doesn't use this setting.",
};

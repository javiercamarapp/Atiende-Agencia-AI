import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge no conoce los tokens de tamaño del preset (tailwind-preset.ts).
// Sin esto, `text-display` / `text-ui` se clasificarían como COLOR y
// `cn("text-ui", "text-foreground")` descartaría el tamaño; y
// `rounded-field`/`duration-fast` no se deduplicarían contra sus pares.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["2xs", "display", "eyebrow", "page", "kpi", "pill", "ui", "widget"] }],
      rounded: [{ rounded: ["control", "field", "card", "shell", "dialog"] }],
      duration: [{ duration: ["instant", "fast", "base", "slow", "enter"] }],
      // `shadow-pop` (lote 1.1 de ds3): sin esto tailwind-merge lo toma por COLOR de sombra y no lo deduplica
      // contra `shadow-md`. Los demas nombres de sombra del preset (card, elevated...) quedan como estaban.
      shadow: [{ shadow: ["pop"] }],
      ease: [{ ease: ["brand", "brand-in-out"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

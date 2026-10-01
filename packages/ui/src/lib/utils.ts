import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge no conoce los tokens de tamaño del preset (tailwind-preset.ts).
// Sin esto, `text-display` / `text-ui` se clasificarían como COLOR y
// `cn("text-ui", "text-foreground")` descartaría el tamaño; y
// `rounded-field`/`duration-fast` no se deduplicarían contra sus pares.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["display", "eyebrow", "pill", "ui", "widget"] }],
      rounded: [{ rounded: ["control", "field", "card", "shell", "dialog"] }],
      duration: [{ duration: ["instant", "fast", "base", "slow", "enter"] }],
      ease: [{ ease: ["brand", "brand-in-out"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge no conoce los tokens de Atiende DS v2 (preset en
// tailwind-preset.ts). Sin esto, `text-display` se clasificaría como COLOR y
// `cn("text-display", "text-foreground")` descartaría el tamaño; y
// `rounded-field`/`duration-fast` no se deduplicarían contra sus pares.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["display"] }],
      rounded: [{ rounded: ["control", "field", "card", "shell", "dialog"] }],
      duration: [{ duration: ["instant", "fast", "base", "slow", "enter"] }],
      ease: [{ ease: ["brand", "brand-in-out"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Sistema de diseño real de atiende.ai — puerto directo de atiende-hoteles
// (packages/ui/src/tailwind-preset.ts, ya la fuente compartida real entre repos
// standalone) al monorepo de fusión. Hallazgo de auditoría (2026-09-15): el
// frontend de fusión llegó a tener backend/base de datos a nivel enterprise pero
// SIN esta capa visual — todo se construyó con `style={{...}}` inline mínimo, sin
// Tailwind ni estos tokens. Nunca reinventar este preset por vertical.
import type { Config } from "tailwindcss";
import preset from "@atiende/ui/tailwind-preset";

export default {
  presets: [preset],
  content: ["./src/**/*.{ts,tsx}", "../../packages/ui/src/**/*.{ts,tsx}"],
} satisfies Config;

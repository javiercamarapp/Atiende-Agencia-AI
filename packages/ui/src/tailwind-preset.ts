import type { Config } from "tailwindcss";
import tailwindcssAnimate from "tailwindcss-animate";

/**
 * Preset compartido, portado literalmente de atiende-restaurantes
 * (tailwind.config.ts) — misma estructura de tokens/radios/sombras,
 * mismo trío tipográfico Inter / Inter Tight / IBM Plex Mono
 * (docs/referencia/05-frontend-restaurantes.md §1.2/§1.3, REQ-UX-001).
 *
 * Atiende DS v2 (PR-1 del plan de diseño-ux): familias, escala tipográfica,
 * radios con nombre, motion y colores semánticos se leen de variables CSS de
 * index.css. Sus valores por defecto reproducen el aspecto actual; la marca
 * nueva solo aplica bajo <html data-theme="v2">.
 */
const preset: Omit<Config, "content"> = {
  darkMode: ["class"],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        display: ["var(--font-display)"],
        body: ["var(--font-body)"],
        sans: ["var(--font-sans)"],
        menu: ["var(--font-body)"],
        serif: ["var(--font-serif)"],
        mono: ["var(--font-mono)"],
      },
      // Escala única 4.2 (los text-[Npx] sueltos migran a estos nombres).
      fontSize: {
        "2xs": ["var(--text-2xs)", { lineHeight: "var(--text-2xs-lh)" }],
        xs: ["var(--text-xs)", { lineHeight: "var(--text-xs-lh)" }],
        sm: ["var(--text-sm)", { lineHeight: "var(--text-sm-lh)" }],
        base: ["var(--text-base)", { lineHeight: "var(--text-base-lh)" }],
        lg: ["var(--text-lg)", { lineHeight: "var(--text-lg-lh)" }],
        xl: ["var(--text-xl)", { lineHeight: "var(--text-xl-lh)" }],
        "2xl": ["var(--text-2xl)", { lineHeight: "var(--text-2xl-lh)" }],
        display: ["var(--text-display)", { lineHeight: "var(--text-display-lh)" }],
      },
      letterSpacing: {
        serif: "var(--tracking-serif)",
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
          tint: "hsl(var(--destructive-tint))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          tint: "hsl(var(--success-tint))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          tint: "hsl(var(--warning-tint))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          tint: "hsl(var(--info-tint))",
        },
        // Trazo de controles de formulario con contraste >= 3:1 (checkbox, Switch).
        control: "hsl(var(--control-off))",
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        control: "var(--radius-control)",
        field: "var(--radius-field)",
        card: "var(--radius-card)",
        shell: "var(--radius-shell)",
        dialog: "var(--radius-dialog)",
      },
      transitionDuration: {
        instant: "var(--dur-instant)",
        fast: "var(--dur-fast)",
        base: "var(--dur-base)",
        slow: "var(--dur-slow)",
        enter: "var(--dur-enter)",
      },
      transitionTimingFunction: {
        brand: "var(--ease-out)",
        "brand-in-out": "var(--ease-in-out)",
      },
      boxShadow: {
        card: "var(--shadow-card)",
        elevated: "var(--shadow-elevated)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        wiggle: {
          "0%, 100%": { transform: "rotate(8deg)" },
          "50%": { transform: "rotate(16deg)" },
        },
        // Motion v2 (4.4). Nombres propios: no chocan con enter/exit de
        // tailwindcss-animate, que siguen alimentando Dialog/Sheet hasta PR-3.
        "overlay-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "overlay-out": { from: { opacity: "1" }, to: { opacity: "0" } },
        "modal-in": {
          from: { opacity: "0", transform: "scale(0.96)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        "modal-out": {
          from: { opacity: "1", transform: "scale(1)" },
          to: { opacity: "0", transform: "scale(0.98)" },
        },
        "sheet-up": {
          from: { transform: "translateY(100%)" },
          to: { transform: "translateY(0)" },
        },
        "sheet-down": {
          from: { transform: "translateY(0)" },
          to: { transform: "translateY(100%)" },
        },
        "popover-in": {
          from: { opacity: "0", transform: "translateY(-4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "toast-in": {
          from: { opacity: "0", transform: "translateY(12px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "page-in": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        wiggle: "wiggle 1s ease-in-out infinite",
        "overlay-in": "overlay-in var(--dur-fast) var(--ease-out) both",
        "overlay-out": "overlay-out var(--dur-fast) var(--ease-out) both",
        "modal-in": "modal-in var(--dur-base) var(--ease-out) both",
        "modal-out": "modal-out var(--dur-fast) var(--ease-out) both",
        "sheet-up": "sheet-up var(--dur-base) var(--ease-out) both",
        "sheet-down": "sheet-down var(--dur-fast) var(--ease-out) both",
        "popover-in": "popover-in var(--dur-fast) var(--ease-out) both",
        "toast-in": "toast-in var(--dur-base) var(--ease-out) both",
        "page-in": "page-in var(--dur-base) var(--ease-out) both",
      },
    },
  },
  plugins: [tailwindcssAnimate],
};

export default preset;

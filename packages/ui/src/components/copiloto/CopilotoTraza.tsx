import { Check, ChevronRight } from "lucide-react";
import { useIdiomaCopiloto } from "./idioma";

/** «1.2 s» / «850 ms»: duracion legible. */
export function textoMs(ms: number | null | undefined, idioma: "es" | "en" = "es"): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${new Intl.NumberFormat(idioma === "en" ? "en-US" : "es-MX", { maximumFractionDigits: 1 }).format(ms / 1000)} s`;
}

/**
 * «Cómo llegué a esto · n pasos · t» (diseno ds3): desplegable cerrado bajo la respuesta con los pasos que el SERVIDOR reporto en
 * vivo (herramienta del catalogo, etiqueta legible) y cuanto tardo cada uno, medido en el navegador. Sin traza (conversacion reabierta
 * del historial, respuesta sin pasos) no se pinta. Quien lo monta lo envuelve en `hidden` + `ds3-solo`.
 */
export function CopilotoTraza({
  traza,
  duracionMs,
  etiquetas,
}: {
  traza: readonly { readonly herramienta: string; readonly ms: number | null }[];
  duracionMs?: number | undefined;
  etiquetas?: Readonly<Record<string, string>> | undefined;
}) {
  const { idioma, t } = useIdiomaCopiloto();
  if (traza.length === 0) return null;
  const total = textoMs(duracionMs ?? traza.reduce((n, p) => n + (p.ms ?? 0), 0), idioma) || "0 ms";
  return (
    <details className="ds3-copiloto-traza" data-testid="copiloto-traza">
      <summary className="ds3-copiloto-ctl ds3-copiloto-traza-resumen">
        <ChevronRight aria-hidden="true" />
        <span>{traza.length === 1 ? t("comoLlegueUno", { t: total }) : t("comoLlegue", { n: traza.length, t: total })}</span>
      </summary>
      <ol className="ds3-copiloto-traza-lista">
        {traza.map((p, i) => (
          <li key={`${p.herramienta}-${i}`}>
            <Check aria-hidden="true" />
            <span>{etiquetas?.[p.herramienta] ?? p.herramienta}</span>
            {p.ms !== null ? <span className="ds3-copiloto-traza-ms"> · {textoMs(p.ms, idioma)}</span> : null}
          </li>
        ))}
      </ol>
      <p className="ds3-copiloto-traza-nota">{t("notaTraza")}</p>
    </details>
  );
}

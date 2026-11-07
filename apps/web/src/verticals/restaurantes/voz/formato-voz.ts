// Formato de datos de conversaciones de voz. Los instantes (con hora) se muestran en
// una zona explícita (America/Mexico_City, el mismo valor por defecto que usa
// lib/formato-fecha.ts), nunca en la zona local del navegador. Locale y etiquetas siguen al idioma de la consola.
import { etiquetasTraducidas, localeActivo, traductorActivo } from "@atiende/ui";
import { restaurantesIndicadoresVoz } from "@atiende/ui/i18n/restaurantes/indicadoresVoz";
import type { ResultadoConversacion } from "../lib/voz-client.ts";

export function formatoDuracion(segundos: number | null): string {
  if (segundos === null || !Number.isFinite(segundos) || segundos < 0) return "—";
  const total = Math.round(segundos);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatoCostoUsd(costo: number | null): string {
  if (costo === null || !Number.isFinite(costo)) return "—";
  return `US$${costo.toFixed(3)}`;
}

export function formatoInstante(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(localeActivo(), { timeZone: "America/Mexico_City", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const ETIQUETAS_RESULTADO: Readonly<Record<ResultadoConversacion, string>> = etiquetasTraducidas(
  ["pedido_creado", "escalado", "abandonado"],
  (r) => `restaurantes.indicadoresVoz.resultado.${r}` as const,
  restaurantesIndicadoresVoz,
);
const tr = traductorActivo(restaurantesIndicadoresVoz);

export function etiquetaResultado(resultado: ResultadoConversacion | null): string {
  return resultado ? ETIQUETAS_RESULTADO[resultado] : tr("restaurantes.indicadoresVoz.resultado.sinClasificar");
}

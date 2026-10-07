// Formato de los ajustes del agente (es-MX). El costo llega en micro-USD enteros (estimacion con precio de lista) y se muestra por 1,000 unidades.
import { formatMoney } from "@atiende/ui";
import type { AjustesAgente, ModeloAgenteVista, RitmoHabla, EstiloHabla } from "../lib/ajustes-agente-client.ts";

const NIVEL: Readonly<Record<ModeloAgenteVista["nivel"], string>> = { economico: "Económico", equilibrado: "Equilibrado", premium: "Premium" };
export const etiquetaNivel = (n: ModeloAgenteVista["nivel"]): string => NIVEL[n];

/** "≈ US$0.80 por 1,000 mensajes". null = el modelo no tiene precio de lista conocido (se dice, no se inventa). */
export function costoPorMil(microUsdPorUnidad: number | null, unidadPlural: string): string {
  if (microUsdPorUnidad === null || !Number.isFinite(microUsdPorUnidad)) return "sin precio de lista conocido";
  const usd = (microUsdPorUnidad * 1000) / 1_000_000;
  return `≈ US$${formatMoney(usd, 2)} por 1,000 ${unidadPlural}`;
}

export const RITMOS: readonly { readonly id: RitmoHabla; readonly rotulo: string }[] = [
  { id: "pausado", rotulo: "Pausado" },
  { id: "normal", rotulo: "Normal" },
  { id: "agil", rotulo: "Ágil" },
];

export const ESTILOS: readonly { readonly id: EstiloHabla; readonly rotulo: string }[] = [
  { id: "neutro", rotulo: "Neutro" },
  { id: "calido", rotulo: "Cálido" },
  { id: "sobrio", rotulo: "Sobrio" },
  { id: "animado", rotulo: "Animado" },
];

/** Pasos de temperatura que ofrece la pantalla (el servidor acepta cualquier valor entre 0 y 1). "auto" = null. */
export const PASOS_TEMPERATURA: readonly string[] = ["auto", "0", "0.2", "0.4", "0.6", "0.8", "1"];

export function pasoDeTemperatura(t: number | null): string {
  return t === null ? "auto" : String(t);
}

export function temperaturaDePaso(paso: string): number | null {
  return paso === "auto" ? null : Number(paso);
}

export function rotuloTemperatura(paso: string): string {
  return paso === "auto" ? "Automática" : Number(paso).toFixed(1);
}

export function ajustesIguales(a: AjustesAgente, b: AjustesAgente): boolean {
  return (
    a.whatsappModelo === b.whatsappModelo &&
    a.whatsappTemperatura === b.whatsappTemperatura &&
    a.vozModeloCascada === b.vozModeloCascada &&
    a.vozTemperatura === b.vozTemperatura &&
    a.vozRitmo === b.vozRitmo &&
    a.vozEstilo === b.vozEstilo &&
    a.vozFondoActivo === b.vozFondoActivo &&
    a.vozFondoVolumen === b.vozFondoVolumen
  );
}

export const NIVELES_FONDO: readonly number[] = [4, 8, 12, 16, 20];

// Formato de los ajustes del agente (textos en el idioma de la consola). El costo llega en micro-USD enteros (estimacion con precio de lista) y se muestra por 1,000 unidades.
import { etiquetasTraducidas, formatMoney, traductorActivo } from "@atiende/ui";
import type { Clave } from "@atiende/ui";
import { restaurantesAjustesAgente } from "@atiende/ui/i18n/restaurantes/ajustesAgente";
import type { AjustesAgente, ModeloAgenteVista, PresetAmbiente, RitmoHabla, EstiloHabla } from "../lib/ajustes-agente-client.ts";

const tr = traductorActivo(restaurantesAjustesAgente);

const NIVEL = etiquetasTraducidas<ModeloAgenteVista["nivel"]>(["economico", "equilibrado", "premium"], (n) => `restaurantes.ajustesAgente.nivel.${n}` as const, restaurantesAjustesAgente);
export const etiquetaNivel = (n: ModeloAgenteVista["nivel"]): string => NIVEL[n];

/** "≈ US$0.80 por 1,000 mensajes". null = el modelo no tiene precio de lista conocido (se dice, no se inventa). */
export function costoPorMil(microUsdPorUnidad: number | null, unidadPlural: "mensajes" | "minutos"): string {
  if (microUsdPorUnidad === null || !Number.isFinite(microUsdPorUnidad)) return tr("restaurantes.ajustesAgente.costo.sinPrecio");
  const usd = (microUsdPorUnidad * 1000) / 1_000_000;
  return tr("restaurantes.ajustesAgente.costo.porMil", { monto: formatMoney(usd, 2), unidad: tr(`restaurantes.ajustesAgente.unidad.${unidadPlural}` as const) });
}

/** Opcion de un selector con rotulo traducido en cada lectura (mismo shape que el arreglo fijo de antes). */
function opcion<T extends string>(id: T, clave: Clave): { readonly id: T; readonly rotulo: string } {
  return {
    id,
    get rotulo() {
      return tr(clave);
    },
  };
}

export const RITMOS: readonly { readonly id: RitmoHabla; readonly rotulo: string }[] = [opcion("pausado", "restaurantes.ajustesAgente.ritmo.pausado"), opcion("normal", "restaurantes.ajustesAgente.ritmo.normal"), opcion("agil", "restaurantes.ajustesAgente.ritmo.agil")];

export const ESTILOS: readonly { readonly id: EstiloHabla; readonly rotulo: string }[] = [
  opcion("neutro", "restaurantes.ajustesAgente.estilo.neutro"),
  opcion("calido", "restaurantes.ajustesAgente.estilo.calido"),
  opcion("sobrio", "restaurantes.ajustesAgente.estilo.sobrio"),
  opcion("animado", "restaurantes.ajustesAgente.estilo.animado"),
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
  return paso === "auto" ? tr("restaurantes.ajustesAgente.temperatura.automatica") : Number(paso).toFixed(1);
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
    a.vozFondoVolumen === b.vozFondoVolumen &&
    a.vozFondoPreset === b.vozFondoPreset &&
    a.vozTecleoActivo === b.vozTecleoActivo &&
    a.vozTecleoVolumen === b.vozTecleoVolumen &&
    a.vozHumanizar === b.vozHumanizar
  );
}

export const NIVELES_FONDO: readonly number[] = [4, 8, 12, 16, 20];

export const NIVELES_TECLEO: readonly number[] = [6, 9, 12, 16, 20];

export const PRESETS_AMBIENTE: readonly { readonly id: PresetAmbiente; readonly rotulo: string }[] = [
  opcion("cocina-taqueria", "restaurantes.ajustesAgente.ambiente.cocina-taqueria"),
  opcion("sala-tranquila", "restaurantes.ajustesAgente.ambiente.sala-tranquila"),
  opcion("calle-ocupada", "restaurantes.ajustesAgente.ambiente.calle-ocupada"),
];

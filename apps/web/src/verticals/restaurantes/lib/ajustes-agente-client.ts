// Cliente HTTP tipado de los ajustes del agente por organizacion (modelo, temperatura, voz, fondo) y de la base de conocimiento automatica.
// Contrato: apps/api/src/routes/verticals/restaurantes/ajustes-agente.ts. Mismo criterio que voz-client.ts: 404/503 -> `VozNoDisponibleError` (la pantalla
// dice "no disponible aun", nunca inventa datos) y un 4xx de validacion lleva el mensaje del servidor.
import { base as baseVoz, pedir } from "./voz-client.ts";

export type RitmoHabla = "pausado" | "normal" | "agil";
export type EstiloHabla = "neutro" | "calido" | "sobrio" | "animado";

export type PresetAmbiente = "cocina-taqueria" | "sala-tranquila" | "calle-ocupada";

/** Los doce ajustes que edita el panel (PUT los reemplaza completos; null = "usar el de la plataforma"). */
export interface AjustesAgente {
  readonly whatsappModelo: string | null;
  readonly whatsappTemperatura: number | null;
  readonly vozModeloCascada: string | null;
  readonly vozTemperatura: number | null;
  readonly vozRitmo: RitmoHabla;
  readonly vozEstilo: EstiloHabla;
  readonly vozFondoActivo: boolean;
  readonly vozFondoVolumen: number;
  /** Ambiente de la sala (migracion 087). */
  readonly vozFondoPreset: PresetAmbiente;
  /** Tecleo mientras el agente anota (migracion 087). */
  readonly vozTecleoActivo: boolean;
  readonly vozTecleoVolumen: number;
  /** Naturalidad y español de Mexico en la instruccion (migracion 087). */
  readonly vozHumanizar: boolean;
}

export interface PresetHumanoVista {
  readonly id: string;
  readonly ritmo: RitmoHabla;
  readonly estilo: EstiloHabla;
  readonly temperatura: number;
  readonly humanizar: boolean;
  readonly fondo: { readonly activo: boolean; readonly preset: PresetAmbiente; readonly volumen: number };
  readonly tecleo: { readonly activo: boolean; readonly volumen: number };
  readonly vozPorMotor?: Readonly<Record<"gemini-live" | "cascada", { readonly proveedor: string; readonly principal: string; readonly alternativas: readonly string[] }>>;
  readonly voz: { readonly principal: string; readonly alternativas: readonly string[]; readonly descripciones: Readonly<Record<string, string>> };
  readonly acento: string;
  readonly candidatasTtsCascadaV2: readonly { readonly proveedor: string; readonly voces: readonly string[]; readonly nota: string }[];
}

export interface ModeloAgenteVista {
  readonly id: string;
  readonly etiqueta: string;
  readonly nivel: "economico" | "equilibrado" | "premium";
  readonly descripcion: string;
  readonly aceptaTemperatura: boolean;
  readonly predeterminado: boolean;
  /** Micro-USD por mensaje de WhatsApp / por minuto de cascada (estimacion con precio de lista); null = sin precio conocido. */
  readonly costoWhatsappMicroUsdPorMensaje: number | null;
  readonly costoVozMicroUsdPorMinuto: number | null;
  readonly precioVerificadoEn: string | null;
}

export interface AjustesAgenteVista {
  /** false = la base todavia no tiene la migracion: se ven los valores de siempre y no se puede guardar. */
  readonly disponible: boolean;
  readonly configurados: boolean;
  /** false = la base tiene la migracion 055 pero no la 087: ambiente con presets, tecleo y naturalidad no se pueden guardar. Ausente (API vieja) = igual que false. */
  readonly ambienteDisponible?: boolean;
  readonly actualizadoEn: string | null;
  readonly ajustes: AjustesAgente;
  readonly modelos: readonly ModeloAgenteVista[];
  readonly supuestosCosto: {
    readonly whatsappMensaje: { readonly tokensEntrada: number; readonly tokensSalida: number };
    readonly vozCascadaMinuto: { readonly tokensEntrada: number; readonly tokensSalida: number };
    readonly nota: string;
  };
  readonly temperatura: { readonly min: number; readonly max: number; readonly paso: number };
  readonly habla: { readonly ritmos: readonly RitmoHabla[]; readonly estilos: readonly EstiloHabla[]; readonly nota: string };
  readonly fondo: { readonly volumenMax: number; readonly porOmision: string; readonly presets?: readonly { readonly id: PresetAmbiente; readonly descripcion: string }[] };
  readonly tecleo?: { readonly volumenMax: number; readonly porOmision: string; readonly nota: string };
  readonly presetHumano?: PresetHumanoVista;
  readonly escaleraVoz: { readonly principal: string; readonly respaldo: string };
  readonly aplicaEn: {
    readonly whatsappModeloYTemperatura: string;
    readonly vozTemperaturaYHabla: string;
    readonly vozModeloCascada: string;
    readonly vozFondo: string;
    readonly vozTecleo?: string;
    readonly vozHumanizar?: string;
  };
  readonly clonacionDeVoz: { readonly disponible: boolean; readonly motivo: string; readonly decision: string };
  readonly documentosOmitidos: readonly { readonly tipo: string; readonly motivo: string }[];
}

export type TipoDocumentoAuto = "sucursales_horarios" | "colonias_sucursal" | "faq" | "menu_precios";

export interface DocumentoAutoVista {
  readonly tipo: TipoDocumentoAuto;
  readonly titulo: string;
  readonly contenido: string;
  readonly caracteres: number;
  readonly huella: string;
  readonly vacio: boolean;
  readonly motivoVacio: string | null;
  /** El documento pasaba del maximo y se recorto por renglones (el final del texto lo declara). */
  readonly truncado?: boolean;
  /** Va dentro de la instruccion de voz (cabe en el tope); si no, el agente lo consulta en vivo con sus herramientas. */
  readonly enPrompt: boolean;
}

export interface ConocimientoAutoVista {
  readonly generadoEn: string;
  readonly huella: string;
  readonly nota: string;
  readonly documentos: readonly DocumentoAutoVista[];
  readonly prompt: { readonly topeCaracteres: number; readonly caracteresUsados: number; readonly omitidos: readonly { readonly tipo: string; readonly motivo: string }[] };
  readonly alertasColonias: { readonly umbralKm: number; readonly items: readonly { readonly colonia: string; readonly sucursales: readonly [string, string]; readonly diferenciaKm: number }[]; readonly sinSucursal: number };
  readonly documentosOmitidos: readonly { readonly tipo: string; readonly motivo: string }[];
}

const rutaAgente = (apiBaseUrl: string, propertyId: string): string => baseVoz(apiBaseUrl, propertyId).replace(/\/voz$/, "/agente");

export async function fetchAjustesAgente(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<AjustesAgenteVista> {
  return pedir<AjustesAgenteVista>(fetchImpl, `${rutaAgente(apiBaseUrl, propertyId)}/ajustes`, token, { method: "GET" });
}

export async function guardarAjustesAgente(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string, ajustes: AjustesAgente): Promise<AjustesAgenteVista> {
  return pedir<AjustesAgenteVista>(fetchImpl, `${rutaAgente(apiBaseUrl, propertyId)}/ajustes`, token, { method: "PUT", body: ajustes });
}

export async function fetchConocimientoAuto(fetchImpl: typeof fetch, apiBaseUrl: string, token: string, propertyId: string): Promise<ConocimientoAutoVista> {
  return pedir<ConocimientoAutoVista>(fetchImpl, `${rutaAgente(apiBaseUrl, propertyId)}/conocimiento`, token, { method: "GET" });
}

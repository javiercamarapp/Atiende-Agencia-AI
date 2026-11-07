// Cliente del CFO de la plataforma (GET/PUT /superadmin/cfo/*). Los tipos son el contrato de la API
// (apps/api/src/cfo/cockpit.ts + packages/billing/src/cockpit/*); la web no recalcula ninguna cifra.
import { fetchConStepUp } from "./stepup.ts";

export type FuenteCosto = "medido" | "modelado" | "sin_uso" | "no_configurado" | "sin_dato";
export type BanderaCliente = "no_rentable" | "margen_bajo" | "sobre_el_tope" | "cerca_del_tope" | "anomalia_uso" | "pico_costo" | "pago_fallido";

export interface CostoCategoria {
  readonly usd: number | null;
  readonly fuente: FuenteCosto;
}

export interface Pool {
  readonly incluido: number;
  readonly usado: number;
  readonly pct: number | null;
  readonly pctProyectado: number | null;
}

export interface FilaEconomia {
  readonly organizationId: string;
  readonly nombre: string;
  readonly vertical: string;
  readonly orgStatus: string;
  readonly planNombre: string | null;
  readonly modeloCobro: "por_asiento" | "medido" | null;
  readonly sucursales: number;
  readonly mrrMxn: number | null;
  readonly excedenteMxn: number | null;
  readonly ingresoMxn: number | null;
  readonly uso: { readonly llamadas: number | null; readonly minutosVoz: number | null; readonly duracionPromedioMin: number | null; readonly conversacionesWa: number | null; readonly pedidos: number | null };
  readonly costo: Readonly<Record<"voz" | "llm" | "whatsapp" | "telefonia" | "otros", CostoCategoria>>;
  readonly costoDirectoUsd: number | null;
  readonly costoDirectoMxn: number | null;
  readonly infraMxn: number | null;
  readonly contribucionMxn: number | null;
  readonly contribucionPct: number | null;
  readonly margenBrutoMxn: number | null;
  readonly margenBrutoPct: number | null;
  readonly proyeccion: { readonly ingresoMxn: number | null; readonly costoMxn: number | null; readonly margenMxn: number | null; readonly margenPct: number | null };
  readonly poolVoz: Pool | null;
  readonly poolWa: Pool | null;
  readonly banderas: readonly BanderaCliente[];
  readonly avisos: readonly string[];
}

export interface Agregado {
  readonly clave: string;
  readonly clientes: number;
  readonly clientesConMargen: number;
  readonly ingresoMxn: number;
  readonly costoDirectoMxn: number;
  readonly contribucionPct: number | null;
  readonly margenBrutoPct: number | null;
  readonly llamadas: number;
  readonly minutosVoz: number;
  readonly duracionPromedioMin: number | null;
  readonly conversacionesWa: number;
  readonly pedidos: number;
}

export interface PuntoSerie {
  readonly mes: string;
  readonly mrrMxn: number;
  readonly clientes: number;
  readonly arpaMxn: number | null;
  readonly nuevoMxn: number | null;
  readonly expansionMxn: number | null;
  readonly contraccionMxn: number | null;
  readonly churnMxn: number | null;
  readonly nrrPct: number | null;
  readonly grrPct: number | null;
  readonly churnLogosPct: number | null;
}

type Disponible<T> = ({ readonly disponible: true } & T) | { readonly disponible: false; readonly razon: string };

export interface MetricasSaas {
  readonly mrrMxn: number;
  readonly arrMxn: number;
  readonly clientes: number;
  readonly arpaMxn: number | null;
  readonly serie: readonly PuntoSerie[];
  readonly margen: { readonly contribucionPct: number | null; readonly margenBrutoPct: number | null };
  readonly ltv: Disponible<{ readonly ltvMxn: number; readonly churnMensualPct: number | null; readonly vidaMeses: number; readonly vidaTopada: boolean; readonly margenBrutoPct: number }>;
  readonly cac: Disponible<{ readonly cacMxn: number | null; readonly paybackMeses: number | null; readonly ltvCac: number | null; readonly marketingMxn: number; readonly clientesNuevos: number }>;
  readonly burn: Disponible<{ readonly resultadoMxn: number; readonly burnNetoMxn: number; readonly runwayMeses: number | null; readonly saldoCajaMxn: number | null; readonly gastoFijoMxn: number; readonly proyectado: boolean }>;
  readonly cohortes: ReadonlyArray<{ readonly cohorte: string; readonly clientesIniciales: number; readonly meses: ReadonlyArray<{ readonly mes: string; readonly logosPct: number; readonly mrrPct: number | null }> }>;
  readonly concentracion: { readonly top1Pct: number | null; readonly top5Pct: number | null; readonly hhi: number | null };
  readonly fx: Disponible<{ readonly mxnPorUsd: number; readonly fecha: string | null; readonly fuente: string | null; readonly costoUsd: number; readonly exposicionPct: number | null; readonly sensibilidad10PctMxn: number; readonly movimiento30dPct: number | null }>;
  readonly presupuesto: ReadonlyArray<{ readonly mes: string; readonly ingresoPresupuestoMxn: number | null; readonly ingresoRealMxn: number | null; readonly costoPresupuestoMxn: number | null; readonly costoRealMxn: number | null }>;
}

export interface AlertaCockpit {
  readonly codigo: string;
  readonly severidad: "critica" | "alta" | "media";
  readonly titulo: string;
  readonly organizaciones: ReadonlyArray<{ readonly organizationId: string; readonly nombre: string; readonly dato: string }>;
}

export interface ValorSupuesto {
  readonly valor: number;
  readonly fuente: string;
  readonly origen: "medido" | "capturado" | "por_omision";
}

export type RespuestaCockpit =
  | { readonly disponible: false; readonly mes: string; readonly mensaje: string }
  | {
      readonly disponible: true;
      readonly mes: string;
      readonly enCurso: boolean;
      readonly diasTranscurridos: number;
      readonly diasDelMes: number;
      readonly tipoCambio: { readonly mxnPorUsd: number; readonly fecha: string | null; readonly fuente: string | null } | null;
      readonly supuestos: {
        readonly vozUsdMinuto: Readonly<Record<string, ValorSupuesto>>;
        readonly telefoniaUsdMinuto: Readonly<Record<string, ValorSupuesto>>;
        readonly llmUsdConversacionWa: ValorSupuesto | null;
        readonly whatsappUsdConversacion: ValorSupuesto | null;
        readonly umbralMargenPct: ValorSupuesto;
        readonly umbralPoolPct: ValorSupuesto;
        readonly umbralPicoCostoPct: ValorSupuesto;
        readonly umbralFxPct: ValorSupuesto;
        readonly ltvMesesTope: ValorSupuesto;
      };
      readonly economia: readonly FilaEconomia[];
      readonly agregados: { readonly total: Agregado; readonly porVertical: readonly Agregado[]; readonly porPlan: readonly Agregado[] };
      readonly saas: MetricasSaas;
      readonly alertas: { readonly cfo: readonly AlertaCockpit[]; readonly cockpit: readonly AlertaCockpit[] };
      readonly faltantes: readonly string[];
      readonly medidorCobro: boolean;
    };

export type TipoCaptura = "gasto_fijo" | "marketing" | "saldo_caja" | "presupuesto_ingreso" | "presupuesto_costo";
export interface Captura {
  readonly mes: string;
  readonly tipo: TipoCaptura;
  readonly concepto: string;
  readonly montoMxnCentavos: number;
  readonly nota: string | null;
}

async function pedir(apiBaseUrl: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) };
  return fetchConStepUp(apiBaseUrl, token, `${apiBaseUrl.replace(/\/$/, "")}${path}`, { ...init, headers });
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Error ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function fetchCockpit(apiBaseUrl: string, token: string, mes: string): Promise<RespuestaCockpit> {
  return json<RespuestaCockpit>(await pedir(apiBaseUrl, token, `/superadmin/cfo/cockpit?mes=${encodeURIComponent(mes)}`));
}

export async function fetchCapturas(apiBaseUrl: string, token: string): Promise<{ readonly disponible: boolean; readonly capturas: readonly Captura[]; readonly mensaje?: string }> {
  return json(await pedir(apiBaseUrl, token, "/superadmin/cfo/capturas"));
}

export async function guardarSupuesto(apiBaseUrl: string, token: string, body: { clave: string; proveedor?: string; valor: number | null; fuente?: string; nota?: string }): Promise<void> {
  await json(await pedir(apiBaseUrl, token, "/superadmin/cfo/supuestos", { method: "PUT", body: JSON.stringify(body) }));
}

export async function guardarCaptura(apiBaseUrl: string, token: string, body: { mes: string; tipo: TipoCaptura; concepto: string; montoMxn: number | null; nota?: string }): Promise<void> {
  await json(await pedir(apiBaseUrl, token, "/superadmin/cfo/capturas", { method: "PUT", body: JSON.stringify(body) }));
}

/** Descarga un archivo del CFO (pide step-up si hace falta). */
export async function descargar(apiBaseUrl: string, token: string, path: string, nombre: string): Promise<void> {
  const res = await pedir(apiBaseUrl, token, path);
  if (!res.ok) throw new Error(`Error ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const ETIQUETA_BANDERA: Readonly<Record<BanderaCliente, string>> = {
  no_rentable: "No rentable",
  margen_bajo: "Margen bajo",
  sobre_el_tope: "Sobre lo incluido",
  cerca_del_tope: "Cerca del tope",
  anomalia_uso: "Uso anómalo",
  pico_costo: "Pico de costo",
  pago_fallido: "Pago fallido",
};

export const ETIQUETA_CAPTURA: Readonly<Record<TipoCaptura, string>> = {
  gasto_fijo: "Gasto fijo",
  marketing: "Marketing",
  saldo_caja: "Saldo de caja",
  presupuesto_ingreso: "Presupuesto de ingreso",
  presupuesto_costo: "Presupuesto de costo",
};

export const ETIQUETA_FUENTE: Readonly<Record<FuenteCosto, string>> = {
  medido: "medido",
  modelado: "modelado",
  sin_uso: "sin uso",
  no_configurado: "sin tarifa",
  sin_dato: "sin dato",
};

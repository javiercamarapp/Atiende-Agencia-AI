// Costos de la simulacion. Regla: una tarifa o es de una fuente citada en el repo, o se marca `sin_verificar` y NO suma al total
// (queda listada con sus unidades para que el ledger muestre lo que habria que cotizar). Nada se redondea a favor del hotel.
import { lookupModelPrice } from "@atiende/agent-core";
import { resolveRoleRoute } from "../../apps/api/src/production/llm-models.ts";
import { HOTELES_WHATSAPP_AGENT_ROLE } from "../../apps/api/src/production/llm-gateway.ts";
import type { LineaCosto, TarifaCitada } from "./ledger.ts";

/** Modelo que el gateway de produccion usa hoy para el agente de WhatsApp de hoteles (primer escalon de la ruta por defecto). */
export function modeloAgenteHoteles(): string {
  const modelo = resolveRoleRoute(HOTELES_WHATSAPP_AGENT_ROLE, undefined).models[0]?.model;
  if (!modelo) throw new Error("costos: la ruta del agente de WhatsApp de hoteles no tiene modelo");
  return modelo;
}

/** USD por mensaje de WhatsApp saliente. SIN fuente primaria: el unico numero del repo vive en Likida (costos.ts, 0.008 "verificar rate card vigente"). */
export const WA_SALIENTE_USD = 0.008;

export function tarifasCitadas(): Record<string, TarifaCitada> {
  const modelo = modeloAgenteHoteles();
  const precio = lookupModelPrice(modelo);
  return {
    llm_entrada_por_millon: precio
      ? { usd: precio.inPerM, estado: "calculado", fuente: `packages/agent-core/src/gateway/prices.ts (${modelo}, verificado ${precio.verifiedAt}, catalogo OpenRouter)` }
      : { usd: null, estado: "sin_verificar", fuente: `sin fila de precio para ${modelo} en packages/agent-core/src/gateway/prices.ts` },
    llm_salida_por_millon: precio
      ? { usd: precio.outPerM, estado: "calculado", fuente: `packages/agent-core/src/gateway/prices.ts (${modelo}, verificado ${precio.verifiedAt}, catalogo OpenRouter)` }
      : { usd: null, estado: "sin_verificar", fuente: `sin fila de precio para ${modelo} en packages/agent-core/src/gateway/prices.ts` },
    whatsapp_mensaje_saliente: {
      usd: WA_SALIENTE_USD,
      estado: "sin_verificar",
      fuente: "referencia interna de Likida (src/lib/likida/costos.ts: 0.008 USD base MX, 'verificar rate card vigente de Meta'); no hay fuente primaria de Meta en este repo",
    },
    pac_timbre_cfdi: { usd: null, estado: "sin_verificar", fuente: "sin cuenta de PAC contratada: FinkokAdapter/SwSapienAdapter lanzan PortUnavailableError (apps/api/src/production/deps.ts); la tarifa depende del contrato" },
    voz_minuto: { usd: null, estado: "sin_verificar", fuente: "la simulacion no genera llamadas de voz; sin tarifa de proveedor contratada" },
    correo_transaccional: { usd: null, estado: "sin_verificar", fuente: "sin tarifa de Resend contratada en el repo (docs/CREDENCIALES.md)" },
  };
}

export interface UsoLlm {
  llamadas: number;
  tokensEntrada: number;
  tokensSalida: number;
}

export interface UsoDia {
  readonly llm: UsoLlm;
  readonly waSalientes: number;
  readonly timbres: number;
  readonly correos: number;
}

const redondear = (n: number) => Math.round(n * 1e8) / 1e8;

/** Lineas de costo de UN dia a partir de las unidades medidas en el ledger. */
export function lineasDeCosto(uso: UsoDia): LineaCosto[] {
  const modelo = modeloAgenteHoteles();
  const precio = lookupModelPrice(modelo);
  const lineas: LineaCosto[] = [];
  const llmUnidades = uso.llm.tokensEntrada + uso.llm.tokensSalida;
  if (precio) {
    const costo = redondear((uso.llm.tokensEntrada * precio.inPerM + uso.llm.tokensSalida * precio.outPerM) / 1_000_000);
    lineas.push({
      concepto: "llm",
      unidades: llmUnidades,
      unidad: "tokens (estimados por longitud del prompt real y de la respuesta guionada)",
      precioUnitarioUsd: llmUnidades === 0 ? precio.inPerM / 1_000_000 : redondear(costo / llmUnidades),
      costoUsd: costo,
      estado: "calculado",
      fuente: `${modelo}: ${precio.inPerM}/${precio.outPerM} USD por millon (entrada/salida), prices.ts verificado ${precio.verifiedAt}`,
    });
  } else {
    lineas.push({ concepto: "llm", unidades: llmUnidades, unidad: "tokens", precioUnitarioUsd: null, costoUsd: null, estado: "sin_verificar", fuente: `sin precio para ${modelo}` });
  }
  lineas.push({
    concepto: "whatsapp",
    unidades: uso.waSalientes,
    unidad: "mensajes salientes",
    precioUnitarioUsd: null,
    costoUsd: null,
    estado: "sin_verificar",
    fuente: `tarifa de referencia ${WA_SALIENTE_USD} USD/mensaje sin fuente primaria de Meta: no se suma al total (ver tarifas.whatsapp_mensaje_saliente)`,
  });
  lineas.push({ concepto: "pac", unidades: uso.timbres, unidad: "timbres CFDI", precioUnitarioUsd: null, costoUsd: null, estado: "sin_verificar", fuente: "sin tarifa de PAC contratada" });
  lineas.push({ concepto: "correo", unidades: uso.correos, unidad: "correos encolados (el envio requiere RESEND_API_KEY)", precioUnitarioUsd: null, costoUsd: null, estado: "sin_verificar", fuente: "sin tarifa de Resend contratada" });
  lineas.push({ concepto: "voz", unidades: 0, unidad: "minutos", precioUnitarioUsd: null, costoUsd: null, estado: "sin_verificar", fuente: "la simulacion no genera voz" });
  return lineas;
}

export function totalDeLineas(lineas: readonly LineaCosto[]): number {
  return redondear(lineas.reduce((s, l) => s + (l.costoUsd ?? 0), 0));
}

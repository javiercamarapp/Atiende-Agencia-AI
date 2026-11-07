// Modelo del turno de voz (decision del dueno): rapido = Gemini 3.5 Flash-Lite, preciso = GPT-6 Luna, respaldo = Claude Haiku 5.5; todos con ZDR.
// El handler de WhatsApp lo recibe como «modelo elegido» (`leerAjustes`) y pone de alterno por tope `modeloAlternoParaTope(elegido, true)`
// (Haiku para Luna y Flash-Lite; Luna para Haiku). Por omision el preciso: el rapido se enciende con VOZ_TURNO_MODELO=rapido tras medirlo.
import { MODELO_PRINCIPAL_CEREBRO_V2_ID, MODELO_RESPALDO_CEREBRO_V2_ID, MODELO_VOZ_RAPIDO_CEREBRO_V2_ID } from "../../ajustes-agente/modelos.ts";

export function modeloDeVoz(valor: string | undefined | null): string {
  const v = (valor ?? "").trim().toLowerCase();
  if (v === "rapido" || v === "rápido") return MODELO_VOZ_RAPIDO_CEREBRO_V2_ID;
  if (v === "respaldo") return MODELO_RESPALDO_CEREBRO_V2_ID;
  return MODELO_PRINCIPAL_CEREBRO_V2_ID;
}

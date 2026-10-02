// Instruccion del agente de VOZ de Los Taquitos de PM para el simulador y la prueba ciega: el MISMO perfil que WhatsApp y que el
// comportamiento sembrado (`voz/perfil-voz-pm.ts`), con la fecha/hora de la prueba, el saludo segun esa hora y la sucursal a la que
// "entra" la llamada. Las reglas duras las vuelve a aplicar el servidor.
import { PM_CONFIG_POR_OMISION } from "../../whatsapp/llm-turn-handler.ts";
import { buildPmSystemPrompt, saludoPorHora } from "../../whatsapp/perfil-pm.ts";
import type { BranchSummary } from "../../types.ts";
import { APENDICE_VOZ } from "../perfil-voz-pm.ts";

export { APENDICE_VOZ };

/**
 * `sucursalSlug` = la sucursal MARCADA a la que entra la llamada (antes se tomaba `branches[0]`, que cambiaba la sucursal de
 * contexto con solo reordenar la lista). Sin ella la llamada no pertenece a una sucursal. Un slug que no esta en la lista lanza:
 * simular otra sucursal en silencio falsearia la prueba.
 */
export function instruccionVozPm(branches: readonly BranchSummary[], fechaHoraLocal: string, diaSemana: string, sucursalSlug: string | null = null): string {
  const marcada = sucursalSlug === null ? null : (branches.find((b) => b.slug === sucursalSlug) ?? null);
  if (sucursalSlug !== null && !marcada) throw new RangeError(`instruccionVozPm: la sucursal marcada "${sucursalSlug}" no esta en la lista de sucursales.`);
  return (
    buildPmSystemPrompt({
      canal: "voz",
      businessName: PM_CONFIG_POR_OMISION.businessName,
      agentName: PM_CONFIG_POR_OMISION.agentName ?? "el asistente virtual",
      deliveryTimeText: PM_CONFIG_POR_OMISION.deliveryTimeText,
      saludo: saludoPorHora(fechaHoraLocal),
      branches,
      entryBranch: marcada ? { name: marcada.name, slug: marcada.slug } : null,
      customer: { isNew: true },
      fechaHoraLocal,
      diaSemana,
    }) + APENDICE_VOZ
  );
}

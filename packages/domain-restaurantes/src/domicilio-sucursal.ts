// Domicilio por sucursal (migracion 057): una sucursal puede no repartir (solo recoger) o repartir solo
// algunos dias de la semana. La regla vive AQUI, en el dominio, y la aplican `cotizar_pedido`, `crear_pedido`
// y el checkout web por el mismo camino (`aplicarReglasDeSucursal`): ni el agente de WhatsApp ni el de voz
// llevan la regla en su prompt.
import type { BranchPolicy } from "./types.ts";

const NOMBRE_DIA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"] as const;
/** Orden de lectura en español: lunes primero, domingo al final. */
const ORDEN_SEMANA = [1, 2, 3, 4, 5, 6, 0] as const;

/** Rachas contiguas de dias en orden de lectura (lunes..domingo). */
function rachasDeSemana(dias: readonly number[]): number[][] {
  const set = new Set(dias);
  const rachas: number[][] = [];
  let anterior = -2;
  ORDEN_SEMANA.forEach((d, idx) => {
    if (!set.has(d)) return;
    if (idx === anterior + 1 && rachas.length > 0) rachas[rachas.length - 1]!.push(d);
    else rachas.push([d]);
    anterior = idx;
  });
  return rachas;
}

export type EstadoDomicilio =
  | { readonly acepta: true }
  | { readonly acepta: false; readonly motivo: "solo_recoger" | "dia_no_disponible" };

/** ¿Reparte a domicilio la sucursal el dia `dia` (0 = domingo .. 6 = sabado, en SU zona horaria)? */
export function evaluarDomicilioSucursal(policy: Pick<BranchPolicy, "aceptaDomicilio" | "diasDomicilio">, dia: number): EstadoDomicilio {
  if (policy.aceptaDomicilio === false) return { acepta: false, motivo: "solo_recoger" };
  const dias = policy.diasDomicilio;
  if (dias && dias.length > 0 && !dias.includes(dia)) return { acepta: false, motivo: "dia_no_disponible" };
  return { acepta: true };
}

/** "viernes a domingo", "lunes, miércoles y viernes", "todos los días". Pura y determinista. */
export function describirDiasDomicilio(dias: readonly number[] | null | undefined): string {
  if (!dias || dias.length === 0 || dias.length >= 7) return "todos los días";
  const rachas = rachasDeSemana(dias);
  const partes = rachas.map((r) => (r.length >= 3 ? `${NOMBRE_DIA[r[0]!]} a ${NOMBRE_DIA[r[r.length - 1]!]}` : r.map((d) => NOMBRE_DIA[d]!).join(" y ")));
  if (partes.length === 1) return partes[0]!;
  return `${partes.slice(0, -1).join(", ")} y ${partes[partes.length - 1]}`;
}

/** Texto corto para la insignia publica: "Solo recoger", "Domicilio vie-dom" o null (reparte todos los dias). */
export function insigniaDomicilio(policy: Pick<BranchPolicy, "aceptaDomicilio" | "diasDomicilio">): string | null {
  if (policy.aceptaDomicilio === false) return "Solo recoger";
  const dias = policy.diasDomicilio;
  if (!dias || dias.length === 0 || dias.length >= 7) return null;
  const rachas = rachasDeSemana(dias);
  const corto = (d: number) => NOMBRE_DIA[d]!.slice(0, 3);
  const partes = rachas.map((r) => (r.length >= 3 ? `${corto(r[0]!)}-${corto(r[r.length - 1]!)}` : r.map(corto).join(", ")));
  return `Domicilio ${partes.join(", ")}`;
}

/** Mensaje honesto para el cliente cuando el domicilio no esta disponible; siempre ofrece recoger o cambiar de sucursal. */
export function mensajeDomicilioNoDisponible(nombreSucursal: string, policy: Pick<BranchPolicy, "diasDomicilio">, estado: Extract<EstadoDomicilio, { acepta: false }>): string {
  if (estado.motivo === "solo_recoger") {
    return `${nombreSucursal} solo atiende pedidos para recoger, no reparte a domicilio; ¿lo recoge o elige otra sucursal?`;
  }
  return `${nombreSucursal} solo entrega a domicilio de ${describirDiasDomicilio(policy.diasDomicilio)}; ¿la recoge o elige otra sucursal?`;
}

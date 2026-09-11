// ═══════════════════════════════════════════════════════════════════════════
// Gate de residencia de datos, configurable — NUNCA hardcodeado a un solo
// proveedor.
//
// PUERTO de licitaciones/packages/agents/src/llm/router.ts +
// llm/provider.ts (REQ-124/REQ-125/REQ-126, invariante AG-06): la vertical
// de licitaciones de gobierno mexicano exige que ciertas rutas del modelo
// permanezcan SIEMPRE en un proveedor con sede legal en un país declarado
// (por defecto EE.UU., "REQUIRED_COUNTRY_FOR_ZERO_TOLERANCE" en el
// original) — es un requisito real de licitación, no una preferencia.
//
// DISEÑO: en vez del enfoque de "5 componentes de tolerancia cero" fijos del
// original (que amarraba la regla a los roles concretos de esa vertical),
// aquí el gate es una POLÍTICA por llamada (`ResidencyPolicy`) que cualquier
// vertical activa o no. Sigue siendo imposible debilitarlo en silencio:
//   - `enabled` es explícito, nunca implícito por ausencia de config.
//   - Cuando está activo, FILTRA la escalera de proveedores a los que
//     cumplen `countryOfResidence === requiredCountry` — no elige "el
//     proveedor de EE.UU." a dedo, así que sigue soportando VARIOS
//     proveedores plegables mientras todos declaren residencia EE.UU.
//     (p.ej. Anthropic directo Y OpenAI directo, ambos con sede en EE.UU.,
//     pueden convivir en la escalera con el gate activo).
//   - Si NINGÚN proveedor de la escalera cumple, se RECHAZA explícito
//     (`ResidencyGateBlockedError`) — igual que `NoCompliantProviderError`
//     del original — en vez de degradar en silencio a un proveedor no
//     conforme.
// ═══════════════════════════════════════════════════════════════════════════

import { ResidencyGateBlockedError } from './errors.js';
import type { LlmProvider } from './types.js';

export interface ResidencyPolicy {
  enabled: boolean;
  /** ISO 3166-1 alpha-2. Por defecto 'US' — el requisito real de licitación
   *  que originó este gate (gobierno mexicano exige residencia EE.UU. para
   *  ciertos componentes). Configurable: nada aquí ata el gate a un único
   *  país ni a un único proveedor. */
  requiredCountry: string;
}

export const DEFAULT_RESIDENCY_POLICY: ResidencyPolicy = {
  enabled: false,
  requiredCountry: 'US',
};

/**
 * Filtra la escalera de proveedores por el gate de residencia. Con el gate
 * apagado, devuelve la escalera intacta (comportamiento normal). Con el gate
 * prendido, devuelve SOLO los proveedores conformes, preservando su orden
 * relativo (la escalera de fallback entre los que sí cumplen se mantiene) —
 * y lanza si ninguno cumple.
 */
export function applyResidencyGate(
  providers: readonly LlmProvider[],
  policy: ResidencyPolicy,
): LlmProvider[] {
  if (!policy.enabled) return [...providers];
  const allowed = providers.filter((p) => p.countryOfResidence === policy.requiredCountry);
  if (allowed.length === 0) {
    throw new ResidencyGateBlockedError(
      policy.requiredCountry,
      providers.map((p) => `${p.id}:${p.countryOfResidence}`),
    );
  }
  return allowed;
}

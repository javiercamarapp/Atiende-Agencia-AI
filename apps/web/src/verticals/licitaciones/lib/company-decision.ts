// Reglas COSMETICAS de la decision sobre datos de empresa (migracion 036): deciden que botones mostrar y cuales deshabilitar con su
// motivo. El servidor SIEMPRE decide (rol, autor distinto del aprobador, step-up, 404/409); `domain-licitaciones/src/roles.ts` es la
// fuente de verdad y aqui solo se espeja (la web no depende del dominio).
import type { CompanyDataAuthorship, CompanyItemKind } from "./company-data-client.ts";

const RATE_DECISION_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);
const DECISION_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "analyst"]);

/** Tarifas (decision economica): owner/admin. El resto de datos: DECISION_ROLES (owner/admin/analyst). */
export function canDecideKind(kind: CompanyItemKind, role: string): boolean {
  return (kind === "rate" ? RATE_DECISION_ROLES : DECISION_ROLES).has(role);
}

/** Solo las tarifas piden segundo factor reciente. */
export function requiresStepUp(kind: CompanyItemKind): boolean {
  return kind === "rate";
}

/** `sub` del JWT de acceso (solo para saber si el dato lo propuso quien mira la pantalla). Nunca se usa para autorizar. */
export function userIdFromToken(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(payload.length / 4) * 4, "="));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

/** Motivo (a la vista) por el que quien mira NO puede decidir este dato, o `null` si puede. */
export function decisionBlockedReason(item: CompanyDataAuthorship, userId: string | null): string | null {
  if (userId && item.proposedBy && item.proposedBy === userId) return "Lo propusiste o editaste tú: lo debe decidir otra persona.";
  return null;
}

/** "Propuso: Ana · Aprobó: Beto" -- sin PII extra: solo el nombre que ya muestra el equipo. `null` si la base aún no trae autoría. */
export function authorshipLine(item: CompanyDataAuthorship & { readonly approvalStatus?: string }, userId: string | null): string | null {
  const parts: string[] = [];
  if (item.proposedBy) parts.push(`Propuso: ${item.proposedBy === userId ? "tú" : (item.proposedByName ?? "otra persona del equipo")}`);
  if (item.approvedBy) parts.push(`${item.approvalStatus === "rechazado" ? "Rechazó" : "Aprobó"}: ${item.approvedBy === userId ? "tú" : (item.approvedByName ?? "otra persona del equipo")}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

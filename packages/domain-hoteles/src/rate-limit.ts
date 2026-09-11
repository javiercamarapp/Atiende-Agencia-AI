// Port literal de domain-restaurantes/src/rate-limit.ts (diseño Fase 2 §4: portado
// tal cual, marcado como segunda copia real del mismo mecanismo — candidato futuro a
// paquete compartido, no resuelto en esta fase).
import { createHash } from "node:crypto";
import type { HotelesRepository } from "./repository.ts";

export function actorHash(actor: string): string {
  return createHash("sha256").update(actor).digest("hex");
}

/** El último salto de X-Forwarded-For evita que un prefijo controlado por el caller
 * fabrique un bucket nuevo por request; cf-connecting-ip (proxy confiable) tiene
 * prioridad cuando está presente. */
export function requestActor(headers: { get(name: string): string | null }, secondary = ""): string {
  const connectingIp = headers.get("cf-connecting-ip")?.trim();
  const forwarded = headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return `${connectingIp || forwarded || "unknown"}:${secondary.slice(0, 128)}`;
}

export async function consumeRateLimit(
  repo: HotelesRepository,
  scope: string,
  actor: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<{ readonly allowed: boolean }> {
  const allowed = await repo.consumeRateLimit(scope, actorHash(actor), maxRequests, windowSeconds);
  return { allowed };
}

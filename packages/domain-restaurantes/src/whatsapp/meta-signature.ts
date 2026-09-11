// Port de restaurantes/supabase/functions/_shared/meta-signature.ts — verifica
// X-Hub-Signature-256 (HMAC-SHA256) sobre los BYTES CRUDOS del body, nunca sobre el
// texto ya decodificado/re-serializado. Este detalle importa de verdad: el caller
// (apps/api/src/routes/verticals/restaurantes/whatsapp.ts) DEBE leer
// `c.req.raw.arrayBuffer()` antes de que cualquier middleware de parseo de JSON toque
// el stream — si algo ya consumió el body, la verificación falla en falso o, peor,
// valida contra un body distinto del que Meta realmente firmó.
//
// Adaptado a `node:crypto` (createHmac/timingSafeEqual) en vez de `crypto.subtle` del
// origen (Deno) — mismo algoritmo (HMAC-SHA256) y misma comparación en tiempo
// constante, solo el API nativo cambia de runtime.
import { createHmac, timingSafeEqual } from "node:crypto";

function constantTimeHexEqual(actual: string, expected: string): boolean {
  const actualBuf = Buffer.from(actual, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  if (actualBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(actualBuf, expectedBuf);
}

export async function verifyMetaSignature(rawBody: Uint8Array, signatureHeader: string | null, appSecret: string | null): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=") || !appSecret) return false;
  const supplied = signatureHeader.slice("sha256=".length).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(supplied)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return constantTimeHexEqual(supplied, expected);
}

// Rn-29 -- cifrador de las instrucciones de acceso de rentas segun el entorno (memoizado por `env`). Una llave
// presente pero invalida NO se degrada a "sin llave" en silencio: se guarda el error para que cada operacion
// responda 503 explicito. Nunca lanza al construirse (un entorno mal configurado no tumba el arranque de la API).
import { AccesoNoDisponibleError, resolverCipherAcceso } from "@atiende/domain-rentas";
import type { AccesoCipher } from "@atiende/domain-rentas";

interface EntornoAcceso {
  readonly rentasAccessKey: string | null;
  readonly rentasAccessKeyVersion: number;
}

export interface CifradorAcceso {
  readonly cipher: AccesoCipher | null;
  readonly error: AccesoNoDisponibleError | null;
}

const cache = new WeakMap<object, CifradorAcceso>();

export function cifradorAccesoDeEntorno(env: EntornoAcceso): CifradorAcceso {
  const hit = cache.get(env);
  if (hit) return hit;
  let r: CifradorAcceso;
  try {
    r = { cipher: resolverCipherAcceso(env.rentasAccessKey, env.rentasAccessKeyVersion), error: null };
  } catch (err) {
    r = { cipher: null, error: err instanceof AccesoNoDisponibleError ? err : new AccesoNoDisponibleError("llave_invalida") };
  }
  cache.set(env, r);
  return r;
}

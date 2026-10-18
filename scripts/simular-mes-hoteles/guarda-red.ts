// Guarda de red del simulador: sustituye `globalThis.fetch`; todo `fetch` a un host que no tenga doble (incluido localhost) se rechaza y se registra.
// Alcance: solo `fetch`; una salida por http/https de Node, net o un SDK que no use fetch NO se intercepta ni se cuenta.
// Objetivo: NINGUNA llamada saliente real por fetch.
// (si algo del codigo bajo prueba intentara hablar con Meta, un PAC, Stripe, OpenRouter o Resend, el assert "cero llamadas externas"
// lo expone en vez de gastar o enviar nada). Excepcion declarada: los HOSTS DOBLADOS (`dobles`), cuyas respuestas fabrica el propio
// simulador en proceso; se cuentan aparte para que el ledger muestre que el doble se uso y no hubo red.
export interface LlamadaBloqueada {
  readonly url: string;
}

export interface DobleDeHost {
  readonly host: string;
  responder(url: string, cuerpo: string): Response | Promise<Response>;
}

export function instalarGuardaRed(dobles: readonly DobleDeHost[] = []): { readonly bloqueadas: LlamadaBloqueada[]; readonly atendidasPorDoble: Record<string, number>; desinstalar(): void } {
  const original = globalThis.fetch;
  const bloqueadas: LlamadaBloqueada[] = [];
  const atendidasPorDoble: Record<string, number> = {};
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const sinQuery = url.replace(/\?.*$/, "");
    const doble = dobles.find((d) => new URL(url).host === d.host);
    if (doble) {
      atendidasPorDoble[doble.host] = (atendidasPorDoble[doble.host] ?? 0) + 1;
      return doble.responder(sinQuery, typeof init?.body === "string" ? init.body : "");
    }
    bloqueadas.push({ url: sinQuery });
    throw new Error(`simulador: llamada saliente bloqueada (${sinQuery}). El simulador no habla con servicios externos.`);
  }) as typeof fetch;
  return {
    bloqueadas,
    atendidasPorDoble,
    desinstalar() {
      globalThis.fetch = original;
    },
  };
}

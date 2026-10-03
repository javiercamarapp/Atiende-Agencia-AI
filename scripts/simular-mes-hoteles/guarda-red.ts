// Guarda de red del simulador: NINGUNA llamada saliente real. Todo `fetch` a un host que no sea local se rechaza y se registra
// (si algo del codigo bajo prueba intentara hablar con Meta, un PAC, Stripe, OpenRouter o Resend, el assert "cero llamadas externas"
// lo expone en vez de gastar o enviar nada).
export interface LlamadaBloqueada {
  readonly url: string;
}

export function instalarGuardaRed(): { readonly bloqueadas: LlamadaBloqueada[]; desinstalar(): void } {
  const original = globalThis.fetch;
  const bloqueadas: LlamadaBloqueada[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    bloqueadas.push({ url: url.replace(/\?.*$/, "") });
    throw new Error(`simulador: llamada saliente bloqueada (${url.replace(/\?.*$/, "")}). El simulador no habla con servicios externos.`);
  }) as typeof fetch;
  return {
    bloqueadas,
    desinstalar() {
      globalThis.fetch = original;
    },
  };
}

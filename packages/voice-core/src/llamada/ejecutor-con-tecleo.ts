// Envuelve el ejecutor de herramientas de la llamada para avisar del INICIO y el FIN de cada herramienta (ok o no, con timeout o sin el): es el unico punto por el
// que pasan las herramientas de los DOS motores (Gemini Live y la cascada llaman a `controlador.herramienta`, que llama a `ejecutor.ejecutar`), asi el tecleo queda
// sincronizado con la duracion REAL de la herramienta sin tocar el protocolo de ninguno. Las lecturas y escrituras se tratan igual; `incluir` deja excluir nombres
// (por ejemplo la escalacion a una persona, que no es "anotar").
export interface AvisosHerramienta {
  readonly inicia: (id: string, nombre: string) => void;
  readonly termina: (id: string, ok: boolean) => void;
  readonly incluir?: (nombre: string) => boolean;
}

export function conAvisosDeHerramienta<E extends { ejecutar(...a: never[]): Promise<{ readonly ok: boolean }> }>(ejecutor: E, avisos: AvisosHerramienta): E {
  let contador = 0;
  const original = ejecutor.ejecutar.bind(ejecutor) as (...a: unknown[]) => Promise<{ readonly ok: boolean }>;
  const envuelto = {
    ...ejecutor,
    ejecutar: async (...a: unknown[]) => {
      const nombre = typeof a[0] === "string" ? a[0] : "";
      if (avisos.incluir && !avisos.incluir(nombre)) return original(...a);
      const id = `herr-${++contador}`;
      avisos.inicia(id, nombre);
      let ok = false;
      try {
        const r = await original(...a);
        ok = r.ok;
        return r;
      } finally {
        avisos.termina(id, ok);
      }
    },
  };
  return envuelto as unknown as E;
}

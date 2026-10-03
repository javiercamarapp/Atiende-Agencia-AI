import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { ESTADO_SESION_INICIAL } from "@atiende/ui";
import type { LineaTranscripcion, OpcionesIniciarSesionVoz, VoiceSessionController, VoiceSessionState } from "@atiende/ui";
import type { AdaptadorVoz, CallbacksAdaptador, CambioEstado, FabricaAdaptador } from "./adaptador.ts";

interface Estado {
  readonly sesion: VoiceSessionState;
  readonly silenciado: boolean;
}

type Accion =
  | { readonly tipo: "reiniciar" }
  | { readonly tipo: "cambiar"; readonly cambio: CambioEstado }
  | { readonly tipo: "linea"; readonly linea: LineaTranscripcion }
  | { readonly tipo: "silenciar"; readonly valor: boolean }
  | { readonly tipo: "fin"; readonly error?: VoiceSessionState["error"] };

const INICIAL: Estado = { sesion: ESTADO_SESION_INICIAL, silenciado: false };

function reducir(estado: Estado, accion: Accion): Estado {
  switch (accion.tipo) {
    case "reiniciar":
      // Empieza una llamada nueva: limpia transcripción y error, conserva el silencio elegido.
      return { silenciado: estado.silenciado, sesion: { ...ESTADO_SESION_INICIAL, modo: "conectando" } };
    case "cambiar":
      return { ...estado, sesion: { ...estado.sesion, ...accion.cambio } };
    case "linea": {
      const previas = estado.sesion.transcripcion;
      const i = previas.findIndex((l) => l.id === accion.linea.id);
      const transcripcion = i === -1 ? [...previas, accion.linea] : previas.map((l, j) => (j === i ? accion.linea : l));
      return { ...estado, sesion: { ...estado.sesion, transcripcion } };
    }
    case "silenciar":
      return { ...estado, silenciado: accion.valor };
    case "fin":
      // La transcripción se conserva al colgar (igual que el panel original).
      return {
        ...estado,
        sesion: { ...estado.sesion, modo: accion.error ? "error" : "reposo", volumenEntrada: 0, volumenSalida: 0, ...(accion.error ? { error: accion.error } : { error: undefined }) },
      };
  }
}

/**
 * Convierte un adaptador de proveedor en el `VoiceSessionController` que consume la
 * interfaz. Crea el adaptador al iniciar (uno por llamada), ignora callbacks de
 * adaptadores ya terminados y cuelga la llamada si el componente se desmonta.
 */
export function useSesionVoz(fabrica: FabricaAdaptador): VoiceSessionController {
  const [estado, despachar] = useReducer(reducir, INICIAL);
  const fabricaRef = useRef(fabrica);
  fabricaRef.current = fabrica;
  const actualRef = useRef<{ readonly adaptador: AdaptadorVoz } | null>(null);
  const silenciadoRef = useRef(false);
  silenciadoRef.current = estado.silenciado;

  const iniciar = useCallback(async (opts?: OpcionesIniciarSesionVoz) => {
    if (actualRef.current) return;
    despachar({ tipo: "reiniciar" });
    const ficha: { adaptador: AdaptadorVoz | null } = { adaptador: null };
    const vigente = () => actualRef.current !== null && actualRef.current.adaptador === ficha.adaptador;
    const callbacks: CallbacksAdaptador = {
      cambiar: (cambio) => {
        if (vigente()) despachar({ tipo: "cambiar", cambio });
      },
      linea: (linea) => {
        if (vigente()) despachar({ tipo: "linea", linea });
      },
      terminado: () => {
        if (!vigente()) return;
        actualRef.current = null;
        despachar({ tipo: "fin" });
      },
    };
    let adaptador: AdaptadorVoz;
    try {
      adaptador = fabricaRef.current(callbacks);
    } catch (err) {
      despachar({ tipo: "fin", error: { codigo: "adaptador", mensaje: err instanceof Error ? err.message : "No se pudo preparar la llamada.", recuperable: false } });
      return;
    }
    ficha.adaptador = adaptador;
    actualRef.current = { adaptador };
    try {
      await adaptador.iniciar(opts);
      if (silenciadoRef.current) adaptador.silenciar(true);
    } catch (err) {
      if (actualRef.current?.adaptador === adaptador) actualRef.current = null;
      despachar({ tipo: "fin", error: { codigo: "inicio", mensaje: err instanceof Error ? err.message : "No se pudo iniciar la llamada.", recuperable: true } });
    }
  }, []);

  const terminar = useCallback(async () => {
    const actual = actualRef.current;
    if (!actual) return;
    actualRef.current = null;
    try {
      await actual.adaptador.terminar();
    } finally {
      despachar({ tipo: "fin" });
    }
  }, []);

  const silenciar = useCallback((valor: boolean) => {
    despachar({ tipo: "silenciar", valor });
    actualRef.current?.adaptador.silenciar(valor);
  }, []);

  // Cuelga si el usuario cierra la vista previa a medias (equivale al cleanup del original).
  useEffect(
    () => () => {
      const actual = actualRef.current;
      actualRef.current = null;
      void actual?.adaptador.terminar().catch(() => undefined);
    },
    [],
  );

  return useMemo(() => ({ estado: estado.sesion, silenciado: estado.silenciado, iniciar, terminar, silenciar }), [estado, iniciar, terminar, silenciar]);
}

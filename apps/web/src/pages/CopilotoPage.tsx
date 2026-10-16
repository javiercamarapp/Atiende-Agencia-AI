// Pagina del Copiloto ("Pregunta a tus datos"), GENERICA para todas las verticales: recibe la configuracion de la vertical
// (textos, chips, categorias), un transporte ya conectado a su API y un lector de /estado, y monta el `ChatDatosShell` de
// @atiende/ui. No tiene datos propios ni respuestas simuladas: sin proveedor de IA o sin acceso muestra un estado honesto.
// El nombre de la pagina lo pinta la barra superior del shell; el h1 visible ("Pregunta a tus datos") es el de la portada.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Lock, Sparkles } from "lucide-react";
import { Callout, ChatDatosShell, EstadoCargando, EstadoError, EstadoVacio, useTituloBarra } from "@atiende/ui";
import type { CopilotoTransporte } from "@atiende/ui";
import type { CopilotoConfigVertical } from "../lib/copiloto/config/tipos.ts";
import type { EstadoCopiloto } from "../lib/copiloto/transporte.ts";

export interface CopilotoPageProps {
  readonly config: CopilotoConfigVertical;
  /** Transporte conectado a la API de la vertical. `reiniciar` (si existe) se llama al iniciar un chat nuevo. */
  readonly transporte: CopilotoTransporte & { reiniciar?: () => void };
  /** GET /estado de la vertical (403 = sin_acceso). */
  readonly consultarEstado: (senal: AbortSignal) => Promise<EstadoCopiloto>;
  /** Sucursal/propiedad activa: al cambiarla se vuelve a consultar el estado y el chat arranca limpio. */
  readonly propertyId: string;
  readonly orgSlug: string;
  /** Nombre visible del alcance ("Sucursal: Centro"); opcional. */
  readonly contexto?: string;
  readonly zonaHoraria?: string;
}

type Carga = { readonly fase: "cargando" } | { readonly fase: "listo"; readonly estado: EstadoCopiloto };

/** Sustituye `:orgSlug` en las rutas de fuente; descarta cualquier ruta que no sea interna. */
export function rutasFuenteDe(rutas: Readonly<Record<string, string>>, orgSlug: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [tool, ruta] of Object.entries(rutas)) {
    const r = ruta.replaceAll(":orgSlug", encodeURIComponent(orgSlug));
    if (r.startsWith("/") && !r.startsWith("//")) out[tool] = r;
  }
  return out;
}

export function CopilotoPage({ config, transporte, consultarEstado, propertyId, orgSlug, contexto, zonaHoraria }: CopilotoPageProps) {
  // La barra superior del shell lleva el nombre y el icono de la pagina como las demas ("Pregunta a tus datos"), en TODOS los estados (cargando, sin acceso, listo).
  useTituloBarra(config.textos.titulo, Sparkles);
  const [carga, setCarga] = useState<Carga>({ fase: "cargando" });
  const [intento, setIntento] = useState(0);
  const [params, setParams] = useSearchParams();
  // La conversacion abierta se refleja en `?c=<id>` para poder volver a ella; se lee UNA vez (el shell la abre al montar).
  const [conversacionInicial] = useState(() => params.get("c") ?? undefined);

  useEffect(() => {
    const ctl = new AbortController();
    setCarga({ fase: "cargando" });
    void consultarEstado(ctl.signal).then((estado) => {
      if (!ctl.signal.aborted) setCarga({ fase: "listo", estado });
    });
    return () => ctl.abort();
    // `consultarEstado` se recrea en cada render del shell; el estado depende solo de la sucursal y del reintento.
  }, [propertyId, intento]);

  const rutasFuente = useMemo(() => rutasFuenteDe(config.rutasFuente, orgSlug), [config.rutasFuente, orgSlug]);
  const textos = useMemo(() => (contexto ? { ...config.textos, contexto } : config.textos), [config.textos, contexto]);

  const alCambiarConversacion = useCallback(
    (id?: string) => {
      if (!id) transporte.reiniciar?.();
      setParams(
        (prev) => {
          const sig = new URLSearchParams(prev);
          if (id) sig.set("c", id);
          else sig.delete("c");
          return sig;
        },
        { replace: true },
      );
    },
    [setParams, transporte],
  );

  if (carga.fase === "cargando") {
    return (
      <div className="p-4">
        <EstadoCargando etiqueta="Preparando el Copiloto…" />
      </div>
    );
  }

  const { estado } = carga;
  if (estado.tipo === "sin_acceso") {
    return (
      <div className="p-4">
        <EstadoVacio icon={Lock} titulo="Sin acceso" mensaje={config.textoSinAcceso} />
      </div>
    );
  }
  if (estado.tipo === "error") {
    return (
      <div className="p-4">
        <EstadoError titulo="No se pudo abrir el Copiloto" mensaje="No pude verificar si el Copiloto está disponible. Revisa tu conexión e inténtalo de nuevo." onReintentar={() => setIntento((n) => n + 1)} />
      </div>
    );
  }
  if (!estado.available) {
    return (
      <div className="p-4">
        <EstadoVacio
          icon={Sparkles}
          titulo="Pronto"
          mensaje="El Copiloto todavía no está activado para tu cuenta: requiere un proveedor de IA configurado. Tus tableros siguen disponibles y no se muestran cifras inventadas."
        />
      </div>
    );
  }

  return (
    <>
      {!estado.permitido && estado.motivo === "tope_diario" ? (
        <div className="px-4 pt-4">
          <Callout tone="warning" titulo="Llegaste al tope diario de preguntas">
            Podrás volver a preguntar mañana. Mientras tanto puedes revisar tus conversaciones anteriores desde el historial.
          </Callout>
        </div>
      ) : null}
      <ChatDatosShell
        transporte={transporte}
        textos={textos}
        sugerencias={config.sugerencias}
        categorias={config.categorias}
        directas={config.directas}
        etiquetasHerramienta={config.etiquetasHerramienta}
        rutasFuente={rutasFuente}
        maxCaracteres={config.maxCaracteres}
        vertical={config.vertical}
        {...(estado.usoHoyPct !== null ? { uso: { pct: estado.usoHoyPct, etiqueta: "Uso de hoy" } } : {})}
        {...(conversacionInicial ? { conversacionInicial } : {})}
        onConversacionCambia={alCambiarConversacion}
        {...(zonaHoraria ? { zonaHoraria } : {})}
      />
    </>
  );
}

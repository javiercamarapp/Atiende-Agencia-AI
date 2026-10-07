// Cuerpo del Copiloto de PLATAFORMA (superadmin): lo comparten la pagina `/superadmin/copiloto` (variante `pagina`) y el panel lateral Cmd+J (variante `panel`).
// Lee `GET /superadmin/copiloto/estado` y monta el `ChatDatosShell` de @atiende/ui conectado al transporte real. Sin respuestas simuladas: cada estado
// (sin acceso, impersonando, error, sin proveedor de IA, interruptor apagado, tope mensual) es un aviso honesto con su motivo.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Lock, ShieldAlert } from "lucide-react";
import { Button, Callout, ChatDatosShell, EstadoCargando, EstadoError, EstadoVacio } from "@atiende/ui";
import { COPILOTO_SUPERADMIN } from "../lib/copiloto-config.ts";
import { consultarEstadoSuperadmin, crearClienteAcciones, crearTransporteSuperadmin } from "../lib/copiloto-cliente.ts";
import type { EstadoCopilotoSuperadmin } from "../lib/copiloto-cliente.ts";

export interface CopilotoPlataformaProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly variante: "pagina" | "panel";
  /** Conversacion a abrir al montar (`?c=<id>`); se lee UNA vez. */
  readonly conversacionInicial?: string;
  readonly onConversacionCambia?: (id?: string) => void;
}

type Carga = { readonly fase: "cargando" } | { readonly fase: "listo"; readonly estado: EstadoCopilotoSuperadmin };

const AVISO_MOTIVO: Readonly<Record<"no_activado" | "interruptor_apagado" | "tope_mensual", { readonly titulo: string; readonly texto: string }>> = {
  no_activado: {
    titulo: "Preguntas libres no activadas",
    texto: "Falta configurar un proveedor de IA en este despliegue. Las consultas de los botones (sin IA) siguen funcionando; las preguntas escritas no.",
  },
  interruptor_apagado: {
    titulo: "El Copiloto está en pausa",
    texto: "Su interruptor está apagado. Las consultas de los botones (sin IA) siguen funcionando; puedes encenderlo en Interruptores.",
  },
  tope_mensual: {
    titulo: "Llegaste al tope mensual del Copiloto",
    texto: "Responde sin IA hasta el mes que entra o hasta que subas su tope. Las consultas de los botones siguen funcionando.",
  },
};

export function CopilotoPlataforma({ apiBaseUrl, token, variante, conversacionInicial, onConversacionCambia }: CopilotoPlataformaProps) {
  const [carga, setCarga] = useState<Carga>({ fase: "cargando" });
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    setCarga({ fase: "cargando" });
    void consultarEstadoSuperadmin(apiBaseUrl, token, ctl.signal).then((estado) => {
      if (!ctl.signal.aborted) setCarga({ fase: "listo", estado });
    });
    return () => ctl.abort();
  }, [apiBaseUrl, token, intento]);

  const conFijados = carga.fase === "listo" && carga.estado.tipo === "ok" && carga.estado.fijados;
  const conAdjuntos = carga.fase === "listo" && carga.estado.tipo === "ok" && carga.estado.adjuntos;
  const transporte = useMemo(() => crearTransporteSuperadmin(apiBaseUrl, token, undefined, { fijados: conFijados, adjuntos: conAdjuntos }), [apiBaseUrl, token, conFijados, conAdjuntos]);
  const acciones = useMemo(() => crearClienteAcciones(apiBaseUrl, token), [apiBaseUrl, token]);

  const envoltura = (hijo: React.ReactNode) => <div className={variante === "panel" ? "p-3" : "p-4"}>{hijo}</div>;

  if (carga.fase === "cargando") return envoltura(<EstadoCargando etiqueta="Preparando el Copiloto…" />);
  const { estado } = carga;
  if (estado.tipo === "sin_acceso") return envoltura(<EstadoVacio icon={Lock} titulo="Sin acceso" mensaje={COPILOTO_SUPERADMIN.textoSinAcceso} />);
  if (estado.tipo === "impersonando") {
    return envoltura(
      <EstadoVacio
        icon={ShieldAlert}
        titulo="Copiloto deshabilitado"
        mensaje={`${estado.mensaje} El Copiloto ve toda la plataforma, por eso no se usa mientras actúas como un cliente.`}
        accion={
          <Button asChild variant="outline" size="sm">
            <Link to="/superadmin/impersonacion">Ir a Impersonación</Link>
          </Button>
        }
      />,
    );
  }
  if (estado.tipo === "error") {
    return envoltura(
      <EstadoError titulo="No se pudo abrir el Copiloto" mensaje="No pude verificar si el Copiloto está disponible. Revisa tu conexión e inténtalo de nuevo." onReintentar={() => setIntento((n) => n + 1)} />,
    );
  }

  const aviso = estado.motivo ? AVISO_MOTIVO[estado.motivo] : null;
  const panel = variante === "panel";
  return (
    <div className={panel ? "flex h-full min-h-0 flex-col" : undefined}>
      {aviso ? (
        <div className={variante === "panel" ? "px-3 pt-3" : "px-4 pt-4"}>
          <Callout tone="warning" titulo={aviso.titulo}>
            {aviso.texto}
          </Callout>
        </div>
      ) : null}
      <div className={panel ? "min-h-0 flex-1" : undefined}>
      <ChatDatosShell
        variante={variante}
        transporte={transporte}
        textos={COPILOTO_SUPERADMIN.textos}
        sugerencias={COPILOTO_SUPERADMIN.sugerencias}
        categorias={COPILOTO_SUPERADMIN.categorias}
        directas={COPILOTO_SUPERADMIN.directas}
        etiquetasHerramienta={COPILOTO_SUPERADMIN.etiquetasHerramienta}
        rutasFuente={COPILOTO_SUPERADMIN.rutasFuente}
        maxCaracteres={COPILOTO_SUPERADMIN.maxCaracteres}
        vertical={COPILOTO_SUPERADMIN.vertical}
        {...(estado.propone ? { acciones } : {})}
        {...(estado.usoMensualPct !== null ? { uso: { pct: estado.usoMensualPct, etiqueta: "Uso del tope mensual" } } : {})}
        {...(conversacionInicial ? { conversacionInicial } : {})}
        {...(onConversacionCambia ? { onConversacionCambia } : {})}
        zonaHoraria="America/Mexico_City"
      />
      </div>
    </div>
  );
}

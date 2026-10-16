// Tablero de fijados del Copiloto, para la pagina de Resumen de cualquier vertical. Cada fijado se RE-EJECUTA al abrir (sin modelo y
// con cache en el servidor) con el alcance y rol actuales, asi que nunca muestra cifras viejas ni fuera de alcance. Nada es
// decorativo: listar, quitar, compartir y reintentar llaman al servidor por el `cliente` inyectado; si el servidor no esta listo
// (base sin migrar) lo dice; si el rol no tiene Copiloto (403) la seccion no se pinta.
// Estilo de la seccion de Resumen de Likida: `Card p-3` + `SectionLabel`.
import { useCallback, useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { Pin, PinOff, Share2, Users } from "lucide-react";
import { cn } from "../../lib/utils";
import { EstadoCargando } from "../EstadoCargando";
import { EstadoError } from "../EstadoError";
import { SectionLabel } from "../SectionLabel";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { BloqueDatos } from "./CopilotoMensaje";
import { FijadosErrorCliente, type FijadoResultado, type FijadoResumen, type FijadosCliente } from "./tipos";

/** Tope de fijados que se re-ejecutan a la vez en el Resumen (el servidor tambien acota la lista). */
export const MAX_FIJADOS_VISIBLES = 12;

type CargaLista =
  | { readonly fase: "cargando" }
  | { readonly fase: "oculto" }
  | { readonly fase: "no_disponible" }
  | { readonly fase: "error" }
  | { readonly fase: "listo"; readonly fijados: readonly FijadoResumen[] };

type CargaResultado = { readonly fase: "cargando" } | { readonly fase: "error" } | { readonly fase: "listo"; readonly resultado: FijadoResultado };

const BOTON_ACCION = "h-7 gap-1.5 px-2 text-xs text-muted-foreground";

function FijadoTarjeta({
  fijado,
  cliente,
  onQuitado,
  onCompartido,
  sinCompartir,
}: {
  fijado: FijadoResumen;
  cliente: FijadosCliente;
  onQuitado: (id: string) => void;
  onCompartido: (id: string, compartido: boolean) => void;
  sinCompartir: boolean;
}) {
  const [carga, setCarga] = useState<CargaResultado>({ fase: "cargando" });
  const [intento, setIntento] = useState(0);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    setCarga({ fase: "cargando" });
    cliente.resultado(fijado.id, ctl.signal).then(
      (resultado) => {
        if (!ctl.signal.aborted) setCarga({ fase: "listo", resultado });
      },
      () => {
        if (!ctl.signal.aborted) setCarga({ fase: "error" });
      },
    );
    return () => ctl.abort();
  }, [cliente, fijado.id, intento]);

  const quitar = async () => {
    if (ocupado) return;
    setOcupado(true);
    setAviso(null);
    try {
      await cliente.quitar(fijado.id);
      onQuitado(fijado.id);
    } catch {
      setAviso("No se pudo quitar; intenta de nuevo.");
      setOcupado(false);
    }
  };

  const compartir = async () => {
    if (ocupado) return;
    setOcupado(true);
    setAviso(null);
    try {
      await cliente.compartir(fijado.id, !fijado.compartido);
      onCompartido(fijado.id, !fijado.compartido);
    } catch (e) {
      setAviso(e instanceof FijadosErrorCliente && e.tipo === "sin_permiso" ? "Solo el dueño o un administrador pueden compartir fijados con la organización." : "No se pudo cambiar; intenta de nuevo.");
    } finally {
      setOcupado(false);
    }
  };

  const resultado = carga.fase === "listo" ? carga.resultado : undefined;
  const bloque = resultado?.blocks[0];
  const fuente = resultado?.sources[0];

  return (
    <li className="min-w-0 space-y-1.5" data-testid="fijado">
      {carga.fase === "cargando" ? <EstadoCargando variante="tarjeta" etiqueta={`Consultando ${fijado.titulo}…`} /> : null}
      {carga.fase === "error" ? <EstadoError compacto titulo={fijado.titulo} mensaje="No pude consultar este fijado ahora." onReintentar={() => setIntento((n) => n + 1)} /> : null}
      {resultado && bloque ? <BloqueDatos bloque={bloque} /> : null}
      {resultado && !bloque ? (
        <Card className="p-3">
          <p className="etiqueta-mono text-eyebrow font-medium uppercase text-muted-foreground">{fijado.titulo}</p>
          <p className="mt-2 text-ui text-muted-foreground">{resultado.text}</p>
        </Card>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {fuente ? <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{[fuente.source, fuente.periodLabel, fuente.scopeLabel].filter(Boolean).join(" · ")}</p> : <span className="flex-1" />}
        {fijado.compartido ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Users className="h-3.5 w-3.5" aria-hidden />
            Compartido
          </span>
        ) : null}
        {fijado.propio ? (
          <>
            {sinCompartir ? null : (
              <Button type="button" variant="ghost" size="xs" className={BOTON_ACCION} disabled={ocupado} onClick={() => void compartir()} aria-label={fijado.compartido ? `Dejar de compartir ${fijado.titulo}` : `Compartir ${fijado.titulo}`}>
                <Share2 aria-hidden />
                {fijado.compartido ? "Dejar de compartir" : "Compartir"}
              </Button>
            )}
            <Button type="button" variant="ghost" size="xs" className={BOTON_ACCION} disabled={ocupado} onClick={() => void quitar()} aria-label={`Quitar ${fijado.titulo} del tablero`}>
              <PinOff aria-hidden />
              Quitar
            </Button>
          </>
        ) : null}
      </div>
      {aviso ? (
        <p role="alert" className="text-xs text-destructive">
          {aviso}
        </p>
      ) : null}
    </li>
  );
}

export interface SeccionFijadosCopilotoProps {
  readonly cliente: FijadosCliente;
  /** Ruta interna del Copiloto de la vertical: se ofrece cuando todavia no hay fijados (solo rutas que empiezan con "/"). */
  readonly rutaCopiloto?: string;
  readonly className?: string;
  /** El tablero es personal (p. ej. el del Copiloto de plataforma): no se ofrece «Compartir», porque el servidor no lo admite. */
  readonly sinCompartir?: boolean;
}

export function SeccionFijadosCopiloto({ cliente, rutaCopiloto, className, sinCompartir = false }: SeccionFijadosCopilotoProps) {
  const [carga, setCarga] = useState<CargaLista>({ fase: "cargando" });
  const [intento, setIntento] = useState(0);
  const idTitulo = useId();

  useEffect(() => {
    const ctl = new AbortController();
    setCarga({ fase: "cargando" });
    cliente.listar(ctl.signal).then(
      (r) => {
        if (ctl.signal.aborted) return;
        setCarga(r.disponible ? { fase: "listo", fijados: r.fijados.slice(0, MAX_FIJADOS_VISIBLES) } : { fase: "no_disponible" });
      },
      (e: unknown) => {
        if (ctl.signal.aborted) return;
        // Un rol sin Copiloto (403) no tiene tablero: no se pinta nada, ni un error.
        setCarga(e instanceof FijadosErrorCliente && e.tipo === "sin_acceso" ? { fase: "oculto" } : { fase: "error" });
      },
    );
    return () => ctl.abort();
  }, [cliente, intento]);

  const alQuitar = useCallback((id: string) => setCarga((c) => (c.fase === "listo" ? { fase: "listo", fijados: c.fijados.filter((f) => f.id !== id) } : c)), []);
  const alCompartir = useCallback(
    (id: string, compartido: boolean) => setCarga((c) => (c.fase === "listo" ? { fase: "listo", fijados: c.fijados.map((f) => (f.id === id ? { ...f, compartido } : f)) } : c)),
    [],
  );

  if (carga.fase === "oculto") return null;
  const rutaSegura = rutaCopiloto && rutaCopiloto.startsWith("/") && !rutaCopiloto.startsWith("//") ? rutaCopiloto : undefined;

  return (
    <Card className={cn("p-3", className)} role="region" aria-labelledby={idTitulo}>
      <SectionLabel id={idTitulo}>Fijados del Copiloto</SectionLabel>
      <div className="mt-2">
        {carga.fase === "cargando" ? <EstadoCargando etiqueta="Cargando tus fijados…" /> : null}
        {carga.fase === "error" ? <EstadoError compacto titulo="No se pudieron cargar tus fijados" onReintentar={() => setIntento((n) => n + 1)} /> : null}
        {carga.fase === "no_disponible" ? <p className="text-ui text-muted-foreground">Los fijados todavía no están disponibles en tu cuenta.</p> : null}
        {carga.fase === "listo" && carga.fijados.length === 0 ? (
          <p className="flex flex-wrap items-center gap-1.5 text-ui text-muted-foreground">
            <Pin className="h-3.5 w-3.5" aria-hidden />
            Aún no fijas nada. Usa «Fijar» en una respuesta del Copiloto para verla aquí, siempre al día.
            {rutaSegura ? (
              <Link to={rutaSegura} className="text-foreground underline underline-offset-4">
                Abrir el Copiloto
              </Link>
            ) : null}
          </p>
        ) : null}
        {carga.fase === "listo" && carga.fijados.length > 0 ? (
          <ul className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
            {carga.fijados.map((f) => (
              <FijadoTarjeta key={f.id} fijado={f} cliente={cliente} onQuitado={alQuitar} onCompartido={alCompartir} sinCompartir={sinCompartir} />
            ))}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}

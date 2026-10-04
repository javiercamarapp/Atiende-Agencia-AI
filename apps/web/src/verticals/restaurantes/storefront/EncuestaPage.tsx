// Encuesta post-entrega del cliente (R-41): una pagina publica y corta, sin login. Califica de 1 a 5 estrellas y, si quiere, deja un comentario.
// Con una calificacion alta y la liga de resenas configurada por la sucursal, se le invita a dejar su resena. Token invalido/vencido: mensaje
// uniforme. Nada personal en pantalla: solo el nombre de la sucursal.
import { useEffect, useMemo, useState } from "react";
import { Star } from "lucide-react";
import { Button, Callout, EstadoCargando, EstadoError, Textarea } from "@atiende/ui";
import { crearClienteEncuesta, EncuestaError } from "./encuesta-client.ts";
import type { EncuestaPublica } from "./encuesta-client.ts";
import { StorefrontLayout } from "./StorefrontLayout.tsx";
import { useMetaPublica } from "./meta-publica.ts";

const COMENTARIO_MAX = 1000;
const ETIQUETAS = ["Muy mala", "Mala", "Regular", "Buena", "Excelente"] as const;

type Estado =
  | { readonly tipo: "cargando" }
  | { readonly tipo: "no_encontrada" }
  | { readonly tipo: "no_disponible"; readonly mensaje: string }
  | { readonly tipo: "error"; readonly mensaje: string }
  | { readonly tipo: "lista"; readonly encuesta: EncuestaPublica }
  | { readonly tipo: "gracias"; readonly calificacion: number; readonly resenasUrl: string | null };

export function EncuestaPage({ apiBaseUrl, orgSlug, token }: { apiBaseUrl: string; orgSlug: string; token: string }) {
  useMetaPublica({ titulo: "¿Cómo estuvo tu pedido?", descripcion: "Cuéntanos cómo fue tu experiencia.", indexable: false });
  const cliente = useMemo(() => crearClienteEncuesta(apiBaseUrl, orgSlug, token), [apiBaseUrl, orgSlug, token]);
  const [estado, setEstado] = useState<Estado>({ tipo: "cargando" });
  const [calificacion, setCalificacion] = useState(0);
  const [comentario, setComentario] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [errorEnvio, setErrorEnvio] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelado = false;
    setEstado({ tipo: "cargando" });
    cliente
      .leer()
      .then((r) => {
        if (cancelado) return;
        if (!r.disponible) setEstado({ tipo: "no_disponible", mensaje: r.mensaje });
        else if (r.encuesta.respondida) setEstado({ tipo: "gracias", calificacion: r.encuesta.calificacion ?? 0, resenasUrl: r.encuesta.resenasUrl });
        else setEstado({ tipo: "lista", encuesta: r.encuesta });
      })
      .catch((e: unknown) => {
        if (cancelado) return;
        if (e instanceof EncuestaError && e.status === 404) setEstado({ tipo: "no_encontrada" });
        else setEstado({ tipo: "error", mensaje: e instanceof Error ? e.message : "No pudimos cargar la encuesta." });
      });
    return () => {
      cancelado = true;
    };
  }, [cliente, version]);

  async function enviar() {
    if (calificacion < 1) return setErrorEnvio("Elige de 1 a 5 estrellas.");
    setErrorEnvio(null);
    setEnviando(true);
    try {
      const r = await cliente.responder(calificacion, comentario);
      setEstado({ tipo: "gracias", calificacion: r.calificacion ?? calificacion, resenasUrl: r.resenasUrl });
    } catch (e) {
      setErrorEnvio(e instanceof Error ? e.message : "No pudimos guardar tu respuesta.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <StorefrontLayout orgSlug={orgSlug}>
      <div className="mx-auto max-w-xl">
        <h1 className="text-xl font-semibold tracking-tight">¿Cómo estuvo tu pedido?</h1>
        <div className="mt-4" aria-live="polite">
          {estado.tipo === "cargando" && <EstadoCargando />}
          {estado.tipo === "no_encontrada" && (
            <Callout tone="warning" titulo="No encontramos esa encuesta">
              El enlace puede haber vencido o estar incompleto. Gracias por tu pedido.
            </Callout>
          )}
          {estado.tipo === "no_disponible" && (
            <Callout tone="info" titulo="Encuesta no disponible por ahora">
              {estado.mensaje}
            </Callout>
          )}
          {estado.tipo === "error" && <EstadoError mensaje={estado.mensaje} onReintentar={() => setVersion((v) => v + 1)} />}
          {estado.tipo === "lista" && (
            <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4" data-testid="encuesta-formulario">
              <p className="text-sm text-muted-foreground">Cuéntanos cómo fue tu experiencia en {estado.encuesta.sucursal}. Toma menos de un minuto.</p>
              <div role="radiogroup" aria-label="Calificación" className="flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={calificacion === n}
                    aria-label={`${n} ${n === 1 ? "estrella" : "estrellas"}: ${ETIQUETAS[n - 1]}`}
                    onClick={() => setCalificacion(n)}
                    className="rounded-md p-1 text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-checked:text-primary"
                  >
                    <Star className={n <= calificacion ? "h-8 w-8 fill-current text-primary" : "h-8 w-8"} aria-hidden />
                  </button>
                ))}
                <span className="ml-2 text-sm text-muted-foreground" data-testid="encuesta-etiqueta">
                  {calificacion > 0 ? ETIQUETAS[calificacion - 1] : ""}
                </span>
              </div>
              <div>
                <label htmlFor="encuesta-comentario" className="mb-1.5 block text-sm font-medium text-foreground">
                  Comentario (opcional)
                </label>
                <Textarea id="encuesta-comentario" rows={4} maxLength={COMENTARIO_MAX} value={comentario} onChange={(e) => setComentario(e.target.value)} placeholder="¿Qué te gustó o qué podemos mejorar?" />
                <p className="mt-1 text-right text-xs text-muted-foreground">
                  {comentario.length}/{COMENTARIO_MAX}
                </p>
              </div>
              {errorEnvio ? (
                <Callout tone="danger">
                  {errorEnvio}
                </Callout>
              ) : null}
              <Button onClick={enviar} disabled={enviando}>
                {enviando ? "Enviando…" : "Enviar"}
              </Button>
            </div>
          )}
          {estado.tipo === "gracias" && (
            <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4" data-testid="encuesta-gracias">
              <p className="text-base font-semibold">¡Gracias por tu respuesta!</p>
              <p className="text-sm text-muted-foreground">
                {estado.calificacion > 0 && estado.calificacion <= 2 ? "Lamentamos que no haya sido la mejor experiencia. Lo revisaremos para mejorar." : "Nos ayuda mucho a seguir mejorando."}
              </p>
              {estado.resenasUrl ? (
                <>
                  <p className="text-sm">¿Nos ayudas contándoselo a más personas?</p>
                  <Button asChild>
                    <a href={estado.resenasUrl} target="_blank" rel="noopener noreferrer">
                      Dejar una reseña
                    </a>
                  </Button>
                </>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </StorefrontLayout>
  );
}

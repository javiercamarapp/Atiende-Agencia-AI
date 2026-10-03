import { AlertTriangle, ExternalLink, Info } from "lucide-react";
import { Link } from "react-router-dom";
import { AtiendeMark } from "../AtiendeLogo";
import { Card, CardContent } from "../ui/card";
import { CopilotoAcciones } from "./CopilotoAcciones";
import { CopilotoTarjetaAccion, TOOL_PROPONER_ACCION, propuestaDeBloque } from "./CopilotoTarjetaAccion";
import { GraficaBloque, Sparkline, planGrafica } from "./CopilotoGraficas";
import { formatoCelda, rutaInternaSegura } from "./formato";
import type { CopilotoAccionesCliente, CopilotoBloque, CopilotoMensaje, CopilotoStatus, CopilotoTransporte } from "./tipos";

const MAX_FILAS = 10;

/** Texto del aviso por `status`. `null` = el estado no lleva aviso (se muestra el texto de la respuesta). */
export function textoAviso(m: Pick<CopilotoMensaje, "status" | "reintentarEnSeg" | "limiteDiario">): string | null {
  const s: CopilotoStatus | undefined = m.status;
  switch (s) {
    case "no_data":
      return "No hay datos para ese periodo.";
    case "out_of_catalog":
      return "Eso todavía no lo puedo consultar. Prueba con:";
    case "rate_limited":
      if (m.limiteDiario !== undefined) return `Llegaste a tus ${m.limiteDiario} preguntas de hoy.`;
      return m.reintentarEnSeg !== undefined ? `Muchas preguntas seguidas; espera ${m.reintentarEnSeg} s.` : "Muchas preguntas seguidas; espera un momento.";
    case "budget_exceeded":
      return "Se alcanzó el tope de IA de tu organización este mes; lo amplía tu administrador.";
    case "apagado":
      return "El Copiloto está en pausa por mantenimiento.";
    case "unavailable":
      return "No disponible por ahora.";
    case "forbidden":
      return "Tu rol no tiene acceso a estas consultas.";
    default:
      return null;
  }
}

/** Filas de la tabla del bloque, con la columna de sparkline si el catalogo mando una serie por fila. */
function TablaDatos({ bloque }: { bloque: CopilotoBloque }) {
  const filas = bloque.rows.slice(0, MAX_FILAS);
  const recortado = bloque.rows.length > MAX_FILAS || bloque.truncated;
  const [a, b] = bloque.columns;
  const spark = bloque.sparkline;
  const lista = bloque.columns.length === 2 && a && b && !spark;
  return (
    <>
      {lista ? (
        <ul className="space-y-2 text-sm" aria-label={bloque.title}>
          {filas.map((r, i) => (
            <li key={i} className="flex justify-between border-b border-dashed border-border last:border-0 pb-2">
              <span>{formatoCelda(a.kind, r[a.key] ?? null)}</span>
              <span className="font-mono tabular-nums text-muted-foreground">{formatoCelda(b.kind, r[b.key] ?? null)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label={bloque.title}>
            <thead>
              <tr>
                {bloque.columns.map((c) => (
                  <th key={c.key} scope="col" className="text-left font-mono text-2xs uppercase tracking-[0.08em] text-muted-foreground pb-2 pr-3 font-normal">
                    {c.label}
                  </th>
                ))}
                {spark ? (
                  <th scope="col" className="text-left font-mono text-2xs uppercase tracking-[0.08em] text-muted-foreground pb-2 pr-3 font-normal">
                    {spark.label}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {filas.map((r, i) => (
                <tr key={i} className="border-b border-dashed border-border last:border-0">
                  {bloque.columns.map((c, j) => (
                    <td key={c.key} className={j === 0 ? "py-2 pr-3" : "py-2 pr-3 font-mono tabular-nums text-muted-foreground"}>
                      {formatoCelda(c.kind, r[c.key] ?? null)}
                    </td>
                  ))}
                  {spark ? (
                    <td className="py-2 pr-3">
                      <Sparkline valores={spark.series[i] ?? []} etiqueta={`${spark.label} de ${formatoCelda(a?.kind ?? "text", a ? (r[a.key] ?? null) : null)}`} />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {recortado ? (
        <p className="text-xs text-muted-foreground mt-2">
          Se muestran las primeras {filas.length} filas{bloque.truncated ? "; hay más en el sistema" : ""}.
        </p>
      ) : null}
    </>
  );
}

/** Bloque del servidor: la grafica que eligio el catalogo si hay con que dibujarla; si no, la tabla. */
export function BloqueDatos({ bloque }: { bloque: CopilotoBloque }) {
  if (planGrafica(bloque)) return <GraficaBloque bloque={bloque} tabla={<TablaDatos bloque={bloque} />} />;
  return <TarjetaTabla bloque={bloque} />;
}

function TarjetaTabla({ bloque }: { bloque: CopilotoBloque }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <p className="font-mono text-2xs uppercase tracking-[0.08em] text-muted-foreground mb-2">{bloque.title}</p>
        <TablaDatos bloque={bloque} />
      </CardContent>
    </Card>
  );
}

export function CopilotoMensajeVista({
  mensaje,
  esUltima,
  conversacionId,
  transporte,
  rutasFuente,
  sugerenciasAlternas,
  ocupado,
  onRegenerar,
  onPreguntar,
  vertical,
  acciones,
}: {
  mensaje: CopilotoMensaje;
  esUltima: boolean;
  conversacionId: string | undefined;
  transporte: CopilotoTransporte;
  rutasFuente: Readonly<Record<string, string>> | undefined;
  sugerenciasAlternas: readonly string[];
  ocupado: boolean;
  onRegenerar: () => void;
  onPreguntar: (pregunta: string) => void;
  vertical?: string;
  /** Solo Copiloto de superadmin: dibuja los bloques `proponer_accion` como tarjeta de accion. */
  acciones?: CopilotoAccionesCliente;
}) {
  if (mensaje.role === "user") {
    return (
      <div className="flex justify-end copiloto-categorias-entra">
        <div className="max-w-[80%] bg-card border border-border rounded-2xl px-4 py-2 text-sm text-foreground shadow-sm whitespace-pre-wrap break-words">
          {mensaje.text}
        </div>
      </div>
    );
  }

  if (mensaje.cancelado) {
    return <p className="ml-6 text-sm text-faint copiloto-categorias-entra">Cancelado.</p>;
  }

  const aviso = textoAviso(mensaje);
  const esError = mensaje.status === "unavailable" || mensaje.status === "apagado" || mensaje.status === "forbidden" || mensaje.status === "budget_exceeded" || mensaje.status === "rate_limited";
  const alternas = mensaje.sugerencias && mensaje.sugerencias.length > 0 ? mensaje.sugerencias : sugerenciasAlternas;
  const exito = !aviso;

  return (
    <div className="space-y-3 copiloto-categorias-entra">
      <div className="flex items-start gap-2">
        <AtiendeMark className="h-4 w-auto shrink-0 mt-0.5" />
        {aviso ? (
          <p className="text-xs text-muted-foreground flex items-start gap-1.5 mt-0.5" role={esError ? "alert" : undefined}>
            {esError ? <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden /> : <Info className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden />}
            <span>{aviso}</span>
          </p>
        ) : (
          <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap break-words">{mensaje.text}</p>
        )}
      </div>

      {mensaje.status === "out_of_catalog" && alternas.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 ml-6">
          {alternas.slice(0, 3).map((q) => (
            <button
              key={q}
              type="button"
              disabled={ocupado}
              onClick={() => onPreguntar(q)}
              className="text-xs rounded-full px-3 py-1 bg-copiloto/10 text-copiloto border border-copiloto/20 hover:bg-copiloto/20 transition-colors disabled:opacity-50"
            >
              {q}
            </button>
          ))}
        </div>
      ) : null}

      {exito
        ? (mensaje.blocks ?? []).map((b, i) => {
            // Una propuesta de accion NUNCA se dibuja como tabla (lleva el identificador de la propuesta): o es tarjeta, o no se muestra.
            if (b.tool === TOOL_PROPONER_ACCION) {
              const propuesta = acciones ? propuestaDeBloque(b) : null;
              return propuesta && acciones ? (
                <div key={`${b.tool}-${i}`} className="ml-6">
                  <CopilotoTarjetaAccion propuesta={propuesta} cliente={acciones} />
                </div>
              ) : null;
            }
            return (
              <div key={`${b.tool}-${i}`} className="ml-6">
                <BloqueDatos bloque={b} />
              </div>
            );
          })
        : null}

      {exito && mensaje.sources && mensaje.sources.length > 0 ? (
        <div className="ml-6 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>Fuentes:</span>
          {mensaje.sources.map((s, i) => {
            const ruta = rutaInternaSegura(rutasFuente?.[s.tool]);
            const etiqueta = [s.source, s.periodLabel, s.scopeLabel].filter(Boolean).join(" · ");
            const clases = "inline-flex items-center gap-1 text-xs rounded-full border border-border px-2 py-0.5 text-muted-foreground";
            return ruta ? (
              <Link key={`${s.tool}-${i}`} to={ruta} className={`${clases} hover:text-foreground hover:bg-muted transition-colors`}>
                {etiqueta}
                <ExternalLink className="w-3 h-3" aria-hidden />
              </Link>
            ) : (
              <span key={`${s.tool}-${i}`} className={clases}>
                {etiqueta}
              </span>
            );
          })}
        </div>
      ) : null}

      {exito && mensaje.text.trim() ? (
        <CopilotoAcciones mensaje={{ ...mensaje, blocks: (mensaje.blocks ?? []).filter((b) => b.tool !== TOOL_PROPONER_ACCION) }} conversacionId={conversacionId} transporte={transporte} esUltima={esUltima} ocupado={ocupado} onRegenerar={onRegenerar} vertical={vertical} />
      ) : null}
      {mensaje.status === "unavailable" && esUltima ? (
        <div className="ml-6">
          <button
            type="button"
            onClick={onRegenerar}
            disabled={ocupado}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 underline underline-offset-2"
          >
            Reintentar
          </button>
        </div>
      ) : null}
    </div>
  );
}

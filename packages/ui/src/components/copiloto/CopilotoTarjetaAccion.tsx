import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ListChecks, ShieldCheck } from "lucide-react";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { StatusBadge, type StatusTone } from "../ui/status-badge";
import { CopilotoAccionError } from "./tipos";
import type { CopilotoAccionEstado, CopilotoAccionPropuesta, CopilotoAccionVista, CopilotoAccionesCliente, CopilotoBloque } from "./tipos";

export const TOOL_PROPONER_ACCION = "proponer_accion";
const MOTIVO_MIN = 20;

/** Lee la propuesta del bloque `proponer_accion` (una fila). `null` = no es una propuesta valida: no se dibuja tarjeta (nunca se inventa una). */
export function propuestaDeBloque(b: CopilotoBloque): CopilotoAccionPropuesta | null {
  if (b.tool !== TOOL_PROPONER_ACCION) return null;
  const f = b.rows[0];
  if (!f) return null;
  const propuesta = f["propuesta"];
  const clase = f["clase"];
  const tipo = f["tipo"];
  const resumen = f["resumen"];
  if (typeof propuesta !== "string" || propuesta.length === 0 || (clase !== "intent" && clase !== "interruptor") || typeof tipo !== "string" || typeof resumen !== "string") return null;
  const agente = f["agente"];
  if (clase === "interruptor" && typeof agente !== "string") return null;
  return { propuesta, clase, tipo, resumen, ...(typeof agente === "string" ? { agente } : {}) };
}

const ESTADOS: Readonly<Record<Exclude<CopilotoAccionEstado, "pendiente">, { readonly tone: StatusTone; readonly etiqueta: string; readonly detalle: string }>> = {
  ejecutada: { tone: "success", etiqueta: "Ejecutada", detalle: "Ya se ejecutó. Quedó registrada en la bitácora." },
  fallida: { tone: "danger", etiqueta: "Falló", detalle: "Se intentó y falló. Revisa el detalle en Acciones." },
  cancelada: { tone: "neutral", etiqueta: "Cancelada", detalle: "No se ejecutó nada. La propuesta vence sola." },
  vencida: { tone: "warning", etiqueta: "Vencida", detalle: "Venció sin confirmarse. Pídele al Copiloto que la prepare de nuevo." },
  archivada: { tone: "neutral", etiqueta: "Archivada", detalle: "Esta propuesta ya no está vigente. Pídele al Copiloto que la prepare de nuevo." },
};

const TEXTO_FALLA: Readonly<Record<string, string>> = {
  stepup_cancelado: "Falta verificar tu identidad. No se ejecutó nada.",
  conflicto: "La propuesta ya no es válida (venció, ya se usó o el estado cambió). No se ejecutó nada.",
  motivo: "El motivo debe tener al menos 20 caracteres.",
  no_disponible: "Esta acción todavía no está disponible en este despliegue. No se ejecutó nada.",
  error: "No pude confirmar la acción en este momento. No se ejecutó nada; inténtalo de nuevo.",
};

type Fase = "cargando" | "pendiente" | "confirmando" | "cancelada" | "ejecutada" | "fallida" | "vencida" | "archivada";

/**
 * Tarjeta de una accion PROPUESTA por el Copiloto (solo superadmin). Vista previa del efecto (texto del servidor), motivo editable y obligatorio
 * (interruptores: 20 caracteres como minimo, igual que `core.platform_switch.reason`), "Confirmar" (el cliente pide la verificacion MFA antes de enviar)
 * y "Cancelar", que NO hace ninguna peticion: la propuesta vence sola. El estado vigente se consulta al montar: una conversacion reabierta ya no ofrece
 * confirmar lo vencido, usado o cambiado.
 */
export function CopilotoTarjetaAccion({ propuesta, cliente }: { propuesta: CopilotoAccionPropuesta; cliente: CopilotoAccionesCliente }) {
  const [fase, setFase] = useState<Fase>("cargando");
  const [vista, setVista] = useState<CopilotoAccionVista | null>(null);
  const [motivo, setMotivo] = useState("");
  const [aviso, setAviso] = useState<string | null>(null);
  const [verifico, setVerifico] = useState(true);
  const idMotivo = useId();
  const idAyuda = useId();
  const confirmando = useRef(false);

  useEffect(() => {
    const ctl = new AbortController();
    setFase("cargando");
    cliente.consultar(propuesta, ctl.signal).then(
      (v) => {
        if (ctl.signal.aborted) return;
        setVista(v);
        setFase(v.estado === "pendiente" ? "pendiente" : v.estado);
      },
      () => {
        if (ctl.signal.aborted) return;
        // Sin poder verificar la vigencia no se bloquea ni se afirma nada: el servidor la vuelve a comprobar al confirmar.
        setVerifico(false);
        setFase("pendiente");
      },
    );
    return () => ctl.abort();
    // `cliente` se recrea en cada render del shell; la tarjeta se consulta una vez por propuesta.
  }, [propuesta.propuesta]);

  const necesitaMotivo = propuesta.clase === "interruptor";
  const motivoOk = !necesitaMotivo || motivo.trim().length >= MOTIVO_MIN;
  const resumen = vista?.resumen ?? propuesta.resumen;

  async function confirmar() {
    if (confirmando.current || !motivoOk) return;
    confirmando.current = true;
    setAviso(null);
    setFase("confirmando");
    try {
      const r = await cliente.confirmar(propuesta, motivo.trim());
      setFase(r.estado);
      if (r.mensaje) setAviso(r.mensaje);
    } catch (e) {
      const tipo = e instanceof CopilotoAccionError ? e.tipo : "error";
      setAviso(TEXTO_FALLA[tipo] ?? TEXTO_FALLA["error"] ?? null);
      // Un conflicto es terminal (ya no se puede reintentar); lo demas deja volver a intentar.
      setFase(tipo === "conflicto" ? "archivada" : "pendiente");
    } finally {
      confirmando.current = false;
    }
  }

  const terminal = fase === "ejecutada" || fase === "fallida" || fase === "cancelada" || fase === "vencida" || fase === "archivada";
  const estado = terminal ? ESTADOS[fase] : null;

  return (
    <section className="rounded-xl border border-border bg-card p-3" aria-label="Acción propuesta por el Copiloto" data-testid="copiloto-tarjeta-accion" data-fase={fase}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 font-mono text-2xs uppercase tracking-[0.08em] text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
          Acción propuesta
        </p>
        {estado ? <StatusBadge tone={estado.tone}>{estado.etiqueta}</StatusBadge> : null}
      </div>

      <p className="text-sm text-foreground">{resumen}</p>
      {propuesta.agente ? <p className="mt-1 font-mono text-xs text-muted-foreground">{propuesta.agente}</p> : null}

      {estado ? (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          {aviso ?? estado.detalle}
        </p>
      ) : fase === "cargando" ? (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          Revisando si la propuesta sigue vigente…
        </p>
      ) : (
        <>
          {necesitaMotivo ? (
            <div className="mt-3">
              <label htmlFor={idMotivo} className="mb-1 block text-xs font-medium text-foreground">
                Motivo (obligatorio)
              </label>
              <Textarea
                id={idMotivo}
                rows={2}
                maxLength={300}
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                disabled={fase === "confirmando"}
                aria-describedby={idAyuda}
                aria-required="true"
                className="min-h-0 text-sm"
                placeholder="Por qué haces este cambio (queda en la bitácora)"
              />
              <p id={idAyuda} className="mt-1 text-2xs text-muted-foreground">
                Mínimo {MOTIVO_MIN} caracteres ({Math.min(motivo.trim().length, MOTIVO_MIN)}/{MOTIVO_MIN}). Queda en la bitácora de seguridad.
              </p>
            </div>
          ) : null}

          {!verifico ? (
            <p className="mt-2 text-xs text-muted-foreground" role="status">
              No pude verificar si la propuesta sigue vigente; el servidor la comprueba al confirmar.
            </p>
          ) : null}
          {aviso ? (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {aviso}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" loading={fase === "confirmando"} disabled={!motivoOk} onClick={() => void confirmar()}>
              Confirmar
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={fase === "confirmando"} onClick={() => setFase("cancelada")}>
              Cancelar
            </Button>
            <p className="text-2xs text-muted-foreground">Pedirá tu verificación MFA si hace falta. No se ejecuta nada hasta que confirmes.</p>
          </div>
        </>
      )}

      <p className="mt-3 border-t border-dashed border-border pt-2 text-xs">
        <Link to={cliente.enlacePendientes} className="inline-flex items-center gap-1.5 text-muted-foreground underline underline-offset-2 hover:text-foreground">
          <ListChecks className="h-3.5 w-3.5" aria-hidden />
          Ver pendientes en Acciones
        </Link>
      </p>
    </section>
  );
}

// Pagina "Plan y uso" de las 6 consolas (una sola pagina compartida, montada en el shell de cada vertical): mensajes del mes
// contra el tope del plan, estado de la prueba y acceso al portal de facturacion de Stripe. Todo sale de GET /billing/uso; el
// boton de facturacion llama a POST /billing/portal y, si el servidor dice que no esta disponible (sin llave de Stripe, sin
// suscripcion o sin permiso), se muestra DESHABILITADO con la explicacion real: nunca un boton que no hace nada.
import { useCallback, useEffect, useRef, useState } from "react";
import { CreditCard, ExternalLink } from "lucide-react";
import { Button, Card, EstadoCargando, EstadoError, StatusBadge, useTituloBarra } from "@atiende/ui";
import { BarraProgreso } from "./BarraProgreso.tsx";
import { PlanUsoError, abrirPortalFacturacion, leerPlanUso } from "../lib/plan-uso-client.ts";
import type { AccionTope, PlanUso } from "../lib/plan-uso-client.ts";

type Fase = "cargando" | "error" | "listo" | "no-disponible";

const ACCION_TEXTO: Readonly<Record<AccionTope, string>> = {
  avisar: "Al llegar al tope se avisa y los mensajes siguen saliendo.",
  cobrar: "Al llegar al tope los mensajes siguen saliendo y se registran como excedente a cobrar.",
  pausar: "Al llegar al tope se omiten los avisos proactivos no críticos; las respuestas a tus clientes siguen saliendo.",
};

function formatoMes(periodo: string): string {
  const [y, m] = periodo.split("-");
  const meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const idx = Number(m) - 1;
  return idx >= 0 && idx < 12 ? `${meses[idx]} de ${y}` : periodo;
}

function formatoFecha(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });
}

export interface PlanYUsoPaginaProps {
  readonly apiBaseUrl: string;
  readonly token: string;
}

export function PlanYUsoPagina({ apiBaseUrl, token }: PlanYUsoPaginaProps) {
  useTituloBarra("Plan y uso", CreditCard);
  const [fase, setFase] = useState<Fase>("cargando");
  const [uso, setUso] = useState<PlanUso | null>(null);
  const [mensaje, setMensaje] = useState<string | null>(null);
  const [abriendo, setAbriendo] = useState(false);
  const [errorPortal, setErrorPortal] = useState<string | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const cargar = useCallback(async () => {
    setFase("cargando");
    setMensaje(null);
    try {
      const r = await leerPlanUso(fetch, apiBaseUrl, tokenRef.current);
      if (r.disponible) {
        setUso(r.uso);
        setFase("listo");
      } else {
        setMensaje(r.motivo);
        setFase("no-disponible");
      }
    } catch (err) {
      setMensaje(err instanceof PlanUsoError ? err.message : "No se pudo cargar el plan.");
      setFase("error");
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    if (token === "") return;
    void cargar();
  }, [cargar, token]);

  async function abrirPortal() {
    setAbriendo(true);
    setErrorPortal(null);
    try {
      const url = await abrirPortalFacturacion(fetch, apiBaseUrl, tokenRef.current);
      window.location.assign(url);
    } catch (err) {
      setErrorPortal(err instanceof PlanUsoError ? err.message : "No se pudo abrir el portal de facturación.");
      setAbriendo(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-eyebrow text-faint">Tu plan, los mensajes del mes contra su tope y el estado de tu cuenta. Todo sale del consumo real de tu organización.</p>

      {fase === "cargando" && <EstadoCargando variante="tarjeta" etiqueta="Cargando plan…" />}
      {fase === "error" && <EstadoError titulo="No se pudo cargar el plan" mensaje={mensaje ?? undefined} onReintentar={() => void cargar()} compacto />}
      {fase === "no-disponible" && (
        <Card className="p-4">
          <p className="text-ui font-medium">Todavía no disponible</p>
          <p className="mt-1 text-eyebrow text-muted-foreground">{mensaje}</p>
        </Card>
      )}

      {fase === "listo" && uso && <ContenidoPlan uso={uso} abriendo={abriendo} errorPortal={errorPortal} onAbrirPortal={() => void abrirPortal()} />}
    </div>
  );
}

function ContenidoPlan({ uso, abriendo, errorPortal, onAbrirPortal }: { uso: PlanUso; abriendo: boolean; errorPortal: string | null; onAbrirPortal: () => void }) {
  const { mensajes, prueba, plan, portal } = uso;
  const pct = mensajes.limite !== null && mensajes.limite > 0 ? Math.round((mensajes.usado / mensajes.limite) * 100) : null;
  const tono = pct === null ? "primary" : pct > 100 ? "danger" : pct > 80 ? "warning" : "primary";
  return (
    <>
      <Card className="p-4" data-testid="plan-mensajes">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-ui font-medium">Mensajes de {formatoMes(uso.periodo)}</p>
          {plan ? <StatusBadge tone="neutral" dot={false} className="text-eyebrow">{plan.nombre}</StatusBadge> : <span className="text-eyebrow text-faint">Sin plan asignado</span>}
        </div>
        <p className="mt-2 text-ui">
          <span className="font-medium">{mensajes.usado.toLocaleString("es-MX")}</span>
          {mensajes.limite !== null ? <span className="text-muted-foreground"> de {mensajes.limite.toLocaleString("es-MX")}</span> : <span className="text-muted-foreground"> enviados · sin tope configurado</span>}
        </p>
        {pct !== null && <BarraProgreso valor={pct} tono={tono} className="mt-2" aria-label={`Mensajes del mes: ${pct} por ciento del tope`} />}
        {mensajes.accion && mensajes.limite !== null && <p className="mt-2 text-eyebrow text-muted-foreground">{ACCION_TEXTO[mensajes.accion]}</p>}
        {mensajes.excedente > 0 && (
          <p className="mt-1 text-eyebrow text-destructive">
            {mensajes.excedente.toLocaleString("es-MX")} {mensajes.excedente === 1 ? "mensaje por encima" : "mensajes por encima"} del tope este mes.
          </p>
        )}
        {mensajes.proactivosOmitidos > 0 && (
          <p className="mt-1 text-eyebrow text-warning">
            {mensajes.proactivosOmitidos.toLocaleString("es-MX")} {mensajes.proactivosOmitidos === 1 ? "aviso proactivo omitido" : "avisos proactivos omitidos"} por el tope del plan.
          </p>
        )}
        <p className="mt-2 text-eyebrow text-faint">El mes se cuenta en la zona horaria de tu negocio ({uso.zonaHoraria}).</p>
      </Card>

      <Card className="p-4" data-testid="plan-prueba">
        <p className="text-ui font-medium">Estado de la cuenta</p>
        {prueba.activa && prueba.diasRestantes !== null ? (
          <p className="mt-1 text-eyebrow text-muted-foreground">
            Tu prueba termina {prueba.terminaEn ? `el ${formatoFecha(prueba.terminaEn)}` : "pronto"} ({prueba.diasRestantes <= 0 ? "hoy" : `en ${prueba.diasRestantes} ${prueba.diasRestantes === 1 ? "día" : "días"}`}).
          </p>
        ) : (
          <p className="mt-1 text-eyebrow text-muted-foreground">Sin fecha de fin de prueba.</p>
        )}
      </Card>

      <Card className="p-4" data-testid="plan-facturacion">
        <p className="text-ui font-medium">Facturación</p>
        <p className="mt-1 text-eyebrow text-muted-foreground">Administra tu método de pago, facturas y suscripción en el portal de Stripe.</p>
        <div className="mt-2.5 flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="xs" onClick={onAbrirPortal} disabled={!portal.disponible || abriendo}>
            <ExternalLink className="size-[13px]" strokeWidth={1.75} />
            {abriendo ? "Abriendo…" : "Administrar facturación"}
          </Button>
          {!portal.disponible && portal.explicacion && <span className="text-eyebrow text-muted-foreground">{portal.explicacion}</span>}
        </div>
        {errorPortal && (
          <p role="alert" className="mt-2 text-eyebrow text-destructive">
            {errorPortal}
          </p>
        )}
      </Card>
    </>
  );
}

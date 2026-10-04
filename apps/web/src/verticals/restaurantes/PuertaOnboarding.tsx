// R-33 -- puerta de onboarding del shell de restaurantes. Para owner/admin consulta el gate (GET .../admin/onboarding/gate):
//  (a) si bloquea (obligatorios pendientes y aun sin pedidos) y quien entra aterriza en el Resumen, lo manda a "Primeros pasos"
//      (la pagina ofrece "Ir al panel de todos modos", que solo dura la sesion);
//  (b) si quedan obligatorios pendientes (bloquee o no), el Resumen muestra un banner compacto con el conteo y el enlace.
// Staff y repartidor nunca consultan el gate (el servidor les responde 403). Si la consulta falla, la puerta se abre: un error del
// checklist nunca debe dejar a nadie fuera de su panel.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { Callout, EstadoCargando } from "@atiende/ui";
import { fetchOnboardingGate, gateOmitido, type OnboardingGateEstado } from "./lib/onboarding-client.ts";

const ROLES_CON_GATE: ReadonlySet<string> = new Set(["owner", "admin"]);

export interface PuertaOnboardingProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  readonly orgSlug: string;
  readonly role: string;
  readonly children: ReactNode;
}

export function PuertaOnboarding({ apiBaseUrl, token, propertyId, orgSlug, role, children }: PuertaOnboardingProps) {
  const { pathname } = useLocation();
  const base = `/restaurantes/${orgSlug}`;
  const esResumen = pathname.replace(/\/+$/, "") === base;
  const aplica = ROLES_CON_GATE.has(role) && esResumen;
  const [gate, setGate] = useState<OnboardingGateEstado | "cargando" | null>("cargando");

  useEffect(() => {
    if (!aplica) return;
    let vigente = true;
    setGate("cargando");
    fetchOnboardingGate(fetch, apiBaseUrl, token, propertyId)
      .then((g) => vigente && setGate(g))
      .catch(() => vigente && setGate(null));
    return () => {
      vigente = false;
    };
  }, [aplica, apiBaseUrl, token, propertyId]);

  if (!aplica) return <>{children}</>;
  const omitido = gateOmitido(orgSlug);
  if (gate === "cargando") return omitido ? <>{children}</> : <EstadoCargando etiqueta="Revisando la configuración…" />;
  if (gate && gate.bloquea && !omitido) return <Navigate to={`${base}/primeros-pasos`} replace />;
  return (
    <>
      {gate && gate.obligatoriosPendientes > 0 && (
        <Callout
          tone="warning"
          titulo="Faltan puntos obligatorios de configuración"
          accion={
            <Link className="text-xs underline underline-offset-2" to={`${base}/primeros-pasos`}>
              Ver primeros pasos
            </Link>
          }
        >
          {gate.obligatoriosPendientes} punto(s) obligatorio(s) pendiente(s) antes de operar con tranquilidad.
        </Callout>
      )}
      {children}
    </>
  );
}

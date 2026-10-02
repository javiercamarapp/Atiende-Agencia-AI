// Banner de plan en la consola de las 6 verticales (se monta una sola vez en VerticalShellConectado): avisa del fin de prueba a
// 7 dias o menos y del 80 % / tope de mensajes del plan, con enlace a "Plan y uso". Los datos son reales (GET /billing/uso); sin
// datos, sin permiso o con la base sin migrar NO muestra nada (nunca un aviso de adorno). Cada aviso se puede cerrar por sesion.
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Button, Callout } from "@atiende/ui";
import { avisosDePlan, leerPlanUso } from "../lib/plan-uso-client.ts";
import type { AvisoPlan } from "../lib/plan-uso-client.ts";

const CLAVE_CERRADOS = "atiende:banner-plan-cerrados";

function leerCerrados(): readonly string[] {
  try {
    const crudo = window.sessionStorage.getItem(CLAVE_CERRADOS);
    const lista: unknown = crudo ? JSON.parse(crudo) : [];
    return Array.isArray(lista) ? lista.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function guardarCerrados(lista: readonly string[]): void {
  try {
    window.sessionStorage.setItem(CLAVE_CERRADOS, JSON.stringify(lista));
  } catch {
    // sin almacenamiento: el aviso reaparece al recargar, nada mas
  }
}

export interface BannerPlanProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  /** Ruta de la pantalla "Plan y uso" de la vertical (`/<vertical>/<orgSlug>/plan`). */
  readonly planHref: string;
}

export function BannerPlan({ apiBaseUrl, token, planHref }: BannerPlanProps) {
  const [avisos, setAvisos] = useState<readonly AvisoPlan[]>([]);
  const [cerrados, setCerrados] = useState<readonly string[]>(() => leerCerrados());
  const { pathname } = useLocation();

  useEffect(() => {
    if (token === "") return;
    let vigente = true;
    leerPlanUso(fetch, apiBaseUrl, token)
      .then((r) => {
        if (vigente && r.disponible) setAvisos(avisosDePlan(r.uso));
      })
      .catch(() => {
        // Sin datos no se muestra nada: el banner solo existe cuando hay algo real que avisar.
      });
    return () => {
      vigente = false;
    };
  }, [apiBaseUrl, token]);

  // En la propia pantalla Plan y uso el banner sobra: ahi esta el detalle.
  const visibles = pathname === planHref ? [] : avisos.filter((a) => !cerrados.includes(a.clave));
  if (visibles.length === 0) return null;

  return (
    <div className="mb-3 space-y-2" data-testid="banner-plan">
      {visibles.map((a) => (
        <Callout
          key={a.clave}
          tone={a.tono}
          titulo={a.titulo}
          accion={
            <Button asChild variant="outline" size="xs">
              <Link to={planHref}>Ver plan y uso</Link>
            </Button>
          }
          onDismiss={() => {
            const siguiente = [...cerrados, a.clave];
            setCerrados(siguiente);
            guardarCerrados(siguiente);
          }}
        >
          {a.detalle}
        </Callout>
      ))}
    </div>
  );
}

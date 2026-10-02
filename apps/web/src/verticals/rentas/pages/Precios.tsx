// Precios de rentas: cotizador + configuración de pricing de la unidad. Rn-23: la configuración
// guardada se LEE (GET .../configuracion-precios), se EDITA y se BORRA desde el panel (ver
// precios/ConfiguracionPricing.tsx); el cotizador (precios/Cotizador.tsx) está disponible para
// cualquier staff con acceso a la property, la edición solo para PRICING_ESCRITURA_ROLES
// (admin_gestora; el servidor re-valida el rol en cada escritura: el gate de aquí es solo UX).
// La barra superior con icono + nombre de la página la pinta el shell (VerticalShell/BarraPagina).
import { useEffect, useState } from "react";
import { Callout, EstadoCargando, EstadoError, Label, NativeSelect, PageContainer } from "@atiende/ui";
import { fetchUnidades } from "../lib/pricing-client.ts";
import type { UnidadOption } from "../lib/pricing-client.ts";
import type { RentasShellContext } from "../RentasShell.tsx";
import { ConfiguracionPricing } from "./precios/ConfiguracionPricing.tsx";
import { Cotizador } from "./precios/Cotizador.tsx";

const PRICING_ESCRITURA_ROLES = new Set(["admin_gestora"]);

const LABEL_CLASES = "flex flex-col gap-1.5 text-sm text-foreground";

export function PreciosPage({ apiBaseUrl, token, propertyId, orgSlug, session }: RentasShellContext) {
  const org = session.organizations.find((o) => o.slug === orgSlug);
  const puedeEscribir = org ? PRICING_ESCRITURA_ROLES.has(org.rol) : false;

  const [unidades, setUnidades] = useState<readonly UnidadOption[] | null>(null);
  const [unidadId, setUnidadId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  // Sube tras cada escritura de configuración: el cotizador descarta su resultado ya desactualizado.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const list = await fetchUnidades(fetch, apiBaseUrl, token, propertyId);
        if (cancelado) return;
        setUnidades(list);
        setUnidadId((current) => current || list[0]?.id || "");
      } catch (err) {
        if (!cancelado) setError(err instanceof Error ? err.message : "No se pudieron cargar las unidades de esta propiedad.");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [apiBaseUrl, token, propertyId]);

  if (unidades && unidades.length === 0) {
    return (
      <PageContainer padding="none" size="lg" className="gap-4 [&>*]:min-w-0">
        <h1 className="font-display text-xl font-semibold text-foreground m-0">Precios</h1>
        <EstadoError titulo="Sin unidades" mensaje="Esta propiedad todavía no tiene ninguna unidad configurada." />
      </PageContainer>
    );
  }
  if (!unidades && !error) {
    return (
      <PageContainer padding="none" size="lg" className="gap-4 [&>*]:min-w-0">
        <h1 className="font-display text-xl font-semibold text-foreground m-0">Precios</h1>
        <EstadoCargando lineas={3} />
      </PageContainer>
    );
  }

  return (
    <PageContainer padding="none" size="sm" className="gap-5 [&>*]:min-w-0">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground m-0 mb-1">Precios</h1>
        <p className="m-0 text-sm text-muted-foreground">Cotiza una estadía y, si tu rol lo permite, configura la tarifa de la unidad.</p>
      </header>

      <Label className={`${LABEL_CLASES} max-w-[320px]`}>
        Unidad
        <NativeSelect value={unidadId} onChange={(e) => setUnidadId(e.target.value)} disabled={!unidades}>
          {!unidades && <option>Cargando…</option>}
          {unidades?.map((u) => (
            <option key={u.id} value={u.id}>
              {u.nombre}
            </option>
          ))}
        </NativeSelect>
      </Label>

      {error && <EstadoError mensaje={error} />}

      {unidadId && <Cotizador key={`${unidadId}:${version}`} apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} unidadId={unidadId} />}

      {unidadId && puedeEscribir && (
        <ConfiguracionPricing apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} unidadId={unidadId} onCambio={() => setVersion((v) => v + 1)} />
      )}

      {unidadId && !puedeEscribir && (
        <Callout tone="info" titulo="Configuración de solo lectura para tu rol">
          Solo el rol <strong className="text-foreground">admin_gestora</strong> puede configurar tarifa base, temporadas, descuentos por duración, estancia mínima y reglas por canal
          {org ? ` — tu rol actual es ${org.rol}.` : "."} Puedes cotizar estadías con las tarifas vigentes.
        </Callout>
      )}
    </PageContainer>
  );
}

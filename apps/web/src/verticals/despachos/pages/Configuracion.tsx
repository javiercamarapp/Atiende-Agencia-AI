// FASE 3 (producto) — zona horaria por negocio (migración 012,
// `despachos.property_config`). Primera pantalla real de esta config -- el
// backend/ruta (configuracion.ts) ya existían sin ninguna UI. Port del mismo
// patrón visual que `apps/web/src/verticals/restaurantes/pages/Configuracion.tsx`
// (leído primero como plantilla) -- select con las 6 zonas IANA comunes en
// México + opción "usar el default de la plataforma".
//
// Gateada por `GESTIONAR_CONFIGURACION_ROLES` (solo `admin`, el único "owner"
// real de despachos) del lado del CLIENTE (cosmético, ver
// `DespachosShellContext.role`) -- el servidor (configuracion.ts) es SIEMPRE el
// enforcement real, tanto en `assertVerticalRole` como en la policy RLS de
// `despachos.property_config` (migración 012).
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, Label, NativeSelect, PageContainer, StatusBadge } from "@atiende/ui";
import { Clock, Info } from "lucide-react";
import { fetchConfiguracion, updateConfiguracion } from "../lib/configuracion-client.ts";
import type { DespachosConfiguracion } from "../lib/configuracion-client.ts";
import { AjustesClasificacionCard } from "../components/AjustesClasificacionCard.tsx";
import type { DespachosShellContext } from "../DespachosShell.tsx";

// Mismo umbral EXACTO que GESTIONAR_CONFIGURACION_ROLES
// (@atiende/domain-despachos/src/roles.ts) -- duplicado aquí a propósito, no
// importado (apps/web no depende de los paquetes de dominio, mismo criterio ya
// documentado en staff-client.ts/declaraciones-client.ts). El servidor
// (configuracion.ts::assertVerticalRole) es SIEMPRE la fuente real de verdad.
const GESTIONAR_CONFIGURACION_ROLES: ReadonlySet<string> = new Set(["admin"]);

// FASE 3 (producto) -- "select de timezone IANA común en México" (mandato
// explícito de esta fase), mismas 6 zonas EXACTAS que
// restaurantes/pages/Configuracion.tsx.
const ZONA_HORARIA_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "America/Mexico_City", label: "Ciudad de México (America/Mexico_City)" },
  { value: "America/Cancun", label: "Cancún (America/Cancun)" },
  { value: "America/Tijuana", label: "Tijuana (America/Tijuana)" },
  { value: "America/Chihuahua", label: "Chihuahua (America/Chihuahua)" },
  { value: "America/Hermosillo", label: "Hermosillo (America/Hermosillo)" },
  { value: "America/Mazatlan", label: "Mazatlán (America/Mazatlan)" },
];

const SIN_CONFIGURAR = "";

export function ConfiguracionPage({ apiBaseUrl, token, propertyId, role }: DespachosShellContext) {
  const canManage = GESTIONAR_CONFIGURACION_ROLES.has(role);

  const [configuracion, setConfiguracion] = useState<DespachosConfiguracion | null>(null);
  const [zonaHorariaSelect, setZonaHorariaSelect] = useState<string>(SIN_CONFIGURAR);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!canManage) return;
    setError(null);
    try {
      const config = await fetchConfiguracion(fetch, apiBaseUrl, token, propertyId);
      setConfiguracion(config);
      setZonaHorariaSelect(config.zonaHoraria ?? SIN_CONFIGURAR);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la configuración.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId, canManage]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const updated = await updateConfiguracion(fetch, apiBaseUrl, token, propertyId, zonaHorariaSelect === SIN_CONFIGURAR ? null : zonaHorariaSelect);
      setConfiguracion(updated);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la zona horaria.");
    } finally {
      setSaving(false);
    }
  }

  if (!canManage) {
    return (
      <PageContainer padding="none" size="sm" className="gap-5 [&>*]:min-w-0">
        <h1 className="m-0 font-display text-xl font-semibold text-foreground">Configuración</h1>
        <Card className="bg-muted/40">
          <CardContent className="flex items-start gap-2 p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
            <span>Editar la zona horaria de este despacho está reservado al administrador. Tu rol actual es «{role}».</span>
          </CardContent>
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer padding="none" size="sm" className="gap-5 [&>*]:min-w-0">
      <h1 className="m-0 font-display text-xl font-semibold text-foreground">Configuración</h1>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      <Card>
        <CardHeader className="p-4 pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Clock className="h-4 w-4" strokeWidth={1.75} />
            Zona horaria
          </CardTitle>
          <CardDescription className="flex items-start gap-2">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            <span>
              De qué hora local se calcula "hoy" para vencimientos fiscales, cobranza y cierre mensual. Sin configurar, se usa el default de la plataforma (Ciudad de México).
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {!configuracion && !error && <EstadoCargando etiqueta="Cargando…" />}
          {configuracion && (
            <form onSubmit={handleSave} className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="despachos-config-zona-horaria" className="text-xs text-muted-foreground">
                  Zona horaria del despacho
                </Label>
                <NativeSelect
                  id="despachos-config-zona-horaria"
                  value={zonaHorariaSelect}
                  onChange={(e) => {
                    setZonaHorariaSelect(e.target.value);
                    setSaved(false);
                  }}
                  wrapperClassName="w-auto min-w-72"
                >
                  <option value={SIN_CONFIGURAR}>Usar el default de la plataforma (Ciudad de México)</option>
                  {ZONA_HORARIA_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <Button type="submit" disabled={saving}>
                {saving ? "Guardando…" : "Guardar"}
              </Button>
              {saved && <StatusBadge tone="success">Guardado</StatusBadge>}
            </form>
          )}
        </CardContent>
      </Card>

      <AjustesClasificacionCard apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} />
    </PageContainer>
  );
}
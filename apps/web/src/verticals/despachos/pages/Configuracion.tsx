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
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, FormField, NativeSelect, notify, PageContainer, PageHeader } from "@atiende/ui";
import { Clock, Lock } from "lucide-react";
import { fetchConfiguracion, updateConfiguracion } from "../lib/configuracion-client.ts";
import type { DespachosConfiguracion } from "../lib/configuracion-client.ts";
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

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateConfiguracion(fetch, apiBaseUrl, token, propertyId, zonaHorariaSelect === SIN_CONFIGURAR ? null : zonaHorariaSelect);
      setConfiguracion(updated);
      notify.success("Zona horaria guardada.");
    } catch (err) {
      notify.error(err instanceof Error ? err.message : "No se pudo guardar la zona horaria.");
    } finally {
      setSaving(false);
    }
  }

  if (!canManage) {
    return (
      <PageContainer className="[&>*]:min-w-0">
        <PageHeader titulo="Configuración" descripcion="Zona horaria y ajustes del despacho." />
        <EstadoVacio icon={Lock} titulo="Sin permiso" mensaje={`Editar la zona horaria de este despacho está reservado al administrador. Tu rol actual es «${role}».`} />
      </PageContainer>
    );
  }

  return (
    <PageContainer className="[&>*]:min-w-0">
      <PageHeader titulo="Configuración" descripcion="Zona horaria y ajustes del despacho." />

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="size-4" strokeWidth={1.75} />
            Zona horaria
          </CardTitle>
          <CardDescription>
            De qué hora local se calcula "hoy" para vencimientos fiscales, cobranza y cierre mensual. Sin configurar, se usa el default de la plataforma (Ciudad de México).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!configuracion && !error && <EstadoCargando etiqueta="Cargando…" />}
          {configuracion && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void handleSave();
              }}
              className="flex flex-wrap items-end gap-2"
            >
              <FormField label="Zona horaria del despacho">
                <NativeSelect id="despachos-config-zona-horaria" value={zonaHorariaSelect} onChange={(e) => setZonaHorariaSelect(e.target.value)} wrapperClassName="w-auto min-w-72">
                  <option value={SIN_CONFIGURAR}>Usar el default de la plataforma (Ciudad de México)</option>
                  {ZONA_HORARIA_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </NativeSelect>
              </FormField>
              <Button type="submit" loading={saving}>
                Guardar
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}

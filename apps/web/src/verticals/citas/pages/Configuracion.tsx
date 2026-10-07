// Configuración del panel de citas — centro de conexión de Google Calendar por
// proveedor (Fase 3/5) y, desde Fase 8, edición real de `citas.tenant_config`
// (rubro/timezone/teléfono de aviso — port de ConfiguracionSection.tsx del
// origen, ver tenant-config-client.ts). A propósito NO edita `name`/`slug`/
// `is_active` del negocio (`core.organization`): ver comentario en
// domain-citas/src/repository.ts::TenantConfigPatch — ese schema es compartido
// por las 6 verticales y ninguna otra lo edita desde el panel todavía. Horarios
// globales del negocio, plantillas de recordatorios y configuración del canal de
// WhatsApp siguen sin lectura/escritura expuesta en domain-citas.
//
// Presentación real (Fase de diseño): las secciones artesanales con hex en línea
// se cambian por Card/Input/Label/Button/Badge de @atiende/ui. La lógica de
// Google Calendar (requestGoogleCalendarConnectUrl -> redirección real) y el
// guardado de `tenant_config` son exactamente los mismos de antes.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { CalendarSync, UserRound } from "lucide-react";
import {
  StatusBadge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EstadoCargando,
  EstadoError,
  EstadoVacio,
  Input,
  Label, NativeSelect } from "@atiende/ui";
import { syncTone } from "../lib/status-tones.ts";
import { fetchProviderDetail, fetchProviders, requestGoogleCalendarConnectUrl } from "../lib/providers-client.ts";
import type { GoogleCalendarStatus, ProviderSummary } from "../lib/providers-client.ts";
import { fetchTenantConfig, RUBRO_OPTIONS, updateTenantConfig } from "../lib/tenant-config-client.ts";
import type { TenantConfig } from "../lib/tenant-config-client.ts";
import type { CitasShellContext } from "../CitasShell.tsx";

interface ProviderRow {
  readonly provider: ProviderSummary;
  readonly googleCalendar: GoogleCalendarStatus | null;
}

export function ConfiguracionPage({ apiBaseUrl, token, propertyId, orgSlug }: CitasShellContext) {
  const [rows, setRows] = useState<readonly ProviderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  const [tenantConfig, setTenantConfig] = useState<TenantConfig | null>(null);
  const [tenantConfigError, setTenantConfigError] = useState<string | null>(null);
  const [rubro, setRubro] = useState("otro");
  const [timezone, setTimezone] = useState("America/Mexico_City");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [savingTenantConfig, setSavingTenantConfig] = useState(false);
  const [tenantConfigSaved, setTenantConfigSaved] = useState(false);

  async function load() {
    setError(null);
    try {
      const providers = await fetchProviders(fetch, apiBaseUrl, token, propertyId);
      const details = await Promise.all(
        providers.map(async (provider) => {
          try {
            const detail = await fetchProviderDetail(fetch, apiBaseUrl, token, propertyId, provider.id);
            return { provider, googleCalendar: detail.googleCalendar };
          } catch {
            return { provider, googleCalendar: null };
          }
        }),
      );
      setRows(details);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la configuración.");
    }
  }

  function loadTenantConfig() {
    setTenantConfigError(null);
    fetchTenantConfig(fetch, apiBaseUrl, token, propertyId)
      .then((config) => {
        setTenantConfig(config);
        setRubro(config.rubro);
        setTimezone(config.defaultTimezone);
        setOwnerPhone(config.ownerNotificationPhone ?? "");
      })
      .catch((err: unknown) => setTenantConfigError(err instanceof Error ? err.message : "No se pudo cargar la configuración del negocio."));
  }

  useEffect(() => {
    void load();
    loadTenantConfig();
  }, [apiBaseUrl, token, propertyId]);

  async function handleConnect(providerId: string) {
    setConnectingId(providerId);
    setError(null);
    try {
      const url = await requestGoogleCalendarConnectUrl(fetch, apiBaseUrl, token, propertyId, providerId);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo iniciar la conexión con Google Calendar.");
      setConnectingId(null);
    }
  }

  async function handleSaveTenantConfig(e: FormEvent) {
    e.preventDefault();
    setSavingTenantConfig(true);
    setTenantConfigError(null);
    setTenantConfigSaved(false);
    try {
      const updated = await updateTenantConfig(fetch, apiBaseUrl, token, propertyId, { rubro, defaultTimezone: timezone, ownerNotificationPhone: ownerPhone.trim() || null });
      setTenantConfig(updated);
      setTenantConfigSaved(true);
    } catch (err) {
      setTenantConfigError(err instanceof Error ? err.message : "No se pudo guardar la configuración del negocio.");
    } finally {
      setSavingTenantConfig(false);
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <header>
        <h1 className="font-display text-xl font-semibold text-foreground">Configuración</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Negocio: <strong className="font-semibold text-foreground">{orgSlug}</strong>
        </p>
      </header>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Datos del negocio</CardTitle>
        </CardHeader>
        <CardContent>
          {tenantConfigError && (
            <div className="mb-3">
              <EstadoError mensaje={tenantConfigError} onReintentar={loadTenantConfig} />
            </div>
          )}
          {!tenantConfig && !tenantConfigError && <EstadoCargando etiqueta="Cargando datos del negocio…" />}

          {tenantConfig && (
            <form onSubmit={handleSaveTenantConfig} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="citas-config-rubro">Rubro</Label>
                <NativeSelect id="citas-config-rubro" value={rubro} onChange={(e) => setRubro(e.target.value)}>
                  {RUBRO_OPTIONS.map((v) => (
                    <option key={v.value} value={v.value}>
                      {v.label}
                    </option>
                  ))}
                </NativeSelect>
                <p className="text-xs text-muted-foreground">Determina qué FAQs y, en rubros de salud, qué guardia de crisis aplica el agente — no cambia el motor.</p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="citas-config-timezone">Zona horaria por defecto</Label>
                <Input id="citas-config-timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Ej. America/Mexico_City" />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="citas-config-telefono">Teléfono de aviso urgente (opcional)</Label>
                <Input id="citas-config-telefono" value={ownerPhone} onChange={(e) => setOwnerPhone(e.target.value)} placeholder="Ej. 5599998888" />
                <p className="text-xs text-muted-foreground">Se avisa por WhatsApp si la guardia de crisis detecta un mensaje real de emergencia.</p>
              </div>

              <div className="flex items-center gap-3">
                <Button type="submit" disabled={savingTenantConfig}>
                  {savingTenantConfig ? "Guardando…" : "Guardar cambios"}
                </Button>
                {tenantConfigSaved && !savingTenantConfig && (
                  <StatusBadge tone="success" role="status">
                    Guardado.
                  </StatusBadge>
                )}
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Conexión con Google Calendar</CardTitle>
          <CardDescription>Cada proveedor conecta su propio calendario — un calendario de Google es personal, nunca compartido por todo el negocio.</CardDescription>
        </CardHeader>
        <CardContent>
          {!rows && !error && <EstadoCargando etiqueta="Cargando proveedores…" />}
          {rows && rows.length === 0 && <EstadoVacio icon={UserRound} mensaje="Este negocio todavía no tiene proveedores activos." />}

          <div className="flex flex-col">
            {rows?.map(({ provider, googleCalendar }) => (
              <div key={provider.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-3 first:border-t-0 first:pt-0">
                <div>
                  <Link to={`/citas/${orgSlug}/proveedores/${provider.id}`} className="font-medium text-foreground hover:underline">
                    {provider.displayName}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted-foreground">{provider.roleLabel}</p>
                </div>
                {googleCalendar?.connected ? (
                  <StatusBadge tone={syncTone(googleCalendar.syncStatus)}>
                    {googleCalendar.syncStatus === "error" ? "Conectado (con error)" : "Conectado"}
                  </StatusBadge>
                ) : (
                  <Button size="sm" onClick={() => void handleConnect(provider.id)} disabled={connectingId === provider.id}>
                    <CalendarSync aria-hidden />
                    {connectingId === provider.id ? "Conectando…" : "Conectar"}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Mensajes y WhatsApp</CardTitle>
          <CardDescription>El canal de WhatsApp y los textos que envía el agente se configuran en sus propias páginas.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to={`/citas/${orgSlug}/agente-whatsapp`}>Agente de WhatsApp</Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to={`/citas/${orgSlug}/mensajes-whatsapp`}>Mensajes de WhatsApp</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

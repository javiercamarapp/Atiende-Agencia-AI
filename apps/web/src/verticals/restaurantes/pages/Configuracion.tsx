// FASE 3 (producto) — hallazgo real: hasta ahora no existía ninguna ruta que
// permitiera al staff de restaurantes EDITAR desde el panel la configuración de
// WhatsApp (número/canal) ni las zonas conocidas usadas para emparejar la
// sucursal más cercana. Ambas tablas YA EXISTÍAN (migrations/001/005) sin ninguna
// ruta de escritura — ver el comentario de cabecera de
// packages/domain-restaurantes/migrations/
// 021_restaurantes_config_editable_y_search_path_fix.sql. Esta página conecta
// admin-config.ts con una pantalla real.
//
// Gateada por STAFF_INVITE_ROLES (owner/admin) del lado del CLIENTE (cosmético,
// ver RestaurantesShellContext.role) — el servidor (admin-config.ts) es SIEMPRE
// el enforcement real, tanto en la policy RLS como en assertVerticalRole.
//
// Huecos conocidos, deliberadamente fuera de esta página (ver knownGaps del PR):
// configuración de voz (ninguna tabla existe para restaurantes) y horarios de
// atención (ninguna tabla existe en el schema base) — ambos requieren una
// migración de esquema nueva más una decisión de producto que esta fase no debe
// inventar sin dirección explícita.
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Label } from "@atiende/ui";
import { Info, MapPin, MessageCircle, Trash2 } from "lucide-react";
import { createKnownZone, deleteKnownZone, fetchKnownZones, fetchWhatsappConfig, updateWhatsappConfig } from "../lib/config-client.ts";
import type { KnownZone, WhatsappChannelConfig } from "../lib/config-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const STAFF_INVITE_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

export function ConfiguracionPage({ apiBaseUrl, token, propertyId, role }: RestaurantesShellContext) {
  const canManage = STAFF_INVITE_ROLES.has(role);

  const [whatsapp, setWhatsapp] = useState<WhatsappChannelConfig | null>(null);
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [savingWhatsapp, setSavingWhatsapp] = useState(false);
  const [whatsappSaved, setWhatsappSaved] = useState(false);

  const [zonas, setZonas] = useState<readonly KnownZone[] | null>(null);
  const [zoneName, setZoneName] = useState("");
  const [zoneLat, setZoneLat] = useState("");
  const [zoneLng, setZoneLng] = useState("");
  const [creatingZone, setCreatingZone] = useState(false);
  const [deletingZoneId, setDeletingZoneId] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!canManage) return;
    setError(null);
    try {
      const [config, zonasList] = await Promise.all([
        fetchWhatsappConfig(fetch, apiBaseUrl, token, propertyId),
        fetchKnownZones(fetch, apiBaseUrl, token, propertyId),
      ]);
      setWhatsapp(config);
      setPhoneNumberId(config.phoneNumberId ?? "");
      setZonas(zonasList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la configuración.");
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId, canManage]);

  async function handleSaveWhatsapp(e: FormEvent) {
    e.preventDefault();
    setSavingWhatsapp(true);
    setWhatsappSaved(false);
    setError(null);
    try {
      const updated = await updateWhatsappConfig(fetch, apiBaseUrl, token, propertyId, phoneNumberId.trim());
      setWhatsapp(updated);
      setWhatsappSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el número de WhatsApp.");
    } finally {
      setSavingWhatsapp(false);
    }
  }

  async function handleCreateZone(e: FormEvent) {
    e.preventDefault();
    const lat = Number(zoneLat);
    const lng = Number(zoneLng);
    if (!zoneName.trim() || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
    setCreatingZone(true);
    setError(null);
    try {
      const created = await createKnownZone(fetch, apiBaseUrl, token, propertyId, { name: zoneName.trim(), lat, lng });
      setZonas((prev) => (prev ? [created, ...prev] : [created]));
      setZoneName("");
      setZoneLat("");
      setZoneLng("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo agregar la zona conocida.");
    } finally {
      setCreatingZone(false);
    }
  }

  async function handleDeleteZone(zone: KnownZone) {
    if (!window.confirm(`¿Quitar "${zone.name}" de las zonas conocidas?`)) return;
    setDeletingZoneId(zone.id);
    setError(null);
    try {
      await deleteKnownZone(fetch, apiBaseUrl, token, propertyId, zone.id);
      setZonas((prev) => (prev ? prev.filter((z) => z.id !== zone.id) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo quitar esa zona conocida.");
    } finally {
      setDeletingZoneId(null);
    }
  }

  if (!canManage) {
    return (
      <div className="flex max-w-2xl flex-col gap-5 p-6">
        <h1 className="m-0 font-display text-xl font-semibold text-foreground">Configuración</h1>
        <Card className="bg-muted/40">
          <CardContent className="flex items-start gap-2 p-3 text-[13px] text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} />
            <span>Editar la configuración de WhatsApp y las zonas conocidas está reservado a dueños y administradores. Tu rol actual es «{role}».</span>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-5 p-6">
      <h1 className="m-0 font-display text-xl font-semibold text-foreground">Configuración</h1>

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      <Card>
        <CardHeader className="p-4 pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <MessageCircle className="h-4 w-4" strokeWidth={1.75} />
            WhatsApp
          </CardTitle>
          <CardDescription>Número (phone_number_id de Meta Cloud API) por el que este negocio recibe y contesta WhatsApp.</CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {!whatsapp && !error && <EstadoCargando etiqueta="Cargando…" />}
          {whatsapp && (
            <form onSubmit={handleSaveWhatsapp} className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="config-whatsapp-phone-number-id" className="text-xs text-muted-foreground">
                  phone_number_id
                </Label>
                <Input
                  id="config-whatsapp-phone-number-id"
                  value={phoneNumberId}
                  onChange={(e) => {
                    setPhoneNumberId(e.target.value);
                    setWhatsappSaved(false);
                  }}
                  placeholder="109876543210123"
                  className="w-auto min-w-[240px]"
                  required
                />
              </div>
              <Button type="submit" disabled={savingWhatsapp}>
                {savingWhatsapp ? "Guardando…" : "Guardar"}
              </Button>
              {whatsappSaved && <Badge variant="secondary">Guardado</Badge>}
            </form>
          )}
          {whatsapp && !whatsapp.phoneNumberId && <p className="mt-2 text-xs text-muted-foreground">Todavía no hay ningún número conectado.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4 pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <MapPin className="h-4 w-4" strokeWidth={1.75} />
            Zonas conocidas
          </CardTitle>
          <CardDescription>
            Colonias/plazas reales de tu ciudad, con sus coordenadas — el agente de voz/WhatsApp las usa para encontrar la sucursal más cercana a la referencia que da el cliente.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <form onSubmit={handleCreateZone} className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="config-zona-nombre" className="text-xs text-muted-foreground">
                Nombre
              </Label>
              <Input id="config-zona-nombre" value={zoneName} onChange={(e) => setZoneName(e.target.value)} placeholder="Altabrisa" className="w-auto min-w-[160px]" required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="config-zona-lat" className="text-xs text-muted-foreground">
                Latitud
              </Label>
              <Input id="config-zona-lat" value={zoneLat} onChange={(e) => setZoneLat(e.target.value)} placeholder="21.0619" className="w-auto min-w-[110px]" required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="config-zona-lng" className="text-xs text-muted-foreground">
                Longitud
              </Label>
              <Input id="config-zona-lng" value={zoneLng} onChange={(e) => setZoneLng(e.target.value)} placeholder="-89.6216" className="w-auto min-w-[110px]" required />
            </div>
            <Button type="submit" disabled={creatingZone}>
              {creatingZone ? "Agregando…" : "Agregar zona"}
            </Button>
          </form>

          <div className="mt-3 flex flex-col gap-2">
            {!zonas && !error && <EstadoCargando etiqueta="Cargando zonas…" />}
            {zonas && zonas.length === 0 && <EstadoVacio mensaje="Todavía no hay ninguna zona conocida sembrada." />}
            {zonas &&
              zonas.map((z) => (
                <div key={z.id} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-2.5">
                  <div>
                    <p className="m-0 text-[13px] font-semibold text-foreground">{z.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {z.lat}, {z.lng}
                    </p>
                  </div>
                  <Button type="button" variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => void handleDeleteZone(z)} disabled={deletingZoneId === z.id}>
                    <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                  </Button>
                </div>
              ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

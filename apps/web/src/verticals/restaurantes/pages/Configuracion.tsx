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
import { Button, Callout, Card, CardContent, CardDescription, CardHeader, CardTitle, EstadoCargando, EstadoError, EstadoVacio, Input, Label, Selector, PageContainer, PageHeader, useConfirm, StatusBadge, FormField, useT } from "@atiende/ui";
import type { Clave } from "@atiende/ui";
import { restaurantesConfiguracion } from "@atiende/ui/i18n/restaurantes/configuracion";
import { Clock, MapPin, MessageCircle, Trash2 } from "lucide-react";
import { createKnownZone, deleteKnownZone, fetchBranchTimezone, fetchKnownZones, fetchWhatsappConfig, updateBranchTimezone, updateWhatsappConfig } from "../lib/config-client.ts";
import type { BranchTimezoneConfig, KnownZone, WhatsappChannelConfig } from "../lib/config-client.ts";
import { AgenteWhatsappSeccion } from "./AgenteWhatsappSeccion.tsx";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";

const STAFF_INVITE_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

// FASE 3 (producto) -- "select de timezone IANA común en México" (mandato
// explícito de esta fase) -- mismo criterio de validación en el servidor
// (Intl.DateTimeFormat, ver admin-config.ts::optionalNullableTimeZone) que
// citas/admin.ts::optionalTimeZone, pero aquí SÍ como `<select>` con las 6 zonas
// reales del país (citas usa un Input libre -- ver su Configuracion.tsx) --
// ninguna otra existe hoy que un negocio mexicano real necesite.
const ZONA_HORARIA_OPTIONS: readonly { readonly value: string; readonly clave: Clave }[] = [
  { value: "America/Mexico_City", clave: "restaurantes.configuracion.tz.mexicoCity" },
  { value: "America/Cancun", clave: "restaurantes.configuracion.tz.cancun" },
  { value: "America/Tijuana", clave: "restaurantes.configuracion.tz.tijuana" },
  { value: "America/Chihuahua", clave: "restaurantes.configuracion.tz.chihuahua" },
  { value: "America/Hermosillo", clave: "restaurantes.configuracion.tz.hermosillo" },
  { value: "America/Mazatlan", clave: "restaurantes.configuracion.tz.mazatlan" },
];

/** Valor especial del `<select>` para "sin configurar" (`zonaHoraria: null` real)
 * -- nunca se manda como timezone IANA, `handleSaveZonaHoraria` lo traduce a
 * `null` antes de llamar a la API. */
const SIN_CONFIGURAR = "";

export function ConfiguracionPage({ apiBaseUrl, token, propertyId, role, nombreSucursal }: RestaurantesShellContext) {
  const t = useT(restaurantesConfiguracion);
  const canManage = STAFF_INVITE_ROLES.has(role);
  const { confirmar, dialogo } = useConfirm();

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

  const [zonaHoraria, setZonaHoraria] = useState<BranchTimezoneConfig | null>(null);
  const [zonaHorariaSelect, setZonaHorariaSelect] = useState<string>(SIN_CONFIGURAR);
  const [savingZonaHoraria, setSavingZonaHoraria] = useState(false);
  const [zonaHorariaSaved, setZonaHorariaSaved] = useState(false);

  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!canManage) return;
    setError(null);
    try {
      const [config, zonasList, timezoneConfig] = await Promise.all([
        fetchWhatsappConfig(fetch, apiBaseUrl, token, propertyId),
        fetchKnownZones(fetch, apiBaseUrl, token, propertyId),
        fetchBranchTimezone(fetch, apiBaseUrl, token, propertyId),
      ]);
      setWhatsapp(config);
      setPhoneNumberId(config.phoneNumberId ?? "");
      setZonas(zonasList);
      setZonaHoraria(timezoneConfig);
      setZonaHorariaSelect(timezoneConfig.zonaHoraria ?? SIN_CONFIGURAR);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("restaurantes.configuracion.error.cargar"));
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
      setError(err instanceof Error ? err.message : t("restaurantes.configuracion.error.whatsapp"));
    } finally {
      setSavingWhatsapp(false);
    }
  }

  async function handleSaveZonaHoraria(e: FormEvent) {
    e.preventDefault();
    setSavingZonaHoraria(true);
    setZonaHorariaSaved(false);
    setError(null);
    try {
      const updated = await updateBranchTimezone(fetch, apiBaseUrl, token, propertyId, zonaHorariaSelect === SIN_CONFIGURAR ? null : zonaHorariaSelect);
      setZonaHoraria(updated);
      setZonaHorariaSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("restaurantes.configuracion.error.zonaHoraria"));
    } finally {
      setSavingZonaHoraria(false);
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
      setError(err instanceof Error ? err.message : t("restaurantes.configuracion.error.agregarZona"));
    } finally {
      setCreatingZone(false);
    }
  }

  async function handleDeleteZone(zone: KnownZone) {
    const ok = await confirmar({
      titulo: t("restaurantes.configuracion.quitar.titulo", { zona: zone.name }),
      descripcion: t("restaurantes.configuracion.quitar.descripcion"),
      tono: "danger",
      confirmar: t("restaurantes.configuracion.quitar.confirmar"),
    });
    if (!ok) return;
    setDeletingZoneId(zone.id);
    setError(null);
    try {
      await deleteKnownZone(fetch, apiBaseUrl, token, propertyId, zone.id);
      setZonas((prev) => (prev ? prev.filter((z) => z.id !== zone.id) : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("restaurantes.configuracion.error.quitarZona"));
    } finally {
      setDeletingZoneId(null);
    }
  }

  if (!canManage) {
    return (
      <PageContainer padding="none">
        <PageHeader titulo={t("restaurantes.configuracion.titulo")} />
        <Callout tone="info">{t("restaurantes.configuracion.soloAdmin", { rol: role })}</Callout>
      </PageContainer>
    );
  }

  return (
    <PageContainer padding="none">
      <PageHeader titulo={t("restaurantes.configuracion.titulo")} />

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}

      <Card>
        <CardHeader className="p-4 pb-3">
          <CardTitle className="flex items-center gap-2">
            <MessageCircle className="h-4 w-4" strokeWidth={1.75} />
            {t("restaurantes.configuracion.whatsapp.titulo")}
          </CardTitle>
          <CardDescription>{t("restaurantes.configuracion.whatsapp.descripcion")}</CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {!whatsapp && !error && <EstadoCargando etiqueta={t("restaurantes.configuracion.cargando")} />}
          {whatsapp && (
            <form onSubmit={handleSaveWhatsapp} className="flex flex-wrap items-end gap-2">
              {/* // i18n-ignorar: nombre tecnico del campo en Meta, igual en ingles */}
              <FormField label="phone_number_id">
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
              </FormField>
              <Button type="submit" loading={savingWhatsapp}>
                {t("restaurantes.configuracion.guardar")}
              </Button>
              {whatsappSaved && <StatusBadge tone="success" dot={false}>{t("restaurantes.configuracion.guardado")}</StatusBadge>}
            </form>
          )}
          {whatsapp && !whatsapp.phoneNumberId && <p className="mt-2 text-xs text-muted-foreground">{t("restaurantes.configuracion.whatsapp.sinNumero")}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4 pb-3">
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4" strokeWidth={1.75} />
            {t("restaurantes.configuracion.tz.titulo")}
          </CardTitle>
          <CardDescription>
            {t("restaurantes.configuracion.tz.descripcion")}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          {!zonaHoraria && !error && <EstadoCargando etiqueta={t("restaurantes.configuracion.cargando")} />}
          {zonaHoraria && (
            <form onSubmit={handleSaveZonaHoraria} className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="config-zona-horaria">{t("restaurantes.configuracion.tz.campo")}</Label>
                <Selector
                  id="config-zona-horaria"
                  value={zonaHorariaSelect}
                  onChange={(e) => {
                    setZonaHorariaSelect(e.target.value);
                    setZonaHorariaSaved(false);
                  }}
                  wrapperClassName="w-auto min-w-72"
                >
                  <option value={SIN_CONFIGURAR}>{t("restaurantes.configuracion.tz.porDefecto")}</option>
                  {ZONA_HORARIA_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {t(opt.clave)}
                    </option>
                  ))}
                </Selector>
              </div>
              <Button type="submit" loading={savingZonaHoraria}>
                {t("restaurantes.configuracion.guardar")}
              </Button>
              {zonaHorariaSaved && <StatusBadge tone="success" dot={false}>{t("restaurantes.configuracion.guardado")}</StatusBadge>}
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="p-4 pb-3">
          <CardTitle className="flex items-center gap-2">
            <MapPin className="h-4 w-4" strokeWidth={1.75} />
            {t("restaurantes.configuracion.zonas.titulo")}
          </CardTitle>
          <CardDescription>
            {t("restaurantes.configuracion.zonas.descripcion")}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-0">
          <form onSubmit={handleCreateZone} className="flex flex-wrap items-end gap-2">
            <FormField label={t("restaurantes.configuracion.zonas.nombre")}>
              {/* // i18n-ignorar: ejemplo de colonia (dato), igual en ingles */}
              <Input id="config-zona-nombre" value={zoneName} onChange={(e) => setZoneName(e.target.value)} placeholder="Altabrisa" className="w-auto min-w-[160px]" required />
            </FormField>
            <FormField label={t("restaurantes.configuracion.zonas.latitud")}>
              <Input id="config-zona-lat" value={zoneLat} onChange={(e) => setZoneLat(e.target.value)} placeholder="21.0619" className="w-auto min-w-[110px]" required />
            </FormField>
            <FormField label={t("restaurantes.configuracion.zonas.longitud")}>
              <Input id="config-zona-lng" value={zoneLng} onChange={(e) => setZoneLng(e.target.value)} placeholder="-89.6216" className="w-auto min-w-[110px]" required />
            </FormField>
            <Button type="submit" loading={creatingZone}>
              {t("restaurantes.configuracion.zonas.agregar")}
            </Button>
          </form>

          <div className="mt-3 flex flex-col gap-2">
            {!zonas && !error && <EstadoCargando etiqueta={t("restaurantes.configuracion.zonas.cargando")} />}
            {zonas && zonas.length === 0 && <EstadoVacio mensaje={t("restaurantes.configuracion.zonas.vacio")} />}
            {zonas &&
              zonas.map((z) => (
                <div key={z.id} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-2.5">
                  <div>
                    <p className="m-0 text-sm font-semibold text-foreground">{z.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {z.lat === null || z.lng === null ? t("restaurantes.configuracion.zonas.sinCoordenadas") : `${z.lat}, ${z.lng}`}
                    </p>
                  </div>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t("restaurantes.configuracion.zonas.quitarAria", { zona: z.name })} onClick={() => void handleDeleteZone(z)} disabled={deletingZoneId === z.id}>
                    <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                  </Button>
                </div>
              ))}
          </div>
        </CardContent>
      </Card>

      <AgenteWhatsappSeccion apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} {...(nombreSucursal ? { nombreSucursal } : {})} />
      {dialogo}
    </PageContainer>
  );
}

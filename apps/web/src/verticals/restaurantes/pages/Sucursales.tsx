// Sucursales (Fase 5) — lista + ficha de edición real (teléfono/dirección/
// coordenadas/slug). Deliberadamente sin "crear sucursal" ni "activar/desactivar":
// ver comentario de cabecera de admin-branches.ts.
//
// Presentación real desde esta ronda: los `style={{...}}` inline de antes pasan a los
// primitivos de `@atiende/ui` — `Card` por sucursal, `Badge` para "Activa/Inactiva",
// `Input`/`Label` para el formulario de edición y `Button` para Editar/Guardar/
// Cancelar. Toda la lógica de carga/edición/guardado de abajo es la MISMA.
import { useEffect, useState } from "react";
import { Button, Callout, Card, CardContent, EstadoCargando, EstadoError, FormField, Input, Label, PageContainer, PageHeader, StatusBadge, useT } from "@atiende/ui";
import { restaurantesComun } from "@atiende/ui/i18n/restaurantes/comun";
import { restaurantesSucursales } from "@atiende/ui/i18n/restaurantes/sucursales";
import { ExternalLink, MapPin, Pencil } from "lucide-react";
import { fetchBranchTimezone } from "../lib/config-client.ts";
import { fetchAdminBranches, updateBranchDetail } from "../lib/branches-client.ts";
import type { BranchDetail } from "../lib/branches-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";
import { puedeEn } from "../lib/permisos.ts";
import { ReglasSucursal } from "./ReglasSucursal.tsx";
import { ControlesSucursal } from "../components/ControlesSucursal.tsx";
import { Link } from "react-router-dom";
import { esEnlaceCortoDeMaps, fueraDeYucatan, interpretarCoordenadasPegadas, textoCoordenada, urlVerEnMapa, validarPar } from "../lib/coordenadas.ts";

// Mismo criterio que STAFF_NAV_ROLES de RestaurantesShell.tsx: cosmético, el servidor (admin-modelo-pm.ts
// + RLS) es el enforcement real.
const REGLAS_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

export function SucursalesPage({ apiBaseUrl, token, propertyId, role, orgSlug }: RestaurantesShellContext) {
  const t = useT(restaurantesComun, restaurantesSucursales);
  const [branches, setBranches] = useState<readonly BranchDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ phone: string; address: string; lat: string; lng: string }>({ phone: "", address: "", lat: "", lng: "" });
  const [tocados, setTocados] = useState({ lat: false, lng: false });
  const [intentoGuardar, setIntentoGuardar] = useState(false);
  const [zonaHoraria, setZonaHoraria] = useState<string | null>(null);
  const [pegado, setPegado] = useState("");
  const [errorPegado, setErrorPegado] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reglasAbiertas, setReglasAbiertas] = useState<string | null>(null);
  // PL-23: editar los datos de la sucursal es de owner/admin; el staff solo los consulta.
  const puedeEditar = puedeEn(role, "sucursal.editar");

  async function load() {
    setError(null);
    try {
      setBranches(await fetchAdminBranches(fetch, apiBaseUrl, token, propertyId));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("restaurantes.sucursales.error.cargar"));
    }
  }

  useEffect(() => {
    void load();
  }, [apiBaseUrl, token, propertyId]);

  function startEditing(branch: BranchDetail) {
    setEditing(branch.propertyId);
    // Zona horaria DE ESA sucursal, pedida solo al abrir la edición (solo dueño/admin llegan aquí): alimenta el aviso no bloqueante de "fuera de Yucatán".
    setZonaHoraria(null);
    fetchBranchTimezone(fetch, apiBaseUrl, token, branch.propertyId).then(
      (c) => setZonaHoraria(c.zonaHoraria),
      () => undefined,
    );
    setDraft({ phone: branch.phone ?? "", address: branch.address ?? "", lat: textoCoordenada(branch.lat), lng: textoCoordenada(branch.lng) });
    setPegado("");
    setErrorPegado(null);
    setTocados({ lat: false, lng: false });
    setIntentoGuardar(false);
  }

  // Aplica lo pegado (o lo que haya en el portapapeles) a los dos campos. Si no se reconoce, no toca nada.
  async function aplicarPegado() {
    setErrorPegado(null);
    let texto = pegado.trim();
    if (texto === "") {
      try {
        texto = (await navigator.clipboard.readText()).trim();
      } catch {
        setErrorPegado(t("restaurantes.sucursales.error.portapapeles"));
        return;
      }
    }
    const par = interpretarCoordenadasPegadas(texto);
    if (!par && esEnlaceCortoDeMaps(texto)) {
      setErrorPegado(t("restaurantes.sucursales.error.enlaceCorto"));
      return;
    }
    if (!par) {
      setErrorPegado(t("restaurantes.sucursales.error.sinCoordenadas"));
      return;
    }
    setDraft((d) => ({ ...d, lat: String(par.lat), lng: String(par.lng) }));
    setPegado("");
  }

  // Un valor que ya estaba guardado y no se tocó no bloquea editar teléfono o dirección (puede venir de antes de esta validación).
  function validacionDe(branch: BranchDetail) {
    const sinTocar = draft.lat === textoCoordenada(branch.lat) && draft.lng === textoCoordenada(branch.lng);
    if (sinTocar) return { lat: branch.lat, lng: branch.lng, errorLat: null, errorLng: null };
    return validarPar(draft.lat, draft.lng);
  }

  async function handleSave(branch: BranchDetail) {
    const coords = validacionDe(branch);
    if (coords.errorLat || coords.errorLng) {
      setIntentoGuardar(true);
      // Foco al primer campo inválido para que el lector de pantalla lo anuncie con su error.
      document.getElementById(`sucursal-${coords.errorLat ? "lat" : "lng"}-${branch.propertyId}`)?.focus();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Las coordenadas solo viajan si cambiaron: así una ficha sin tocarlas no las reescribe (ni las manda a una base sin migrar).
      const cambioCoords = coords.lat !== branch.lat || coords.lng !== branch.lng;
      await updateBranchDetail(fetch, apiBaseUrl, token, propertyId, branch.propertyId, {
        phone: draft.phone || null,
        address: draft.address || null,
        ...(cambioCoords ? { lat: coords.lat, lng: coords.lng } : {}),
      });
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("restaurantes.sucursales.error.guardar"));
    } finally {
      setSaving(false);
    }
  }

  const sinCoordenadas = (branches ?? []).filter((b) => b.status === "active" && (b.lat === null || b.lng === null));
  return (
    <PageContainer padding="none">
      <PageHeader titulo={t("restaurantes.sucursales.titulo")} />
      <Callout tone="info">
        {t("restaurantes.sucursales.plataformaAntes")}{" "}
        <Link to={`/restaurantes/${orgSlug}/plan`} className="underline">{t("restaurantes.sucursales.planYUso")}</Link>{t("restaurantes.sucursales.plataformaDespues")}
      </Callout>

      {!puedeEditar && <Callout tone="info">{t("restaurantes.sucursales.soloDueno")}</Callout>}

      {sinCoordenadas.length > 0 && (
        <Callout tone="warning" titulo={t("restaurantes.sucursales.sinCoordenadasTitulo")} icon={<MapPin />}>
          {t("restaurantes.sucursales.sinCoordenadasTexto", { sucursales: sinCoordenadas.map((b) => b.name).join(", ") })}
          {t(puedeEditar ? "restaurantes.sucursales.sinCoordenadasEditar" : "restaurantes.sucursales.sinCoordenadasPedir")}
        </Callout>
      )}

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
      {!branches && !error && <EstadoCargando etiqueta={t("restaurantes.sucursales.cargando")} />}

      <div className="flex flex-col gap-3">
        {branches?.map((b) => {
          const validacion = validacionDe(b);
          // El error se anuncia al salir del campo o al intentar guardar, no en cada tecla.
          const verLat = intentoGuardar || tocados.lat;
          const verLng = intentoGuardar || tocados.lng;
          const avisoYucatan = zonaHoraria === "America/Merida" && !validacion.errorLat && !validacion.errorLng && validacion.lat !== null && validacion.lng !== null && fueraDeYucatan(validacion.lat, validacion.lng);
          const hrefMapaDraft = validacion.errorLat || validacion.errorLng ? null : urlVerEnMapa(validacion.lat, validacion.lng);
          return (
          <Card key={b.propertyId}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="m-0 font-semibold text-foreground">{b.name}</p>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span>/{b.slug} ·</span>
                    <StatusBadge tone={b.status === "active" ? "success" : "danger"}>{t(b.status === "active" ? "restaurantes.sucursales.activa" : "restaurantes.sucursales.inactiva")}</StatusBadge>
                  </div>
                </div>
                {editing !== b.propertyId && puedeEditar && (
                  <Button type="button" variant="outline" size="sm" onClick={() => startEditing(b)}>
                    <Pencil />
                    {t("restaurantes.sucursales.editar")}
                  </Button>
                )}
              </div>

              <div className="mt-3">
                <ControlesSucursal apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} branchId={b.propertyId} branchName={b.name} puedeCambiar={REGLAS_ROLES.has(role)} />
              </div>

              {editing === b.propertyId ? (
                <div className="mt-3 flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`sucursal-telefono-${b.propertyId}`} className="text-xs text-muted-foreground">
                      {t("restaurantes.sucursales.telefono")}
                    </Label>
                    <Input
                      id={`sucursal-telefono-${b.propertyId}`}
                      value={draft.phone}
                      onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`sucursal-direccion-${b.propertyId}`} className="text-xs text-muted-foreground">
                      {t("restaurantes.sucursales.direccion")}
                    </Label>
                    <Input
                      id={`sucursal-direccion-${b.propertyId}`}
                      value={draft.address}
                      onChange={(e) => setDraft((d) => ({ ...d, address: e.target.value }))}
                    />
                  </div>
                  <fieldset className="m-0 flex flex-col gap-3 rounded-card border border-border p-3">
                    <legend className="px-1 text-xs font-semibold text-foreground">{t("restaurantes.sucursales.ubicacion")}</legend>
                    <p className="m-0 text-xs text-muted-foreground">
                      {t("restaurantes.sucursales.ubicacionAyuda")}
                    </p>
                    <FormField label={t("restaurantes.sucursales.pegar")} error={errorPegado ?? undefined} id={`sucursal-pegar-${b.propertyId}`}>
                      {(props) => (
                        <div className="flex gap-2">
                          <Input {...props} value={pegado} placeholder={t("restaurantes.sucursales.pegarPh")} onChange={(e) => setPegado(e.target.value)} />
                          <Button type="button" variant="outline" size="sm" onClick={() => void aplicarPegado()}>
                            {t("restaurantes.sucursales.pegar")}
                          </Button>
                        </div>
                      )}
                    </FormField>
                    <div className="grid grid-cols-2 gap-3">
                      <FormField label={t("restaurantes.sucursales.latitud")} id={`sucursal-lat-${b.propertyId}`} error={verLat ? (validacion.errorLat ?? undefined) : undefined}>
                        <Input
                          inputMode="decimal"
                          value={draft.lat}
                          onChange={(e) => setDraft((d) => ({ ...d, lat: e.target.value }))}
                          onBlur={() => setTocados((t) => ({ ...t, lat: true }))}
                        />
                      </FormField>
                      <FormField label={t("restaurantes.sucursales.longitud")} id={`sucursal-lng-${b.propertyId}`} error={verLng ? (validacion.errorLng ?? undefined) : undefined}>
                        <Input
                          inputMode="decimal"
                          value={draft.lng}
                          onChange={(e) => setDraft((d) => ({ ...d, lng: e.target.value }))}
                          onBlur={() => setTocados((t) => ({ ...t, lng: true }))}
                        />
                      </FormField>
                    </div>
                    {avisoYucatan && (
                      <p role="status" className="m-0 text-xs text-warning">
                        {t("restaurantes.sucursales.coord.fueraYucatan")}
                      </p>
                    )}
                    {hrefMapaDraft && (
                      <a href={hrefMapaDraft} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary underline">
                        {t("restaurantes.sucursales.verEnMapa")}<ExternalLink className="size-3" aria-hidden="true" />
                      </a>
                    )}
                  </fieldset>
                  <div className="flex gap-2">
                    <Button type="button" size="sm" onClick={() => void handleSave(b)} loading={saving}>
                      {t("restaurantes.sucursales.guardar")}
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => setEditing(null)} disabled={saving}>
                      {t("restaurantes.cancelar")}
                    </Button>
                  </div>
                </div>
              ) : (
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">{t("restaurantes.sucursales.telefono")}</dt>
                  <dd className="m-0 text-foreground">{b.phone ?? "—"}</dd>
                  <dt className="text-muted-foreground">{t("restaurantes.sucursales.direccion")}</dt>
                  <dd className="m-0 text-foreground">{b.address ?? "—"}</dd>
                  <dt className="text-muted-foreground">{t("restaurantes.sucursales.coordenadas")}</dt>
                  <dd className="m-0 text-foreground">
                    {b.lat !== null && b.lng !== null ? (
                      <>
                        {b.lat}, {b.lng}{" "}
                        <a href={urlVerEnMapa(b.lat, b.lng) ?? undefined} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary underline">
                          {t("restaurantes.sucursales.verEnMapa")}<ExternalLink className="size-3" aria-hidden="true" />
                        </a>
                      </>
                    ) : b.status === "active" ? (
                      <StatusBadge tone="warning">{t("restaurantes.sucursales.sinCoordenadas")}</StatusBadge>
                    ) : (
                      "—"
                    )}
                  </dd>
                </dl>
              )}

              {REGLAS_ROLES.has(role) && editing !== b.propertyId && (
                <div className="mt-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-expanded={reglasAbiertas === b.propertyId}
                    onClick={() => setReglasAbiertas((actual) => (actual === b.propertyId ? null : b.propertyId))}
                  >
                    {t(reglasAbiertas === b.propertyId ? "restaurantes.sucursales.ocultarReglas" : "restaurantes.sucursales.reglas")}

                  </Button>
                  {reglasAbiertas === b.propertyId && <ReglasSucursal apiBaseUrl={apiBaseUrl} token={token} propertyId={propertyId} branchId={b.propertyId} />}
                </div>
              )}
            </CardContent>
          </Card>
          );
        })}
      </div>
    </PageContainer>
  );
}

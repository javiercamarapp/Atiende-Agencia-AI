// Sucursales (Fase 5) — lista + ficha de edición real (teléfono/dirección/
// coordenadas/slug). Deliberadamente sin "crear sucursal" ni "activar/desactivar":
// ver comentario de cabecera de admin-branches.ts.
//
// Presentación real desde esta ronda: los `style={{...}}` inline de antes pasan a los
// primitivos de `@atiende/ui` — `Card` por sucursal, `Badge` para "Activa/Inactiva",
// `Input`/`Label` para el formulario de edición y `Button` para Editar/Guardar/
// Cancelar. Toda la lógica de carga/edición/guardado de abajo es la MISMA.
import { useEffect, useState } from "react";
import { Button, Callout, Card, CardContent, EstadoCargando, EstadoError, FormField, Input, Label, PageContainer, StatusBadge } from "@atiende/ui";
import { ExternalLink, MapPin, Pencil } from "lucide-react";
import { fetchBranchTimezone } from "../lib/config-client.ts";
import { fetchAdminBranches, updateBranchDetail } from "../lib/branches-client.ts";
import type { BranchDetail } from "../lib/branches-client.ts";
import type { RestaurantesShellContext } from "../RestaurantesShell.tsx";
import { puedeEn } from "../lib/permisos.ts";
import { ReglasSucursal } from "./ReglasSucursal.tsx";
import { AVISO_FUERA_DE_YUCATAN, esEnlaceCortoDeMaps, fueraDeYucatan, interpretarCoordenadasPegadas, textoCoordenada, urlVerEnMapa, validarPar } from "../lib/coordenadas.ts";

// Mismo criterio que STAFF_NAV_ROLES de RestaurantesShell.tsx: cosmético, el servidor (admin-modelo-pm.ts
// + RLS) es el enforcement real.
const REGLAS_ROLES: ReadonlySet<string> = new Set(["owner", "admin"]);

export function SucursalesPage({ apiBaseUrl, token, propertyId, role }: RestaurantesShellContext) {
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
      setError(err instanceof Error ? err.message : "No se pudieron cargar las sucursales.");
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
        setErrorPegado("El navegador no dejó leer el portapapeles. Pega el texto en el recuadro y vuelve a pulsar el botón.");
        return;
      }
    }
    const par = interpretarCoordenadasPegadas(texto);
    if (!par && esEnlaceCortoDeMaps(texto)) {
      setErrorPegado("Ese es un enlace corto de Google Maps y no trae el punto. Ábrelo en el navegador, mantén pulsado el pin y copia las coordenadas (o copia el enlace largo de la barra de direcciones).");
      return;
    }
    if (!par) {
      setErrorPegado("No reconocí coordenadas. Pega algo como 21.0280, -89.6100 o el enlace de Google Maps con @latitud,longitud.");
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
      setError(err instanceof Error ? err.message : "No se pudo guardar la sucursal.");
    } finally {
      setSaving(false);
    }
  }

  const sinCoordenadas = (branches ?? []).filter((b) => b.status === "active" && (b.lat === null || b.lng === null));
  return (
    <PageContainer padding="none">
      <h1 className="sr-only">Sucursales</h1>
      <Callout tone="info">
        Crear una sucursal nueva o activar/desactivarla todavía no está disponible desde el panel — requiere un cambio de plataforma compartido por todas las verticales (ver README de este vertical).
      </Callout>

      {!puedeEditar && <Callout tone="info">Solo el dueño o un administrador puede editar los datos de la sucursal.</Callout>}

      {sinCoordenadas.length > 0 && (
        <Callout tone="warning" titulo="Sucursal activa sin coordenadas" icon={<MapPin />}>
          {sinCoordenadas.map((b) => b.name).join(", ")}: sin coordenadas el agente no puede asignar la sucursal por distancia cuando el cliente manda su ubicación.
          {puedeEditar ? " Edita la sucursal y captura latitud y longitud." : " Pídele al dueño o a un administrador que las capture."}
        </Callout>
      )}

      {error && <EstadoError mensaje={error} onReintentar={() => void load()} />}
      {!branches && !error && <EstadoCargando etiqueta="Cargando sucursales…" />}

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
                    <StatusBadge tone={b.status === "active" ? "success" : "danger"}>{b.status === "active" ? "Activa" : "Inactiva"}</StatusBadge>
                  </div>
                </div>
                {editing !== b.propertyId && puedeEditar && (
                  <Button type="button" variant="outline" size="sm" onClick={() => startEditing(b)}>
                    <Pencil />
                    Editar
                  </Button>
                )}
              </div>

              {editing === b.propertyId ? (
                <div className="mt-3 flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`sucursal-telefono-${b.propertyId}`} className="text-xs text-muted-foreground">
                      Teléfono
                    </Label>
                    <Input
                      id={`sucursal-telefono-${b.propertyId}`}
                      value={draft.phone}
                      onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`sucursal-direccion-${b.propertyId}`} className="text-xs text-muted-foreground">
                      Dirección
                    </Label>
                    <Input
                      id={`sucursal-direccion-${b.propertyId}`}
                      value={draft.address}
                      onChange={(e) => setDraft((d) => ({ ...d, address: e.target.value }))}
                    />
                  </div>
                  <fieldset className="m-0 flex flex-col gap-3 rounded-card border border-border p-3">
                    <legend className="px-1 text-xs font-semibold text-foreground">Ubicación en el mapa</legend>
                    <p className="m-0 text-xs text-muted-foreground">
                      En Google Maps, mantén pulsado el punto exacto del local: abajo aparece el pin y arriba los números (por ejemplo 21.0280, -89.6100). Cópialos, o copia el enlace del mapa, y pégalos aquí.
                    </p>
                    <FormField label="Pegar de Google Maps" error={errorPegado ?? undefined} id={`sucursal-pegar-${b.propertyId}`}>
                      {(props) => (
                        <div className="flex gap-2">
                          <Input {...props} value={pegado} placeholder="21.0280, -89.6100 o enlace con @lat,lng" onChange={(e) => setPegado(e.target.value)} />
                          <Button type="button" variant="outline" size="sm" onClick={() => void aplicarPegado()}>
                            Pegar de Google Maps
                          </Button>
                        </div>
                      )}
                    </FormField>
                    <div className="grid grid-cols-2 gap-3">
                      <FormField label="Latitud" id={`sucursal-lat-${b.propertyId}`} error={verLat ? (validacion.errorLat ?? undefined) : undefined}>
                        <Input
                          inputMode="decimal"
                          value={draft.lat}
                          onChange={(e) => setDraft((d) => ({ ...d, lat: e.target.value }))}
                          onBlur={() => setTocados((t) => ({ ...t, lat: true }))}
                        />
                      </FormField>
                      <FormField label="Longitud" id={`sucursal-lng-${b.propertyId}`} error={verLng ? (validacion.errorLng ?? undefined) : undefined}>
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
                        {AVISO_FUERA_DE_YUCATAN}
                      </p>
                    )}
                    {hrefMapaDraft && (
                      <a href={hrefMapaDraft} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary underline">
                        Ver en el mapa <ExternalLink className="size-3" aria-hidden="true" />
                      </a>
                    )}
                  </fieldset>
                  <div className="flex gap-2">
                    <Button type="button" size="sm" onClick={() => void handleSave(b)} loading={saving}>
                      Guardar
                    </Button>
                    <Button type="button" variant="outline" size="sm" onClick={() => setEditing(null)} disabled={saving}>
                      Cancelar
                    </Button>
                  </div>
                </div>
              ) : (
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">Teléfono</dt>
                  <dd className="m-0 text-foreground">{b.phone ?? "—"}</dd>
                  <dt className="text-muted-foreground">Dirección</dt>
                  <dd className="m-0 text-foreground">{b.address ?? "—"}</dd>
                  <dt className="text-muted-foreground">Coordenadas</dt>
                  <dd className="m-0 text-foreground">
                    {b.lat !== null && b.lng !== null ? (
                      <>
                        {b.lat}, {b.lng}{" "}
                        <a href={urlVerEnMapa(b.lat, b.lng) ?? undefined} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary underline">
                          Ver en el mapa <ExternalLink className="size-3" aria-hidden="true" />
                        </a>
                      </>
                    ) : b.status === "active" ? (
                      <StatusBadge tone="warning">Sin coordenadas</StatusBadge>
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
                    {reglasAbiertas === b.propertyId ? "Ocultar reglas de pedido" : "Reglas de pedido"}
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

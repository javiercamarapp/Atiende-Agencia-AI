// Ubicacion de la sucursal con pin (portado del repo suelto, SucursalesSection.tsx: «Buscar dirección o colonia…», pin arrastrable y
// «Usar mi ubicación actual»). La busqueda y la direccion del punto pasan por la API propia (lib/geocodificar-client.ts): el navegador
// no habla con el proveedor ni ve llaves. Sin geocodificacion configurada lo dice y el mapa sigue sirviendo (arrastrar el pin) junto con
// las coordenadas pegadas de Google Maps que ya tenia la pantalla. El mapa (Leaflet) se carga perezoso, en su propio chunk.
import { lazy, Suspense, useState } from "react";
import type { KeyboardEvent, ReactElement } from "react";
import { LocateFixed, Search } from "lucide-react";
import { Button, Callout, Input, Label, RegionCargando, useT } from "@atiende/ui";
import { pinSucursal } from "@atiende/ui/i18n/pinSucursal";
import { GeocodificacionNoDisponibleError, buscarDireccion, direccionDePunto, redondearCoordenada } from "../lib/geocodificar-client.ts";
import type { ResultadoDireccion } from "../lib/geocodificar-client.ts";

const MapaPinSucursal = lazy(() => import("./MapaPinSucursal.tsx"));

export interface UbicacionSucursalProps {
  readonly apiBaseUrl: string;
  readonly token: string;
  readonly propertyId: string;
  /** Sufijo unico para los id del formulario (la sucursal que se edita). */
  readonly idBase: string;
  /** Ubicacion vigente del borrador (null si aun no hay una valida). */
  readonly lat: number | null;
  readonly lng: number | null;
  readonly onUbicar: (lat: number, lng: number) => void;
  /** Direccion escrita en el borrador: si la del punto es la misma no se ofrece. */
  readonly direccion: string;
  readonly onUsarDireccion: (direccion: string) => void;
  /** Solo pruebas. */
  readonly fetchImpl?: typeof fetch;
  readonly geolocalizacion?: Geolocation | null;
  /** Solo pruebas: reemplaza el mapa Leaflet (jsdom no lo dibuja). */
  readonly mapa?: (props: { lat: number | null; lng: number | null; onMover: (lat: number, lng: number) => void; etiqueta: string }) => ReactElement;
}

const Q_MIN = 3;

export function UbicacionSucursal(props: UbicacionSucursalProps) {
  const { apiBaseUrl, token, propertyId, idBase, lat, lng, onUbicar, direccion, onUsarDireccion } = props;
  const fetchImpl = props.fetchImpl ?? fetch;
  const t = useT(pinSucursal);
  const [q, setQ] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [resultados, setResultados] = useState<readonly ResultadoDireccion[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);
  const [noDisponible, setNoDisponible] = useState<string | null>(null);
  const [sugerencia, setSugerencia] = useState<string | null>(null);
  const [ubicando, setUbicando] = useState(false);

  async function buscar() {
    const texto = q.trim();
    setResultados([]);
    if (texto.length < Q_MIN) {
      setAviso(t("pinSucursal.buscar.corto"));
      return;
    }
    setAviso(null);
    setBuscando(true);
    try {
      const r = await buscarDireccion(fetchImpl, apiBaseUrl, token, propertyId, texto);
      setResultados(r);
      if (r.length === 0) setAviso(t("pinSucursal.buscar.sinResultados"));
    } catch (err) {
      if (err instanceof GeocodificacionNoDisponibleError) setNoDisponible(err.message);
      else setAviso(t("pinSucursal.buscar.error"));
    } finally {
      setBuscando(false);
    }
  }

  function elegir(r: ResultadoDireccion) {
    onUbicar(redondearCoordenada(r.lat), redondearCoordenada(r.lng));
    setSugerencia(r.etiqueta);
    setResultados([]);
    setAviso(null);
  }

  /** Arrastre del pin, clic en el mapa o «mi ubicación»: mueve y, si se puede, sugiere la direccion del punto (nunca bloquea). */
  async function moverPin(la: number, ln: number) {
    onUbicar(la, ln);
    setSugerencia(null);
    if (noDisponible) return;
    try {
      setSugerencia(await direccionDePunto(fetchImpl, apiBaseUrl, token, propertyId, la, ln));
    } catch (err) {
      if (err instanceof GeocodificacionNoDisponibleError) setNoDisponible(err.message);
    }
  }

  function usarMiUbicacion() {
    const geo = props.geolocalizacion === undefined ? (typeof navigator !== "undefined" ? navigator.geolocation : null) : props.geolocalizacion;
    if (!geo) {
      setAviso(t("pinSucursal.miUbicacion.noSoportada"));
      return;
    }
    setUbicando(true);
    geo.getCurrentPosition(
      (pos) => {
        setUbicando(false);
        void moverPin(redondearCoordenada(pos.coords.latitude), redondearCoordenada(pos.coords.longitude));
      },
      () => {
        setUbicando(false);
        setAviso(t("pinSucursal.miUbicacion.error"));
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  function alTeclear(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void buscar();
    }
  }

  const etiquetaMapa = t("pinSucursal.mapa.etiqueta");
  const Mapa = props.mapa;
  const idBuscar = `sucursal-buscar-${idBase}`;

  return (
    <div className="flex flex-col gap-2" data-testid="ubicacion-sucursal">
      {noDisponible ? (
        <Callout tone="info" data-testid="geocodificacion-no-disponible">
          {noDisponible}
        </Callout>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={idBuscar} className="text-xs text-muted-foreground">
            {t("pinSucursal.buscar.etiqueta")}
          </Label>
          <div className="flex gap-2">
            <Input id={idBuscar} value={q} placeholder={t("pinSucursal.buscar.placeholder")} onChange={(e) => setQ(e.target.value)} onKeyDown={alTeclear} autoComplete="off" />
            <Button type="button" variant="outline" size="sm" onClick={() => void buscar()} loading={buscando} disabled={buscando}>
              <Search />
              {t("pinSucursal.buscar.boton")}
            </Button>
          </div>
        </div>
      )}
      {aviso && (
        <p role="status" className="m-0 text-xs text-muted-foreground">
          {aviso}
        </p>
      )}
      {resultados.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="geocodificar-resultados">
          <p className="m-0 text-xs font-medium text-muted-foreground">{t("pinSucursal.buscar.resultados")}</p>
          <ul className="m-0 flex list-none flex-col divide-y divide-border overflow-hidden rounded-md border border-border p-0">
            {resultados.map((r, i) => (
              <li key={`${r.lat},${r.lng},${i}`}>
                <button type="button" className="w-full px-3 py-2 text-left text-xs text-foreground hover:bg-muted focus-visible:bg-muted focus-visible:outline-none" onClick={() => elegir(r)}>
                  {r.etiqueta}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="m-0 text-xs text-muted-foreground">{t("pinSucursal.mapa.ayuda")}</p>
        <Button type="button" variant="outline" size="sm" onClick={usarMiUbicacion} loading={ubicando} disabled={ubicando}>
          <LocateFixed />
          {t("pinSucursal.miUbicacion")}
        </Button>
      </div>
      {Mapa ? (
        <Mapa lat={lat} lng={lng} onMover={(a, b) => void moverPin(a, b)} etiqueta={etiquetaMapa} />
      ) : (
        <Suspense fallback={<RegionCargando ocupado etiqueta={t("pinSucursal.mapa.cargando")} pulso className="h-56 rounded-xl border border-border bg-canvas" claseDs3="h-56 rounded-xl border border-border" />}>
          <MapaPinSucursal lat={lat} lng={lng} onMover={(a, b) => void moverPin(a, b)} etiqueta={etiquetaMapa} />
        </Suspense>
      )}
      {sugerencia && sugerencia.trim() !== direccion.trim() && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="sugerencia-direccion">
          <span>{t("pinSucursal.sugerencia.texto", { direccion: sugerencia })}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => onUsarDireccion(sugerencia)}>
            {t("pinSucursal.sugerencia.usar")}
          </Button>
        </div>
      )}
    </div>
  );
}

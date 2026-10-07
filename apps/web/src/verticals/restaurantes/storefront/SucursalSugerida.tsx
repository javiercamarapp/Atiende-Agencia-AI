// "¿Dónde está?": sugiere la sucursal que reparte en su colonia (autocompletar contra las zonas conocidas del restaurante) o la mas
// cercana a su ubicacion (con permiso del navegador; las coordenadas viajan solo en un POST y el servidor no las guarda). La
// sucursal elegida se recuerda en localStorage (solo slug y nombre; con try/catch porque puede estar bloqueado).
import { useEffect, useId, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, Callout, FormField, Input } from "@atiende/ui";
import { crearClienteStorefront, type SugerenciaSucursal } from "./storefront-client.ts";

interface SucursalRecordada {
  readonly slug: string;
  readonly name: string;
}

const clave = (orgSlug: string) => `atiende.storefront.sucursal.${orgSlug}`;

export function leerSucursalRecordada(orgSlug: string): SucursalRecordada | null {
  try {
    const raw = globalThis.localStorage?.getItem(clave(orgSlug));
    const v = raw ? (JSON.parse(raw) as Partial<SucursalRecordada>) : null;
    return v && typeof v.slug === "string" && typeof v.name === "string" && /^[a-z0-9-]{1,80}$/.test(v.slug) ? { slug: v.slug, name: v.name.slice(0, 120) } : null;
  } catch {
    return null;
  }
}

function recordarSucursal(orgSlug: string, s: SucursalRecordada | null): void {
  try {
    if (s) globalThis.localStorage?.setItem(clave(orgSlug), JSON.stringify(s));
    else globalThis.localStorage?.removeItem(clave(orgSlug));
  } catch {
    // sin almacenamiento (modo privado, bloqueado): la sugerencia sigue funcionando, solo no se recuerda
  }
}

export function SucursalSugerida({ apiBaseUrl, orgSlug }: { apiBaseUrl: string; orgSlug: string }) {
  const cliente = useMemo(() => crearClienteStorefront(apiBaseUrl, orgSlug), [apiBaseUrl, orgSlug]);
  const listaId = useId();
  const [recordada, setRecordada] = useState<SucursalRecordada | null>(() => leerSucursalRecordada(orgSlug));
  const [zonas, setZonas] = useState<string[]>([]);
  const [colonia, setColonia] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [resultado, setResultado] = useState<SugerenciaSucursal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hayGeolocalizacion = typeof navigator !== "undefined" && "geolocation" in navigator;

  useEffect(() => {
    let vigente = true;
    // El autocompletar es una ayuda: si falla, el campo sigue aceptando texto libre.
    cliente.zonas().then((r) => vigente && setZonas(Array.isArray(r.zonas) ? r.zonas : [])).catch(() => undefined);
    return () => {
      vigente = false;
    };
  }, [cliente]);

  async function consultar(entrada: { colonia: string } | { lat: number; lng: number }) {
    setBuscando(true);
    setError(null);
    setResultado(null);
    try {
      const { sugerencia } = await cliente.sucursalSugerida(entrada);
      setResultado(sugerencia);
      if (sugerencia.tipo !== "sin_resultado") {
        recordarSucursal(orgSlug, sugerencia.sucursal);
        setRecordada(sugerencia.sucursal);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "No pudimos sugerir una sucursal.");
    } finally {
      setBuscando(false);
    }
  }

  function buscarPorColonia(ev: FormEvent) {
    ev.preventDefault();
    if (!colonia.trim()) {
      setError("Escriba su colonia.");
      return;
    }
    void consultar({ colonia: colonia.trim() });
  }

  function usarUbicacion() {
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => void consultar({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => setError("No pudimos obtener su ubicación. Puede escribir su colonia."),
      { timeout: 10_000, maximumAge: 60_000 },
    );
  }

  return (
    <section aria-labelledby="donde-esta" className="mb-4 rounded-lg border border-border bg-card p-4">
      <h2 id="donde-esta" className="text-sm font-semibold">
        ¿Dónde está?
      </h2>
      {recordada && (
        <p className="mt-1 text-ui text-muted-foreground">
          Su sucursal: <strong className="text-foreground">{recordada.name}</strong>.{" "}
          <Link className="underline underline-offset-2" to={`/pedir/${orgSlug}/${recordada.slug}`}>
            Pedir aquí
          </Link>{" "}
          ·{" "}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => {
              recordarSucursal(orgSlug, null);
              setRecordada(null);
              setResultado(null);
            }}
          >
            Cambiar
          </button>
        </p>
      )}
      <form onSubmit={buscarPorColonia} noValidate className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <FormField label="Su colonia" hint="Escriba y elija de la lista, o use su ubicación.">
            {(p) => (
              <>
                <Input {...p} list={listaId} value={colonia} onChange={(e) => setColonia(e.target.value)} maxLength={120} autoComplete="off" />
                <datalist id={listaId}>
                  {zonas.map((z) => (
                    <option key={z} value={z} />
                  ))}
                </datalist>
              </>
            )}
          </FormField>
        </div>
        <div className="flex gap-2">
          <Button type="submit" loading={buscando}>
            Buscar sucursal
          </Button>
          {hayGeolocalizacion && (
            <Button type="button" variant="outline" disabled={buscando} onClick={usarUbicacion}>
              Usar mi ubicación
            </Button>
          )}
        </div>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-ui text-destructive">
          {error}
        </p>
      )}
      {resultado && (
        <Callout tone={resultado.tipo === "sin_resultado" ? "warning" : "info"} className="mt-3">
          <p>{resultado.mensaje}</p>
          {resultado.tipo !== "sin_resultado" && (
            <p className="mt-1">
              <Link className="underline underline-offset-2" to={`/pedir/${orgSlug}/${resultado.sucursal.slug}`}>
                {resultado.tipo === "solo_recoger" ? `Pedir para recoger en ${resultado.sucursal.name}` : `Pedir en ${resultado.sucursal.name}`}
              </Link>
              {resultado.tipo === "cercana" && " (confirme su colonia al pedir a domicilio)"}
            </p>
          )}
        </Callout>
      )}
    </section>
  );
}

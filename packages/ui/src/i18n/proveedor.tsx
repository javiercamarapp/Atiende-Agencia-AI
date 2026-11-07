import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { leerDisenoDs3 } from "../lib/diseno";
import { CLAVE_IDIOMA, IDIOMA_CAMBIO_EVENTO, guardarIdioma, leerIdioma, type Idioma } from "../lib/idioma";
import { cargarIdioma, idiomaListo, registrarModuloEs } from "./mensajes/index.ts";
import type { ModuloEs } from "./tipos.ts";
import { LOCALE_POR_IDIOMA } from "./tipos.ts";
import { crearTraductor, type Traductor } from "./traducir";

export interface ContextoI18n {
  readonly idioma: Idioma;
  /** BCP 47 del formato: "es-MX" / "en-US". */
  readonly locale: string;
  readonly t: Traductor;
  /** Cambia el idioma en caliente: guarda la preferencia, la anuncia a otros componentes (selector del sidebar) y la persiste. */
  readonly cambiarIdioma: (idioma: Idioma) => void;
}

function contextoPara(idioma: Idioma, cambiarIdioma: (i: Idioma) => void): ContextoI18n {
  return { idioma, locale: LOCALE_POR_IDIOMA[idioma], t: crearTraductor(idioma), cambiarIdioma };
}

// Sin proveedor (pruebas de componentes sueltos, catalogo) todo sale en espanol: el idioma por omision de la consola.
const I18nContext = createContext<ContextoI18n>(contextoPara("es", (i) => guardarIdioma(i)));

export interface IdiomaProviderProps {
  readonly children: ReactNode;
  /** Idioma fijo inicial (pruebas, SSR). Sin esto se resuelve `?lang=` -> localStorage -> "es" (ver lib/idioma). */
  readonly idiomaInicial?: Idioma;
  /**
   * Persistencia del lado del servidor (opcional). Hoy no existe una tabla de preferencias por persona, asi que la preferencia
   * vive en localStorage (`atiende-idioma`); cuando exista, la app pasa aqui la llamada al API. Un fallo no revierte el cambio.
   */
  readonly persistir?: (idioma: Idioma) => Promise<void> | void;
}

/**
 * Proveedor del idioma de la interfaz. Monta una vez en la raiz de la app. Escucha el evento de `guardarIdioma` (el selector
 * ES/EN del sidebar) y el `storage` de otras pestanas, asi que el cambio se ve en caliente en toda la consola. Mantiene
 * `<html lang>` sincronizado para lectores de pantalla y para el corrector del navegador.
 *
 * SOLO CON EL DISENO ds3: el selector ES/EN existe unicamente en ds3, asi que sin la bandera el idioma efectivo es siempre
 * espanol (una organizacion sin ds3 no cambia ni un byte, aunque llegue con `?lang=en` o con EN guardado de antes). La
 * bandera puede encenderse en caliente (`sincronizarDisenoOrganizacion`): se observa `<html>` y se re-evalua. `?lang=` vale
 * solo para esa carga; la preferencia se guarda unicamente con un clic explicito (`cambiarIdioma` / selector).
 */
export function IdiomaProvider({ children, idiomaInicial, persistir }: IdiomaProviderProps) {
  const [idioma, setIdioma] = useState<Idioma>(() => idiomaInicial ?? leerIdioma());
  const [, setCatalogosCargados] = useState(0);
  const [ds3, setDs3] = useState<boolean>(() => leerDisenoDs3());
  const pedido: Idioma = ds3 ? idioma : "es";
  // El ingles es un chunk aparte: mientras llega, la consola sigue en espanol (nunca claves crudas) y cambia de golpe al llegar.
  const efectivo: Idioma = idiomaListo(pedido) ? pedido : "es";

  useEffect(() => {
    if (typeof MutationObserver === "undefined") return undefined;
    const observador = new MutationObserver(() => setDs3(leerDisenoDs3()));
    observador.observe(document.documentElement, { attributes: true });
    return () => observador.disconnect();
  }, []);

  useEffect(() => {
    const idioma = pedido;
    if (idiomaListo(idioma)) return undefined;
    let vigente = true;
    cargarIdioma(idioma).then(
      () => {
        if (vigente) setCatalogosCargados((n) => n + 1);
      },
      () => {
        // Sin red: se queda en espanol; el siguiente cambio de idioma lo reintenta.
      },
    );
    return () => {
      vigente = false;
    };
  }, [pedido]);

  useEffect(() => {
    const alCambiar = (e: Event) => {
      const nuevo = (e as CustomEvent<unknown>).detail;
      if (nuevo === "es" || nuevo === "en") setIdioma(nuevo);
    };
    const alGuardarEnOtraPestana = (e: StorageEvent) => {
      if (e.key === CLAVE_IDIOMA && (e.newValue === "es" || e.newValue === "en")) setIdioma(e.newValue);
    };
    window.addEventListener(IDIOMA_CAMBIO_EVENTO, alCambiar);
    window.addEventListener("storage", alGuardarEnOtraPestana);
    return () => {
      window.removeEventListener(IDIOMA_CAMBIO_EVENTO, alCambiar);
      window.removeEventListener("storage", alGuardarEnOtraPestana);
    };
  }, []);

  useEffect(() => {
    if (typeof document !== "undefined") document.documentElement.lang = efectivo;
  }, [efectivo]);

  const cambiarIdioma = useCallback(
    (nuevo: Idioma) => {
      setIdioma(nuevo);
      guardarIdioma(nuevo);
      if (persistir) {
        Promise.resolve()
          .then(() => persistir(nuevo))
          .catch(() => {
            // La preferencia local ya quedo guardada; el servidor se reintenta en el siguiente cambio.
          });
      }
    },
    [persistir],
  );

  const valor = useMemo(() => contextoPara(efectivo, cambiarIdioma), [efectivo, cambiarIdioma]);
  return <I18nContext.Provider value={valor}>{children}</I18nContext.Provider>;
}

/**
 * Idioma, locale, `t` y `cambiarIdioma`. Recibe los modulos de area que usa el componente (`useI18n(nav, shell)`): su espanol se
 * registra aqui, en el render, y no al importar el archivo. Asi un componente que el bundle no usa (tree-shaking) no arrastra
 * su catalogo al chunk de arranque.
 */
export function useI18n(...modulos: readonly ModuloEs[]): ContextoI18n {
  for (const m of modulos) registrarModuloEs(m);
  return useContext(I18nContext);
}

/** Atajo cuando solo hace falta `t` (mismos modulos que `useI18n`). Para numeros, dinero y fechas: `useFormatos()`. */
export function useT(...modulos: readonly ModuloEs[]): Traductor {
  for (const m of modulos) registrarModuloEs(m);
  return useContext(I18nContext).t;
}

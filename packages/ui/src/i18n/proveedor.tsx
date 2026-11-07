import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { CLAVE_IDIOMA, IDIOMA_CAMBIO_EVENTO, guardarIdioma, leerIdioma, type Idioma } from "../lib/idioma";
import { cargarIdioma, idiomaListo } from "./mensajes/index.ts";
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
 */
export function IdiomaProvider({ children, idiomaInicial, persistir }: IdiomaProviderProps) {
  const [idioma, setIdioma] = useState<Idioma>(() => idiomaInicial ?? leerIdioma());
  const [, setCatalogosCargados] = useState(0);
  // El ingles es un chunk aparte: mientras llega, la consola sigue en espanol (nunca claves crudas) y cambia de golpe al llegar.
  const efectivo: Idioma = idiomaListo(idioma) ? idioma : "es";

  useEffect(() => {
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
  }, [idioma]);

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

/** Idioma, locale, `t` y `cambiarIdioma`. Para numeros, dinero y fechas: `useFormatos()`. */
export function useI18n(): ContextoI18n {
  return useContext(I18nContext);
}

/** Atajo cuando solo hace falta `t`. */
export function useT(): Traductor {
  return useContext(I18nContext).t;
}

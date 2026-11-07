// @vitest-environment jsdom
//
// i18n ES/EN: un enlace con `?lang=` (login en ingles) deja guardada la preferencia, asi que la consola sigue en ese idioma
// despues de redirigir sin el parametro.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { IdiomaProvider } from "../src/i18n/index";
import { CLAVE_IDIOMA } from "../src/lib/idioma";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("IdiomaProvider con ?lang=", () => {
  it("guarda el idioma de la URL", () => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/restaurantes/login?lang=en");
    const c = document.createElement("div");
    const root = createRoot(c);
    act(() => root.render(createElement(IdiomaProvider, null, null)));
    expect(window.localStorage.getItem(CLAVE_IDIOMA)).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    act(() => root.unmount());
  });
});

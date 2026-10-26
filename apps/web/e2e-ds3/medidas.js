/* global innerWidth, innerHeight, document, getComputedStyle, matchMedia, NodeFilter */
// Medidor de compacidad, objetivos tactiles, contraste y ritmo del diseno ds3. UN solo archivo: se lee como texto y se evalua igual en
// Playwright (`page.evaluate(texto)`) y en Claude in Chrome (`javascript_tool`). Es una expresion (IIFE) que devuelve
// { vp, tactil, defectos[], resumen{}, informativo{} }. No modifica el DOM. Umbrales: E01-E30 del protocolo de verificacion.
// Solo mide lo visible (cajas > 1x1 px: un enlace «saltar al contenido» recortado con .sr-only no cuenta) y fuera de `inert`. Los controles dentro de `[data-excepcion-alto]` (login 44, boton de Google) se exentan
// del chequeo de «boton gordo» y deben estar registrados en excepciones.json.
(() => {
  const vw = innerWidth;
  const vh = innerHeight;
  const tactil = matchMedia("(pointer:coarse)").matches || vw < 768;
  const out = { vp: [vw, vh], tactil, defectos: [], resumen: { conteos: {} }, informativo: {} };
  const LIMITE_POR_TIPO = 25; // ruido acotado: pasado el limite solo se cuenta (resumen.conteos)

  const nombre = (el) =>
    el
      ? el.tagName.toLowerCase() +
        (el.id ? "#" + el.id : "") +
        (el.getAttribute("data-testid") ? `[data-testid=${el.getAttribute("data-testid")}]` : "") +
        (el.getAttribute("aria-label") ? `[aria-label="${el.getAttribute("aria-label").slice(0, 30)}"]` : "") +
        " «" + (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 28) + "»"
      : "";
  const falla = (tipo, el, msg, dato) => {
    out.resumen.conteos[tipo] = (out.resumen.conteos[tipo] || 0) + 1;
    if (out.resumen.conteos[tipo] <= LIMITE_POR_TIPO) out.defectos.push({ tipo, el: nombre(el), msg, dato });
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none" && +s.opacity > 0.01;
  };
  const px = (v) => parseFloat(v) || 0;
  const cerca = (v, lista, tol = 0.6) => lista.some((x) => Math.abs(v - x) <= tol);

  // E01/K15 -- Scroll horizontal: documento, main y TODOS sus ancestros con overflow recortado; elementos que se salen del viewport.
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1) falla("scroll-h", de, "el documento desborda", [de.scrollWidth, de.clientWidth]);
  const mains = document.querySelectorAll("main");
  const main = document.querySelector("main#contenido-principal") || mains[0] || null;
  for (let n = main; n && n !== document.body; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 1 && !/auto|scroll/.test(getComputedStyle(n).overflowX)) {
      falla("scroll-h", n, "contenedor recortado en horizontal", [n.scrollWidth, n.clientWidth]);
    }
  }
  const dentroDeScrollX = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) if (/auto|scroll/.test(getComputedStyle(n).overflowX)) return true;
    return false;
  };
  document.querySelectorAll("body *").forEach((el) => {
    if (!visible(el)) return;
    const r = el.getBoundingClientRect();
    if ((r.right > vw + 1 || r.left < -1) && !dentroDeScrollX(el) && getComputedStyle(el).position !== "fixed") {
      falla("fuera-viewport", el, "se sale del viewport", [Math.round(r.left), Math.round(r.right)]);
    }
  });

  // E27 -- un <h1> y un <main> por pantalla.
  const h1s = [...document.querySelectorAll("h1")].filter((h) => h.getClientRects().length > 0 || h.closest(".sr-only"));
  if (h1s.length !== 1) falla("h1", h1s[0] || document.body, `hay ${h1s.length} <h1> (debe haber 1)`, h1s.length);
  if (mains.length !== 1) falla("main", mains[0] || document.body, `hay ${mains.length} <main> (debe haber 1)`, mains.length);

  // E02-E05, E07 -- Objetivos: tamano visual, «gordura» y prueba de area de toque (hit44, 5 puntos; acepta el ::after expandido).
  const SEL =
    'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=tab],[role=link],[role=menuitem],[role=switch],[role=checkbox],[role=radio],[role=option],[tabindex]:not([tabindex="-1"])';
  const hit44 = (el, r) => {
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = Math.max(r.width / 2, 22) - 1;
    const dy = Math.max(r.height / 2, 22) - 1;
    return [[0, 0], [-dx, 0], [dx, 0], [0, -dy], [0, dy]].every(([x, y]) => {
      const X = cx + x;
      const Y = cy + y;
      if (X < 0 || Y < 0 || X > vw || Y > vh) return true;
      const t = document.elementFromPoint(X, Y);
      return t && (t === el || el.contains(t) || t.closest(SEL) === el);
    });
  };
  const enLinea = (el) =>
    el.tagName === "A" && el.closest("p,li,dd,td") && [...el.parentElement.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  const alturasBoton = [];
  const alturasEscala = tactil ? [32, 36, 44] : [24, 28, 32, 36];
  const alturasFuera = new Set();
  document.querySelectorAll(SEL).forEach((el) => {
    if (!visible(el) || el.disabled || el.closest("[hidden],[inert]")) return;
    const r = el.getBoundingClientRect();
    if (enLinea(el)) return;
    const esBoton = el.tagName === "BUTTON" || el.getAttribute("role") === "button";
    const conTexto = esBoton && el.textContent.trim();
    const alto = Math.round(r.height);
    if (conTexto) {
      alturasBoton.push(alto);
      if (!cerca(alto, alturasEscala, 1)) alturasFuera.add(alto);
    }
    const exento = el.closest("[data-excepcion-alto]");
    if (Math.min(r.width, r.height) < 24 && !el.matches("input[type=checkbox],input[type=radio]")) {
      falla("target-24", el, "menor que 24 px (2.5.8)", [Math.round(r.width), alto]);
    } else if (tactil && !hit44(el, r)) {
      falla("target-44", el, "area de toque < 44x44", [Math.round(r.width), alto]);
    } else if (!tactil && conTexto && r.height > 40 && !exento) {
      falla("boton-gordo", el, "boton mas alto de 40 px", alto);
    } else if (tactil && conTexto && r.height > 52 && !exento) {
      falla("boton-gordo", el, "boton mas alto de 52 px", alto);
    }
    if (tactil && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) && px(getComputedStyle(el).fontSize) < 16) {
      falla("zoom-ios", el, "campo < 16 px dispara zoom en iOS", getComputedStyle(el).fontSize);
    }
  });
  out.resumen.alturasBoton = [...new Set(alturasBoton)].sort((a, b) => a - b);
  out.informativo.alturasBotonFueraDeEscala = [...alturasFuera].sort((a, b) => a - b);

  // E06 -- Tipografia minima (11 px solo en MAYUSCULAS con tracking >= .06em) y truncados en navegacion.
  let minFuente = 99;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t; (t = w.nextNode()); ) {
    if (!t.textContent.trim()) continue;
    const p = t.parentElement;
    if (!p || !visible(p) || p.closest("script,style,noscript,[aria-hidden=true],.sr-only")) continue;
    const s = getComputedStyle(p);
    const fs = px(s.fontSize);
    minFuente = Math.min(minFuente, fs);
    const tracking = s.letterSpacing === "normal" ? 0 : px(s.letterSpacing) / fs;
    const mayus = s.textTransform === "uppercase" && tracking >= 0.06;
    if (fs < 12 && !(mayus && fs >= 11)) falla("fuente-chica", p, `texto de ${fs}px`, fs);
  }
  out.resumen.minFuente = minFuente === 99 ? null : minFuente;
  document.querySelectorAll("nav a, nav button").forEach((el) => {
    const t = el.querySelector("span") || el;
    if (visible(el) && t.scrollWidth > t.clientWidth + 1 && getComputedStyle(t).textOverflow === "ellipsis") {
      falla("nav-truncada", el, "etiqueta de navegacion truncada");
    }
  });

  // E08/E09 -- Contraste calculado (compone alfa real; omite fondos con imagen/gradiente y deshabilitados -> informativo.sinMedir).
  const cv = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const rgba = (c) => {
    cv.clearRect(0, 0, 1, 1);
    cv.fillStyle = "#000";
    cv.fillStyle = c;
    cv.fillRect(0, 0, 1, 1);
    const d = cv.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const sobre = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3]));
  const lum = ([r, g, b]) => {
    const f = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };
  const fondo = (el) => {
    const capas = [];
    for (let n = el; n; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.backgroundImage !== "none") return null;
      const c = rgba(s.backgroundColor);
      if (c[3] > 0) capas.push(c);
      if (c[3] === 1) break;
    }
    let base = [255, 255, 255];
    for (let i = capas.length - 1; i >= 0; i--) base = sobre(capas[i], base);
    return base;
  };
  const pares = [];
  const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t; (t = w2.nextNode()); ) {
    if (!t.textContent.trim()) continue;
    const p = t.parentElement;
    if (!p || !visible(p) || p.closest("script,style,[aria-hidden=true],:disabled,[aria-disabled=true],.sr-only")) continue;
    const s = getComputedStyle(p);
    const f = rgba(s.color);
    const b = fondo(p);
    if (!b) {
      out.informativo.sinMedir = (out.informativo.sinMedir || 0) + 1;
      continue;
    }
    const fs = px(s.fontSize);
    const grande = fs >= 24 || (fs >= 18.66 && +s.fontWeight >= 700);
    const r = ratio(sobre(f, b), b);
    pares.push(r);
    if (r < (grande ? 3 : 4.5)) falla("contraste", p, `contraste ${r.toFixed(2)}:1`, +r.toFixed(2));
  }
  out.resumen.contrasteMin = pares.length ? +Math.min(...pares).toFixed(2) : null;
  document.querySelectorAll("input:not([type=checkbox]):not([type=radio]):not([type=hidden]),select,textarea").forEach((el) => {
    if (!visible(el)) return;
    const s = getComputedStyle(el);
    const b = fondo(el.parentElement);
    if (!b || px(s.borderTopWidth) < 1) return;
    const r = ratio(sobre(rgba(s.borderTopColor), b), b);
    if (r < 3) falla("contraste-borde-input", el, `borde de campo ${r.toFixed(2)}:1`, +r.toFixed(2));
  });

  // Safe-area: elementos fijos/sticky pegados al borde (el inset real lo inyecta Playwright por CDP; aqui solo se listan).
  out.informativo.fijosAlBorde = [...document.querySelectorAll("body *")]
    .filter((el) => {
      if (!/fixed|sticky/.test(getComputedStyle(el).position) || !visible(el)) return false;
      const r = el.getBoundingClientRect();
      return r.bottom >= vh - 1 || r.top <= 1;
    })
    .map((el) => ({ el: nombre(el), padB: getComputedStyle(el).paddingBottom, padT: getComputedStyle(el).paddingTop }));
  const meta = document.querySelector("meta[name=viewport]");
  out.informativo.viewportFitCover = /viewport-fit=cover/.test((meta && meta.content) || "");

  // E11 -- Radios usados: {0, 4, 8, 12, 16, completo, 50%}. Se mira el radio de la esquina superior izquierda de lo visible en <body>.
  const RADIOS = [0, 4, 8, 12, 16];
  const radiosVistos = {};
  document.querySelectorAll("body *").forEach((el) => {
    if (!visible(el) || el.closest("svg")) return;
    const s = getComputedStyle(el);
    const rr = s.borderTopLeftRadius;
    if (rr === "0px") return;
    if (rr.includes("%")) {
      if (px(rr) !== 50) falla("radio", el, `radio ${rr} (solo 50%)`, rr);
      return;
    }
    const v = px(rr);
    const r = el.getBoundingClientRect();
    if (v >= 999 || v >= Math.min(r.width, r.height) / 2) return; // pastilla/circulo
    radiosVistos[rr] = (radiosVistos[rr] || 0) + 1;
    if (!cerca(v, RADIOS, 0.05)) falla("radio", el, `radio ${rr} fuera de {4,8,12,16,999,50%}`, rr);
  });
  out.informativo.radios = radiosVistos;

  // E12/E13/E14/E15 -- Ritmo dentro de <main>: padding de superficies, gaps, huecos entre bloques y filas de tabla.
  const gapsPermitidos = [0, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32, 40, 48];
  const superficies = {};
  const gapsBloque = {};
  const cuerpo = main || document.body;
  cuerpo.querySelectorAll("*").forEach((el) => {
    if (!visible(el)) return;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (px(s.borderTopWidth) >= 1 && px(s.borderTopLeftRadius) >= 8 && el.children.length && r.width >= 120 && r.height >= 48) {
      const pt = px(s.paddingTop);
      const pl = px(s.paddingLeft);
      superficies[`${s.paddingTop}/${s.paddingLeft}/r${s.borderTopLeftRadius}`] = (superficies[`${s.paddingTop}/${s.paddingLeft}/r${s.borderTopLeftRadius}`] || 0) + 1;
      const conRelleno = pt > 0 || pl > 0; // tarjetas con subpartes (cabecera/contenido) llevan 0 y no se juzgan aqui
      if (conRelleno && !(cerca(pt, [12, 14, 16], 0.05) && cerca(pl, [12, 14, 16], 0.05))) {
        falla("padding-superficie", el, `padding ${s.paddingTop} ${s.paddingLeft} fuera de {12,14,16}`, [pt, pl]);
      }
    }
    for (const g of [s.rowGap, s.columnGap]) {
      const v = px(g);
      if (g !== "normal" && !gapsPermitidos.includes(Math.round(v))) falla("gap-fuera-de-escala", el, `gap ${g}`, g);
    }
    // Gap entre BLOQUES de pagina: contenedor flex/grid vertical cuyos hijos visibles son bloques altos y anchos.
    if (/flex|grid/.test(s.display) && (s.display.includes("grid") || s.flexDirection === "column") && s.rowGap !== "normal") {
      const hijos = [...el.children].filter(visible);
      const bloques = hijos.filter((h) => {
        const hr = h.getBoundingClientRect();
        return hr.height >= 56 && hr.width >= r.width * 0.25;
      });
      if (bloques.length >= 2 && bloques.length === hijos.length) {
        const v = px(s.rowGap);
        gapsBloque[s.rowGap] = (gapsBloque[s.rowGap] || 0) + 1;
        if (!cerca(v, [8, 12, 16, 24], 0.05)) falla("gap-bloque", el, `gap entre bloques ${s.rowGap} fuera de {8,12,16,24}`, s.rowGap);
      }
    }
  });
  out.informativo.superficies = superficies;
  out.informativo.gapsBloque = gapsBloque;
  const hijos = main
    ? [...main.querySelectorAll(":scope > * > *, :scope > *")].filter(visible).map((e) => e.getBoundingClientRect()).sort((a, b) => a.top - b.top)
    : [];
  const huecos = [];
  for (let i = 1; i < hijos.length; i++) {
    const g = Math.round(hijos[i].top - hijos[i - 1].bottom);
    if (g > 48) huecos.push(g);
  }
  out.informativo.huecosMayoresA48 = huecos;

  // E15 -- Filas de tabla (solo display:table-row; en tarjeta-fila movil no aplica): 40 (36 densa) +-1; cabecera 32 (informativo).
  const filas = new Set();
  const cabeceras = new Set();
  cuerpo.querySelectorAll("tbody tr").forEach((tr) => {
    if (!visible(tr) || getComputedStyle(tr).display !== "table-row") return;
    const h = Math.round(tr.getBoundingClientRect().height);
    filas.add(h);
    if (!cerca(h, [40, 36], 1) && tr.querySelectorAll("td").length <= 12 && !tr.querySelector("table,[colspan]")) falla("fila-tabla", tr, `fila de ${h} px (40, o 36 densa)`, h);
  });
  cuerpo.querySelectorAll("thead th").forEach((th) => {
    if (visible(th) && getComputedStyle(th).display === "table-cell") cabeceras.add(Math.round(th.getBoundingClientRect().height));
  });
  out.informativo.alturasFila = [...filas].sort((a, b) => a - b);
  out.informativo.alturasTh = [...cabeceras].sort((a, b) => a - b);

  // E17 -- Tupla de la pantalla para comparar consolas: h1, padding de pagina, tarjeta, alto md, alto de fila/th, ancho de sidebar.
  const h1 = h1s[0];
  const h1s_ = h1 ? getComputedStyle(h1) : null;
  const aside = document.querySelector('aside[aria-label="Navegación principal"]') || document.querySelector("aside");
  const sup = Object.entries(superficies).sort((a, b) => b[1] - a[1])[0];
  const alturasOrden = [...new Set(alturasBoton)];
  const frecuentes = {};
  alturasBoton.forEach((a) => (frecuentes[a] = (frecuentes[a] || 0) + 1));
  const altoMd = Object.entries(frecuentes).sort((a, b) => b[1] - a[1])[0];
  out.informativo.tupla = {
    h1: h1s_ ? [h1s_.fontSize, h1s_.fontWeight] : null,
    paddingPagina: main ? [getComputedStyle(main).paddingTop, getComputedStyle(main).paddingLeft] : null,
    tarjeta: sup ? sup[0] : null,
    altoBotonFrecuente: altoMd ? +altoMd[0] : null,
    altosBoton: alturasOrden.length,
    altoFila: [...filas][0] || null,
    altoTh: [...cabeceras][0] || null,
    anchoSidebar: aside ? Math.round(aside.getBoundingClientRect().width) : null,
  };
  return out;
})()

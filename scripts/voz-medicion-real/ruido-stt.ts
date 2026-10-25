// Ruido de STT para el arnes de voz por TEXTO: lo que el cliente "dice" se degrada como lo haria un reconocedor de voz telefonico (Deepgram es-419),
// para que el agente no reciba texto escrito limpio. Puro y determinista (semilla): el mismo texto y la misma semilla dan siempre el mismo resultado.
//
// Que imita (calibrado a lo medido en la ronda de cascada con audio real: WER 4-6 % en linea limpia, ~10 % con ruido de cocina):
//  * numeros hablados que el STT entrega como cifras ("trescientos cuarenta y cinco" -> "345"; "veinte y veintidos" -> "20 y 22");
//  * confusiones fonéticas de nombres propios, platillos y colonias del menu ("Ana Prueba" -> "A la prueba");
//  * muletillas y titubeos ("eh", "este", "mmm"), palabras repetidas y alguna palabra comida;
//  * puntuacion irregular (sin signos de apertura, comas a medias).
// Lo que NO imita: audio, endpointing partido, finales perdidos, eco ni barge-in real. Eso solo se mide con una llamada.

export type Rng = () => number;

/** mulberry32 sembrado con un hash de texto. */
export function rngDesdeSemilla(semilla: string): Rng {
  let h = 1779033703 ^ semilla.length;
  for (let i = 0; i < semilla.length; i += 1) {
    h = Math.imul(h ^ semilla.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UNIDADES: Record<string, number> = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintiun: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25,
  veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
};
const DECENAS: Record<string, number> = { treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };
const CENTENAS: Record<string, number> = { cien: 100, ciento: 100, doscientos: 200, trescientos: 300, cuatrocientos: 400, quinientos: 500, seiscientos: 600, setecientos: 700, ochocientos: 800, novecientos: 900 };

const sinTildes = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const esNumeral = (p: string): boolean => {
  const k = sinTildes(p);
  return k in UNIDADES || k in DECENAS || k in CENTENAS || k === "mil" || k === "y";
};

/** Convierte una corrida de palabras numericas ("trescientos cuarenta y cinco") a su valor; null si no es una cifra bien formada. */
export function palabrasANumero(palabras: readonly string[]): number | null {
  let total = 0;
  let actual = 0;
  let visto = false;
  for (const p of palabras) {
    const k = sinTildes(p);
    if (k === "y") continue;
    visto = true;
    if (k in UNIDADES) actual += UNIDADES[k]!;
    else if (k in DECENAS) actual += DECENAS[k]!;
    else if (k in CENTENAS) actual += CENTENAS[k]!;
    else if (k === "mil") { total += (actual === 0 ? 1 : actual) * 1000; actual = 0; } else return null;
  }
  return visto ? total + actual : null;
}

/** Cada corrida de palabras-numero pasa a cifra con probabilidad `p` (Deepgram con formato inteligente escribe cifras; a veces las deja en letra). Un "una"/"un" suelto no se toca. */
export function numerosACifras(texto: string, rng: Rng, p: number): string {
  const tokens = texto.split(/(\s+)/);
  const salida: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    const limpio = t.replace(/[.,;:!?¿¡]+$/g, "");
    if (t.trim() !== "" && esNumeral(limpio) && sinTildes(limpio) !== "y") {
      let j = i;
      const corrida: string[] = [];
      let puntuacionFinal = "";
      while (j < tokens.length) {
        const u = tokens[j]!;
        if (u.trim() === "") { j += 1; continue; }
        const l = u.replace(/[.,;:!?¿¡]+$/g, "");
        if (!esNumeral(l)) break;
        // "veinte y veintidos" son DOS cifras (calle 20 por 22); "treinta y cinco" es una sola. Una "y" solo une decena + unidad.
        if (sinTildes(l) === "y") {
          const prev = sinTildes(corrida[corrida.length - 1] ?? "");
          const sig = sinTildes((tokens.slice(j + 1).find((x) => x.trim() !== "") ?? "").replace(/[.,;:!?¿¡]+$/g, ""));
          if (!(prev in DECENAS && sig in UNIDADES && UNIDADES[sig]! < 10)) break;
        }
        corrida.push(l);
        puntuacionFinal = u.slice(l.length);
        j += 1;
        if (puntuacionFinal !== "") break;
      }
      const valor = palabrasANumero(corrida);
      const soloUno = corrida.length === 1 && ["un", "uno", "una"].includes(sinTildes(corrida[0]!));
      if (valor !== null && !soloUno && rng() < p) {
        salida.push(String(valor) + puntuacionFinal);
      } else {
        for (let k = i; k < j; k += 1) salida.push(tokens[k]!);
      }
      i = j;
      continue;
    }
    salida.push(t);
    i += 1;
  }
  return salida.join("");
}

interface Confusion {
  readonly re: RegExp;
  readonly alternativas: readonly string[];
}

/** Confusiones plausibles de un STT telefonico en es-419 sobre el vocabulario del restaurante. Probabilidad por coincidencia: `PROB_CONFUSION`. */
export const CONFUSIONES: readonly Confusion[] = [
  { re: /\bAna Prueba\b/g, alternativas: ["A la prueba", "Haga prueba", "Ana Prueva", "Anaprueba"] },
  { re: /\bAna Pech\b/g, alternativas: ["Ana Pe", "Ana Pesh", "A la Pech"] },
  { re: /\bCarlos Prueba\b/g, alternativas: ["Carlos Prueva", "Carlo Sprueba"] },
  { re: /\bgarc[ií]a lav[ií]n\b/gi, alternativas: ["García La Vin", "Garcilavín", "García Labín"] },
  { re: /\bvictory platz\b/gi, alternativas: ["Victoria Plaza", "Víctor Platz"] },
  { re: /\bpastor\b/gi, alternativas: ["pasto", "al pastor", "pastor"] },
  { re: /\bbistec\b/gi, alternativas: ["bisté", "vistec", "bistek"] },
  { re: /\bgringas?\b/gi, alternativas: ["cringas", "gringa", "grin gas"] },
  { re: /\balambre\b/gi, alternativas: ["al ambre", "alambre", "en alambre"] },
  { re: /\bhorchata\b/gi, alternativas: ["orchata", "horchata", "o chata"] },
  { re: /\bheineken\b/gi, alternativas: ["Jainiken", "Hainecen", "Heiniken"] },
  { re: /\bcoca[- ]?cola\b/gi, alternativas: ["coca", "Coca-Cola", "coca cola"] },
  { re: /\bnachos?\b/gi, alternativas: ["nacho", "nachos"] },
  { re: /\bmestizas?\b/gi, alternativas: ["mestiza", "mes tizas"] },
  { re: /\bkilos?\b/gi, alternativas: ["kilo", "quilo"] },
  { re: /\bcuatro\b/gi, alternativas: ["cuarto"] },
  { re: /\bseis\b/gi, alternativas: ["seis", "sé"] },
  { re: /\brecoger\b/gi, alternativas: ["recoger", "recorrer"] },
  { re: /\bdomicilio\b/gi, alternativas: ["domicilio", "a domicilio"] },
];

const MULETILLAS = ["eh", "este", "mmm", "o sea", "pues", "eh, bueno"] as const;
/** Palabras que NO se pueden comer sin cambiar el sentido. */
const PROTEGIDAS = /^(no|sí|si|ni|nada|sin|con|mejor|cancela|cancelar|cuatro|tres|seis|dos|uno|una|cinco|diez|doce|\d+)$/i;

export interface OpcionesRuido {
  /** Probabilidad por corrida numerica de pasar a cifras (por omision 0.6). */
  readonly pCifras?: number;
  /** Probabilidad por coincidencia de la tabla de confusiones (por omision 0.12). */
  readonly pConfusion?: number;
  /** Probabilidad de anteponer o intercalar una muletilla (por omision 0.2). */
  readonly pMuletilla?: number;
  /** Probabilidad por palabra de repetirla (titubeo; por omision 0.025). */
  readonly pRepeticion?: number;
  /** Probabilidad por palabra de que el STT se la coma (por omision 0.015). */
  readonly pOmision?: number;
  /** 0 apaga todo el ruido (cliente limpio, de control). */
  readonly nivel?: number;
}

export interface ResultadoRuido {
  readonly texto: string;
  readonly cambios: readonly string[];
}

/** Aplica el ruido de STT a lo que dijo el cliente. `nivel` escala todas las probabilidades (0 = sin ruido, 1 = el calibrado, 2 = linea mala). */
export function ruidoStt(textoOriginal: string, rng: Rng, o: OpcionesRuido = {}): ResultadoRuido {
  const nivel = o.nivel ?? 1;
  if (nivel <= 0) return { texto: textoOriginal, cambios: [] };
  const esc = (p: number) => Math.min(0.95, p * nivel);
  const cambios: string[] = [];
  let t = textoOriginal.replace(/[¿¡]/g, "");
  // 1. confusiones foneticas
  for (const c of CONFUSIONES) {
    t = t.replace(c.re, (m) => {
      if (rng() >= esc(o.pConfusion ?? 0.12)) return m;
      const alt = c.alternativas[Math.floor(rng() * c.alternativas.length)]!;
      if (alt.toLowerCase() === m.toLowerCase()) return m;
      cambios.push(`${m}->${alt}`);
      return alt;
    });
  }
  // 2. cifras
  const antes = t;
  t = numerosACifras(t, rng, Math.min(1, esc(o.pCifras ?? 0.6)));
  if (t !== antes) cambios.push("numeros->cifras");
  // 3. repeticiones y omisiones por palabra
  const palabras = t.split(/\s+/).filter((w) => w !== "");
  const out: string[] = [];
  for (const w of palabras) {
    const protegida = PROTEGIDAS.test(w.replace(/[.,;:!?]+$/g, ""));
    if (!protegida && w.length > 3 && rng() < esc(o.pOmision ?? 0.015)) { cambios.push(`omite:${w}`); continue; }
    out.push(w);
    if (!protegida && w.length > 2 && !/[.,;:!?]$/.test(w) && rng() < esc(o.pRepeticion ?? 0.025)) { out.push(w); cambios.push(`repite:${w}`); }
  }
  t = out.join(" ");
  // 4. muletilla
  if (rng() < esc(o.pMuletilla ?? 0.2)) {
    const m = MULETILLAS[Math.floor(rng() * MULETILLAS.length)]!;
    const ws = t.split(" ");
    const pos = ws.length > 4 && rng() < 0.4 ? 1 + Math.floor(rng() * (ws.length - 2)) : 0;
    ws.splice(pos, 0, pos === 0 ? `${m},` : `${m},`);
    t = ws.join(" ");
    cambios.push(`muletilla:${m}`);
  }
  // 5. puntuacion irregular
  t = t.replace(/,/g, (c) => (rng() < 0.4 ? "" : c));
  return { texto: t.replace(/\s+/g, " ").trim(), cambios };
}

/** Interrupcion: el cliente es cortado a media frase (el STT entrega solo lo dicho hasta ahi). Conserva entre 35 % y 65 % de las palabras y termina con puntos suspensivos. */
export function cortarMensaje(texto: string, rng: Rng): string {
  const ws = texto.split(/\s+/).filter((w) => w !== "");
  if (ws.length < 4) return texto;
  const n = Math.max(2, Math.floor(ws.length * (0.35 + rng() * 0.3)));
  return `${ws.slice(0, n).join(" ").replace(/[.,;:!?]+$/g, "")}...`;
}

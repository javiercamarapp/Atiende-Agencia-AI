// Detector de textos visibles en espanol escritos a mano (i18n ES/EN). Parsea con el compilador de TypeScript (no regex) y
// cuenta, por archivo, los literales que una persona LEE en pantalla:
//   - texto JSX con letras (`<p>Hola</p>`);
//   - un literal dentro de `{...}` hijo directo de JSX (`<p>{"Hola"}</p>`) o en una rama `cond ? "A" : "B"` de ese hijo;
//   - el valor de un atributo JSX o de una propiedad de objeto con nombre de texto visible (title, label, placeholder,
//     aria-label, mensaje, etiqueta, descripcion...);
//   - cualquier otro literal con letras del espanol (acentos, ñ, ¿, ¡) — rutas, claves y clases casi nunca las llevan.
// NO cuenta: los argumentos de `t()`/`traducir()`, `import`/`export`, `console.*`, claves de objetos, ni una linea marcada con
// `// i18n-ignorar` (para datos fijos que no son interfaz, p. ej. un ejemplo de mensaje que el agente envia por WhatsApp).
import ts from "typescript";

export const ATRIBUTOS_VISIBLES: ReadonlySet<string> = new Set([
  "title",
  "label",
  "placeholder",
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "alt",
  "titulo",
  "subtitulo",
  "etiqueta",
  "mensaje",
  "descripcion",
  "texto",
  "ayuda",
  "eyebrow",
  "tooltip",
  "rolEtiqueta",
  "textoBoton",
  "textoAccion",
  "confirmLabel",
  "cancelLabel",
  "description",
  "emptyMessage",
  "loadingMessage",
]);

/** Nombres compuestos que tambien son texto visible: `volverEtiqueta`, `confirmLabel`, `tituloVacio`, `mensajeError`... */
const SUFIJO_VISIBLE = /(label|labels|etiqueta|etiquetas|titulo|titulos|title|mensaje|mensajes|texto|textos|placeholder|descripcion|subtitulo|ayuda|tooltip|rotulo)$|^(label|etiqueta|titulo|title|mensaje|texto|placeholder|descripcion)[A-Z]/i;

export function nombreVisible(nombre: string): boolean {
  return ATRIBUTOS_VISIBLES.has(nombre) || SUFIJO_VISIBLE.test(nombre);
}

const ESPANOL = /[áéíóúñÁÉÍÓÚÑ¿¡]/;
const LETRAS = /\p{L}{2,}/u;
/** Una clave del catalogo (`nav.resumen`, `shell.tema.claro`): es un identificador, no texto. */
/** Nombre de la marca: se escribe igual en los dos idiomas. */
const MARCA = new Set(["atiende", "Atiende"]);
/** Lista de clases utilitarias (`group-[.toast]:text-sm mt-0.5`): cada token lleva `-`, `:`, `[` o `/` y no hay mayusculas ni acentos. */
export function esListaDeClases(texto: string): boolean {
  const tokens = texto.trim().split(/\s+/);
  return !/[A-ZÁÉÍÓÚÑáéíóúñ¿¡]/.test(texto) && tokens.length > 0 && tokens.every((t) => /[-:[\]/]/.test(t));
}
const CLAVE_CATALOGO = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;
const FUNCIONES_TRADUCCION = new Set(["t", "traducir"]);

export interface Hallazgo {
  readonly linea: number;
  readonly texto: string;
}

function nombreDe(n: ts.PropertyName | ts.JsxAttributeName): string | null {
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
  if (ts.isJsxNamespacedName(n)) return `${n.namespace.text}:${n.name.text}`;
  return null;
}

function esArgumentoDeTraduccion(n: ts.Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isCallExpression(p)) {
      const f = p.expression;
      const nombre = ts.isIdentifier(f) ? f.text : ts.isPropertyAccessExpression(f) ? f.name.text : "";
      if (FUNCIONES_TRADUCCION.has(nombre)) return true;
      if (ts.isPropertyAccessExpression(f) && ts.isIdentifier(f.expression) && f.expression.text === "console") return true;
      return false;
    }
    if (ts.isBlock(p) || ts.isSourceFile(p)) return false;
  }
  return false;
}

/** Sube por `?:`, `||`, `??` y parentesis hasta el nodo que da contexto al literal. */
function contexto(n: ts.Node): ts.Node {
  let p = n.parent;
  while (p && (ts.isConditionalExpression(p) || ts.isParenthesizedExpression(p) || (ts.isBinaryExpression(p) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.PlusToken].includes(p.operatorToken.kind)))) {
    p = p.parent;
  }
  return p;
}

function esVisible(lit: ts.Node): boolean {
  const c = contexto(lit);
  if (!c) return false;
  if (ts.isJsxExpression(c)) {
    const padre = c.parent;
    if (ts.isJsxElement(padre) || ts.isJsxFragment(padre)) return true;
    if (ts.isJsxAttribute(padre)) return nombreVisible(nombreDe(padre.name) ?? "");
  }
  if (ts.isJsxAttribute(c)) return nombreVisible(nombreDe(c.name) ?? "");
  if (ts.isPropertyAssignment(c)) return nombreVisible(nombreDe(c.name) ?? "");
  // Valor por omision de una prop o parametro: `({ volverEtiqueta = "Volver al panel" })`.
  if ((ts.isBindingElement(c) || ts.isParameter(c) || ts.isVariableDeclaration(c)) && ts.isIdentifier(c.name)) return nombreVisible(c.name.text);
  // Arreglo de textos con nombre visible: `const etiquetas = ["Lunes", "Martes"]`.
  if (ts.isArrayLiteralExpression(c) && c.parent && ts.isVariableDeclaration(c.parent) && ts.isIdentifier(c.parent.name)) return nombreVisible(c.parent.name.text);
  return false;
}

function textoDeLiteral(n: ts.Node): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(" ");
  return null;
}

function lineasIgnoradas(codigo: string): Set<number> {
  const s = new Set<number>();
  codigo.split("\n").forEach((l, i) => {
    // Solo un comentario `// i18n-ignorar` (al final de la linea o en la linea anterior); nunca dentro de un literal.
    if (/\/\/\s*i18n-ignorar\b/.test(l) && !/["'`][^"'`]*\/\/\s*i18n-ignorar/.test(l)) {
      s.add(i + 1);
      s.add(i + 2);
    }
  });
  return s;
}

export function detectar(codigo: string, nombre = "archivo.tsx"): Hallazgo[] {
  const fuente = ts.createSourceFile(nombre, codigo, ts.ScriptTarget.Latest, true, nombre.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const ignoradas = lineasIgnoradas(codigo);
  const hallazgos: Hallazgo[] = [];
  const anotar = (n: ts.Node, texto: string) => {
    const linea = fuente.getLineAndCharacterOfPosition(n.getStart(fuente)).line + 1;
    if (!ignoradas.has(linea)) hallazgos.push({ linea, texto: texto.trim().replace(/\s+/g, " ").slice(0, 80) });
  };
  const visitar = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isTypeNode(n)) return;
    if (ts.isJsxText(n)) {
      if (LETRAS.test(n.text) && !MARCA.has(n.text.trim())) anotar(n, n.text);
      return;
    }
    const texto = textoDeLiteral(n);
    if (texto !== null) {
      // Clave de objeto (`{ "Hola": 1 }`) o indice: no es texto mostrado.
      if (n.parent && ts.isPropertyAssignment(n.parent) && n.parent.name === n) return;
      if (n.parent && (ts.isElementAccessExpression(n.parent) || ts.isLiteralTypeNode(n.parent))) return;
      if (LETRAS.test(texto) && !CLAVE_CATALOGO.test(texto) && !MARCA.has(texto.trim()) && !esListaDeClases(texto) && !esArgumentoDeTraduccion(n) && (esVisible(n) || ESPANOL.test(texto))) anotar(n, texto);
      if (!ts.isTemplateExpression(n)) return;
    }
    ts.forEachChild(n, visitar);
  };
  visitar(fuente);
  return hallazgos;
}

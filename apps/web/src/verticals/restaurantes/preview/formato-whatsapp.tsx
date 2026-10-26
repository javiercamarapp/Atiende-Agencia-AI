// Formato de texto como en WhatsApp para las burbujas: *negrita*, _cursiva_, ~tachado~, `código`, enlaces http(s) y listas con «- » / «* » / «• ».
// Todo se construye con elementos de React (nunca HTML en crudo): el texto del agente no puede inyectar marcado.
import type { ReactNode } from "react";

const TOKEN = /(https?:\/\/[^\s<]*[^\s<.,;:!?)\]])|\*([^*\n]+)\*|_([^_\n]+)_|~([^~\n]+)~|`([^`\n]+)`/g;
const VINETA = /^\s*[-*•]\s+(.*)$/;

export function enLinea(texto: string, clave: string): ReactNode[] {
  const salida: ReactNode[] = [];
  let ultimo = 0;
  let n = 0;
  for (const m of texto.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > ultimo) salida.push(texto.slice(ultimo, i));
    const k = `${clave}-${n++}`;
    if (m[1]) {
      salida.push(
        <a key={k} href={m[1]} target="_blank" rel="noopener noreferrer nofollow" className="wa-enlace">
          {m[1]}
        </a>,
      );
    } else if (m[2]) salida.push(<strong key={k}>{m[2]}</strong>);
    else if (m[3]) salida.push(<em key={k}>{m[3]}</em>);
    else if (m[4]) salida.push(<s key={k}>{m[4]}</s>);
    else if (m[5]) salida.push(<code key={k} className="wa-codigo">{m[5]}</code>);
    ultimo = i + m[0].length;
  }
  if (ultimo < texto.length) salida.push(texto.slice(ultimo));
  return salida;
}

/** `fin` (hora y palomitas) se pega al final de la última línea, como en WhatsApp. */
export function FormatoWhatsApp({ texto, fin }: { readonly texto: string; readonly fin?: ReactNode }) {
  const lineas = texto.replace(/\r\n?/g, "\n").split("\n");
  return (
    <>
      {lineas.map((linea, i) => {
        const ultima = i === lineas.length - 1;
        const v = VINETA.exec(linea);
        return v ? (
          <span key={i} className="wa-linea wa-linea--vineta">
            <span aria-hidden="true" className="wa-vineta">
              •
            </span>
            <span>
              {enLinea(v[1] ?? "", `l${i}`)}
              {ultima ? fin : null}
            </span>
          </span>
        ) : (
          <span key={i} className="wa-linea">
            {linea === "" && !ultima ? " " : enLinea(linea, `l${i}`)}
            {ultima ? fin : null}
          </span>
        );
      })}
    </>
  );
}

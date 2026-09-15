// Marco visual compartido de los correos transaccionales de licitaciones —
// DUPLICADO deliberado (no compartido vía un paquete común) de
// @atiende/domain-rentas::emails/layout.ts (a su vez duplicado de
// @atiende/domain-citas::emails/layout.ts), mismo criterio de aislamiento por
// paquete que el resto de este monorepo. Sin cambios de paleta ni de
// wordmark — sigue siendo la marca "atiende" (un solo software/frontend para
// todos los verticales, nunca el nombre de un cliente ni de un vertical
// concreto en el remitente).
//
// escapeHtml se EXPORTA (nunca privada) porque este vertical interpola datos
// dinámicos de negocio reales (título de convocatoria, concepto de factura)
// que llegan tal cual los tecleó alguien en el panel de staff — nunca
// confiables sin escapar.

const FUENTE = `Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`;
const FUENTE_TITULO = `'Inter Tight',Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`;
const LOGO_DATA_URI = "data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PSIwIDAgMjIwIDQwIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPgogIDxnPgogICAgPHJlY3QgeD0iMCIgeT0iMTAiIHdpZHRoPSIxMyIgaGVpZ2h0PSI0IiByeD0iMiIgZmlsbD0iIzdERDNGQyIgLz4KICAgIDxyZWN0IHg9IjQiIHk9IjE4IiB3aWR0aD0iMTMiIGhlaWdodD0iNCIgcng9IjIiIGZpbGw9IiM3REQzRkMiIC8+CiAgICA8cmVjdCB4PSIwIiB5PSIyNiIgd2lkdGg9IjEzIiBoZWlnaHQ9IjQiIHJ4PSIyIiBmaWxsPSIjN0REM0ZDIiAvPgogICAgPGNpcmNsZSBjeD0iMjYiIGN5PSIxMiIgcj0iNSIgZmlsbD0iIzM4QkRGOCIgLz4KICAgIDxwYXRoCiAgICAgIGQ9Ik0xNCAzOCBMMjAgMjYgUTIyIDIyIDI3IDIyIEwzMSAyMiBRMzQgMjIgMzYgMTkgTDM4IDE2IgogICAgICBzdHJva2U9IiMxRDRFRDgiCiAgICAgIHN0cm9rZS13aWR0aD0iNyIKICAgICAgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIgogICAgICBzdHJva2UtbGluZWpvaW49InJvdW5kIgogICAgICBmaWxsPSJub25lIgogICAgLz4KICA8L2c+CiAgPHRleHQgeD0iNTIiIHk9IjMwIiBmb250LWZhbWlseT0iQXJpYWwsIEhlbHZldGljYSwgc2Fucy1zZXJpZiIgZm9udC1zaXplPSIyNiIgZm9udC13ZWlnaHQ9IjcwMCIgZmlsbD0iIzFENEVEOCIgbGV0dGVyLXNwYWNpbmc9Ii0wLjUiPmF0aWVuZGU8L3RleHQ+Cjwvc3ZnPgo=";

export function escapeHtml(t: string): string {
  return t
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface EtiquetaPlantilla {
  readonly texto: string;
  readonly color: string; // color del punto + texto de la etiqueta superior
}

export interface FilaPlantilla {
  readonly etiqueta: string;
  readonly valor: string; // texto plano — renderCorreo lo escapa, nunca pasar HTML aquí
}

export interface SeccionPlantilla {
  readonly titulo: string;
  readonly preheader: string; // texto de avance oculto, bajo el asunto en la bandeja
  readonly etiqueta?: EtiquetaPlantilla;
  readonly parrafosHtml: readonly string[]; // ya escapados/con <strong> si aplica — ver escapeHtml
  readonly tabla?: { readonly filas: readonly FilaPlantilla[] };
  readonly nota?: string; // ya escapado si trae dato dinámico
  readonly piePorQueLlego: string;
}

export function renderCorreo(s: SeccionPlantilla): string {
  const colorEtiqueta = s.etiqueta?.color ?? "#1D4ED8";
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escapeHtml(s.titulo)} — atiende</title>
</head>
<body style="margin:0;padding:0;background-color:#f7f9fc;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">${escapeHtml(s.preheader)}${"&nbsp;&zwnj;".repeat(40)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f7f9fc;">
  <tr><td align="center" style="padding:44px 16px 36px 16px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:100%;border-collapse:collapse;">

      <tr><td align="left" style="padding:0 0 26px 2px;">
        <img src="${LOGO_DATA_URI}" width="96" height="17" alt="atiende" style="display:block;border:0;outline:none;text-decoration:none;">
      </td></tr>

      <tr><td bgcolor="#ffffff" style="padding:42px 44px 38px 44px;border:1px solid #e2e8f0;border-radius:16px;">
        ${
          s.etiqueta
            ? `<p style="margin:0 0 14px 0;font-family:${FUENTE};font-size:10px;line-height:14px;font-weight:600;letter-spacing:0.11em;text-transform:uppercase;color:${colorEtiqueta};"><span style="color:${colorEtiqueta};">&#9679;</span>&nbsp;&nbsp;${escapeHtml(s.etiqueta.texto)}</p>`
            : ""
        }
        <h1 style="margin:0 0 18px 0;font-family:${FUENTE_TITULO};font-size:26px;line-height:34px;font-weight:600;letter-spacing:-0.02em;color:#0f1b2d;">${escapeHtml(s.titulo)}</h1>
        ${s.parrafosHtml.map((p) => `<p style="margin:0 0 16px 0;font-family:${FUENTE};font-size:15px;line-height:24px;color:#5b6b82;">${p}</p>`).join("\n        ")}

        ${
          s.tabla
            ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:14px 0 4px 0;border-collapse:collapse;">
          ${s.tabla.filas
            .map(
              (f) =>
                `<tr><td style="padding:11px 0;border-top:1px solid #e2e8f0;font-family:${FUENTE};font-size:10.5px;line-height:16px;font-weight:600;letter-spacing:0.09em;text-transform:uppercase;color:#5b6b82;">${escapeHtml(f.etiqueta)}</td><td align="right" style="padding:11px 0;border-top:1px solid #e2e8f0;font-family:${FUENTE};font-size:14px;line-height:20px;color:#0f1b2d;font-weight:600;">${escapeHtml(f.valor)}</td></tr>`,
            )
            .join("\n          ")}
          <tr><td colspan="2" style="border-top:1px solid #e2e8f0;font-size:0;line-height:0;">&nbsp;</td></tr>
        </table>`
            : ""
        }

        ${
          s.nota
            ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:26px 0 0 0;border-collapse:collapse;">
          <tr><td bgcolor="#eef3f9" style="padding:15px 18px;border:1px solid #e2e8f0;border-radius:10px;font-family:${FUENTE};font-size:12px;line-height:19px;color:#5b6b82;">${s.nota}</td></tr>
        </table>`
            : ""
        }
      </td></tr>

      <tr><td align="left" style="padding:26px 6px 0 6px;">
        <p style="margin:0 0 7px 0;font-family:${FUENTE};font-size:11px;line-height:17px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#5b6b82;">atiende&nbsp;&nbsp;&#183;&nbsp;&nbsp;Gestión de licitaciones públicas por IA</p>
        <p style="margin:0 0 5px 0;font-family:${FUENTE};font-size:11px;line-height:18px;color:#5b6b82;">${escapeHtml(s.piePorQueLlego)}</p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

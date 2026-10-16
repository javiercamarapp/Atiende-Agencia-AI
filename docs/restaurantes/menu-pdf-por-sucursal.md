# Menú en PDF por sucursal (WhatsApp)

Decisión de Javier: el menú por WhatsApp va como **PDF adjunto** y es el **de cada sucursal publicado en internet**. Cierra T7-065 («no manda menú/PDF»).

## Qué publica hoy el sitio de PM

`https://www.lostaquitosdepm.com` (Wix) **no tiene PDF**. Cada sucursal tiene una página de menú con una galería de imágenes de página completa (carta, 2550 × 3300 px): **9 imágenes** en Montejo/García Lavín/Altabrisa, Francisco de Montejo y Galerías, y **8** en Pensiones y Playa (Chicxulub). Los PDF antiguos de 3 páginas están obsoletos.

Los PDF finales se arman con esas imágenes oficiales (sin agregar contenido) y se **alojan en la propia app**: `apps/web/public/menu-pdf/`. Vite los copia a `dist/` y Vercel los sirve como archivos estáticos (el sistema de archivos se resuelve antes que el comodín `/(.*)` → `/index.html` de `vercel.json`), así que Meta los descarga con un GET directo `200 application/pdf` sin redirecciones.

| Menú publicado (`https://app.useatiende.ai/menu-pdf/…`) | `branch_slug` que lo usan | Páginas | Peso | Página oficial |
|---|---|---|---|---|
| `menu-montejo-altabrisa-victory.pdf` | `prol-montejo`, `garcia-lavin`, `altabrisa` | 9 | 2.86 MB | `/menu-altabrisa-montejo-victory` |
| `menu-fco-montejo.pdf` | `fco-montejo` | 9 | 2.85 MB | `/menufranciscodemontejo` |
| `menu-galerias.pdf` | `galerias` | 9 | 2.80 MB | `/menupmgalerias` |
| `menu-playa.pdf` | `playa` (Chicxulub) | 8 | 2.84 MB | `/menuchicxulub` |
| *(sin PDF)* | `pensiones` | | | `/menupensiones` |

`garcia-lavin` se llama «García Lavín (Victory Platz)» en la cuenta real y `altabrisa` «Victory Altabrisa»; **no existe un slug `victory-platz`** (se comprobó en `packages/domain-restaurantes/tests/fixtures/cuenta-real-pm-estado.json`). El menú «Victory» del sitio sirve a ambas.

**Pensiones queda EXCLUIDA a propósito.** Su menú publica los precios 2025 (kilo de pastor a domicilio $750; la lista 2026 dice $900) y el agente cotiza 2026: mandar ese PDF lo contradeciría. Para Pensiones el agente comparte el enlace de la página oficial hasta que Javier consiga la imagen actualizada (`MENU_PDF_POR_SUCURSAL.pensiones.archivo = null`; lo fija `menu-pdf-alojado.spec.ts` y `enviar-menu-pdf.spec.ts`). **Menús en inglés: fuera de alcance** (no se publican ni se cablean).

### Peso y legibilidad

Objetivo ≤ 3 MB por PDF. Las imágenes originales son fotos densas (≈ 0.9 MB por página con el JPEG original), así que se reescalan a **1600 px de ancho (1700 en Playa)** y se recomprimen con JPEG calidad 40-42 (4:2:0, sin EXIF), la más alta que cabe en 2.9 MB. **No se llegó a la calidad 82-85 que se sugería**: con 9 páginas fotográficas esa calidad pesa 7-8 MB (medido). Revisado a ojo con recortes a tamaño nativo: precios, nombres de platillos, el texto pequeño del pie y la leyenda de restricciones de la promoción se leen bien; el costo de la compresión se nota solo en los bordes de las fotos de comida. El manifiesto `menu-pdf-manifiesto.json` guarda, por PDF: SHA-256 y bytes del resultado, SHA-256 y bytes del PDF de origen (sin recomprimir, 8-9 páginas) y SHA-256 de cada imagen oficial (se comprobó que las páginas del PDF de origen son idénticas, byte a byte, a `fotos/<slug>/NN.*`).

### Cómo regenerar

`python3 scripts/menu-pdf/armar-menu-pdf.py <carpeta con fotos/<slug>/NN.jpg> <salida>` (necesita Pillow: `pip install pillow`); luego actualizar `menu-pdf-manifiesto.json` con los nuevos SHA-256 y bytes (la prueba `menu-pdf-alojado.spec.ts` falla si no coinciden).

## Cómo envía el agente el menú

1. El prompt manda llamar `enviar_menu` con el `branch_slug` (la sucursal del chat por omisión, o la que pida el cliente). Solo WhatsApp.
2. `enviar_menu` **no manda nada por sí misma**: escribe en el outbox un mensaje con `documento` (`url`, `filename`, `fallbackUrl`) por el mismo número del chat, idempotente por mensaje del cliente y sucursal.
3. El despachador del outbox lo entrega con `type: "document"` (Graph API, enlace público; no se suben binarios), dentro de la ventana de 24 h del cliente.
4. Si Meta no puede traer el PDF (131052, 131053 o 100), el cliente recibe **una vez** el texto con el enlace de la página oficial de esa sucursal.
5. Sin número de WhatsApp activo, o con Pensiones (sin PDF), `enviar_menu` no encola y devuelve el **enlace de la página oficial**; el agente lo comparte tal cual. La URL del PDF usa la base por omisión; `PM_MENU_PDF_BASE_URL` solo la sobre-escribe.
6. Sucursal desconocida: la herramienta rechaza y el agente pregunta de cuál sucursal. Sucursal activa sin menú publicado: `sin_menu`, y el agente deja el aviso `registrar_contacto` `menu_pdf` (comportamiento anterior).

El documento se guarda en el outbox con `enviado_como` NULL (el check de la migración 066 no admite un valor nuevo; no se tocó ninguna migración).

## Qué hacer tras el despliegue (Javier)

No hay que definir variables en Vercel: la base por omisión es `https://app.useatiende.ai/menu-pdf` (`MENU_PDF_BASE_POR_OMISION`). `PM_MENU_PDF_BASE_URL` solo sirve para sobre-escribirla (p. ej. un bucket aparte); si es inválida (http, credenciales, query), se ignora y se usa la de omisión.

1. Verificar cada URL pública (esperado: `200`, `application/pdf`, el tamaño del manifiesto y 0 redirecciones):
   `for a in montejo-altabrisa-victory fco-montejo galerias playa; do curl -sIL -o /dev/null -w "%{http_code} %{content_type} %{size_download} redirecciones=%{num_redirects}\n" "https://app.useatiende.ai/menu-pdf/menu-$a.pdf"; done` y, para ver `content-length`, `curl -I <url>` de cada una. `curl -I https://app.useatiende.ai/menu-pdf/menu-pensiones.pdf` NO debe devolver `application/pdf`.
2. Comparar el SHA-256 de lo descargado con `menu-pdf-manifiesto.json`.
3. Probar con un número de prueba: pedir «el menú» y confirmar que llega el documento.
4. **No probado con la API real de Meta**: Graph puede aceptar el enlace en el envío y fallar después, con un evento de estado en el webhook (p. ej. 131052 «no se pudo descargar el medio»). El código solo degrada al enlace de la página oficial cuando el error llega en la respuesta del envío. Hay que mirar el webhook de estado del primer envío real.

## Pendientes y avisos (no inventados)

- **Pensiones publica una lista de precios vieja** (imágenes de enero de 2025; ver arriba): sin PDF hasta que el dueño dé la imagen actualizada. Entonces se agrega el archivo a `apps/web/public/menu-pdf/`, se pone su nombre en `MENU_PDF_POR_SUCURSAL.pensiones` y se actualizan manifiesto y pruebas.
- Montejo, Altabrisa y Victory comparten un solo menú en el sitio; se asignó a `prol-montejo`, `garcia-lavin` y `altabrisa`. Falta que el dueño confirme que «Victory» del sitio es García Lavín (Victory Platz).
- La promoción (lunes 2x1 en tacos al pastor, martes nachos de pastor + 2 aguas por $328, solo Francisco de Montejo, Pensiones y Galerías, no a domicilio) viene impresa en los PDF de Francisco de Montejo y Galerías; no se editó.
- Verificación: no hay OCR en esta Mac (`tesseract`). Se revisaron a ojo (recortes a tamaño nativo del PDF final) páginas de Montejo/Victory, Francisco de Montejo y Playa, y en la ronda anterior unos 20 precios de la página «Entradas y Nachos» coinciden con `menu-pm.json`. Faltan por revisar a ojo las demás páginas.

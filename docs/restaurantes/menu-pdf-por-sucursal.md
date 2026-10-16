# Menú en PDF por sucursal (WhatsApp)

Decisión de Javier: el menú por WhatsApp va como **PDF adjunto** y es el **de cada sucursal publicado en internet**. Cierra T7-065 («no manda menú/PDF»).

## Qué publica hoy el sitio de PM

`https://www.lostaquitosdepm.com` (Wix) **no tiene PDF**. Cada sucursal tiene una página de menú con **3 imágenes de página completa** (carta, 2550 × 3300 px) que se ven en una galería. Los PDF se arman con esas mismas imágenes: sin recompresión (JPEG tal cual, `DCTDecode`), sin texto ni contenido agregado. El manifiesto `menu-pdf-manifiesto.json` guarda página fuente, URL y SHA-256 de cada imagen y de cada PDF, páginas y tamaño. **No hay binarios en el repo.**

| Menú publicado | `branch_slug` que lo usan | Página oficial |
|---|---|---|
| `menu-montejo-altabrisa-victory.pdf` | `prol-montejo`, `garcia-lavin`, `altabrisa` | `/menu-altabrisa-montejo-victory` |
| `menu-francisco-de-montejo.pdf` | `fco-montejo` | `/menufranciscodemontejo` |
| `menu-pensiones.pdf` | `pensiones` | `/menupensiones` |
| `menu-galerias.pdf` | `galerias` | `/menupmgalerias` |
| `menu-chicxulub.pdf` | `playa` | `/menuchicxulub` |

El sitio también publica un menú en inglés (`/taquitospm-english-menu`); no está cableado.

## Cómo envía el agente el menú

1. El prompt manda llamar `enviar_menu` con el `branch_slug` (la sucursal del chat por omisión, o la que pida el cliente). Solo WhatsApp.
2. `enviar_menu` **no manda nada por sí misma**: escribe en el outbox un mensaje con `documento` (`url`, `filename`, `fallbackUrl`) por el mismo número del chat, idempotente por mensaje del cliente y sucursal.
3. El despachador del outbox lo entrega con `type: "document"` (Graph API, enlace público; no se suben binarios), dentro de la ventana de 24 h del cliente.
4. Si Meta no puede traer el PDF (131052, 131053 o 100), el cliente recibe **una vez** el texto con el enlace de la página oficial de esa sucursal.
5. Sin `PM_MENU_PDF_BASE_URL` (o inválida), o sin número de WhatsApp activo, `enviar_menu` no encola y devuelve el **enlace de la página oficial**; el agente lo comparte tal cual.
6. Sucursal desconocida: la herramienta rechaza y el agente pregunta de cuál sucursal. Sucursal activa sin menú publicado: `sin_menu`, y el agente deja el aviso `registrar_contacto` `menu_pdf` (comportamiento anterior).

El documento se guarda en el outbox con `enviado_como` NULL (el check de la migración 066 no admite un valor nuevo; no se tocó ninguna migración).

## Qué debe subir Javier a producción

1. Subir los 5 PDF a un lugar **público por https** (por ejemplo un bucket público de Supabase Storage o un directorio estático), con estos nombres exactos:
   `https://<base>/menu-montejo-altabrisa-victory.pdf`, `.../menu-francisco-de-montejo.pdf`, `.../menu-pensiones.pdf`, `.../menu-galerias.pdf`, `.../menu-chicxulub.pdf`.
   Los archivos están fuera del repo, en `~/atiende-loop/work/pm-menus-pdf/`; el SHA-256 de cada uno está en `menu-pdf-manifiesto.json` para comprobar la subida.
2. Definir en Vercel (Producción) `PM_MENU_PDF_BASE_URL=https://<base>` (sin barra final, sin credenciales ni query). Mientras no exista, el agente comparte el enlace de la página oficial (ya funciona, sin PDF).
3. Probar con un número de prueba: pedir «el menú» y confirmar que llega el documento; `curl -I` a cada URL debe dar 200 y `content-type: application/pdf`.

## Pendientes y avisos (no inventados)

- **Pensiones publica una lista de precios vieja.** Las imágenes de `/menupensiones` llevan fecha de Photoshop de enero de 2025 y precios de la lista 2025 (kilo de pastor a domicilio $750; la lista 2026 de Francisco de Montejo dice $900). El PDF es fiel al sitio, pero el agente cotiza con precios 2026: puede contradecirse con el total. Pedir al dueño la imagen actualizada antes de subir ese PDF.
- Montejo, Altabrisa y Victory comparten un solo menú en el sitio; se asignó también a `garcia-lavin` (T7, Victory Platz). Falta que el dueño confirme que «Victory» es T7.
- La promoción (lunes 2x1 en tacos al pastor, martes nachos de pastor + 2 aguas por $328, solo Francisco de Montejo, Pensiones y Galerías, no a domicilio) viene impresa en los PDF de Francisco de Montejo y Galerías; no se editó.
- Verificación: no hay OCR en esta Mac (`tesseract`). Se revisaron a ojo páginas de Montejo/Victory, Francisco de Montejo, Galerías y Pensiones, y unos 20 precios de la página «Entradas y Nachos» coinciden con `menu-pm.json`. Faltan por revisar a ojo las demás páginas y todo Chicxulub.

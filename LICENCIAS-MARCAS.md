# Licencias y uso de marcas de terceros

Este archivo documenta de dónde sale cada logo que muestra `LogoMarca` (`packages/ui/src/components/LogoMarca.tsx`) y bajo qué condiciones se usa. Lo genera y lo valida `scripts/marcas/generar-logos.py`.

## Fuente de los SVG

| Dato | Valor |
|---|---|
| Paquete | `simple-icons` (npm), versión `16.36.0` |
| Fecha de la fuente | 2026-10-26 |
| Licencia de los archivos | CC0 1.0 (dominio público sobre el SVG) |
| sha1 del tarball | `45f50dc2ec8fa7a14b68b6eb1b8ac1c1e4340772` |
| sha512 (integrity) | `sha512-+VNPPkqSOLidFeSgBKUWX4n50WPpDC09hav+BgS26anIF1oQOlGBb8LvwGR+6fYRjo+B6CiKzNBceMPkSVXANQ==` |
| Tarball | `https://registry.npmjs.org/simple-icons/-/simple-icons-16.36.0.tgz` |

Cómo se obtiene: el generador descarga el `.tgz`, verifica sha1 y sha512 contra los valores fijados en el propio script y contra los que publica el registro (`dist.shasum`, `dist.integrity`), y lee en memoria solo los `.svg` de las marcas listadas. No se instala el paquete ni se ejecuta ningún script suyo, y `simple-icons` no es dependencia del repositorio. Para subir de versión, cambia las constantes del script (versión, hashes, fecha), regenera y revisa el diff.

La licencia CC0 cubre el archivo SVG, no la marca. Cada marca sigue siendo propiedad de su titular.

## Uso nominativo

Los logos se muestran únicamente para identificar la integración o fuente a la que se refiere la pantalla (por ejemplo, "se conecta con WhatsApp"). Atiende no es socio, distribuidor ni cuenta con respaldo de estas empresas por el hecho de mostrarlas; ningún texto debe afirmarlo (por ejemplo, no decir "partner de Meta"). Reglas del componente: no se deforma, no se anima, no se le aplican sombras ni filtros, y solo se recolorea a `currentColor` (variante `mono`) o a su color de marca (variante `color`). Si el titular pide retirar su logo, se mueve a `PENDIENTES_MARCA` y se regenera.

## Marcas con asset (5)

| Marca | Slug en simple-icons | Notas |
|---|---|---|
| WhatsApp | `whatsapp` | Verde de marca solo con `variante="color"` (contraste bajo sobre fondo claro: el componente la fuerza a `mono`). |
| Google Calendar | `googlecalendar` | Ícono de producto, no la «G» de Google. Uso nominativo para nombrar la integración; debe cumplir las guías de marca de Google (https://about.google/brand-resource-center/), sin alterar el glifo ni sugerir respaldo de Google. |
| Stripe | `stripe` | |
| Airbnb | `airbnb` | |
| Expedia | `expedia` | |

## Pendientes (7): sin asset oficial verificado

No se dibuja ni se copia ningún logo para estas marcas. `LogoMarca` muestra un ícono neutro y el nombre (en estas marcas `decorativo` no tiene efecto: el nombre siempre es visible). La FUENTE ÚNICA de la lista, con el motivo de cada una, es `PENDIENTES_MARCA` en `packages/ui/src/lib/logos-marca.generated.ts` (se edita en `scripts/marcas/generar-logos.py`); aquí solo se listan marca y tipo, y un spec comprueba que coincidan. También se imprime con `python3 scripts/marcas/generar-logos.py --pendientes`.

| Marca | Tipo |
|---|---|
| Google | pendiente-asset |
| Booking.com | restringida |
| Vrbo | pendiente-asset |
| Tripadvisor | solo-texto |
| Meta | solo-texto |
| OpenStreetMap | solo-texto |
| SoftRestaurant | pendiente-asset |

Quién decide: el dueño del producto. Booking.com pasa a logo (mono) o se queda en texto con un PR que cambie su entrada en el generador; esa entrada y el PR son el registro de la decisión. Los demás pendientes salen de la lista cuando se aporta el asset oficial o el permiso del titular.

## Cómo importar

`LogoMarca` no está en el barrel `@atiende/ui` (un export estático impediría dividir el chunk). Usa `import { LogoMarca } from "@atiende/ui/logo-marca"` donde el peso no importe, y `LogoMarcaDiferido` (barrel) en chunks de entrada. `PENDIENTES_MARCA` y los assets: `@atiende/ui/logos-marca`. Peso propio de `LogoMarca`: `node scripts/marcas/medir-peso.mjs` (tope 4608 B gzip; solo código propio, sin react, clsx, tailwind-merge ni lucide, que la app ya comparte. El criterio del lote era 4 KB: se subió el tope porque el margen era de 163 B y cada marca nueva suma 250-400 B).

No se usan logos de clientes en el repositorio: el logo de cada cliente lo sube el cliente a su almacenamiento.

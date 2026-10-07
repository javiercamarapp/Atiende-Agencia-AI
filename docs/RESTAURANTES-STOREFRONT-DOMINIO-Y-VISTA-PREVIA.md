# Restaurantes: vista previa al compartir, dominio propio y 301 del sitio viejo

Fuente: encargo `huecos-finales-restaurantes` §3. Estado: la vista previa en servidor y `robots.txt` están construidos; el dominio
propio y los 301 son decisión y acceso de Javier (no se configuró nada de DNS ni de Vercel en este PR).

## Qué ya hace el servidor

- `GET /pedir/:org` y `GET /pedir/:org/:sucursal` (reescritos a la función en `vercel.json`) sirven el `index.html` del panel con
  `title`, `description`, `og:*`, `twitter:*`, `canonical` y, en la sucursal, un bloque JSON-LD `Restaurant` (nombre, dirección,
  teléfono, horario y `hasMenu`). Sin precios, ids, coordenadas ni datos de clientes. Código: `apps/api/src/routes/verticals/restaurantes/storefront-meta.ts`.
- Organización o sucursal inexistente: meta genéricas con `noindex`. Si falla la lectura: meta genéricas, nunca una página rota.
- Caché: `s-maxage=300, stale-while-revalidate=600` (solo depende de la URL y de datos públicos).
- `/pedir/:org/sucursales`, `/pedir/:org/privacidad` y `/pedir/:org/pedido/:token`: las dos primeras llevan meta propias; la de rastreo (3 segmentos, con
  token) sigue siendo el SPA estático y `robots.txt` la bloquea.
- La URL canónica usa `APP_BASE_URL` (por omisión `https://app.atiende.ai`), no el `Host` de la petición.
- `og:image`: no se pone ninguna imagen de Atiende en las páginas de restaurantes. Cuando exista logo o foto de la organización (r38 y §4), se agrega aquí.
- Aviso para despliegue: la función toma el `index.html` embebido en el build (`scripts/build-vercel-function.mjs`) y, si falta, el del CDN en `APP_BASE_URL`;
  si no hay ninguno responde 503. El build ya construye `apps/web` antes, así que el HTML embebido corresponde al mismo despliegue.

## Dominio propio `pedidos.<dominio de PM>` (pasos para Javier)

1. En el proyecto de Vercel, Settings → Domains → agregar `pedidos.<dominio>`.
2. En el DNS del dominio de PM, crear un `CNAME` de `pedidos` al valor que indique Vercel (normalmente `cname.vercel-dns.com`).
3. Esperar la verificación y el certificado automático.
4. Agregar el dominio a `ALLOWED_ORIGINS` de la API (el CORS del storefront es por origen).
5. Pendiente de construir (no está en este PR): resolver `Host` → organización para que `https://pedidos.<dominio>/` abra el storefront de PM sin
   escribir `/pedir/los-taquitos-de-pm`, y que el `canonical` use ese dominio. Hasta entonces, el dominio propio puede apuntar a la ruta `/pedir/<org>` con una redirección.

## 301 desde las rutas del sitio viejo

Se configuran en el dominio del sitio viejo (o en `vercel.json` del dominio propio) cuando Javier decida el dominio. Tabla propuesta:

| Ruta vieja | Destino | Estado del destino |
|---|---|---|
| `/menu` | `/pedir/<org>` | existe |
| `/sucursales` | `/pedir/<org>/sucursales` | existe (este PR) |
| `/whatsapppm` | `/pedir/<org>` | el botón flotante de WhatsApp lo construye r38; hasta entonces, la portada |
| `/servicioeventos` | página de eventos de r38 (ruta por definir) | no existe aún |
| `/facturacion` | página pública de facturación (§4, no construida) | no existe aún |
| `/preguntas` | página pública de preguntas frecuentes (§4, no construida) | no existe aún |

No configurar los tres últimos hasta que existan sus destinos: un 301 a una página inexistente es peor que el sitio viejo.

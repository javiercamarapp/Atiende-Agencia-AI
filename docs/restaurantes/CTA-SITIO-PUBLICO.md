# CTA de registro de restaurantes: app y sitio público

Este documento cubre solo la **página y el botón de restaurantes**. El rediseño del sitio de marketing (`useatiende.ai`) queda fuera de alcance.

## En la app (este repo)

- **Selector de vertical (`/`)**: en la misma línea del subtítulo aparece «¿Tienes un restaurante? **Crea tu cuenta**», que lleva a `/restaurantes/registro`. Va en esa línea para que la página siga cabiendo sin scroll en 1280x720.
- **Login de restaurantes (`/restaurantes/login`)**: el pie dice «¿Sin acceso? Pídele a tu restaurante que te dé de alta. ¿Eres dueño? **Crea tu cuenta**». Es corto a propósito: el login no debe hacer scroll.
- **Registro (`/restaurantes/registro`)**: correo o Google. Nace la organización en prueba de 14 días con su primera sucursal inactiva. Luego viene la ruta corta «primer valor en 30 minutos»: menú, horario, zonas, cómo cobras, prueba del agente y activación.

## En el sitio público (`useatiende.ai`, fuera de este repo)

El sitio vive fuera de este repo. Esto es lo que hay que poner en la **página de restaurantes**, sin tocar el resto del sitio:

- **Botón principal**: «Crea tu cuenta gratis».
- **Texto de apoyo**: «14 días de prueba. Tu agente de WhatsApp toma pedidos en menos de 30 minutos: sube tu menú, pon tu horario y tus colonias, y pruébalo».
- **Enlace**: `https://app.useatiende.ai/restaurantes/registro?utm_source=sitio&utm_medium=cta&utm_campaign=restaurantes`.
- **Botón secundario**: «Ya tengo cuenta» → `https://app.useatiende.ai/restaurantes/login`.
- **Qué no prometer**:
  - **voz telefónica**: sigue siendo un runbook con alta manual;
  - **número propio de WhatsApp sin ayuda**: Embedded Signup va detrás de configuración hasta que se cargue la app de Meta (`docs/restaurantes/WHATSAPP-EMBEDDED-SIGNUP.md`);
  - **precios distintos a los del plan vigente**.

Hoy la app no lee los parámetros `utm_*`: se pueden medir en la analítica del sitio. Guardarlos en el registro queda como hueco conocido.

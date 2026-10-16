# Restaurantes: Google Business Profile (trámite de Javier)

Fuente: encargo `huecos-finales-restaurantes` §8 (A-36/B-14). El acceso a la API lo aprueba Google aparte y tarda: conviene pedirlo ya.
**No se construyó la integración.** En el código solo hay el puerto `ResenasProvider` (`packages/domain-restaurantes/src/resenas-provider.ts`)
con un adaptador falso para pruebas y un adaptador "no disponible aún" que lanza un error honesto.

## Pasos para solicitar el acceso (acción de Javier; verificar los requisitos vigentes en la documentación de Google)

1. Tener, con la cuenta de Google de PM, los perfiles de las sucursales verificados y administrados desde una sola cuenta (o grupo de ubicaciones).
2. Crear un proyecto en Google Cloud para Atiende y anotar su número.
3. Pedir el acceso a la **Google Business Profile API** con el formulario de contacto de la API de Google Business Profile (soporte de Google), indicando el número del
   proyecto, el correo de la cuenta y el caso de uso: leer reseñas y responderlas con aprobación humana, y enlazar el botón "Pedir" al storefront.
4. Cuando Google apruebe la cuota, habilitar la API en el proyecto y crear las credenciales OAuth. Guardarlas como secreto por organización (no en el repo).
5. Avisar para construir el adaptador real de `ResenasProvider` y conectar la bandeja de reseñas.

## Reglas ya fijadas en el dominio

- Borrador de respuesta redactado por el agente; las de **3 estrellas o menos exigen aprobación humana** antes de publicarse (`publicarRespuestaAResena`).
- Una respuesta con incentivos o condiciones sobre una reseña se rechaza siempre.
- Botón "Pedir" de Google apuntando al storefront (`/pedir/<org>/<sucursal>`): pendiente del acceso.
- Atención de política: invitar a reseñar a Google solo a quien calificó 4 o 5 (regla de la encuesta, §6 del encargo) puede considerarse "filtrado de reseñas" por Google;
  conviene que Javier lo revise antes de activar el envío en r41.

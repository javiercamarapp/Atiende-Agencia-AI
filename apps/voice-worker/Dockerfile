# Imagen del worker de telefonia de voz (apps/voice-worker). Se construye DESDE LA RAIZ del repo:
#
#   docker build -f apps/voice-worker/Dockerfile -t atiende-voice-worker .
#
# NO se ha construido ni corrido en esta maquina (sin daemon de Docker en el entorno de desarrollo): el bundle (`npm run bundle`) y el arranque en
# modo "no configurado" (/salud 503) SI se probaron con Node directamente; la imagen es la receta, sin verificar. El host lo decide Javier
# (apps/voice-worker/README.md, "Donde vive el proceso").
#
# Etapa 1: instala las dependencias del workspace y empaqueta el worker en un solo archivo (dist/main.mjs) con las versiones EXACTAS de los dos SDK de
# LiveKit (que traen un binario nativo y quedan fuera del bundle) en dist/package.json.
FROM node:22-bookworm-slim AS bundle
WORKDIR /repo
COPY . .
RUN npm ci --workspace @atiende/voice-worker --include-workspace-root --ignore-scripts \
 && npm run bundle -w @atiende/voice-worker

# Etapa 2: solo el bundle, los SDK de LiveKit y los audios pregrabados. Sin codigo fuente, sin devDependencies, sin secretos (todo entra por entorno).
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
COPY --from=bundle /repo/apps/voice-worker/dist/package.json ./package.json
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=bundle /repo/apps/voice-worker/dist/main.mjs ./main.mjs
COPY --from=bundle /repo/apps/voice-worker/assets ./assets
ENV NODE_ENV=production PORT=8080 VOICE_ASSETS_DIR=/app/assets
USER node
EXPOSE 8080
# /salud responde 200 solo si el worker esta configurado; 503 con los motivos si no (nunca contesta llamadas a medias).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/salud').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "main.mjs"]

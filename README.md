# Gemini Code Reviewer

Este proyecto es una función serverless para Vercel que revisa automáticamente los Pull Requests de GitHub usando la API de Gemini.

## Despliegue en Vercel

1.  **Sube este proyecto a un repositorio de GitHub.**
2.  **Crea un nuevo proyecto en Vercel** e impórtalo desde tu repositorio de GitHub.
3.  **Configura las Variables de Entorno** en la sección `Settings -> Environment Variables` de tu proyecto en Vercel:
    *   `GITHUB_TOKEN`: Un [Token de Acceso Personal](https://github.com/settings/tokens) de GitHub. Necesita los permisos `repo` (para acceder al código y escribir comentarios) y `read:org` (para leer información de la organización si los repos son privados).
    *   `GEMINI_API_KEY`: Tu clave de API de Google AI Studio (Gemini).
    *   `WEBHOOK_SECRET`: Una contraseña larga y aleatoria que crearás tú mismo. La usarás para asegurar la comunicación entre GitHub y Vercel.
    *   `NODE_ENV`: Ponle el valor `production`.

## Configuración del Webhook en GitHub

1.  Ve a la configuración de tu **organización** de GitHub (`Settings -> Webhooks`).
2.  Crea un nuevo webhook:
    *   **Payload URL**: La URL de tu despliegue en Vercel (será algo como `https://<tu-proyecto>.vercel.app/api/webhook`).
    *   **Content type**: `application/json`.
    *   **Secret**: La misma contraseña que pusiste en la variable `WEBHOOK_SECRET`.
    *   **Which events would you like to trigger this webhook?**: Selecciona "Let me select individual events" y marca únicamente **Pull requests**.
3.  Guarda el webhook. ¡Listo!
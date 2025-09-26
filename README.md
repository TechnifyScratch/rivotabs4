# Production Proxy

**Use responsibly.** This proxy rewrites HTML/CSS and injects a script to proxy XHR/fetch. It is NOT guaranteed to work for highly-protected sites (banks, DRM, streaming).

## Deploy (Render)
1. Push repo to GitHub.
2. Create a new **Web Service** on Render:
   - Connect repo and branch.
   - Build command: `npm install`
   - Start command: `npm start`
3. Set environment variables in Render dashboard from `.env.example`.
   - **Set BASIC_AUTH_USER and BASIC_AUTH_PASS before exposing publicly**.
   - Set ALLOWED_HOSTS to restrict hosts.
4. Deploy.

## Local

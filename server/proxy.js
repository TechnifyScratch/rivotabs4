// server/proxy.js
import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";
import compression from "compression";
import morgan from "morgan";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { rewriteHTML, rewriteCSSUrls, makeAbsoluteUrl } from "./rewrite.js";
import cookie from "cookie";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const PROXY_PREFIX = process.env.PROXY_PREFIX || "/go";
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || "";
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS || "";
const TRUST_PROXY = process.env.TRUST_PROXY === "true" || false;

// Allowed hosts (optional)
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "").split(",").map(s => s.trim()).filter(Boolean);

// Rate limiter
const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10);
const MAX = parseInt(process.env.RATE_LIMIT_MAX || "60", 10);

const app = express();
app.set("trust proxy", TRUST_PROXY);

// Logging & security middlewares
app.use(morgan("tiny"));
app.use(compression());

// Use helmet but we'll strip some headers for proxied content later
app.use(helmet({
  contentSecurityPolicy: false // disable CSP enforcement so we can send proxied content
}));

// Serve static UI
app.use(express.static(path.join(__dirname, "..", "public")));

// Basic rate limiting
const limiter = rateLimit({
  windowMs: WINDOW_MS,
  max: MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests, slow down."
});
app.use(limiter);

// Basic auth middleware (optional)
if (BASIC_AUTH_USER && BASIC_AUTH_PASS) {
  app.use((req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Basic ")) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Proxy"');
      return res.status(401).send("Authentication required.");
    }
    const b = Buffer.from(auth.split(" ")[1], "base64").toString();
    const [u, p] = b.split(":");
    if (u !== BASIC_AUTH_USER || p !== BASIC_AUTH_PASS) {
      return res.status(403).send("Forbidden.");
    }
    next();
  });
}

// small helper: check allowed hostnames
function hostAllowed(hostname) {
  if (!ALLOWED_HOSTS || ALLOWED_HOSTS.length === 0) return true; // permissive if none set
  return ALLOWED_HOSTS.includes(hostname.toLowerCase());
}

// Utility to remove dangerous headers from upstream response
function sanitizeUpstreamHeaders(headers) {
  const out = {};
  headers.forEach((v, k) => {
    const key = k.toLowerCase();
    // Drain frame/security headers and hop-by-hop
    const blocked = [
      "content-security-policy",
      "content-security-policy-report-only",
      "x-frame-options",
      "x-xss-protection",
      "x-content-type-options",
      "referrer-policy",
      "strict-transport-security",
      "set-cookie" // we'll handle Set-Cookie specially
    ];
    if (blocked.includes(key)) return;
    // Skip hop-by-hop headers
    const hopByHop = ["connection", "keep-alive", "transfer-encoding", "proxy-authenticate", "proxy-authorization", "te", "trailers", "upgrade"];
    if (hopByHop.includes(key)) return;
    out[k] = v;
  });
  return out;
}

// Proxy route
app.get(`${PROXY_PREFIX}`, async (req, res) => {
  try {
    let raw = req.query.u;
    if (!raw) return res.status(400).send("Missing 'u' query parameter.");

    // Make absolute
    if (!/^https?:\/\//i.test(raw)) raw = "http://" + raw;
    const targetUrl = new URL(raw);

    // Host whitelist
    if (!hostAllowed(targetUrl.hostname)) {
      return res.status(403).send("Host not allowed.");
    }

    // Build headers to forward (filter out hop-by-hop)
    const forwardHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const kk = k.toLowerCase();
      if (["host", "connection", "content-length", "accept-encoding"].includes(kk)) continue;
      forwardHeaders[k] = v;
    }
    // Optionally set a custom user agent
    forwardHeaders["user-agent"] = forwardHeaders["user-agent"] || "production-proxy/1.0";

    // Fetch upstream
    const upstream = await fetch(targetUrl.href, {
      method: "GET",
      headers: forwardHeaders,
      redirect: "follow"
    });

    // Get content type
    const contentType = upstream.headers.get("content-type") || "";

    // Handle Set-Cookie: rewrite Domain attribute away so cookies are scoped to proxy domain.
    const setCookieRaw = upstream.headers.raw()["set-cookie"] || [];
    const rewrittenCookies = setCookieRaw.map(sc => {
      // Remove Domain=... and Secure; keep basic cookie value and Path=/
      // This is a simple strategy and won't work for all cookie semantics,
      // but it makes many sites' cookies usable under the proxy domain.
      let c = sc.replace(/;\s*Domain=[^;]+/i, "");
      // Optionally keep Secure if original was secure AND our server runs HTTPS.
      // For simplicity remove SameSite=None; Secure etc.
      c = c.replace(/;\s*Secure/i, "");
      c = c.replace(/;\s*SameSite=[^;]+/i, "");
      // Ensure a path exists
      if (!/;\s*Path=/i.test(c)) c += "; Path=/";
      return c;
    });

    // Remove shielding headers and copy safe headers to response
    const safeHeaders = sanitizeUpstreamHeaders(upstream.headers);
    for (const k of Object.keys(safeHeaders)) res.setHeader(k, safeHeaders[k]);

    // Send rewritten Set-Cookie headers
    rewrittenCookies.forEach(rc => res.append("Set-Cookie", rc));

    // If content is HTML, rewrite
    if (contentType.includes("text/html")) {
      const html = await upstream.text();
      // Use JSDOM to parse and rewrite links/assets
      const rewritten = await rewriteHTML(html, targetUrl.href, PROXY_PREFIX);
      // Inject our small client script before </body> to intercept JS fetch/XHR in-page
      const injectedScript = fs.readFileSync(path.join(__dirname, "injected-client.js"), "utf8");
      // Append script
      const finalHtml = rewritten.replace(/<\/body>/i, `<script>${injectedScript}</script></body>`);
      res.type("html").send(finalHtml);
      return;
    }

    // If CSS, rewrite url(...) references then send
    if (contentType.includes("text/css")) {
      const css = await upstream.text();
      const rewrittenCss = rewriteCSSUrls(css, targetUrl.href, PROXY_PREFIX);
      res.type("text/css").send(rewrittenCss);
      return;
    }

    // Binary / other content: stream directly
    res.status(upstream.status);
    upstream.body.pipe(res);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(502).send("Upstream fetch failed: " + String(err));
  }
});

// health check
app.get("/_health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// fallback - serve index.html for SPA
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Production proxy listening on port ${PORT}`);
});

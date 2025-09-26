// server/rewrite.js
import { JSDOM } from "jsdom";

/**
 * Rewrite HTML document links/assets to route through our /go?u= proxy.
 * - Converts <a href>, <img src>, <script src>, <link href> etc. to proxied URLs
 * - Adds a base tag to help with relative URLs
 *
 * @param {string} html
 * @param {string} originUrl - absolute URL string of upstream page
 * @param {string} proxyPrefix - e.g. "/go"
 * @returns {string} rewritten html
 */
export async function rewriteHTML(html, originUrl, proxyPrefix = "/go") {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const origin = new URL(originUrl);

  // Add/replace <base> so relative URLs resolve to original host
  let base = doc.querySelector("base");
  if (!base) {
    base = doc.createElement("base");
    base.setAttribute("href", origin.origin);
    const head = doc.querySelector("head");
    if (head) head.insertBefore(base, head.firstChild);
  } else {
    base.setAttribute("href", origin.origin);
  }

  // Helper to convert a resource URL to proxied URL
  function proxify(resourceUrl) {
    try {
      const abs = new URL(resourceUrl, origin.href).href;
      return `${proxyPrefix}?u=${encodeURIComponent(abs)}`;
    } catch (e) {
      return resourceUrl;
    }
  }

  // Attributes to rewrite and their attribute name
  const toRewrite = [
    { selector: "a[href]", attr: "href" },
    { selector: "img[src]", attr: "src" },
    { selector: "script[src]", attr: "src" },
    { selector: "link[href]", attr: "href" },
    { selector: "iframe[src]", attr: "src" },
    { selector: "source[src]", attr: "src" },
    { selector: "video[src]", attr: "src" },
    { selector: "audio[src]", attr: "src" }
  ];

  toRewrite.forEach(({ selector, attr }) => {
    doc.querySelectorAll(selector).forEach(el => {
      const original = el.getAttribute(attr);
      if (!original) return;
      // Skip javascript: links
      if (/^\s*javascript:/i.test(original)) return;
      // Keep mailto and tel
      if (/^\s*(mailto|tel):/i.test(original)) return;
      el.setAttribute(attr, proxify(original));
      // For <a> tags, ensure they open in same iframe (avoid target=_blank unless needed)
      if (el.tagName.toLowerCase() === "a") {
        el.setAttribute("rel", "noopener noreferrer");
      }
    });
  });

  // Rewrite inline CSS url(...) within style attributes and style tags
  // style attributes
  doc.querySelectorAll("[style]").forEach(el => {
    const style = el.getAttribute("style");
    const newStyle = style.replace(/url\(([^)]+)\)/g, (m, p1) => {
      const cleaned = p1.replace(/['"]/g, "").trim();
      const proxyUrl = proxify(cleaned);
      return `url("${proxyUrl}")`;
    });
    el.setAttribute("style", newStyle);
  });

  // style tags
  doc.querySelectorAll("style").forEach(s => {
    const text = s.textContent;
    s.textContent = text.replace(/url\(([^)]+)\)/g, (m, p1) => {
      const cleaned = p1.replace(/['"]/g, "").trim();
      const proxyUrl = proxify(cleaned);
      return `url("${proxyUrl}")`;
    });
  });

  // Rewrite meta-refresh redirects
  doc.querySelectorAll("meta[http-equiv]").forEach(meta => {
    const httpEq = meta.getAttribute("http-equiv") || "";
    if (httpEq.toLowerCase() === "refresh") {
      const content = meta.getAttribute("content") || "";
      // format like "5; url=/path"
      const parts = content.split(";");
      if (parts.length > 1) {
        const urlPart = parts.slice(1).join(";").trim();
        const match = urlPart.match(/url=(.*)/i);
        if (match) {
          const target = match[1].trim().replace(/^['"]|['"]$/g, "");
          meta.setAttribute("content", `${parts[0]}; url=${proxify(target)}`);
        }
      }
    }
  });

  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
}

/**
 * Rewrite CSS url(...) calls to proxied URLs
 * @param {string} cssText
 * @param {string} originUrl
 * @param {string} proxyPrefix
 */
export function rewriteCSSUrls(cssText, originUrl, proxyPrefix = "/go") {
  const origin = new URL(originUrl);
  return cssText.replace(/url\(([^)]+)\)/g, (m, p1) => {
    const raw = p1.replace(/['"]/g, "").trim();
    // skip data: URIs
    if (/^data:/i.test(raw)) return `url(${raw})`;
    const abs = new URL(raw, origin.href).href;
    return `url("${proxyPrefix}?u=${encodeURIComponent(abs)}")`;
  });
}

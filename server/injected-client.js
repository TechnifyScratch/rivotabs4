// server/injected-client.js
// This string is injected verbatim into proxied HTML pages by the server.
// It intercepts fetch and XHR so page-generated requests are routed via the proxy.

(function () {
  try {
    const proxyPrefix = window.__PROXY_PREFIX__ || "/go"; // server can set this if needed

    function proxifyUrl(url) {
      try {
        // If relative, resolve against document.baseURI
        const abs = new URL(url, document.baseURI).href;
        return `${proxyPrefix}?u=${encodeURIComponent(abs)}`;
      } catch (e) {
        return url;
      }
    }

    // Override fetch
    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        const reqUrl = typeof input === "string" ? input : input.url;
        // Skip proxying if already proxied
        if (typeof reqUrl === "string" && reqUrl.includes(`${proxyPrefix}?u=`)) {
          return originalFetch(input, init);
        }
        const newUrl = proxifyUrl(reqUrl);
        if (typeof input === "string") {
          return originalFetch(newUrl, init);
        } else {
          // clone request and replace URL
          const newReq = new Request(newUrl, input);
          return originalFetch(newReq, init);
        }
      } catch (err) {
        console.error("fetch proxy shim error:", err);
        return originalFetch(input, init);
      }
    };

    // Override XHR.open to rewrite the URL
    const XHR = window.XMLHttpRequest;
    function ProxyXHR() {
      const xhr = new XHR();
      const origOpen = xhr.open;
      xhr.open = function (method, url, ...rest) {
        try {
          if (!url.includes(`${proxyPrefix}?u=`)) {
            url = proxifyUrl(url);
          }
        } catch (e) {
          // ignore and use original url
        }
        return origOpen.call(this, method, url, ...rest);
      };
      return xhr;
    }
    ProxyXHR.prototype = XHR.prototype;
    window.XMLHttpRequest = ProxyXHR;

    // Also rewrite Image / Video src setters via descriptor override (best-effort)
    try {
      const IMG = HTMLImageElement.prototype;
      const origSet = Object.getOwnPropertyDescriptor(IMG, "src").set;
      Object.defineProperty(IMG, "src", {
        set: function (val) {
          try {
            const newUrl = proxifyUrl(val);
            return origSet.call(this, newUrl);
          } catch (e) {
            return origSet.call(this, val);
          }
        }
      });
    } catch (e) {}
  } catch (e) {
    console.error("injected-client init error", e);
  }
})();

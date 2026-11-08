import type { Plugin } from 'vite';

/** Local synthetic build only. Production source keeps its original assets. */
export function isolatedClientPlugin(): Plugin {
  return {
    name: 'lba-isolated-client',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (process.env.LBA_ISOLATED !== '1') return html;
        html = html
          .replace(/<script\b[^>]*src=["']https?:\/\/[^"']+["'][^>]*>\s*<\/script>/gi, '')
          .replace(/<link\b[^>]*href=["']https?:\/\/[^"']+["'][^>]*>/gi, '')
          .replace(/<link\b[^>]*(?:manifest|icon-512)[^>]*>/gi, '')
          .replace("if (!isCapacitorNative && 'serviceWorker' in navigator)", "if (!window.__LBA_ISOLATED__ && !isCapacitorNative && 'serviceWorker' in navigator)");
        return html.replace('<head>', `<head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'">
    <script>
      window.__LBA_ISOLATED__ = true;
      var localOpen = window.open.bind(window);
      window.open = function(url, target, features) {
        if (!url || new URL(url, location.href).origin !== location.origin) return null;
        return localOpen(url, target, features);
      };
      document.addEventListener('click', function(event) {
        var anchor = event.target && event.target.closest && event.target.closest('a[href]');
        if (anchor && new URL(anchor.href, location.href).origin !== location.origin) {
          event.preventDefault();
        }
      }, true);
    </script>`).replace('<body>', `<body>
    <div role="status" id="lba-synthetic-banner" style="position:sticky;top:0;z-index:99999;padding:8px 16px;background:#fef3c7;color:#78350f;text-align:center;font:600 13px/1.4 system-ui">
      Локальна тестова копія · Telegram вимкнено
    </div>`);
      },
    },
  };
}

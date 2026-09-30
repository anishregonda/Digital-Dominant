import { defineConfig } from 'vite'
import { resolve } from 'path'

// DD Hub's visit counter (t.js) is a deferred script, and deferred scripts run in
// page order. Vite puts the site's own bundle at the end of <head>, after the
// counter, so a slow or unreachable Hub would hold back the menu, the lead forms
// and every animated section (hidden until AOS starts). Move the counter tag after
// the bundle: the tag itself stays exactly as written, and stays in <head>.
const TRACKER_TAG = /[ \t]*<script\b[^>]*\bsrc="https:\/\/hub\.digitaldominant\.co\.uk\/t\.js"[^>]*><\/script>[ \t]*\r?\n?/

function trackerRunsLast() {
  return {
    name: 'dd-tracker-runs-last',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const match = html.match(TRACKER_TAG)
        if (!match || !html.includes('</head>')) return html
        const rest = html.replace(match[0], '')
        return rest.replace('</head>', `  ${match[0].trim()}\n  </head>`)
      }
    }
  }
}

export default defineConfig({
  plugins: [trackerRunsLast()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        about: resolve(__dirname, 'about.html'),
        book: resolve(__dirname, 'book.html'),
        contact: resolve(__dirname, 'contact.html'),
        work: resolve(__dirname, 'work.html'),
        portfolio: resolve(__dirname, 'portfolio.html'),
        pricing: resolve(__dirname, 'pricing.html'),
        websiteDesignHyderabad: resolve(__dirname, 'website-design-hyderabad.html'),
        googleAdsHyderabad: resolve(__dirname, 'google-ads-hyderabad.html'),
        testimonials: resolve(__dirname, 'testimonials.html'),
        privacyPolicy: resolve(__dirname, 'privacy-policy.html'),
        termsConditions: resolve(__dirname, 'terms-conditions.html'),
        influencersLab: resolve(__dirname, 'influencers-lab.html'),
        thankYou: resolve(__dirname, 'thank-you.html')
      }
    }
  }
})

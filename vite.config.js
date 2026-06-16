import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        about: resolve(__dirname, 'about.html'),
        book: resolve(__dirname, 'book.html'),
        contact: resolve(__dirname, 'contact.html'),
        portfolio: resolve(__dirname, 'portfolio.html'),
        pricing: resolve(__dirname, 'pricing.html'),
        testimonials: resolve(__dirname, 'testimonials.html'),
        privacyPolicy: resolve(__dirname, 'privacy-policy.html'),
        termsConditions: resolve(__dirname, 'terms-conditions.html')
      }
    }
  }
})

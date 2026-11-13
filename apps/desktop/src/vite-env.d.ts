/// <reference types="vite/client" />

// Set only by scripts/phone-preview.mjs for the dev-only phone preview.
interface ImportMetaEnv {
  readonly VITE_PREVIEW_EMAIL?: string;
  readonly VITE_PREVIEW_PASSWORD?: string;
  readonly VITE_PREVIEW_DEVICE_ID?: string;
  readonly VITE_PREVIEW_DEVICE_SECRET?: string;
}

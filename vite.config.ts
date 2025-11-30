import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // НИЧЕГО лишнего, без base: "/tg-analytics-dashboard/"
});
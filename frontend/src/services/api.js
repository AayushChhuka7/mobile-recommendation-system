import axios from "axios";

// Vite inlines `import.meta.env.VITE_*` at build time. The Dockerfile
// builds with `--build-arg VITE_API_URL=...` (defaults to localhost).
// Fallback to the documented dev URL so a fresh checkout works without
// any build wiring — but in production, VITE_API_URL MUST be set at
// build time to the public backend URL.
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:8001/api",
  withCredentials: true,
  headers: {
    "Content-Type": "application/json",
  },
});

export default api;

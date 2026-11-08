import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { STORE_KEY } from "@/lib/store";

try {
  const raw = localStorage.getItem(STORE_KEY);
  if (raw) {
    JSON.parse(raw);
  }
} catch (e) {
  console.error('[Boot] Corrupted store data in localStorage, clearing:', e);
  try { localStorage.removeItem(STORE_KEY); } catch {}
}

createRoot(document.getElementById("root")!).render(<App />);

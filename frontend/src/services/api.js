import { runtimePort } from "../platform/runtimePort";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8787";
const PAGES_CACHE_KEY = "home2-pages";

export async function fetchPages() {
  const response = await runtimePort.request({ url: `${API_BASE}/api/pages` });
  if (!response.ok) {
    throw new Error("Failed to load pages");
  }
  return response.data;
}

export async function createPage(page) {
  const response = await runtimePort.request({
    url: `${API_BASE}/api/pages`,
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    data: page
  });

  if (!response.ok) {
    throw new Error("Failed to save page");
  }

  return response.data;
}

export function readCachedPages() {
  return runtimePort.storage.get(PAGES_CACHE_KEY, []);
}

export function writeCachedPages(pages) {
  runtimePort.storage.set(PAGES_CACHE_KEY, pages);
}

export { runtimePort };

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8787";

export async function fetchPages() {
  const response = await fetch(`${API_BASE}/api/pages`);
  if (!response.ok) {
    throw new Error("Failed to load pages");
  }
  return response.json();
}

export async function createPage(page) {
  const response = await fetch(`${API_BASE}/api/pages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(page)
  });

  if (!response.ok) {
    throw new Error("Failed to save page");
  }

  return response.json();
}

const API_BASE = "http://localhost:8000";

export async function postChat(message) {
  const response = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  return response.json();
}

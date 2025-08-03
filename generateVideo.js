import fetch from "node-fetch";

export async function generateVideo(text) {
  const username = process.env.DID_USERNAME;
  const password = process.env.DID_PASSWORD;

  if (!username || !password) {
    throw new Error("Credenciales D-ID no configuradas.");
  }

  const auth = Buffer.from(`${username}:${password}`).toString("base64");

  const data = {
    source_url: "https://i.imgur.com/gJ1JYB5.png",
    script: {
      type: "text",
      input: text,
      provider: {
        type: "microsoft",
        voice_id: "es-ES-AlvaroNeural"
      },
      ssml: false
    }
  };

  const response = await fetch("https://api.d-id.com/clips", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(data)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`D-ID error: ${errorText}`);
  }

  return await response.json();
}

async function pollTalkStatus(talkId) {
  let status = "";
  let attempts = 0;
  console.log(`Iniciando polling para talkId: ${talkId}`);

  while (status !== "done") {
    attempts++;
    console.log(`Intento #${attempts} para talkId ${talkId}`);

    const res = await fetch(`https://api.d-id.com/talks/${talkId}`, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error(`Error consultando estado de video (status ${res.status}): ${errorText}`);
      throw new Error(`Error consultando estado de video: ${res.status} ${errorText}`);
    }

    const json = await res.json();
    console.log(`Respuesta D-ID en polling:`, json);

    status = json.status;
    if (status === "done") {
      console.log(`Video listo para talkId ${talkId}, URL: ${json.result_url}`);
      return json.result_url;
    }
    if (status === "failed") {
      console.error(`Generación de video fallida para talkId ${talkId}`);
      throw new Error("Falló la generación del video");
    }

    await new Promise((r) => setTimeout(r, 10000)); // ahora 10 segundos
  }
}

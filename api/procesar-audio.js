const fetch = require('node-fetch'); // <-- ESTA LÍNEA CORRIGE EL ERROR
const Busboy = require('busboy');

// Función para parsear el audio (esta no cambia)
const parseMultipartForm = (req) => new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const result = { files: [] };
    busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
        const chunks = [];
        file.on('data', (chunk) => chunks.push(chunk));
        file.on('end', () => result.files.push({ buffer: Buffer.concat(chunks), mimetype }));
    });
    busboy.on('finish', () => resolve(result));
    busboy.on('error', reject);
    req.pipe(busboy);
});

// Función principal que se ejecuta
module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).send({ message: 'Only POST requests are allowed' });
    }

    try {
        const { files } = await parseMultipartForm(req);
        if (files.length === 0) {
            return res.status(400).send({ message: 'No audio file uploaded.' });
        }
        
        const audioFile = files[0];
        
        // 1. PREPARAMOS LA LLAMADA DIRECTA A LA API DE GEMINI
        const GOOGLE_API_KEY = process.env.GEMINI_API_KEY;
        const GOOGLE_PROJECT_ID = process.env.GCLOUD_PROJECT;
        const GOOGLE_LOCATION = process.env.GCLOUD_LOCATION;

        const url = `https://${GOOGLE_LOCATION}-aiplatform.googleapis.com/v1/projects/${GOOGLE_PROJECT_ID}/locations/${GOOGLE_LOCATION}/publishers/google/models/gemini-1.5-pro:streamGenerateContent`;

        const prompt = `
            Eres un asistente experto en facturación. Tu tarea es analizar la siguiente nota de voz.
            1. Transcribe el audio.
            2. Del texto, extrae: nombre de la empresa, NIT o cédula, valor total y el concepto.
            3. Devuelve únicamente un objeto JSON con las claves: "empresa", "nit_Cédula", "valor" (como número), "concepto", "correo_cliente", "numero_orden", "nombre_razón ", "fecha", "correo", "metodo_pago", "cuenta_bancaria", "firma".
            4. Si algún dato falta, déjalo como null. El JSON debe estar limpio, sin ```json ni ```.
        `;

        const requestBody = {
            contents: [{
                role: "user",
                parts: [{ text: prompt }, { inlineData: { mimeType: audioFile.mimetype, data: audioFile.buffer.toString('base64') } }]
            }]
        };

        // 2. LLAMAMOS A GEMINI CON LA API KEY
        const geminiResponse = await fetch(`${url}?key=${GOOGLE_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });

        if (!geminiResponse.ok) {
            throw new Error(`Google API error: ${await geminiResponse.text()}`);
        }
        
        const geminiResult = await geminiResponse.json();
        const jsonText = geminiResult[0].candidates[0].content.parts[0].text;
        const dataForN8n = JSON.parse(jsonText);

        // 3. LLAMAMOS AL WEBHOOK DE N8N
        await fetch(process.env.N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dataForN8n),
        });

        // 4. RESPONDEMOS AL FRONTEND
        res.status(200).json({ message: 'Cuenta de cobro iniciada.' });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ message: 'Error en el servidor.' });
    }
};
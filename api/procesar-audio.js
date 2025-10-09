const fetch = require('node-fetch');
const Busboy = require('busboy');

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

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).send({ message: 'Only POST requests are allowed' });

    try {
        const { files } = await parseMultipartForm(req);
        if (files.length === 0) return res.status(400).send({ message: 'No audio file uploaded.' });
        
        const audioFile = files[0];
        const GOOGLE_API_KEY = process.env.GEMINI_API_KEY;
        const GOOGLE_PROJECT_ID = process.env.GCLOUD_PROJECT;
        const GOOGLE_LOCATION = process.env.GCLOUD_LOCATION;

        const url = `https://${GOOGLE_LOCATION}-aiplatform.googleapis.com/v1/projects/${GOOGLE_PROJECT_ID}/locations/${GOOGLE_LOCATION}/publishers/google/models/gemini-2.0-flash:generateContent`;
        
        const prompt = `
Eres un asistente experto en facturación. Analiza la nota de voz:
1. Transcribe el audio con precisión, respetando acentos y palabras (ej: "i" con tilde es "í", "ina" es "ina" no "ina", pronuncia claro "ahorros" o "corriente").
2. Extrae exactamente:
   - numero_orden (número de orden).
   - nombre_razon (nombre completo o razón social del emisor, quien hace la cuenta).
   - nit_Cedula (NIT o cédula del emisor).
   - direccion (dirección del emisor).
   - telefono_Celular (teléfono del emisor, con +57 si es Colombia).
   - correo (email del emisor, quien envía la cuenta – el tuyo).
   - empresa (nombre de la empresa o cliente a facturar, el receptor).
   - concepto (descripción del cobro).
   - valor (número entero del total).
   - metodo_pago (opciones: Transferencia bancaria, Nequi, Daviplata, Efectivo).
   - cuenta_bancaria (número de cuenta para pago, incluyendo el banco y tipo como ahorros, corriente o vista si se menciona – ej: "Bancolombia ahorros 123456789").
   - fecha (YYYY-MM-DD, usa hoy si no se dice: 2025-10-09).
   - firma (nombre para firma del emisor).
   - correo_cliente (email del receptor/cliente, a quien se envía la cuenta – diferente del correo del emisor).
3. Devuelve SOLO un JSON limpio con esas claves exactas. Null si falta. Valor como número. No añadas texto extra, ni \`\`\`json.
`;

        const requestBody = {
            contents: [{
                role: "user",
                parts: [{ text: prompt }, { inlineData: { mimeType: audioFile.mimetype || 'audio/webm', data: audioFile.buffer.toString('base64') } }]
            }]
        };

        const geminiResponse = await fetch(`${url}?key=${GOOGLE_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });

        if (!geminiResponse.ok) {
            const errorText = await geminiResponse.text();
            throw new Error(`Google API error: ${errorText}`);
        }
        
        const geminiResult = await geminiResponse.json();
        let jsonText = geminiResult.candidates[0].content.parts[0].text;
        
        // NUEVO: Limpia markdown de Gemini (quita ```json
        jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        
        let dataForN8n;
        try {
            dataForN8n = JSON.parse(jsonText);
            // Fallback para espacio en nombre_razon si Gemini lo genera mal
            if (dataForN8n['nombre_razón ']) {
                dataForN8n.nombre_razon = dataForN8n['nombre_razón '];
                delete dataForN8n['nombre_razón '];
            }
            // Default fecha hoy
            if (!dataForN8n.fecha) dataForN8n.fecha = '2025-10-07';
            // Asegura que nit_Cedula sea string
            if (dataForN8n.nit_Cedula) dataForN8n.nit_Cedula = String(dataForN8n.nit_Cedula);
        } catch (parseError) {
            throw new Error(`Error parse JSON: ${parseError.message}. Texto: ${jsonText}`);
        }

        // Envía a n8n webhook
        const n8nResponse = await fetch(process.env.N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dataForN8n),
        });

        if (!n8nResponse.ok) console.error('Error n8n:', await n8nResponse.text());

        res.status(200).json({ message: 'Cuenta de cobro iniciada.' });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ message: 'Error en el servidor: ' + error.message });
    }
};
const fetch = require('node-fetch');
const Busboy = require('busboy');

const parseMultipartForm = (req) => new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const result = { files: [] };
    busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
        const chunks = [];
        file.on('data', (chunk) => chunks.push(chunk));
        file.on('end', () => result.files.push({ buffer: Buffer.concat(chunks), mimetype: mimetype || 'audio/webm' }));
    });
    busboy.on('finish', () => resolve(result));
    busboy.on('error', reject);
    req.pipe(busboy);
});

const getTodayDate = () => {
    const today = new Date();
    today.setHours(today.getHours() - 5);
    return today.toISOString().split('T')[0];
};

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).send({ message: 'Only POST requests are allowed' });

    try {
        const { files } = await parseMultipartForm(req);
        if (files.length === 0) return res.status(400).send({ message: 'No audio file uploaded.' });
        
        const audioFile = files[0];
        console.log('Audio recibido:', { length: audioFile.buffer.length, mimeType: audioFile.mimetype });

        if (audioFile.buffer.length === 0) {
            return res.status(400).send({ message: 'Audio vacío – graba de nuevo.' });
        }

        const GOOGLE_API_KEY = process.env.GEMINI_API_KEY;
        const GOOGLE_PROJECT_ID = process.env.GCLOUD_PROJECT;
        const GOOGLE_LOCATION = process.env.GCLOUD_LOCATION;

        const url = `https://${GOOGLE_LOCATION}-aiplatform.googleapis.com/v1/projects/${GOOGLE_PROJECT_ID}/locations/${GOOGLE_LOCATION}/publishers/google/models/gemini-2.0-flash:generateContent`;
        
        const prompt = `
Eres un asistente experto en facturación. Analiza la nota de voz:
1. Transcribe el audio con precisión.
2. Extrae exactamente los siguientes campos:
   - numero_orden (número de orden).
   - nombre_razon (nombre completo o razón social del EMISOR, quien hace la cuenta).
   - nit_Cedula (NIT o cédula del EMISOR).
   - direccion (dirección del EMISOR).
   - telefono_Celular (teléfono del EMISOR, con +57 si es Colombia).
   - correo (Email del EMISOR. Ejemplo: 'emisor@miempresa.com').
   - empresa (nombre de la empresa o CLIENTE a facturar, el RECEPTOR).
   - concepto (descripción del cobro).
   - valor (número entero del total, sin puntos ni comas).
   - metodo_pago (opciones: Transferencia bancaria, Nequi, Daviplata, Efectivo).
   - cuenta_bancaria (número de cuenta para pago, incluyendo banco y tipo. Ej: "Bancolombia ahorros 123456789").
   - fecha (Fecha en formato YYYY-MM-DD. Si el audio dice "hoy", usa la fecha actual).
   - firma (nombre para firma del EMISOR).
   - correo_cliente (Email del CLIENTE/RECEPTOR. Ejemplo: 'cliente@otraempresa.com').
   
3. Devuelve SÓLO un JSON limpio con esas claves exactas. Si un campo falta, usa 'null'. El campo 'valor' debe ser un número. No añadas texto extra, ni \`\`\`json.
`;

        const mimeType = audioFile.mimetype || 'audio/webm';
        const base64Data = audioFile.buffer.toString('base64');
        console.log('Enviando a Gemini:', { mimeType, base64Length: base64Data.length });

        const requestBody = {
            contents: [{
                role: "user",
                parts: [{ text: prompt }, { inlineData: { mimeType, data: base64Data } }]
            }]
        };

        const geminiResponse = await fetch(`${url}?key=${GOOGLE_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });

        if (!geminiResponse.ok) {
            const errorText = await geminiResponse.text();
            console.error('Gemini response error:', errorText);
            throw new Error(`Google API error: ${errorText}`);
        }
        
        const geminiResult = await geminiResponse.json();
        let jsonText = geminiResult.candidates[0].content.parts[0].text;
        
        jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        console.log('JSON extraído de Gemini:', jsonText);
        
        let dataForN8n;
        try {
            dataForN8n = JSON.parse(jsonText);
            
            if (!dataForN8n.fecha || dataForN8n.fecha.toLowerCase() === 'hoy') {
                dataForN8n.fecha = getTodayDate();
            }

            if (dataForN8n.nit_Cedula) dataForN8n.nit_Cedula = String(dataForN8n.nit_Cedula);
            
            if (dataForN8n['nombre_razón ']) {
                dataForN8n.nombre_razon = dataForN8n['nombre_razón '];
                delete dataForN8n['nombre_razón '];
            }

        } catch (parseError) {
            console.error('Parse JSON error:', parseError.message, 'Texto:', jsonText);
            throw new Error(`Error parse JSON: ${parseError.message}. Texto: ${jsonText}`);
        }

        console.log('Datos para n8n:', dataForN8n);

        // ✅ SOLUCIÓN: Envía a n8n SIN esperar respuesta (fire and forget)
        // Esto permite que Vercel responda rápido al usuario y n8n procese en background
        fetch(process.env.N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dataForN8n),
            timeout: 5000 // Timeout corto, no bloqueamos
        }).catch(err => {
            console.error('Error enviando a n8n (background):', err.message);
            // No lanzamos error, solo registramos
        });

        // ✅ Responde inmediatamente al usuario
        res.status(200).json({ 
            message: 'Cuenta de cobro en proceso. Recibirás un email en unos momentos.' 
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ message: 'Error en el servidor: ' + error.message });
    }
};
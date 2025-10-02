const { VertexAI } = require('@google-cloud/vertexai');
const Busboy = require('busboy');

// Función para parsear el audio que llega del frontend
const parseMultipartForm = (req) => new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const result = { files: [] };

    busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
        const chunks = [];
        file.on('data', (chunk) => chunks.push(chunk));
        file.on('end', () => result.files.push({
            fieldname,
            buffer: Buffer.concat(chunks),
            filename,
            encoding,
            mimetype,
        }));
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

        // 1. INICIALIZAR GEMINI
        const vertexAI = new VertexAI({
            project: process.env.GCLOUD_PROJECT,
            location: process.env.GCLOUD_LOCATION,
        });
        
        const generativeModel = vertexAI.getGenerativeModel({
            model: 'gemini-1.5-pro-preview-0409',
        });
        
        // 2. PREPARAR LA PETICIÓN PARA GEMINI
        const audioPart = {
            inlineData: {
                mimeType: audioFile.mimetype,
                data: audioFile.buffer.toString('base64'),
            },
        };
        
        const prompt = `
            Eres un asistente experto en facturación. Tu tarea es analizar la siguiente nota de voz.
            1. Transcribe el audio.
            2. Del texto, extrae: nombre de la empresa, NIT o cédula, valor total y el concepto.
            3. Devuelve únicamente un objeto JSON con las claves: "empresa", "nit_Cédula", "valor" (como número), "concepto", "correo_cliente", "numero_orden", "nombre_razón ", "fecha", "correo", "metodo_pago", "cuenta_bancaria", "firma".
            4. Si algún dato falta, déjalo como null.
        `;

        // 3. LLAMAR A GEMINI
        const result = await generativeModel.generateContent([prompt, audioPart]);
        const jsonText = result.response.candidates[0].content.parts[0].text.replace(/```json|```/g, '').trim();
        const dataForN8n = JSON.parse(jsonText);

        // 4. LLAMAR AL WEBHOOK DE N8N
        await fetch(process.env.N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dataForN8n),
        });

        // 5. RESPONDER AL FRONTEND
        res.status(200).json({ message: 'Cuenta de cobro iniciada.' });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ message: 'Error en el servidor.' });
    }
};
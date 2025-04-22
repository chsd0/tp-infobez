const http = require('http');
const net = require('net');
const tls = require('tls');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const express = require('express');
const { parseRequest, parseResponse } = require('http-string-parser');
const { parse: parseCookie } = require('cookie');
const { MongoClient, ObjectId } = require('mongodb');
const { URL, URLSearchParams } = require('url');
const zlib = require('zlib');
const axios = require('axios');

// Database connection
let db;
(async () => {
  try {
    const client = new MongoClient(process.env.MONGO_URI || 'mongodb://mongo:27017/proxy');
    await client.connect();
    db = client.db();
    await db.collection('requests').createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 });
    console.log('Connected to MongoDB');
  } catch (err) {
    console.error('MongoDB connection error:', err);
  }
})();

class RequestStore {
  async add(request) {
    const collection = db.collection('requests');
    request.createdAt = new Date();
    const result = await collection.insertOne(request);
    return result.insertedId;
  }

  async get(id) {
    const collection = db.collection('requests');
    return await collection.findOne({ _id: new ObjectId(id) });
  }

  async getAll() {
    const collection = db.collection('requests');
    return await collection.find().sort({ createdAt: -1 }).toArray();
  }

  async update(id, update) {
    const collection = db.collection('requests');
    return await collection.updateOne({ _id: new ObjectId(id) }, { $set: update });
  }
}

const store = new RequestStore();

// API Server
const api = express();
api.use(express.json());

api.get('/requests', async (req, res) => {
  try {
    const requests = await store.getAll();
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

api.get('/requests/:id', async (req, res) => {
  try {
    const request = await store.get(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    res.json(request);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

api.post('/repeat/:id', async (req, res) => {
  try {
    const request = await store.get(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });

    const response = await sendRequest(request);
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

api.post('/scan/:id', async (req, res) => {
  try {
    const request = await store.get(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });

    const results = await scanRequest(request, 0);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

api.post('/scan/:id/fast', async (req, res) => {
  try {
    const request = await store.get(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found' });

    const results = await scanRequest(request, 1);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

api.listen(8000, () => console.log('API server running on port 8000'));

// Helper functions
function parseIncomingRequest(req, body) {
  // Правильно собираем заголовки
  const headers = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const key = req.rawHeaders[i];
    const value = req.rawHeaders[i+1];
    headers[key] = value;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const cookies = headers.cookie ? parseCookie(headers.cookie) : {};

  let postParams = {};
  if (body && headers['content-type'] === 'application/x-www-form-urlencoded') {
    try {
      postParams = Object.fromEntries(new URLSearchParams(body));
    } catch (e) {
      postParams = { raw: body };
    }
  }

  return {
    method: req.method,
    url: req.url,
    protocol: url.protocol,
    host: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname,
    headers: headers,  // Теперь заголовки в правильном формате
    cookies,
    get_params: Object.fromEntries(url.searchParams),
    post_params: postParams,
    body: body,
    raw: `${req.method} ${req.url} HTTP/1.1\r\n${
      Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
    }\r\n\r\n${body}`
  };
}

function parseResponseData(res, body) {
  return {
    status: res.statusCode,
    message: res.statusMessage,
    headers: res.headers,
    body: body,
    raw: `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}\r\n${
      Object.entries(res.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
    }\r\n\r\n${body}`
  };
}

// HTTP Proxy
const proxy = http.createServer(async (clientReq, clientRes) => {
  let body = [];
  clientReq.on('data', chunk => body.push(chunk));
  clientReq.on('end', async () => {
    try {
      body = Buffer.concat(body).toString();
      const parsedReq = await parseIncomingRequest(clientReq, body);
      const requestId = await store.add({
        ...parsedReq,
        response: null,
        isHTTPS: false
      });

      const targetUrl = new URL(clientReq.url);
      const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 80,
        path: targetUrl.pathname + targetUrl.search,
        method: clientReq.method,
        headers: { ...clientReq.headers }
      };

      // Remove proxy headers
      delete options.headers['proxy-connection'];
      delete options.headers['proxy-authorization'];

      const proxyReq = http.request(options, async (targetRes) => {
        let responseBody = [];
        targetRes.on('data', chunk => responseBody.push(chunk));
        targetRes.on('end', async () => {
          responseBody = Buffer.concat(responseBody);
          
          // Handle compressed responses
          if (targetRes.headers['content-encoding'] === 'gzip') {
            responseBody = zlib.gunzipSync(responseBody);
          } else if (targetRes.headers['content-encoding'] === 'deflate') {
            responseBody = zlib.inflateSync(responseBody);
          }

          const parsedRes = parseResponseData(targetRes, responseBody.toString());
          await store.update(requestId, { response: parsedRes });

          clientRes.writeHead(targetRes.statusCode, targetRes.headers);
          clientRes.end(responseBody);
        });
      });

      proxyReq.on('error', (err) => {
        console.error('Proxy request error:', err);
        clientRes.statusCode = 502;
        clientRes.end('Bad Gateway');
      });

      if (body.length > 0) {
        proxyReq.write(body);
      }
      proxyReq.end();
    } catch (err) {
      console.error('HTTP Proxy error:', err);
      clientRes.statusCode = 500;
      clientRes.end('Internal Server Error');
    }
  });
});

// HTTPS Proxy
proxy.on('connect', async (req, clientSocket, head) => {
  try {
    const [hostname, port] = req.url.split(':');
    const portNumber = port || 443;

    // Save CONNECT request
    const connectRequest = {
      method: 'CONNECT',
      url: req.url,
      host: hostname,
      port: portNumber,
      headers: req.headers,
      isHTTPS: true,
      createdAt: new Date()
    };
    const requestId = await store.add(connectRequest);

    // Generate certificate if needed
    const certPath = path.join(__dirname, '../certs', `${hostname}.crt`);
    if (!fs.existsSync(certPath)) {
      console.log(`Generating certificate for ${hostname}`);
      const { status } = spawnSync('./scripts/gen_cert.sh', [hostname], {
        stdio: 'inherit',
        cwd: path.join(__dirname, '..')
      });
      if (status !== 0) throw new Error('Certificate generation failed');
    }

    // Create TLS context
    const key = fs.readFileSync(path.join(__dirname, '../certs/cert.key'));
    const cert = fs.readFileSync(certPath);
    const ca = fs.readFileSync(path.join(__dirname, '../ca/ca.crt'));

    // Establish connection with client
    const serverSocket = tls.connect({
      host: hostname,
      port: portNumber,
      rejectUnauthorized: false
    }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      // Create MITM TLS socket
      const tlsSocket = new tls.TLSSocket(clientSocket, {
        isServer: true,
        key,
        cert,
        SNICallback: (servername, cb) => {
          cb(null, tls.createSecureContext({ key, cert }));
        }
      });

      // Pipe data between client and server
      tlsSocket.pipe(serverSocket);
      serverSocket.pipe(tlsSocket);

      // Handle initial data
      if (head && head.length) {
        serverSocket.write(head);
      }

      // Save HTTPS traffic
      const requestBuffers = [];
      const responseBuffers = [];
      let requestComplete = false;

      tlsSocket.on('data', (data) => {
        if (!requestComplete) {
          requestBuffers.push(data);
          const raw = Buffer.concat(requestBuffers).toString();
          if (raw.includes('\r\n\r\n')) {
            requestComplete = true;
            // Here you would parse and save the HTTPS request
          }
        } else {
          responseBuffers.push(data);
        }
      });

      serverSocket.on('data', (data) => {
        responseBuffers.push(data);
      });

      tlsSocket.on('end', () => {
        serverSocket.end();
      });

      serverSocket.on('end', () => {
        tlsSocket.end();
      });
    });

    serverSocket.on('error', (err) => {
      console.error('Server socket error:', err);
      clientSocket.end();
    });

    clientSocket.on('error', (err) => {
      console.error('Client socket error:', err);
      serverSocket.end();
    });
  } catch (err) {
    console.error('HTTPS Proxy error:', err);
    clientSocket.end();
  }
});

// Request repeater
async function sendRequest(request) {
  try {
    // Фильтрация заголовков - удаляем пустые и невалидные
    const headers = {};
    for (const [key, value] of Object.entries(request.headers)) {
      if (key && value && key.trim() !== '' && value.trim() !== '') {
        headers[key] = value;
      }
    }

    // Удаляем прокси-заголовки
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];

    const config = {
      method: request.method,
      url: request.url,
      headers: headers,
      data: request.body,
      maxRedirects: 0,
      validateStatus: () => true
    };

    const response = await axios(config);
    
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      data: response.data
    };
  } catch (err) {
    if (err.response) {
      return {
        status: err.response.status,
        statusText: err.response.statusText,
        headers: err.response.headers,
        data: err.response.data
      };
    }
    throw err;
  }
}

// Vulnerability scanner
async function scanRequest(request, isFast) {
  try {
    if (request.method !== 'GET') {
      return { error: 'Only GET requests can be scanned for parameters' };
    }

    // Чтение параметров из файла
    const paramsFile = path.join(__dirname, `../params${isFast ? '' : '_full'}.txt`);
    if (!fs.existsSync(paramsFile)) {
      return { error: 'Params dictionary not found' };
    }

    const params = fs.readFileSync(paramsFile, 'utf8')
      .split('\n')
      .filter(p => p.trim().length > 0);

    const results = [];
    const baseUrl = new URL(request.url);

    // Подготовка заголовков
    const headers = { ...request.headers };
    
    // Удаляем проблемные заголовки
    delete headers['Proxy-Connection'];
    delete headers['proxy-connection'];
    delete headers['content-length'];

    for (const param of params) {
      try {
        const randomValue = Math.random().toString(36).substring(2, 15);
        const testUrl = new URL(baseUrl);
        testUrl.searchParams.set(param, randomValue);

        const response = await axios.get(testUrl.toString(), {
          headers: headers,
          maxRedirects: 0,
          validateStatus: () => true,
          decompress: true
        });

        const found = response.data.includes(randomValue);
        results.push({
          param,
          found,
          status: response.status,
          reflected: found ? randomValue : undefined
        });
      } catch (err) {
        results.push({
          param,
          error: err.message
        });
      }
    }

    return results;
  } catch (err) {
    console.error('Scan error:', err);
    throw err;
  }
}

proxy.listen(8080, () => console.log('Proxy server running on port 8080'));
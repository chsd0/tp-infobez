const http = require('http');
const net = require('net');
const tls = require('tls');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const express = require('express');

class RequestStore {
  constructor() { 
    this.requests = []; 
  }

  add(req) {
    this.requests.push(req); 
  }
  
  get(id) { 
    return this.requests[id]; 
  }
}

const store = new RequestStore();

// API
const api = express();
api.get('/requests', (req, res) => res.json(store.requests));
api.listen(8000);

const proxy = http.createServer((clientReq, clientRes) => {
  const target = new URL(clientReq.url);

  const proxyReq = http.request({
    hostname: target.hostname,
    port: target.port || 80,
    path: target.pathname,
    method: clientReq.method,
    headers: { ...clientReq.headers, Connection: 'close' }
  }, (targetRes) => {
    clientRes.writeHead(targetRes.statusCode, targetRes.headers);
    targetRes.pipe(clientRes);
  });

  clientReq.pipe(proxyReq);
});


const CA_DIR = path.join(__dirname, '../ca');
const CERTS_DIR = path.join(__dirname, '../certs');
const CERT_KEY_PATH = path.join(CERTS_DIR, 'cert.key');

proxy.on('connect', (req, socket, head) => {
  const [host, port] = req.url.split(':');


  const target = net.connect(port || 443, host, () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    try {
      // Генерация сертификата домена
      const certPath = path.join(CERTS_DIR, `${host}.crt`);
      if (!fs.existsSync(certPath)) {
        console.log(`Generating certificate for ${host}`);
        const { status } = spawnSync('./scripts/gen_cert.sh', [host], {
          stdio: 'inherit',
          cwd: path.join(__dirname, '..')
        });
        if (status !== 0) {
          throw new Error('Certificate generation failed');
        }
      }

      // Загрузка ключей
      const key = fs.readFileSync(CERT_KEY_PATH);
      const cert = fs.readFileSync(certPath);
      const ca = fs.readFileSync(path.join(CA_DIR, 'ca.crt'));


      // Настройка TLS
      const tlsSocket = new tls.TLSSocket(socket, {
        key,
        cert,
        ca: [ca],
        isServer: true,
        SNICallback: (servername, cb) => cb(null, tls.createSecureContext({ key, cert }))
      });

      const remote = tls.connect({
        host,
        port: port || 443,
        rejectUnauthorized: false
      }, () => {
        tlsSocket.pipe(remote);
        remote.pipe(tlsSocket);
        remote.write(head);
      });

    } catch (err) {
      console.error('HTTPS Error:', err);
      socket.destroy();
    }
  });
});

proxy.listen(8080, () => {
  console.log('Proxy server running on port 8080');
  console.log('API server running on port 8000');
});
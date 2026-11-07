import http from 'node:http';

// Goal responses arrive only after execution finishes. Native fetch imposes a
// headers deadline on that wait. Never retry a POST: it may already have acted.
export function postGoalJson(baseUrl, endpoint, body = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      reject(new Error('CLI goal transport requires the local HTTP host')); return;
    }
    const payload = JSON.stringify(body);
    const request = http.request(url, {
      method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode >= 400 || result.ok === false) throw new Error(result.error?.message || result.message || `Goal request failed with HTTP ${response.statusCode}`);
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

import http from 'http';

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok raw');
}).listen(PORT, '0.0.0.0', () => {
  console.log('raw server running on', PORT);
});

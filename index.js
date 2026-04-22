import express from 'express';

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('ok express');
});

app.post('/resolve', (req, res) => {
  res.json({
    ok: true,
    body: req.body
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log('server running on', PORT);
});

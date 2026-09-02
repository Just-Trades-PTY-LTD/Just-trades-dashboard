import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { createAroFloClient } from './aroflo/index.js';
import { createDashboardRouter } from './routes/dashboard.js';

const app = express();
app.use(cors({ origin: config.clientOrigin }));
app.use(express.json());

const aroflo = createAroFloClient();

app.get('/api/health', (req, res) => res.json({ ok: true, mode: config.aroflo.mode }));
app.use('/api', createDashboardRouter({ aroflo, config }));

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Technician dashboard API listening on :${config.port} (AroFlo mode: ${config.aroflo.mode})`);
});

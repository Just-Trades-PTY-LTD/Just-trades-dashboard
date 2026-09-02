import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT) || 4000,
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  refreshIntervalMs: Number(process.env.REFRESH_INTERVAL_MS) || 60000,
  aroflo: {
    mode: (process.env.AROFLO_MODE || 'mock').toLowerCase(), // 'mock' | 'live'
    baseUrl: process.env.AROFLO_BASE_URL || 'https://api.aroflo.com',
    sdkKey: process.env.AROFLO_SDK_KEY || '',
    accessKey: process.env.AROFLO_ACCESS_KEY || '',
    secretKey: process.env.AROFLO_SECRET_KEY || '',
  },
};

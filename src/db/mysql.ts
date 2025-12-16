import mysql from 'mysql2/promise';

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function createPool() {
  return mysql.createPool({
    host: env('DB_HOST', '127.0.0.1'),
    port: Number(process.env.DB_PORT ?? 3306),
    user: env('DB_USER', 'oly'),
    password: env('DB_PASSWORD', 'oly'),
    database: env('DB_NAME', 'oly'),
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_SIZE ?? 10),
    enableKeepAlive: true,
  });
}

export type MySqlPool = ReturnType<typeof createPool>;



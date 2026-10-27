const port = Number(process.env.PORT || 3000);
try {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000), redirect: 'error' });
  if (!response.ok || (await response.json() as { status?: string }).status !== 'ok') process.exitCode = 1;
} catch { process.exitCode = 1; }
export {};
